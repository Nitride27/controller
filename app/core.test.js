import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BTN, H, LAYOUTS, NEUTRAL, W, PIVOT, calibrateFromThumbs, createController, createThumbTest, groupAt, hapticsFor, moveGroup, placeControls, readOffsets, rumblePattern, sameOutput, wireButtons } from './core.js';
import { findBestLink } from './link.js';

const LAYOUT = LAYOUTS.ps5;

const touch = (id, c, dx = 0, dy = 0) => ({ id, x: c.x + dx, y: c.y + dy });

test('multi-touch: stick, button and trigger work at once', () => {
  const update = createController();
  update([touch(1, LAYOUT.ls)], 0);
  const s = update([
    touch(1, LAYOUT.ls, 46, 0),
    touch(2, LAYOUT.a),
    { id: 3, x: LAYOUT.lt.x + 10, y: LAYOUT.lt.y + LAYOUT.lt.h - 2 },
  ], 10);
  assert.equal(s.lx, 32767);
  assert.equal(s.buttons, BTN.A);
  assert.equal(s.lt, 255);
});

test('releasing everything returns to neutral', () => {
  const update = createController();
  update([touch(1, LAYOUT.ls), touch(2, LAYOUT.a)], 0);
  update([touch(1, LAYOUT.ls, 40, 40), touch(2, LAYOUT.a)], 10);
  assert.ok(sameOutput(update([], 20), NEUTRAL));
});

test('stick up is positive for XInput and has a deadzone', () => {
  const update = createController();
  update([touch(1, LAYOUT.rs)], 0);
  assert.ok(update([touch(1, LAYOUT.rs, 0, -46)], 1).ry > 32000);
  assert.equal(update([touch(1, LAYOUT.rs, 1, 1)], 2).rx, 0);
});

test('stick re-centres under the landing point', () => {
  const update = createController();
  const s = update([touch(1, LAYOUT.ls, 40, 40)], 0);
  assert.equal(s.lx, 0);
  assert.equal(s.ly + 0, 0); // -0 is fine: JSON sends it as 0
});

test('a thumb sliding off the stick keeps controlling it', () => {
  const update = createController();
  update([touch(1, LAYOUT.ls)], 0);
  const s = update([touch(1, LAYOUT.a)], 10);
  assert.ok(s.lx > 32000);
  assert.equal(s.buttons, 0);
});

test('a thumb can roll between buttons, and a midpoint presses both', () => {
  const update = createController();
  assert.equal(update([touch(1, LAYOUT.a)], 0).buttons, BTN.A);
  assert.equal(update([touch(1, LAYOUT.b)], 10).buttons, BTN.B);
  const mid = { id: 1, x: (LAYOUT.a.x + LAYOUT.b.x) / 2, y: (LAYOUT.a.y + LAYOUT.b.y) / 2 };
  assert.equal(update([mid], 20).buttons, BTN.A | BTN.B);
});

test('d-pad: cardinals, diagonals and the dead pivot', () => {
  const press = (dx, dy) => createController()([touch(1, LAYOUT.dpad, dx, dy)], 0).buttons;
  assert.equal(press(50, 0), BTN.RIGHT);
  assert.equal(press(0, -50), BTN.UP);
  assert.equal(press(-50, 10), BTN.LEFT);
  assert.equal(press(40, 40), BTN.RIGHT | BTN.DOWN);
  assert.equal(press(2, 2), 0);
});

test('double tap and hold clicks the stick; re-grabbing a held stick does not', () => {
  const tapped = createController();
  tapped([touch(1, LAYOUT.ls)], 0);
  tapped([], 100);
  assert.equal(tapped([touch(2, LAYOUT.ls)], 200).buttons, BTN.L3);
  assert.equal(tapped([touch(2, LAYOUT.ls)], 900).buttons, BTN.L3);
  assert.equal(tapped([], 950).buttons, 0);

  const held = createController();
  held([touch(1, LAYOUT.ls)], 0);
  held([touch(1, LAYOUT.ls)], 900);
  held([], 1000);
  assert.equal(held([touch(2, LAYOUT.ls)], 1100).buttons, 0);
});

test('touchpad presses as its own control on screen and sends BACK to the laptop', () => {
  const { x, y, w, h } = LAYOUT.touchpad;
  const s = createController()([{ id: 1, x: x + w / 2, y: y + h / 2 }], 0);
  assert.equal(s.buttons, BTN.TOUCHPAD);
  assert.equal(wireButtons(s.buttons), BTN.BACK);
  assert.equal(wireButtons(BTN.TOUCHPAD | BTN.A), BTN.BACK | BTN.A);
  assert.equal(wireButtons(BTN.A), BTN.A);
  assert.ok(hapticsFor(NEUTRAL, s).has('light'));
});

test('Create, Options and PS do not press the touchpad or their neighbours', () => {
  const press = (c) => createController()([touch(1, c)], 0).buttons;
  assert.equal(press(LAYOUT.back), BTN.BACK);
  assert.equal(press(LAYOUT.start), BTN.START);
  assert.equal(press(LAYOUT.guide), BTN.GUIDE);
});

test('trigger depth follows the slide and always registers', () => {
  const update = createController();
  const top = update([{ id: 1, x: LAYOUT.rt.x + 5, y: LAYOUT.rt.y }], 0).rt;
  const bottom = update([{ id: 1, x: LAYOUT.rt.x + 5, y: LAYOUT.rt.y + LAYOUT.rt.h }], 1).rt;
  assert.ok(top >= 30, 'above the usual XInput threshold of 30');
  assert.equal(bottom, 255);
});

for (const [skin, L] of Object.entries(LAYOUTS)) {
  test(`${skin}: every control is on screen and clear of the home indicator`, () => {
    for (const [name, c] of Object.entries(L)) {
      const box = c.w ? [c.x, c.y, c.x + c.w, c.y + c.h] : [c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r];
      assert.ok(box[0] >= 47 && box[2] <= W - 47, `${name} clears the notch side`);
      assert.ok(box[1] >= 0 && box[3] <= H - 20, `${name} clears the home indicator`);
    }
  });

  test(`${skin}: touch targets do not overlap across groups, and thumbs can reach everything`, () => {
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    assert.ok(dist(L.ls, L.dpad) > L.ls.hit + L.dpad.hit);
    assert.ok(dist(L.rs, L.a) > L.rs.hit + L.a.hit);
    for (const name of ['back', 'guide', 'start']) {
      assert.ok(dist(L.ls, L[name]) > L.ls.hit + L[name].hit, `stick clear of ${name}`);
      assert.ok(dist(L.dpad, L[name]) > L.dpad.hit + L[name].hit, `d-pad clear of ${name}`);
    }
    const mm = (pt) => pt / 5.8;
    const left = [dist(L.ls, PIVOT.left), dist(L.dpad, PIVOT.left)].map(mm);
    assert.ok(Math.max(...left) < 48);
    assert.ok(Math.min(...left) < 33);
    assert.ok(mm(dist(L.rs, PIVOT.right)) < 48);
    for (const name of ['a', 'b', 'x', 'y']) assert.ok(mm(dist(L[name], PIVOT.right)) < 42, name);
    assert.ok(L.y.y - L.y.r >= L.rt.y + L.rt.h, 'top face button stays clear of the right trigger');
  });

  test(`${skin}: stick, d-pad and every button respond at their own position`, () => {
    const press = (c) => createController(L)([touch(1, c)], 0).buttons;
    for (const [name, bit] of [['a', BTN.A], ['b', BTN.B], ['x', BTN.X], ['y', BTN.Y],
      ['back', BTN.BACK], ['guide', BTN.GUIDE], ['start', BTN.START]]) {
      assert.equal(press(L[name]), bit, name);
    }
    assert.equal(press({ x: L.dpad.x, y: L.dpad.y - 50 }), BTN.UP);
    const update = createController(L);
    update([touch(1, L.ls)], 0);
    assert.ok(update([touch(1, L.ls, 46, 0)], 1).lx > 32000);
  });
}

for (const style of ['ps5', 'xbox']) {
  test(`${style} face buttons form a diamond`, () => {
    const { a, b, x, y } = LAYOUTS[style];
    const center = { x: (x.x + b.x) / 2, y: (x.y + b.y) / 2 };
    for (const c of [a, b, x, y]) assert.ok(Math.abs(Math.hypot(c.x - center.x, c.y - center.y) - 54) < 0.01);
    assert.ok(y.y < x.y && y.y < b.y && a.y > x.y && a.y > b.y, 'top button above, bottom button below');
    assert.ok(x.x < a.x && a.x < b.x, 'left and right either side');
  });
}

test('the two styles swap the left stick and d-pad, and only PS5 has a touchpad', () => {
  assert.deepEqual([LAYOUTS.ps5.ls.x, LAYOUTS.ps5.ls.y], [LAYOUTS.xbox.dpad.x, LAYOUTS.xbox.dpad.y]);
  assert.deepEqual([LAYOUTS.xbox.ls.x, LAYOUTS.xbox.ls.y], [LAYOUTS.ps5.dpad.x, LAYOUTS.ps5.dpad.y]);
  assert.equal(LAYOUTS.xbox.touchpad, undefined);
  const spot = { x: 463, y: 80 }; // the PS5 touchpad, empty shell in Xbox style
  assert.equal(createController(LAYOUTS.xbox)([touch(1, spot)], 0).buttons, 0);
  assert.equal(createController(LAYOUTS.ps5)([touch(1, spot)], 0).buttons, BTN.TOUCHPAD);
});

test('calibration: a moved control presses at its new spot and no longer at its old one', () => {
  const offsets = moveGroup(LAYOUT, {}, 'guide', [0, 40]);
  assert.deepEqual(offsets.guide, [0, 40]);
  const placed = placeControls(LAYOUT, offsets);
  assert.equal(createController(placed)([touch(1, placed.guide)], 0).buttons, BTN.GUIDE);
  assert.equal(createController(placed)([touch(1, LAYOUT.guide)], 0).buttons, 0);
});

test('calibration: the face buttons move together and keep their diamond', () => {
  const placed = placeControls(LAYOUT, moveGroup(LAYOUT, {}, 'face', [-10, 0]));
  for (const name of ['a', 'b', 'x', 'y']) {
    assert.equal(placed[name].x, LAYOUT[name].x - 10);
    assert.equal(placed[name].y, LAYOUT[name].y);
  }
});

test('manual adjust: a touch picks up the control under it, at its current spot', () => {
  const placed = placeControls(LAYOUT, { face: [-10, 0] });
  assert.equal(groupAt(placed, placed.y.x, placed.y.y), 'face');
  assert.equal(groupAt(placed, LAYOUT.ls.x, LAYOUT.ls.y), 'ls');
  assert.equal(groupAt(placed, LAYOUT.touchpad.x + 5, LAYOUT.touchpad.y + 5), 'touchpad');
  assert.equal(groupAt(placed, 463, 400), null);
  assert.equal(groupAt(LAYOUTS.xbox, 463, 80), null, 'Xbox has no touchpad');
});

const sweep = (rest, dx = 80, dy = 80) => [rest, { x: rest.x + dx, y: rest.y }, { x: rest.x - dx, y: rest.y },
  { x: rest.x, y: rest.y - dy }, { x: rest.x, y: rest.y + dy }];

test('thumb test: reports each thumb once every finger lifts, with first contact first', () => {
  const update = createThumbTest();
  assert.equal(update([{ id: 1, x: 200, y: 250 }, { id: 2, x: 700, y: 260 }]), null);
  assert.equal(update([{ id: 1, x: 240, y: 200 }, { id: 2, x: 700, y: 260 }, { id: 3, x: 100, y: 100 }]), null);
  const thumbs = update([]);
  assert.deepEqual(thumbs.left, [{ x: 200, y: 250 }, { x: 240, y: 200 }], 'the extra finger is not the left thumb');
  assert.equal(thumbs.right.length, 2);
  assert.equal(createThumbTest()([]), null, 'nothing has touched yet');
});

test('thumb test: needs two thumbs that actually swept', () => {
  const still = [{ x: 200, y: 250 }, { x: 205, y: 252 }];
  const moving = sweep({ x: 700, y: 260 });
  assert.equal(calibrateFromThumbs(LAYOUT, { left: still, right: moving }), null);
  assert.equal(calibrateFromThumbs(LAYOUT, { left: [], right: moving }), null);
  assert.ok(calibrateFromThumbs(LAYOUT, { left: sweep({ x: 200, y: 250 }), right: moving }));
});

test('thumb test: controls follow where the thumbs rest; shoulders and menus stay', () => {
  const home = calibrateFromThumbs(LAYOUT, { left: sweep({ x: 184, y: 258 }, 120, 120), right: sweep({ x: 745, y: 261 }, 120, 120) });
  assert.ok(Math.abs(home.ls[0]) <= 2 && Math.abs(home.dpad[1]) <= 2, 'thumbs at the default rest barely move anything');
  const inward = calibrateFromThumbs(LAYOUT, { left: sweep({ x: 215, y: 258 }, 120, 120), right: sweep({ x: 720, y: 261 }, 120, 120) });
  assert.ok(inward.ls[0] > 20 && inward.dpad[0] > 20, 'left controls follow the left thumb inward');
  assert.ok(inward.rs[0] < -15, 'right stick follows the right thumb inward');
  for (const name of ['lt', 'rt', 'lb', 'rb', 'back', 'guide', 'start', 'touchpad']) assert.equal(inward[name], undefined, name);
});

test('thumb test: a short reach pulls controls closer to the thumb', () => {
  const rest = { x: 184, y: 258 };
  const far = placeControls(LAYOUT, calibrateFromThumbs(LAYOUT, { left: sweep(rest, 200, 200), right: sweep({ x: 745, y: 261 }) }));
  const near = placeControls(LAYOUT, calibrateFromThumbs(LAYOUT, { left: sweep(rest, 45, 45), right: sweep({ x: 745, y: 261 }) }));
  const distance = (c) => Math.hypot(c.x - rest.x, c.y - rest.y);
  assert.ok(distance(near.dpad) <= distance(far.dpad));
  assert.ok(distance(near.dpad) <= 91, 'within the smallest reach the layout allows');
});

for (const [skin, L] of Object.entries(LAYOUTS)) {
  test(`${skin}: any thumbs give a playable layout, on screen and with nothing overlapping`, () => {
    let seed = 7;
    const random = (max) => { seed = (seed * 16807) % 2147483647; return seed % max; };
    const [statusTop, panelTop] = skin === 'ps5' ? [228, 274] : [22, 182];
    const keepOut = [{ x: 363, y: statusTop, w: 200, h: 32 }, { x: 353, y: panelTop, w: 220, h: 100 }];
    const inKeepOut = (c) => keepOut.some((b) => Math.hypot(
      Math.max(b.x - c.x, 0, c.x - b.x - b.w),
      Math.max(b.y - c.y, 0, c.y - b.y - b.h),
    ) < c.r);
    for (let run = 0; run < 200; run++) {
      const thumbs = {
        left: sweep({ x: random(W / 2), y: random(H) }, 40 + random(200), 40 + random(200)),
        right: sweep({ x: W / 2 + random(W / 2), y: random(H) }, 40 + random(200), 40 + random(200)),
      };
      const placed = placeControls(L, calibrateFromThumbs(L, thumbs, keepOut));
      for (const name of ['ls', 'rs', 'dpad', 'a', 'b', 'x', 'y']) {
        const c = placed[name];
        assert.ok(c.x - c.r >= 47 && c.x + c.r <= W - 47 && c.y - c.r >= 0 && c.y + c.r <= H - 20, `${name} on screen, run ${run}`);
        assert.ok(!inKeepOut(c), `${name} clear of the status pill, run ${run}`);
      }
      assert.ok(Math.hypot(placed.ls.x - placed.dpad.x, placed.ls.y - placed.dpad.y) >= 160, `left side apart, run ${run}`);
      for (const name of ['a', 'b', 'x', 'y']) {
        assert.ok(Math.hypot(placed.rs.x - placed[name].x, placed.rs.y - placed[name].y) >= 117, `${name} clear of the stick, run ${run}`);
      }
      assert.equal(createController(placed)([{ id: 1, x: placed.a.x, y: placed.a.y }], 0).buttons, BTN.A, `A presses, run ${run}`);
    }
  });
}

test('calibration: controls stay on screen, clear of the notch and home indicator', () => {
  for (const [group, control, target] of [['rs', 'rs', [9999, 9999]], ['ls', 'ls', [-9999, 9999]]]) {
    const c = placeControls(LAYOUT, moveGroup(LAYOUT, {}, group, target))[control];
    assert.ok(c.x - c.r >= 47 && c.x + c.r <= W - 47, group);
    assert.ok(c.y + c.r <= H - 20, group);
  }
});

test('calibration: a control cannot land on another, but slides along it', () => {
  const onto = [LAYOUT.ls.x - LAYOUT.guide.x, LAYOUT.ls.y - LAYOUT.guide.y];
  const { guide, ls } = placeControls(LAYOUT, moveGroup(LAYOUT, {}, 'guide', onto));
  assert.ok(Math.hypot(guide.x - ls.x, guide.y - ls.y) >= ls.hit + guide.r, 'guide stays out of the stick');

  const free = moveGroup(LAYOUT, {}, 'rs', [-300, -2]);
  assert.deepEqual(free.rs, [-300, -2]);
  const keepOut = [{ x: 363, y: 228, w: 200, h: 200 }];
  assert.deepEqual(moveGroup(LAYOUT, {}, 'rs', [-300, -2], keepOut).rs, [0, -2], 'blocked sideways, free upward');
});

test('calibration: the defaults that already touch can still be dragged apart', () => {
  assert.deepEqual(moveGroup(LAYOUT, {}, 'face', [0, 10]).face, [0, 10]);
  assert.deepEqual(moveGroup(LAYOUT, {}, 'rt', [0, -10]).rt, [0, -10]);
});

test('calibration: saved offsets survive a round trip and damage reads as not calibrated', () => {
  const offsets = moveGroup(LAYOUT, {}, 'guide', [0, 40]);
  assert.deepEqual(readOffsets(JSON.stringify(offsets), LAYOUT), offsets);
  assert.deepEqual(readOffsets('{}', LAYOUT), {});
  assert.equal(readOffsets(null, LAYOUT), null);
  assert.equal(readOffsets('not json', LAYOUT), null);
  assert.equal(readOffsets('{"ls":[1,"2"]}', LAYOUT), null);
  assert.ok(placeControls(LAYOUT, readOffsets('{"ls":[99999,0]}', LAYOUT)).ls.x + LAYOUT.ls.r <= W - 47);
  assert.equal(readOffsets('{"touchpad":[1,1]}', LAYOUTS.xbox).touchpad, undefined);
});

test('haptics: firm press, soft release, heavy on full trigger', () => {
  const pressed = { ...NEUTRAL, buttons: BTN.A };
  assert.deepEqual([...hapticsFor(NEUTRAL, pressed)], ['medium']);
  assert.deepEqual([...hapticsFor(pressed, NEUTRAL)], ['soft']);
  assert.ok(hapticsFor({ ...NEUTRAL, lt: 200 }, { ...NEUTRAL, lt: 255 }).has('heavy'));
  assert.ok(hapticsFor({ ...NEUTRAL, rt: 60 }, { ...NEUTRAL, rt: 70 }).has('selection'));
  assert.equal(hapticsFor(pressed, pressed).size, 0);
});

test('stick rim ticks once despite jitter at the edge', () => {
  const update = createController();
  update([touch(1, LAYOUT.ls)], 0);
  let prev = NEUTRAL;
  let ticks = 0;
  for (const dx of [20, 46, 42, 45, 41, 46]) {
    const next = update([touch(1, LAYOUT.ls, dx, 0)], 1);
    if (hapticsFor(prev, next).has('light')) ticks++;
    prev = next;
  }
  assert.equal(ticks, 1);
});

test('rumble: stops at zero and gets stronger with the large motor', () => {
  assert.equal(rumblePattern(0, 0), null);
  assert.equal(rumblePattern(255, 0).style, 'heavy');
  assert.equal(rumblePattern(0, 40).style, 'light');
  assert.ok(rumblePattern(255, 0).everyMs < rumblePattern(50, 0).everyMs);
});

class FakeWS {
  static all = [];
  closed = false;
  constructor(url) { this.url = url; FakeWS.all.push(this); }
  close() { this.closed = true; }
  hello(link) { this.onmessage?.({ data: JSON.stringify({ link }) }); }
}

test('link race: USB wins at once and the losers are closed', async () => {
  FakeWS.all = [];
  const found = findBestLink(['a', 'b', 'a', null], 1, { WS: FakeWS, settleMs: 5000 });
  assert.equal(FakeWS.all.length, 2);
  FakeWS.all[0].hello('Wi-Fi');
  FakeWS.all[1].hello('USB');
  const best = await found;
  assert.equal(best.link, 'USB');
  assert.equal(best.ws, FakeWS.all[1]);
  assert.ok(FakeWS.all[0].closed);
  assert.ok(!FakeWS.all[1].closed);
});

test('link race: Wi-Fi beats Bluetooth regardless of who answers first', async () => {
  FakeWS.all = [];
  const found = findBestLink(['a', 'b'], 1, { WS: FakeWS, settleMs: 10 });
  FakeWS.all[0].hello('Bluetooth');
  FakeWS.all[1].hello('Wi-Fi');
  assert.equal((await found).link, 'Wi-Fi');
});

test('link race: nothing answers, resolves null and closes everything', async () => {
  FakeWS.all = [];
  assert.equal(await findBestLink(['a'], 1, { WS: FakeWS, timeoutMs: 5 }), null);
  assert.ok(FakeWS.all[0].closed);
});
