// Drives the real browser build in headless Chrome with real touch events, against a stand-in laptop.
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFile, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { BTN, LAYOUTS, placeControls } from './core.js';

// shortcut: ws only arrives through Expo's dependencies, add it as a devDependency if Expo drops it.
const { Server: WebSocketServer } = createRequire(import.meta.url)('ws');

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((path) => path && existsSync(path));

const TEST_TEXT = 'Rest both thumbs';
const RETRY_TEXT = 'Use both thumbs';
const REVIEW_TEXT = 'Buttons placed';
const ADJUST_TEXT = 'Drag any control';
const PS5 = LAYOUTS.ps5;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let work;
let server;
let chrome;
let cdp;
let url;
const laptop = { buttons: 0, seen: new Set() };

function startLaptop(webDir) {
  server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    readFile(join(webDir, path === '/' ? 'index.html' : path), (err, data) => {
      res.writeHead(err ? 404 : 200, { 'Content-Type': TYPES[extname(path)] ?? 'text/html' });
      res.end(data);
    });
  });
  new WebSocketServer({ server }).on('connection', (ws) => {
    ws.send(JSON.stringify({ link: 'Wi-Fi' }));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.pin) ws.send(JSON.stringify({ ok: true, player: 1 }));
      else if (Array.isArray(message)) {
        laptop.buttons = message[1];
        laptop.seen.add(message[1]);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function connectChrome(userDataDir) {
  chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const debugUrl = await new Promise((resolve, reject) => {
    let log = '';
    chrome.stderr.on('data', (chunk) => {
      log += chunk;
      const found = /ws:\/\/([^/\s]+)\//.exec(log);
      if (found) resolve(found[1]);
    });
    chrome.on('exit', () => reject(new Error(`Chrome exited: ${log}`)));
  });
  const targets = await (await fetch(`http://${debugUrl}/json/list`)).json();
  const socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => { socket.onopen = resolve; });
  const pending = new Map();
  let nextId = 0;
  socket.onmessage = ({ data }) => {
    const { id, result, error } = JSON.parse(data);
    if (!pending.has(id)) return;
    if (error) pending.get(id).reject(new Error(error.message));
    else pending.get(id).resolve(result);
    pending.delete(id);
  };
  cdp = {
    socket,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    }),
  };
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 926, height: 428, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 },
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
const shows = (text) => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
const stored = (key) => evaluate(`localStorage.getItem(${JSON.stringify(key)})`);
const savedPs5 = async () => JSON.parse(await stored('layout.ps5'));

async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await wait(50);
  }
  assert.fail(`timed out waiting for ${what}. On screen: ${await evaluate('document.body.innerText')}`);
}

const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })),
});

// Thumbs rest at the given points, sweep up, down and sideways together, then lift.
async function thumbSweep(rests, reach = 70) {
  await touch('touchStart', rests);
  await wait(30);
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0], [0, 0]]) {
    for (let i = 1; i <= 4; i++) {
      await touch('touchMove', rests.map((p) => ({ x: p.x + (dx * reach * i) / 4, y: p.y + (dy * reach * i) / 4 })));
      await wait(15);
    }
  }
  await touch('touchEnd', []);
  await wait(60);
}

// One finger, in steps longer than the browser's touch slop, which swallows the first bit of movement.
async function drag(from, to) {
  await touch('touchStart', [from]);
  await wait(20);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 }]);
    await wait(20);
  }
  await touch('touchEnd', []);
  await wait(40);
}

async function tap(point) {
  await touch('touchStart', [point]);
  await wait(60);
  await touch('touchEnd', []);
  await wait(60);
}

async function tapText(text) {
  const point = await evaluate(`(() => {
    const el = [...document.querySelectorAll('*')].find((e) => !e.children.length && e.textContent.startsWith(${JSON.stringify(text)}));
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  assert.ok(point, `"${text}" is on screen`);
  await tap(point);
}

async function open() {
  // Going to the same URL only changes the hash, so later visits have to reload for real. The mark
  // tells the old page from the new one, which is what a user's refresh gives too.
  const firstVisit = (await evaluate('location.href')) === 'about:blank';
  await evaluate('window.oldPage = true');
  await cdp.send(firstVisit ? 'Page.navigate' : 'Page.reload', firstVisit ? { url } : {});
  await until(async () => !(await evaluate('window.oldPage')) && shows('P1'), 'the phone to pair');
}

// Presses at a spot and reports everything the laptop received meanwhile.
async function pressAt(point) {
  laptop.seen.clear();
  await tap(point);
  await until(() => laptop.buttons === 0, 'the release to reach the laptop');
  return [...laptop.seen];
}

const THUMBS = [{ x: 240, y: 290 }, { x: 680, y: 300 }];

before(async () => {
  if (!CHROME) return;
  work = mkdtempSync(join(tmpdir(), 'phone-pad-e2e-'));
  const webDir = join(work, 'web');
  execSync(`npx expo export --platform web --output-dir "${webDir}"`, { cwd: import.meta.dirname, stdio: 'ignore' });
  const port = await startLaptop(webDir);
  url = `http://127.0.0.1:${port}/#code=123456`;
  await connectChrome(join(work, 'profile'));
});

after(async () => {
  cdp?.socket.close();
  chrome?.kill();
  server?.closeAllConnections();
  server?.close();
  await wait(500); // Chrome holds its profile open for a moment after being killed
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('thumb calibration, first login to redoing it', { skip: CHROME ? false : 'no Chrome or Edge found; set CHROME_PATH' }, async (t) => {
  await t.test('starts by itself on first login and saves nothing yet', async () => {
    await open();
    await until(() => shows(TEST_TEXT), 'the thumb test');
    assert.equal(await stored('layout.ps5'), null);
  });

  await t.test('one thumb is not enough, and asks again', async () => {
    await thumbSweep([THUMBS[0]]);
    await until(() => shows(RETRY_TEXT), 'the retry message');
    assert.equal(await shows(REVIEW_TEXT), false);
  });

  await t.test('the first touch on the controller goes full screen', async () => {
    await until(() => evaluate('Boolean(document.fullscreenElement)'), 'full screen');
  });

  await t.test('touches during the test send nothing to the laptop', async () => {
    laptop.seen.clear();
    await thumbSweep([{ x: PS5.a.x, y: PS5.a.y }]); // on the X button
    await wait(1100); // long enough for a heartbeat
    assert.deepEqual([...laptop.seen].filter(Boolean), []);
  });

  await t.test('two sweeping thumbs place the buttons, and nothing is saved until Done', async () => {
    await thumbSweep(THUMBS);
    await until(() => shows(REVIEW_TEXT), 'the result');
    assert.equal(await stored('layout.ps5'), null);
    await tapText('Test again');
    await until(() => shows(TEST_TEXT), 'the thumb test again');
    await thumbSweep(THUMBS);
    await until(() => shows(REVIEW_TEXT), 'the result');
    await tapText('Done');
    await until(async () => !(await shows(REVIEW_TEXT)), 'the result to close');

    const saved = await savedPs5();
    assert.ok(saved.ls[0] > 20, 'left stick moved toward the left thumb');
    assert.ok(saved.face[0] < -20, 'face buttons moved toward the right thumb');
    assert.equal(saved.guide, undefined, 'menu buttons stay put');
    assert.equal(saved.lt, undefined, 'triggers stay put');
  });

  await t.test('after a reload it does not ask again and plays from the fitted spots', async () => {
    await open();
    await wait(300);
    assert.equal(await shows(TEST_TEXT), false);
    const placed = placeControls(PS5, await savedPs5());
    const atNewSpot = await pressAt(placed.b);
    assert.ok(atNewSpot.includes(BTN.B), `Circle presses at its new spot; laptop got [${atNewSpot}]`);
    // A spot inside Circle's old touch zone, on the far side from where it moved.
    const moved = Math.hypot(placed.b.x - PS5.b.x, placed.b.y - PS5.b.y);
    const oldSide = {
      x: PS5.b.x + ((PS5.b.x - placed.b.x) / moved) * 25,
      y: PS5.b.y + ((PS5.b.y - placed.b.y) / moved) * 25,
    };
    assert.ok(moved + 25 > PS5.b.hit, 'the spot is outside its new touch zone');
    assert.ok(!(await pressAt(oldSide)).includes(BTN.B), 'and not at its old one');
  });

  await t.test('it can be redone from the status, cancelled, or set back to defaults', async () => {
    const fitted = await savedPs5();
    await tapText('P1');
    await tapText('Redo thumb test');
    await until(() => shows(TEST_TEXT), 'the thumb test');
    await tapText('Cancel');
    await until(async () => !(await shows(TEST_TEXT)), 'the test to close');
    assert.deepEqual(await savedPs5(), fitted);

    await tapText('P1');
    await tapText('Redo thumb test');
    await until(() => shows(TEST_TEXT), 'the thumb test');
    await tapText('Use defaults');
    await until(async () => !(await shows(TEST_TEXT)), 'the test to close');
    assert.deepEqual(await savedPs5(), {});
    assert.ok((await pressAt(PS5.b)).includes(BTN.B), 'Circle is back at its default spot');
  });

  await t.test('Adjust manually drags controls, sends nothing, and can be cancelled', async () => {
    await tapText('P1');
    await tapText('Adjust manually');
    await until(() => shows(ADJUST_TEXT), 'the adjust screen');
    laptop.seen.clear();
    await drag(PS5.ls, { x: PS5.ls.x + 30, y: PS5.ls.y - 14 });
    assert.deepEqual([...laptop.seen].filter(Boolean), [], 'nothing reaches the laptop');
    await tapText('Cancel');
    await until(async () => !(await shows(ADJUST_TEXT)), 'the adjust screen to close');
    assert.deepEqual(await savedPs5(), {});
    assert.ok((await pressAt(PS5.guide)).includes(BTN.GUIDE), 'the controller works again');
  });

  await t.test('Adjust manually saves what was dragged, stops at obstacles, and survives a reload', async () => {
    await tapText('P1');
    await tapText('Adjust manually');
    await until(() => shows(ADJUST_TEXT), 'the adjust screen');
    await drag(PS5.guide, { x: PS5.guide.x, y: PS5.guide.y + 70 }); // into the status pill: stops short
    await drag(PS5.guide, { x: PS5.guide.x - 123, y: PS5.guide.y });
    await drag(PS5.ls, { x: PS5.ls.x + 30, y: PS5.ls.y - 14 });
    await drag(PS5.lb, { x: PS5.lb.x, y: PS5.lb.y }); // a touch that doesn't move changes nothing
    await tapText('Done');
    await until(async () => !(await shows(ADJUST_TEXT)), 'the adjust screen to close');

    const saved = await savedPs5();
    assert.deepEqual(saved.ls, [30, -14]);
    assert.equal(saved.guide[0], -123);
    assert.ok(saved.guide[1] >= 0 && saved.guide[1] <= 8, 'PS stays out of the status pill');
    assert.equal(saved.lb, undefined);

    await open();
    await wait(300);
    assert.equal(await shows(ADJUST_TEXT), false);
    assert.ok((await pressAt({ x: PS5.guide.x - 123, y: PS5.guide.y })).includes(BTN.GUIDE), 'PS presses at its new spot');
    assert.ok(!(await pressAt(PS5.guide)).includes(BTN.GUIDE), 'and not at its old one');
  });

  await t.test('Reset in Adjust manually goes back to the defaults', async () => {
    await tapText('P1');
    await tapText('Adjust manually');
    await until(() => shows(ADJUST_TEXT), 'the adjust screen');
    await tapText('Reset');
    await tapText('Done');
    await until(async () => !(await shows(ADJUST_TEXT)), 'the adjust screen to close');
    assert.deepEqual(await savedPs5(), {});
  });

  await t.test('settings can leave and re-enter full screen, and leaving stays left', async () => {
    const isFull = () => evaluate('Boolean(document.fullscreenElement)');
    await tap(PS5.guide); // the visit's first touch: a reload dropped full screen, and this brings it back
    await until(isFull, 'full screen');
    await tapText('P1');
    await tapText('Exit full screen');
    await until(async () => !(await isFull()), 'leaving full screen');
    await until(() => shows('Full screen'), 'the button to change');
    await tapText('Back to controller');
    await tap(PS5.guide);
    await wait(200);
    assert.equal(await isFull(), false, 'pressing a control does not force it back on');
    await tapText('P1');
    await tapText('Full screen');
    await until(isFull, 'full screen again');
    await until(() => shows('Exit full screen'), 'the button to change');
    await tapText('Back to controller');
  });

  await t.test('each controller style is tested separately', async () => {
    await tapText('P1');
    await tapText('Xbox');
    await tapText('Back to controller');
    await until(() => shows(TEST_TEXT), 'the thumb test for Xbox');
    assert.equal(await stored('layout.xbox'), null);
    await thumbSweep(THUMBS);
    await until(() => shows(REVIEW_TEXT), 'the result');
    await tapText('Done');
    await until(async () => !(await shows(REVIEW_TEXT)), 'the result to close');
    assert.ok(JSON.parse(await stored('layout.xbox')).ls);
    await tapText('P1');
    await until(() => shows('Adjust manually'), 'the settings page');
    await tapText('Back to controller');
    assert.deepEqual(await savedPs5(), {}, 'PS5 is untouched');
  });

  await t.test('damaged saved positions ask again instead of breaking the controller', async () => {
    await evaluate(`localStorage.setItem('layout.xbox', 'not json')`);
    await open();
    await until(() => shows(TEST_TEXT), 'the thumb test');
  });
});
