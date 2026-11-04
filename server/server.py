"""Bridges phones to virtual Xbox 360 pads on this PC, one pad per phone.

Protocol (WebSocket text frames, JSON):
  server -> {"link": "USB"}            on open, so the phone can pick its best link
  phone  -> {"pin": "123456", "id": "..."}   first frame; wrong pin closes with 4001
  server -> {"ok": true, "player": 1}  or closes with 4003 if every slot is in use
  phone  -> [seq,buttons,lx,ly,rx,ry,lt,rt]   full pad state, on every change
  server -> seq                        echo; also defeats Nagle + delayed-ACK on the phone's socket
  server -> {"r": [large, small]}      game rumble for this phone's pad, 0-255

Plain HTTP requests on the same port get the browser version of the controller from app/dist.
"""
import asyncio
import functools
import json
import secrets
import socket
import sys
from pathlib import Path

import psutil
from websockets.asyncio.server import broadcast, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response

PORT = 8765
PIN_FILE = Path(__file__).with_name(".pin")
WEB_DIR = Path(__file__).resolve().parent.parent / "app" / "dist"
# Not mimetypes: on Windows it reads the registry, which can mislabel .js and stop the page loading.
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".ttf": "font/ttf",
}
BUTTON_MASK = 0xF7FF  # every XUSB button bit; 0x0800 is reserved
MAX_PLAYERS = 4  # Windows' XInput, which most games read pads through, stops at four

create_pad = None  # set in main(); takes the on_rumble(large, small) callback for that pad
pin = ""
players = []
closing = set()


class Player:
    """One virtual pad. It stays plugged in between sessions so a brief drop can't reorder players."""

    def __init__(self):
        self.owner = None  # the id of the phone this slot is kept for
        self.ws = None  # that phone's live connection
        self.pad = create_pad(functools.partial(send_rumble, self))
        # A new pad reads off-centre (about 10%) until a report actually differs, and all zeros
        # doesn't count, so nudge one axis and put it back.
        self.pad.report.sThumbLX = 1
        self.pad.update()
        self.pad.report.sThumbLX = 0
        self.pad.update()

    @property
    def number(self):
        return players.index(self) + 1


def claim_player(owner):
    """Returns the slot for this phone, or None if four other phones are connected."""
    for player in players:
        if player.owner == owner:
            return player
    claimed = next((p for p in players if p.owner is None), None)
    if claimed is None and len(players) < MAX_PLAYERS:
        claimed = Player()
        players.append(claimed)
    # Only when full does a new phone take the slot of one that has gone away.
    claimed = claimed or next((p for p in players if p.ws is None), None)
    if claimed is not None:
        claimed.owner = owner
    return claimed


def clamp(value, low, high):
    return max(low, min(high, value))


def parse_state(message):
    """Validate one state frame from the network. Raises ValueError on anything malformed."""
    state = json.loads(message)
    if not isinstance(state, list) or len(state) != 8 or any(type(v) is not int for v in state):
        raise ValueError("expected 8 integers")
    seq, buttons, lx, ly, rx, ry, lt, rt = state
    return (
        seq,
        buttons & BUTTON_MASK,
        clamp(lx, -32768, 32767),
        clamp(ly, -32768, 32767),
        clamp(rx, -32768, 32767),
        clamp(ry, -32768, 32767),
        clamp(lt, 0, 255),
        clamp(rt, 0, 255),
    )


def apply_state(pad, state):
    report = pad.report
    (_, report.wButtons, report.sThumbLX, report.sThumbLY,
     report.sThumbRX, report.sThumbRY, report.bLeftTrigger, report.bRightTrigger) = state
    pad.update()


def release_everything(pad):
    pad.reset()
    pad.update()


def link_name(ip):
    for name, addresses in psutil.net_if_addrs().items():
        if any(a.family == socket.AF_INET and a.address == ip for a in addresses):
            lowered = name.lower()
            if "bluetooth" in lowered:
                return "Bluetooth"
            if "wi-fi" in lowered or "wlan" in lowered or "wireless" in lowered:
                return "Wi-Fi"
            # The phone's USB tether shows up as a plain "Ethernet N" on the hotspot subnet.
            return "USB" if ip.startswith("172.20.10.") else "LAN"
    return "LAN"


def read_hello(message):
    """Returns the phone's id if the pairing code is right, otherwise None."""
    try:
        hello = json.loads(message)
        given = hello["pin"]
        if not (isinstance(given, str) and secrets.compare_digest(given.encode(), pin.encode())):
            return None
    except (ValueError, TypeError, KeyError):
        return None
    owner = hello.get("id")
    # Without a usable id the phone still plays, it just can't reclaim its slot after a drop.
    return owner if isinstance(owner, str) and 0 < len(owner) <= 64 else secrets.token_hex(8)


async def handle(ws):
    link = link_name(ws.local_address[0])
    await ws.send(json.dumps({"link": link}))
    try:
        first = await asyncio.wait_for(ws.recv(), 5)
    except (TimeoutError, ConnectionClosed):
        return  # the phone probes every link and drops the slower ones
    owner = read_hello(first)
    if owner is None:
        await asyncio.sleep(1)  # slows down guessing
        await ws.close(4001, "wrong pairing code")
        return

    player = claim_player(owner)
    if player is None:
        await ws.close(4003, "all controller slots are in use")
        return
    previous, player.ws = player.ws, ws
    if previous is not None:
        release_everything(player.pad)
        # Not awaited: a dead old connection would hold up the phone until the close times out.
        closing.add(task := asyncio.create_task(previous.close(4002, "this phone connected again")))
        task.add_done_callback(closing.discard)
    print(f"Player {player.number} connected over {link}", flush=True)
    await ws.send(json.dumps({"ok": True, "player": player.number}))
    try:
        async for message in ws:
            state = parse_state(message)
            apply_state(player.pad, state)
            await ws.send(str(state[0]))
    except ValueError:
        await ws.close(1007, "bad state frame")
    except ConnectionClosed:
        pass
    finally:
        # A dropped phone must never leave a game holding the throttle down.
        if player.ws is ws:
            player.ws = None
            release_everything(player.pad)
            print(f"Player {player.number} disconnected, inputs released", flush=True)


def send_rumble(player, large, small):
    if player.ws is not None:
        broadcast({player.ws}, json.dumps({"r": [large, small]}))


def load_pin():
    if PIN_FILE.exists():
        return PIN_FILE.read_text().strip()
    new_pin = f"{secrets.randbelow(10**6):06d}"
    PIN_FILE.write_text(new_pin)
    return new_pin


def web_file(url_path):
    """Returns the file a URL path names inside WEB_DIR, or None. Nothing outside it is reachable."""
    relative = url_path.split("?")[0].lstrip("/") or "index.html"
    # Checked before touching the disk: resolving a \\host\share path would make Windows contact that host.
    if "\\" in relative or ":" in relative:
        return None
    path = (WEB_DIR / relative).resolve()
    return path if path.is_relative_to(WEB_DIR) and path.is_file() else None


async def serve_web_page(connection, request):
    if "Upgrade" in request.headers:
        return None  # a controller connecting, so carry on with the WebSocket handshake
    path = web_file(request.path)
    if path is None:
        return connection.respond(404, "Not found\n")
    # In a thread so a friend loading the page can't delay anyone's input.
    body = await asyncio.to_thread(path.read_bytes)
    return Response(200, "OK", Headers({
        "Content-Type": CONTENT_TYPES.get(path.suffix, "application/octet-stream"),
        "Content-Length": str(len(body)),
        "Cache-Control": "no-cache",
        "Connection": "close",
    }), body)


def listen():
    # Pings catch a phone that vanished (locked, out of range) within about 3 seconds.
    return serve(handle, "0.0.0.0", PORT, process_request=serve_web_page,
                 ping_interval=1, ping_timeout=2, max_size=256, compression=None)


async def main():
    global create_pad, pin
    loop = asyncio.get_running_loop()

    def create_real_pad(on_rumble):
        import vgamepad
        pad = vgamepad.VX360Gamepad()

        # The argument names are checked by vgamepad; this runs on the driver's own thread.
        def on_notification(client, target, large_motor, small_motor, led_number, user_data):
            loop.call_soon_threadsafe(on_rumble, large_motor, small_motor)

        pad.register_notification(on_notification)
        return pad

    create_pad = create_real_pad
    try:
        players.append(Player())  # up front, so a missing driver shows here and not on first connect
    except Exception as error:
        sys.exit(f"Could not create the virtual gamepad ({error}).\nRun setup.ps1 as administrator to install the driver.")

    psutil.Process().nice(psutil.HIGH_PRIORITY_CLASS)  # a game pegging the CPU shouldn't delay input
    pin = load_pin()

    print(f"\n  Pairing code: {pin}\n  Use the same code on every phone, up to {MAX_PLAYERS}.\n", flush=True)
    async with listen() as server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
