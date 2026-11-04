import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

import server

server.PORT = 18765  # clear of a real server that may be running on the default port


class FakePad:
    def __init__(self, on_rumble):
        self.on_rumble = on_rumble
        self.report = SimpleNamespace()
        self.resets = 0
        self.updates = 0

    def update(self):
        self.updates += 1

    def reset(self):
        self.resets += 1
        self.report = SimpleNamespace(wButtons=0)


class ParseState(unittest.TestCase):
    def test_clamps_values_and_masks_reserved_button(self):
        state = server.parse_state("[7, 65535, 99999, -99999, 0, 1, 300, -5]")
        self.assertEqual(state, (7, 0xF7FF, 32767, -32768, 0, 1, 255, 0))

    def test_rejects_malformed_frames(self):
        for bad in ['{"a":1}', "[1,2,3]", "[1,2,3,4,5,6,7,1.5]", "[true,2,3,4,5,6,7,8]", "nope"]:
            with self.assertRaises(ValueError, msg=bad):
                server.parse_state(bad)


class WebFile(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        original = server.WEB_DIR
        self.addCleanup(setattr, server, "WEB_DIR", original)
        server.WEB_DIR = Path(self.folder.name).resolve()
        (server.WEB_DIR / "index.html").write_text("page")
        (server.WEB_DIR.parent / "phone-pad-secret.txt").write_text("secret")
        self.addCleanup((server.WEB_DIR.parent / "phone-pad-secret.txt").unlink)

    def test_finds_files_and_defaults_to_the_page(self):
        self.assertEqual(server.web_file("/").name, "index.html")
        self.assertEqual(server.web_file("/index.html?v=1").name, "index.html")

    def test_nothing_outside_the_folder_is_reachable(self):
        for bad in ["/../phone-pad-secret.txt", "/x/../../phone-pad-secret.txt", "/..\\phone-pad-secret.txt",
                    "/C:/Windows/win.ini", "//C:/Windows/win.ini", "/\\\\attacker\\share\\x", "/missing.js"]:
            self.assertIsNone(server.web_file(bad), bad)

    def test_a_folder_is_not_a_file(self):
        (server.WEB_DIR / "sub").mkdir()
        self.assertIsNone(server.web_file("/sub"))


class WebPage(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.addCleanup(setattr, server, "WEB_DIR", server.WEB_DIR)
        server.WEB_DIR = Path(self.folder.name).resolve()
        server.create_pad = FakePad
        server.pin = "123456"
        server.players.clear()
        self.listener = await server.listen()

    async def asyncTearDown(self):
        self.listener.close()
        await self.listener.wait_closed()

    async def get(self, path):
        reader, writer = await asyncio.open_connection("127.0.0.1", server.PORT)
        writer.write(f"GET {path} HTTP/1.1\r\nHost: test\r\n\r\n".encode())
        reply = await reader.read()
        writer.close()
        await writer.wait_closed()
        return reply

    async def test_serves_a_large_file_whole_with_its_type(self):
        body = b"x" * 3_000_000
        (server.WEB_DIR / "app.js").write_bytes(body)
        head, _, received = (await self.get("/app.js")).partition(b"\r\n\r\n")
        self.assertIn(b"200 OK", head)
        self.assertIn(b"text/javascript", head)
        self.assertEqual(received, body)

    async def test_missing_page_is_a_404_and_controllers_still_connect(self):
        self.assertIn(b"404", await self.get("/"))
        async with connect(f"ws://127.0.0.1:{server.PORT}") as ws:
            self.assertIn("link", json.loads(await ws.recv()))


class Sessions(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        server.create_pad = FakePad
        server.pin = "123456"
        server.players.clear()
        self.listener = await server.listen()
        self.url = f"ws://127.0.0.1:{server.PORT}"

    async def asyncTearDown(self):
        self.listener.close()
        await self.listener.wait_closed()

    async def pair(self, ws, phone="phone-a"):
        self.assertIn("link", json.loads(await ws.recv()))
        await ws.send(json.dumps({"pin": "123456", "id": phone}))
        reply = json.loads(await ws.recv())
        self.assertTrue(reply["ok"])
        return reply["player"]

    def pad(self, number):
        return server.players[number - 1].pad

    async def test_state_reaches_pad_and_is_echoed(self):
        async with connect(self.url) as ws:
            self.assertEqual(await self.pair(ws), 1)
            await ws.send("[42, 4096, 100, -100, 0, 0, 255, 0]")
            self.assertEqual(await ws.recv(), "42")
            self.assertEqual(self.pad(1).report.wButtons, 4096)
            self.assertEqual(self.pad(1).report.sThumbLY, -100)
            self.assertEqual(self.pad(1).report.bLeftTrigger, 255)

    async def test_wrong_pin_never_claims_a_pad(self):
        for attempt in ('{"pin":"000000","id":"x"}', '{"pin":5}', "[1]", "garbage"):
            async with connect(self.url) as ws:
                await ws.recv()
                await ws.send(attempt)
                with self.assertRaises(ConnectionClosed) as caught:
                    await ws.recv()
                self.assertEqual(caught.exception.rcvd.code, 4001, attempt)
        self.assertEqual(server.players, [])

    async def test_new_pad_is_nudged_then_left_neutral_before_any_phone_input(self):
        async with connect(self.url) as ws:
            await self.pair(ws)
            self.assertEqual(self.pad(1).updates, 2)
            self.assertEqual(self.pad(1).report.sThumbLX, 0)

    async def test_each_phone_drives_its_own_pad(self):
        async with connect(self.url) as a, connect(self.url) as b:
            self.assertEqual(await self.pair(a, "a"), 1)
            self.assertEqual(await self.pair(b, "b"), 2)
            await a.send("[1, 4096, 111, 0, 0, 0, 0, 0]")
            await b.send("[2, 8192, 222, 0, 0, 0, 0, 0]")
            self.assertEqual(await a.recv(), "1")
            self.assertEqual(await b.recv(), "2")
            self.assertEqual((self.pad(1).report.wButtons, self.pad(1).report.sThumbLX), (4096, 111))
            self.assertEqual((self.pad(2).report.wButtons, self.pad(2).report.sThumbLX), (8192, 222))

    async def test_rumble_reaches_only_the_phone_whose_pad_it_is(self):
        async with connect(self.url) as a, connect(self.url) as b:
            await self.pair(a, "a")
            await self.pair(b, "b")
            self.pad(2).on_rumble(200, 10)
            self.assertEqual(json.loads(await b.recv()), {"r": [200, 10]})
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(a.recv(), 0.1)

    async def test_one_phone_leaving_releases_only_its_own_pad(self):
        async with connect(self.url) as b:
            async with connect(self.url) as a:
                await self.pair(a, "a")
                await self.pair(b, "b")
                await a.send("[1, 4096, 0, 0, 0, 0, 255, 255]")
                await a.recv()
                await b.send("[2, 8192, 0, 0, 0, 0, 0, 0]")
                await b.recv()
            await asyncio.sleep(0.1)
            self.assertEqual(self.pad(1).resets, 1)
            self.assertEqual(self.pad(1).report.wButtons, 0)
            self.assertEqual(self.pad(2).resets, 0)
            self.assertEqual(self.pad(2).report.wButtons, 8192)
            await b.send("[3, 8192, 0, 0, 0, 0, 0, 0]")
            self.assertEqual(await b.recv(), "3")

    async def test_a_phone_that_drops_returns_to_its_own_player_number(self):
        async with connect(self.url) as a:
            await self.pair(a, "a")
        async with connect(self.url) as b:
            self.assertEqual(await self.pair(b, "b"), 2)
            async with connect(self.url) as back:
                self.assertEqual(await self.pair(back, "a"), 1)

    async def test_same_phone_reconnecting_replaces_its_stale_connection(self):
        async with connect(self.url) as stale:
            await self.pair(stale, "a")
            await stale.send("[1, 8192, 0, 0, 0, 0, 0, 0]")
            await stale.recv()
            async with connect(self.url) as fresh:
                self.assertEqual(await self.pair(fresh, "a"), 1)
                self.assertEqual(self.pad(1).report.wButtons, 0, "stale inputs are released")
                await fresh.send("[9, 4096, 0, 0, 0, 0, 0, 0]")
                self.assertEqual(await fresh.recv(), "9")
                with self.assertRaises(ConnectionClosed) as caught:
                    await stale.recv()
                self.assertEqual(caught.exception.rcvd.code, 4002)
                await asyncio.sleep(0.1)
                self.assertEqual(self.pad(1).report.wButtons, 4096, "the stale one leaving doesn't touch them")
                self.assertEqual(len(server.players), 1)

    async def test_fifth_phone_is_refused_and_the_four_keep_working(self):
        phones = [await connect(self.url) for _ in range(4)]
        try:
            for i, ws in enumerate(phones):
                self.assertEqual(await self.pair(ws, f"p{i}"), i + 1)
            async with connect(self.url) as fifth:
                await fifth.recv()
                await fifth.send('{"pin":"123456","id":"p4"}')
                with self.assertRaises(ConnectionClosed) as caught:
                    await fifth.recv()
                self.assertEqual(caught.exception.rcvd.code, 4003)
            self.assertEqual(len(server.players), 4)
            await phones[3].send("[5, 4096, 0, 0, 0, 0, 0, 0]")
            self.assertEqual(await phones[3].recv(), "5")
        finally:
            for ws in phones:
                await ws.close()

    async def test_when_full_a_new_phone_takes_the_slot_of_one_that_left(self):
        phones = [await connect(self.url) for _ in range(4)]
        try:
            for i, ws in enumerate(phones):
                await self.pair(ws, f"p{i}")
            await phones[1].close()
            await asyncio.sleep(0.1)
            async with connect(self.url) as newcomer:
                self.assertEqual(await self.pair(newcomer, "new"), 2)
        finally:
            for ws in phones:
                await ws.close()

    async def test_a_free_slot_is_used_before_taking_one_from_a_phone_that_left(self):
        async with connect(self.url) as a:
            await self.pair(a, "a")
        async with connect(self.url) as b:
            self.assertEqual(await self.pair(b, "b"), 2)

    async def test_bad_frame_closes_and_releases(self):
        async with connect(self.url) as ws:
            await self.pair(ws)
            await ws.send("[1, 4096, 0, 0, 0, 0, 255, 255]")
            await ws.recv()
            await ws.send("not json")
            with self.assertRaises(ConnectionClosed):
                await ws.recv()
        await asyncio.sleep(0.1)
        self.assertEqual(self.pad(1).resets, 1)

    async def test_phone_without_an_id_still_plays(self):
        async with connect(self.url) as ws:
            await ws.recv()
            await ws.send('{"pin":"123456"}')
            self.assertEqual(json.loads(await ws.recv())["player"], 1)
            self.assertIsNotNone(server.players[0].owner)

    async def test_unpaired_probe_can_leave_quietly(self):
        async with connect(self.url) as ws:
            await ws.recv()
        await asyncio.sleep(0.05)
        self.assertEqual(server.players, [])


if __name__ == "__main__":
    unittest.main()
