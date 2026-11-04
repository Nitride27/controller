"""Shows a QR code on the laptop that friends scan to play from their phone's browser."""
import html
import http.client
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

import segno

from server import PIN_FILE, PORT, WEB_DIR

APP_DIR = WEB_DIR.parent
SOURCES = ["App.js", "core.js", "link.js", "app.json", "package-lock.json", "public/index.html"]


def lan_address():
    # Sends nothing: connecting a UDP socket only asks Windows which adapter reaches the network.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.connect(("10.255.255.255", 1))
        return probe.getsockname()[0]


def server_serves_page():
    connection = http.client.HTTPConnection("127.0.0.1", PORT, timeout=2)
    try:
        connection.request("GET", "/")
        return connection.getresponse().status in (200, 404)  # 404 is just a page not built yet
    except OSError:
        return False
    finally:
        connection.close()


def page_is_stale():
    index = WEB_DIR / "index.html"
    if not index.exists():
        return True
    built = index.stat().st_mtime
    return any((APP_DIR / name).stat().st_mtime > built for name in SOURCES)


def invite_page(url, pin):
    qr = segno.make(url, error="m").svg_inline(omitsize=True, dark="#000", light="#fff", border=4)
    typed = url.split("#")[0]
    return f"""<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Phone Pad: scan to play</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
         gap: 18px; background: #1B1D23; color: #F5F6F8; font: 18px system-ui, sans-serif; text-align: center; }}
  h1 {{ margin: 0; font-size: 32px; }}
  p {{ margin: 0; color: #A6ABB5; }}
  svg {{ display: block; width: min(60vh, 90vw); height: auto; border-radius: 12px; }}
  code {{ color: #F5F6F8; }}
</style>
<h1>Scan to play</h1>
{qr}
<p>Join the same Wi-Fi as this laptop, then scan with the phone's camera.</p>
<p>Or type <code>{html.escape(typed)}</code> in the browser and enter code <code>{html.escape(pin)}</code>.</p>
</html>"""


def main():
    if not server_serves_page():
        sys.exit("Phone Pad isn't running, or was opened before this update. Close it, open Phone Pad, then try this again.")
    if page_is_stale():
        print("Building the browser controller...", flush=True)
        if subprocess.run(["npx.cmd", "expo", "export", "--platform", "web"], cwd=APP_DIR).returncode != 0:
            sys.exit("Could not build the browser controller. Check the error above.")
    try:
        url_host = lan_address()
    except OSError:
        sys.exit("This laptop isn't on a network. Join the Wi-Fi your friends are on, then try again.")

    pin = PIN_FILE.read_text().strip()
    url = f"http://{url_host}:{PORT}/#code={pin}"
    page = Path(tempfile.gettempdir()) / "phone-pad-invite.html"
    page.write_text(invite_page(url, pin), encoding="utf-8")
    os.startfile(page)
    print(f"Friends can open {url}")


if __name__ == "__main__":
    main()
