// Pure controller logic: layout, touches -> pad state, pad state -> haptics. No React here.

export const W = 926; // iPhone 13 Pro Max in landscape, in points
export const H = 428;
const mirror = (x) => W - x;

// Either style, Windows sees an Xbox 360 pad, the most widely supported kind. In PS5 style:
// cross=A, circle=B, square=X, triangle=Y, L1=LB, R1=RB, L2=LT, R2=RT, Create=BACK, Options=START, PS=GUIDE.
export const BTN = {
  UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008, START: 0x0010, BACK: 0x0020,
  L3: 0x0040, R3: 0x0080, LB: 0x0100, RB: 0x0200, GUIDE: 0x0400,
  A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000,
  TOUCHPAD: 0x10000, // on-screen state only: an Xbox pad has no touchpad, so it sends BACK
};

export const wireButtons = (buttons) => (buttons & BTN.TOUCHPAD ? (buttons & 0xffff) | BTN.BACK : buttons);

// Thumb pivots sit just off the side edges. 1 mm is about 5.8 pt on this screen. The D-pad and
// face buttons land about 31 mm out and the sticks about 46 mm; 61 mm felt like a stretch in use.
export const PIVOT = { left: { x: -25, y: 260 }, right: { x: W + 25, y: 260 } };

// Clockwise tilt so the diamond follows the right thumb's sweep instead of the screen's grid.
const TILT = (15 * Math.PI) / 180;
const FACE_CENTER = { x: mirror(129), y: 188 };
const FACE_OFFSET = 54;
const faceButton = (center, dx, dy) => ({
  x: center.x + dx * Math.cos(TILT) - dy * Math.sin(TILT),
  y: center.y + dx * Math.sin(TILT) + dy * Math.cos(TILT),
  r: 29,
  hit: 43, // overlaps its neighbours at the midpoint, so one thumb can roll onto two buttons
});
const diamond = (dx, dy) => faceButton(FACE_CENTER, dx * FACE_OFFSET, dy * FACE_OFFSET);

const UPPER_LEFT = { x: 136, y: 182 };
const LOWER_LEFT = { x: 232, y: 334 };
const STICK = { r: 74, hit: 86 };
const DPAD = { r: 72, hit: 86 };

const SHARED = {
  rs: { x: mirror(232), y: 334, r: 74, hit: 86 },
  lt: { x: 52, y: 14, w: 104, h: 80 },
  rt: { x: mirror(156), y: 14, w: 104, h: 80 },
  lb: { x: 160, y: 14, w: 88, h: 70 },
  rb: { x: mirror(248), y: 14, w: 88, h: 70 },
};

export const LAYOUTS = {
  ps5: {
    ...SHARED,
    ls: { ...LOWER_LEFT, ...STICK },
    dpad: { ...UPPER_LEFT, ...DPAD },
    a: diamond(0, 1),
    b: diamond(1, 0),
    x: diamond(-1, 0),
    y: diamond(0, -1),
    touchpad: { x: 330, y: 14, w: 266, h: 136 },
    back: { x: 290, y: 44, r: 15, hit: 30 },
    guide: { x: 463, y: 190, r: 20, hit: 30 },
    start: { x: mirror(290), y: 44, r: 15, hit: 30 },
  },
  xbox: {
    ...SHARED,
    ls: { ...UPPER_LEFT, ...STICK },
    dpad: { ...LOWER_LEFT, ...DPAD },
    a: diamond(0, 1),
    b: diamond(1, 0),
    x: diamond(-1, 0),
    y: diamond(0, -1),
    back: { x: 396, y: 128, r: 18, hit: 30 },
    guide: { x: 463, y: 128, r: 22, hit: 30 },
    start: { x: 530, y: 128, r: 18, hit: 30 },
  },
};

// Calibration moves whole groups, so the face diamond keeps its shape.
export const GROUPS = {
  face: ['a', 'b', 'x', 'y'], ls: ['ls'], rs: ['rs'], dpad: ['dpad'], lt: ['lt'], rt: ['rt'], lb: ['lb'], rb: ['rb'],
  back: ['back'], guide: ['guide'], start: ['start'], touchpad: ['touchpad'],
};
// Clear of the notch sides and the home indicator.
const SAFE = { left: 47, right: W - 47, top: 0, bottom: H - 20 };

const STICK_TRAVEL = 46; // 8 mm of thumb movement for full deflection
const STICK_DEADZONE = 0.06;
const RIM_ON = 0.92;
const RIM_OFF = 0.8;
const CLICK_WINDOW_MS = 280; // double-tap gap for L3/R3
const CLICK_TAP_MS = 200; // only a real tap arms the click, not letting go of a held stick
const INT16 = 32767;

const inCircle = (c, x, y, r = c.hit) => Math.hypot(x - c.x, y - c.y) <= r;
const inRect = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function dpadBits(dpad, x, y) {
  const dx = x - dpad.x;
  const dy = y - dpad.y;
  if (Math.hypot(dx, dy) < 10) return 0; // the rocker's pivot presses nothing
  // 0.6 keeps diagonals to 28 degrees each, so cardinal presses don't slip into them.
  let bits = 0;
  if (dx > 0.6 * Math.abs(dy)) bits |= BTN.RIGHT;
  if (-dx > 0.6 * Math.abs(dy)) bits |= BTN.LEFT;
  if (dy > 0.6 * Math.abs(dx)) bits |= BTN.DOWN;
  if (-dy > 0.6 * Math.abs(dx)) bits |= BTN.UP;
  return bits;
}

// Pulling harder is sliding down the trigger. Landing anywhere still fires, and the lower 30%
// is a full pull so shooters get an instant 100%.
function triggerValue(t, y) {
  return Math.round(255 * (0.25 + 0.75 * clamp01((y - t.y) / (t.h * 0.7))));
}

function stickVector(capture, x, y) {
  let dx = (x - capture.ox) / STICK_TRAVEL;
  let dy = (y - capture.oy) / STICK_TRAVEL;
  const m = Math.hypot(dx, dy);
  if (m < STICK_DEADZONE) return { x: 0, y: 0, m: 0 };
  const scaled = Math.min(1, (m - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  dx = (dx / m) * scaled;
  dy = (dy / m) * scaled;
  return { x: dx, y: dy, m: scaled };
}

export const NEUTRAL = Object.freeze({
  buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, lRim: false, rRim: false,
});

// Returns update(touches, now): touches is the full list of fingers on screen as {id, x, y}.
// Recomputing from the whole list means a lost touch event can never leave a button stuck.
export function createController(layout = LAYOUTS.ps5) {
  const captures = new Map();
  const lastTap = { ls: -Infinity, rs: -Infinity };
  let rim = { ls: false, rs: false };

  const circles = [
    [layout.a, BTN.A], [layout.b, BTN.B], [layout.x, BTN.X], [layout.y, BTN.Y],
    [layout.back, BTN.BACK], [layout.guide, BTN.GUIDE], [layout.start, BTN.START],
  ];
  const rects = [[layout.lb, BTN.LB], [layout.rb, BTN.RB]];
  if (layout.touchpad) rects.push([layout.touchpad, BTN.TOUCHPAD]);

  const buttonBits = (x, y) => {
    let bits = 0;
    for (const [c, bit] of circles) if (inCircle(c, x, y)) bits |= bit;
    for (const [b, bit] of rects) if (inRect(b, x, y)) bits |= bit;
    if (inCircle(layout.dpad, x, y)) bits |= dpadBits(layout.dpad, x, y);
    return bits;
  };

  const land = (t, now) => {
    for (const kind of ['ls', 'rs']) {
      if (inCircle(layout[kind], t.x, t.y)) {
        // The stick re-centres under the thumb, so landing off-centre doesn't yank the camera.
        return { kind, ox: t.x, oy: t.y, at: now, moved: false, click: now - lastTap[kind] < CLICK_WINDOW_MS };
      }
    }
    if (inRect(layout.lt, t.x, t.y)) return { kind: 'lt' };
    if (inRect(layout.rt, t.x, t.y)) return { kind: 'rt' };
    return { kind: 'button' }; // not captured: a thumb can roll from button to button
  };

  return (touches, now = Date.now()) => {
    const seen = new Set();
    let buttons = 0;
    let lt = 0;
    let rt = 0;
    const sticks = { ls: { x: 0, y: 0, m: 0 }, rs: { x: 0, y: 0, m: 0 } };

    for (const t of touches) {
      seen.add(t.id);
      if (!captures.has(t.id)) captures.set(t.id, land(t, now));
      const c = captures.get(t.id);
      if (c.kind === 'ls' || c.kind === 'rs') {
        const v = stickVector(c, t.x, t.y);
        if (v.m > 0) c.moved = true;
        if (v.m >= sticks[c.kind].m) sticks[c.kind] = v;
        if (c.click) buttons |= c.kind === 'ls' ? BTN.L3 : BTN.R3;
      } else if (c.kind === 'lt') {
        lt = Math.max(lt, triggerValue(layout.lt, t.y));
      } else if (c.kind === 'rt') {
        rt = Math.max(rt, triggerValue(layout.rt, t.y));
      } else {
        buttons |= buttonBits(t.x, t.y);
      }
    }

    for (const [id, c] of captures) {
      if (seen.has(id)) continue;
      if ((c.kind === 'ls' || c.kind === 'rs') && !c.moved && !c.click && now - c.at < CLICK_TAP_MS) {
        lastTap[c.kind] = now;
      }
      captures.delete(id);
    }

    rim = {
      ls: sticks.ls.m > (rim.ls ? RIM_OFF : RIM_ON),
      rs: sticks.rs.m > (rim.rs ? RIM_OFF : RIM_ON),
    };
    return {
      buttons,
      lx: Math.round(sticks.ls.x * INT16),
      ly: Math.round(-sticks.ls.y * INT16), // XInput's up is positive, screen's is negative
      rx: Math.round(sticks.rs.x * INT16),
      ry: Math.round(-sticks.rs.y * INT16),
      lt,
      rt,
      lRim: rim.ls,
      rRim: rim.rs,
    };
  };
}

const partsOf = (base, group) => GROUPS[group].filter((part) => base[part]);

// Offsets are saved as {group: [dx, dy]} from the default layout.
export function placeControls(base, offsets) {
  const placed = { ...base };
  for (const group of Object.keys(GROUPS)) {
    const offset = offsets?.[group];
    if (!offset) continue;
    for (const part of partsOf(base, group)) {
      placed[part] = { ...base[part], x: base[part].x + offset[0], y: base[part].y + offset[1] };
    }
  }
  return placed;
}

function clampOffset(base, group, [dx, dy]) {
  const boxes = partsOf(base, group).map((part) => {
    const c = base[part];
    return c.w ? [c.x, c.y, c.x + c.w, c.y + c.h] : [c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r];
  });
  // Whole points, rounded so they can't land past the limit.
  const limit = (v, low, high) => Math.max(Math.ceil(low), Math.min(Math.floor(high), Math.round(v)));
  return [
    limit(dx, SAFE.left - Math.min(...boxes.map((b) => b[0])), SAFE.right - Math.max(...boxes.map((b) => b[2]))),
    limit(dy, SAFE.top - Math.min(...boxes.map((b) => b[1])), SAFE.bottom - Math.max(...boxes.map((b) => b[3]))),
  ];
}

// Below zero means a touch meant for one control could land on the other: no control's visible
// body may sit inside another's touch zone.
function clearance(a, b) {
  if (a.w && b.w) {
    return Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h));
  }
  if (a.w || b.w) {
    const [rect, c] = a.w ? [a, b] : [b, a];
    const dx = Math.max(rect.x - c.x, 0, c.x - rect.x - rect.w);
    const dy = Math.max(rect.y - c.y, 0, c.y - rect.y - rect.h);
    return Math.hypot(dx, dy) - c.hit;
  }
  return Math.hypot(a.x - b.x, a.y - b.y) - Math.max(a.r + b.hit, a.hit + b.r);
}

// Returns the new offsets, sliding along whatever blocks the move. keepOut is a list of {x, y, w, h}.
// "Not getting worse" rather than "no overlap", because the defaults touch slightly (Y and R2).
export function moveGroup(base, offsets, group, target, keepOut = []) {
  const before = placeControls(base, offsets);
  const others = [
    ...Object.keys(GROUPS).filter((g) => g !== group).flatMap((g) => partsOf(base, g).map((part) => before[part])),
    ...keepOut,
  ];
  const current = offsets[group] ?? [0, 0];
  for (const attempt of [target, [target[0], current[1]], [current[0], target[1]]]) {
    const offset = clampOffset(base, group, attempt);
    const after = placeControls(base, { ...offsets, [group]: offset });
    const fits = partsOf(base, group).every((part) => others.every((other) => {
      const now = clearance(after[part], other);
      return now >= 0 || now >= clearance(before[part], other);
    }));
    if (fits) return { ...offsets, [group]: offset };
  }
  return offsets;
}

export function groupAt(layout, x, y) {
  for (const [group, parts] of Object.entries(GROUPS)) {
    for (const part of parts) {
      const c = layout[part];
      if (c && (c.w ? inRect(c, x, y) : inCircle(c, x, y))) return group;
    }
  }
  return null;
}

// Thumb test: touches go in, and once every finger has lifted it returns {left, right}, each a list
// of points with the thumb's first contact (its natural rest) first.
export function createThumbTest() {
  const thumbs = { left: [], right: [] };
  const tracks = new Map();
  return (touches) => {
    for (const t of touches) {
      if (!tracks.has(t.id)) {
        const side = thumbs[t.x < W / 2 ? 'left' : 'right'];
        tracks.set(t.id, side.length ? null : side); // a second finger on a side isn't that thumb
      }
      tracks.get(t.id)?.push({ x: t.x, y: t.y });
    }
    return touches.length === 0 && tracks.size > 0 ? thumbs : null;
  };
}

const MIN_SWEEP = 40; // less than this wasn't a sweep, so there's no reach to measure
const MIN_REACH = 90; // half the gap the two controls on each side need to stay apart
const SIDES = { left: ['ls', 'dpad'], right: ['face', 'rs'] };

function centerOf(base, group) {
  const parts = partsOf(base, group);
  return {
    x: parts.reduce((sum, part) => sum + base[part].x, 0) / parts.length,
    y: parts.reduce((sum, part) => sum + base[part].y, 0) / parts.length,
  };
}

// Where each control on one side should go: centred on the thumb's rest, then pulled in to its reach.
function thumbTargets(base, groups, points) {
  const rest = points[0];
  const centers = groups.map((group) => centerOf(base, group));
  const home = {
    x: centers.reduce((sum, c) => sum + c.x, 0) / centers.length,
    y: centers.reduce((sum, c) => sum + c.y, 0) / centers.length,
  };
  return groups.map((group, i) => {
    const c = centers[i];
    const x = c.x + rest.x - home.x;
    const y = c.y + rest.y - home.y;
    const distance = Math.hypot(x - rest.x, y - rest.y);
    const ux = (x - rest.x) / distance;
    const uy = (y - rest.y) / distance;
    const reach = Math.max(MIN_REACH, ...points.map((p) => (p.x - rest.x) * ux + (p.y - rest.y) * uy));
    const scale = Math.min(1, reach / distance);
    return { group, offset: [rest.x + ux * distance * scale - c.x, rest.y + uy * distance * scale - c.y] };
  });
}

// Returns offsets for the thumb controls, or null if the test didn't catch two sweeping thumbs.
// The shoulders and menu buttons stay put: a thumb sweep says nothing about the fingers or menus.
export function calibrateFromThumbs(base, thumbs, keepOut = []) {
  const swept = (points) => points.some((p) => Math.hypot(p.x - points[0].x, p.y - points[0].y) >= MIN_SWEEP);
  if (!swept(thumbs.left) || !swept(thumbs.right)) return null;
  const targets = Object.entries(SIDES).flatMap(([side, groups]) => thumbTargets(base, groups, thumbs[side]));
  let offsets = {};
  // Walked in steps so a control stops against an obstacle rather than giving up, and repeated
  // because one control moving can clear the way for another.
  for (let pass = 0; pass < 3; pass++) {
    for (const { group, offset } of targets) {
      const from = offsets[group] ?? [0, 0];
      for (let step = 1; step <= 20; step++) {
        const along = (i) => from[i] + ((offset[i] - from[i]) * step) / 20;
        offsets = moveGroup(base, offsets, group, [along(0), along(1)], keepOut);
      }
    }
  }
  return offsets;
}

// Saved text comes back as offsets, or null if missing or damaged, which means calibrate again.
export function readOffsets(text, base) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return null;
    const offsets = {};
    for (const group of Object.keys(GROUPS)) {
      const o = parsed[group];
      if (o === undefined || !partsOf(base, group).length) continue;
      if (!Array.isArray(o) || o.length !== 2 || !o.every(Number.isFinite)) return null;
      offsets[group] = clampOffset(base, group, o);
    }
    return offsets;
  } catch {
    return null;
  }
}

const FACE_BITS = BTN.A | BTN.B | BTN.X | BTN.Y;
const DPAD_BITS = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;
const SHOULDER_BITS = BTN.LB | BTN.RB;
const CLICK_BITS = BTN.L3 | BTN.R3;
const DETENT = 64; // a tick every quarter of trigger travel

function triggerHaptics(prev, next, out) {
  if (prev === 0 && next > 0) out.add('light');
  else if (prev > 0 && next === 0) out.add('soft');
  else if (next === 255 && prev < 255) out.add('heavy');
  else if (Math.floor(prev / DETENT) !== Math.floor(next / DETENT)) out.add('selection');
}

// Real switches click twice: a firm snap going down, a softer return. Each input type gets its
// own weight so the thumb can tell them apart without looking.
export function hapticsFor(prev, next) {
  const out = new Set();
  const down = next.buttons & ~prev.buttons;
  const up = prev.buttons & ~next.buttons;
  if (down & FACE_BITS) out.add('medium');
  if (down & DPAD_BITS) out.add('rigid');
  if (down & (SHOULDER_BITS | CLICK_BITS)) out.add('heavy');
  if (down & (BTN.BACK | BTN.START | BTN.GUIDE | BTN.TOUCHPAD)) out.add('light');
  if (up) out.add('soft');
  if ((next.lRim && !prev.lRim) || (next.rRim && !prev.rRim)) out.add('light');
  triggerHaptics(prev.lt, next.lt, out);
  triggerHaptics(prev.rt, next.rt, out);
  return out;
}

// Maps the game's two motors to the closest Taptic style and a repeat rate. null means stop.
export function rumblePattern(large, small) {
  const strongest = Math.max(large, small);
  if (strongest === 0) return null;
  const style = large > 170 ? 'heavy' : large > 70 ? 'medium' : small > 120 ? 'rigid' : 'light';
  return { style, everyMs: strongest > 170 ? 45 : 70 };
}

export function sameOutput(a, b) {
  return a.buttons === b.buttons && a.lx === b.lx && a.ly === b.ly && a.rx === b.rx
    && a.ry === b.ry && a.lt === b.lt && a.rt === b.rt;
}
