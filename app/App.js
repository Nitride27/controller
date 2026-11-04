import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Polygon, RadialGradient, Rect, Stop } from 'react-native-svg';
import { BTN, H, LAYOUTS, NEUTRAL, PIVOT, W, calibrateFromThumbs, createController, createThumbTest, groupAt, hapticsFor, moveGroup, placeControls, readOffsets, rumblePattern, sameOutput, wireButtons } from './core';
import { HOTSPOT_HOSTS, findBestLink } from './link';

const PORT = 8765;
const VOID = '#000000';
const RUBBER = '#1A1B20';
const RUBBER_LIGHT = '#30323A';
const WARNING = '#E09A3E';
const LEGEND = Platform.select({ ios: 'DINCondensed-Bold', default: undefined });
const DATA = Platform.select({ ios: 'DINAlternate-Bold', default: undefined });
const LEGEND_WEIGHT = Platform.OS === 'ios' ? undefined : '700';

// The scoop between the grips is true black so it melts into the OLED.
const SCOOP = `L600,${H} C535,${H} 530,340 463,340 C396,340 391,${H} 326,${H}`;
const SHELL_PATH = `M0,0 L300,0 C340,0 360,7 400,7 L526,7 C566,7 586,0 626,0 L${W},0 L${W},${H} ${SCOOP} L0,${H} Z`;
const DUALSENSE_CORE = `M262,0 L664,0 C676,90 664,160 672,205 C680,250 800,285 806,345 L806,${H} ${SCOOP}
  L120,${H} L120,345 C126,285 246,250 254,205 C262,160 250,90 262,0 Z`;

const THEMES = {
  ps5: {
    layout: LAYOUTS.ps5,
    shell: ['#F8F9FB', '#D6D8DF'],
    grip: ['#000000', 0.12],
    arcs: ['#000000', 0.09, '#FFFFFF', 0.7],
    core: DUALSENSE_CORE,
    coreFill: '#1B1D23',
    coreEdge: '#3D4049',
    wellDark: ['#08090B', '#111216', '#3D4049'],
    wellLight: ['#B4B7C0', '#F6F7F9'],
    cap: ['#3A3C45', '#17181D'],
    menuCap: ['#3A3C45', '#17181D'],
    guideCap: ['#3A3C45', '#17181D'],
    capShadow: ['#08090B', 0.55],
    capPressed: ['#FFFFFF', 0.14],
    face: {
      a: { symbol: 'cross', color: '#86B6F2' },
      b: { symbol: 'circle', color: '#F2888A' },
      x: { symbol: 'square', color: '#E6A4DB' },
      y: { symbol: 'triangle', color: '#76DCC4' },
    },
    names: { lt: 'L2', rt: 'R2', lb: 'L1', rb: 'R1', back: 'CREATE', start: 'OPTIONS' },
    guideLabel: 'PS',
    accent: '#2F7BEF',
    text: '#F5F6F8',
    muted: '#A6ABB5',
    engraved: '#A6ABB5',
    placeholder: '#6C7280',
    statusFill: 'rgba(255,255,255,0.09)',
    statusTop: 228,
    hintTop: 274,
    setupFill: '#1B1D23',
    inputFill: '#08090B',
    onLight: '#14151A',
    error: '#F2A49B',
  },
  xbox: {
    layout: LAYOUTS.xbox,
    shell: ['#17505A', '#0C3138'],
    grip: ['#FFFFFF', 0.09],
    arcs: ['#072126', 0.5, '#2C6E79', 0.28],
    wellDark: ['#072126', '#0B2C33', '#205A65'],
    cap: ['#EEE7D7', '#BFB59E'],
    menuCap: ['#30323A', '#1A1B20'],
    guideCap: ['#EEE7D7', '#BFB59E'],
    capShadow: ['#072126', 0.8],
    capPressed: ['#16262A', 0.22],
    face: {
      a: { label: 'A', color: '#2C7A4D' },
      b: { label: 'B', color: '#B5372D' },
      x: { label: 'X', color: '#22609F' },
      y: { label: 'Y', color: '#A9761A' },
    },
    names: { lt: 'LT', rt: 'RT', lb: 'LB', rb: 'RB', back: 'BACK', guide: 'HOME', start: 'START' },
    accent: '#2C6E79',
    connected: '#EEE7D7',
    text: '#EEE7D7',
    muted: '#A9C4C7',
    engraved: '#8FB0B4',
    placeholder: '#5C7A7F',
    statusFill: 'rgba(7,33,38,0.75)',
    statusTop: 22,
    hintTop: 182,
    setupFill: '#0C3138',
    inputFill: '#072126',
    onLight: '#16262A',
    error: '#F0A58F',
  },
};
const SKIN_NAMES = { ps5: 'PS5', xbox: 'Xbox' };
// The status pill takes touches in play and the panel needs its spot, so controls can't be placed under either.
const keepOutFor = (t) => [
  { x: W / 2 - 100, y: t.statusTop, w: 200, h: 32 },
  { x: 353, y: t.hintTop, w: 220, h: 100 },
];

const ON_WEB = Platform.OS === 'web';
// SecureStore doesn't exist in a browser. Without saving, a refresh would look like a new phone and use up a slot.
const Store = ON_WEB
  ? {
    getItemAsync: async (key) => localStorage.getItem(key),
    setItemAsync: async (key, value) => localStorage.setItem(key, value),
  }
  : SecureStore;
// A friend's invite link carries the code, so they have nothing to type.
const INVITE_PIN = ON_WEB ? /^#code=(\d{6})$/.exec(window.location.hash)?.[1] : null;
// iPhone Safari has no fullscreen for pages; its way to lose the toolbars is Add to Home Screen.
const CAN_FULLSCREEN = ON_WEB && Boolean(document.documentElement.requestFullscreen);
const IN_HOME_SCREEN_APP = ON_WEB && (window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches);

// Only works from a press or lift. Rotation can only be locked once fullscreen, which Android needs.
function enterFullscreen() {
  document.documentElement.requestFullscreen()
    .then(() => ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE))
    .catch(() => {}); // refused just means playing with the browser's toolbars showing
}

const IMPACT = {
  light: Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
  heavy: Haptics.ImpactFeedbackStyle.Heavy,
  soft: Haptics.ImpactFeedbackStyle.Soft,
  rigid: Haptics.ImpactFeedbackStyle.Rigid,
};
function play(style) {
  const done = style === 'selection' ? Haptics.selectionAsync() : Haptics.impactAsync(IMPACT[style]);
  done.catch(() => {}); // iOS refuses haptics in Low Power Mode; the button must still work
}

// The body. Arcs are the actual reach of each thumb, engraved.
const Shell = memo(function Shell({ t }) {
  const L = t.layout;
  const sunk = [L.ls, L.rs, L.back, L.guide, L.start];
  const face = [L.dpad, L.a, L.b, L.x, L.y];
  // In PS5 style the face controls sit on the white wings, so their sockets are light too.
  const lightWells = t.wellLight ? face : [];
  const darkWells = t.wellLight ? sunk : [...sunk, ...face];
  const lip = (c) => (c === L.ls || c === L.rs ? 7 : c === L.dpad ? 6 : 4);
  return (
    <Svg width={W} height={H} style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id="body" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={t.shell[0]} />
          <Stop offset="1" stopColor={t.shell[1]} />
        </LinearGradient>
        <RadialGradient id="gripL" cx="0" cy="1" r="0.55">
          <Stop offset="0" stopColor={t.grip[0]} stopOpacity={t.grip[1]} />
          <Stop offset="1" stopColor={t.grip[0]} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="gripR" cx="1" cy="1" r="0.55">
          <Stop offset="0" stopColor={t.grip[0]} stopOpacity={t.grip[1]} />
          <Stop offset="1" stopColor={t.grip[0]} stopOpacity="0" />
        </RadialGradient>
        <LinearGradient id="wellDark" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={t.wellDark[0]} />
          <Stop offset="0.7" stopColor={t.wellDark[1]} />
          <Stop offset="1" stopColor={t.wellDark[2]} />
        </LinearGradient>
        {t.wellLight ? (
          <LinearGradient id="wellLight" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={t.wellLight[0]} />
            <Stop offset="1" stopColor={t.wellLight[1]} />
          </LinearGradient>
        ) : null}
      </Defs>
      <Rect width={W} height={H} fill={VOID} />
      <Path d={SHELL_PATH} fill="url(#body)" />
      <Path d={SHELL_PATH} fill="url(#gripL)" />
      <Path d={SHELL_PATH} fill="url(#gripR)" />
      {[PIVOT.left, PIVOT.right].map((p) => [205, 265, 325, 385].map((r) => (
        <G key={`${p.x}-${r}`}>
          <Circle cx={p.x} cy={p.y} r={r} fill="none" stroke={t.arcs[0]} strokeOpacity={t.arcs[1]} />
          <Circle cx={p.x} cy={p.y + 1} r={r} fill="none" stroke={t.arcs[2]} strokeOpacity={t.arcs[3]} />
        </G>
      )))}
      {t.core ? <Path d={t.core} fill={t.coreFill} stroke={t.coreEdge} /> : null}
      {lightWells.map((c) => <Circle key={`${c.x}-${c.y}`} cx={c.x} cy={c.y} r={c.r + lip(c)} fill="url(#wellLight)" />)}
      {darkWells.map((c) => <Circle key={`${c.x}-${c.y}`} cx={c.x} cy={c.y} r={c.r + lip(c)} fill="url(#wellDark)" />)}
    </Svg>
  );
});

function Symbol({ kind, c, color }) {
  const at = c.r;
  const s = c.r * 0.42; // the glyph's half-size
  const line = { stroke: color, strokeWidth: 3.2, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (kind === 'cross') {
    return <Path d={`M${at - s},${at - s} L${at + s},${at + s} M${at + s},${at - s} L${at - s},${at + s}`} {...line} />;
  }
  if (kind === 'circle') return <Circle cx={at} cy={at} r={s * 1.1} {...line} />;
  if (kind === 'square') return <Rect x={at - s} y={at - s} width={s * 2} height={s * 2} rx={1.5} {...line} />;
  return <Polygon points={`${at},${at - s * 1.15} ${at + s * 1.15},${at + s * 0.8} ${at - s * 1.15},${at + s * 0.8}`} {...line} />;
}

// A sculpted cap: lit from above, shadow on the shell, sinks and loses its shadow when pressed.
const RoundCap = memo(function RoundCap({ c, id, t, colors, label, symbol, color, pressed, size = 24 }) {
  const d = c.r * 2;
  return (
    <View
      style={{
        position: 'absolute', left: c.x - c.r, top: c.y - c.r, width: d, height: d, alignItems: 'center', justifyContent: 'center',
        transform: pressed ? [{ translateY: 1.5 }, { scale: 0.94 }] : [],
      }}
    >
      <Svg width={d} height={d + 4} style={{ position: 'absolute', top: 0 }}>
        <Defs>
          <RadialGradient id={id} cx="0.42" cy="0.3" r="0.8">
            <Stop offset="0" stopColor={colors[0]} />
            <Stop offset="0.72" stopColor={colors[1]} />
            <Stop offset="1" stopColor={colors[1]} stopOpacity="0.88" />
          </RadialGradient>
        </Defs>
        {!pressed && <Circle cx={c.r} cy={c.r + 3} r={c.r} fill={t.capShadow[0]} fillOpacity={t.capShadow[1]} />}
        <Circle cx={c.r} cy={c.r} r={c.r} fill={`url(#${id})`} />
        {pressed && <Circle cx={c.r} cy={c.r} r={c.r} fill={t.capPressed[0]} fillOpacity={t.capPressed[1]} />}
        {symbol ? <Symbol kind={symbol} c={c} color={color} /> : null}
      </Svg>
      {label ? <Text style={[styles.capLabel, { color, fontSize: size, lineHeight: size + 4 }]}>{label}</Text> : null}
    </View>
  );
});

// PS5 style has four separate arrows that point at the centre.
function SplitArrows({ r, bits, t }) {
  const path = `M${r - 21},12 Q${r - 21},2 ${r - 11},2 L${r + 11},2 Q${r + 21},2 ${r + 21},12 L${r + 21},${r - 24} L${r},${r - 6} L${r - 21},${r - 24} Z`;
  const arm = (rotate, on) => (
    <G key={rotate} rotation={rotate} origin={`${r},${r}`}>
      <Path d={path} fill={on ? RUBBER_LIGHT : 'url(#dpadLit)'} />
      <Polygon points={`${r},14 ${r - 8},27 ${r + 8},27`} fill={on ? t.text : t.muted} />
    </G>
  );
  return (
    <>
      <Defs>
        <LinearGradient id="dpadLit" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={t.cap[0]} />
          <Stop offset="1" stopColor={t.cap[1]} />
        </LinearGradient>
      </Defs>
      {arm(0, bits & BTN.UP)}
      {arm(90, bits & BTN.RIGHT)}
      {arm(180, bits & BTN.DOWN)}
      {arm(270, bits & BTN.LEFT)}
    </>
  );
}

// Xbox style has one solid cross.
function SolidCross({ r, bits, t }) {
  const d = r * 2;
  const width = 50;
  const near = r - width / 2;
  const tip = (rotate, on) => (
    <G key={rotate} rotation={rotate} origin={`${r},${r}`}>
      {on && <Rect x={near} y={0} width={width} height={near} fill={t.capPressed[0]} fillOpacity={t.capPressed[1]} rx={9} />}
      <Polygon points={`${r},15 ${r - 9},29 ${r + 9},29`} fill={on ? t.onLight : '#8B8370'} />
    </G>
  );
  return (
    <>
      <Defs>
        <LinearGradient id="dpadLit" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={d}>
          <Stop offset="0" stopColor={t.cap[0]} />
          <Stop offset="1" stopColor={t.cap[1]} />
        </LinearGradient>
        <LinearGradient id="dpadDimple" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#A89F89" />
          <Stop offset="1" stopColor={t.cap[0]} />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={near + 3} width={d} height={width} rx={10} fill={t.capShadow[0]} fillOpacity={t.capShadow[1]} />
      <Rect x={near} y={3} width={width} height={d} rx={10} fill={t.capShadow[0]} fillOpacity={t.capShadow[1]} />
      <Rect x={near} y={0} width={width} height={d} rx={10} fill="url(#dpadLit)" />
      <Rect x={0} y={near} width={d} height={width} rx={10} fill="url(#dpadLit)" />
      <Circle cx={r} cy={r} r={13} fill="url(#dpadDimple)" />
      {tip(0, bits & BTN.UP)}
      {tip(90, bits & BTN.RIGHT)}
      {tip(180, bits & BTN.DOWN)}
      {tip(270, bits & BTN.LEFT)}
    </>
  );
}

const DPad = memo(function DPad({ bits, t }) {
  const { x, y, r } = t.layout.dpad;
  const d = r * 2;
  const shift = {
    translateX: (bits & BTN.RIGHT ? 1.5 : 0) - (bits & BTN.LEFT ? 1.5 : 0),
    translateY: (bits & BTN.DOWN ? 1.5 : 0) - (bits & BTN.UP ? 1.5 : 0),
  };
  const Arms = t.core ? SplitArrows : SolidCross;
  return (
    <View style={{ position: 'absolute', left: x - r, top: y - r, width: d, height: d, transform: [{ translateX: shift.translateX }, { translateY: shift.translateY }] }}>
      <Svg width={d} height={d + 4}>
        <Arms r={r} bits={bits} t={t} />
      </Svg>
    </View>
  );
});

const KNOB_R = 46;
const KNOB_TRAVEL = 26;

const Stick = memo(function Stick({ c, id, pan, clicked, t }) {
  const ticks = useMemo(() => Array.from({ length: 40 }, (_, i) => (i / 40) * 2 * Math.PI), []);
  return (
    <Animated.View
      style={{
        position: 'absolute', left: c.x - KNOB_R, top: c.y - KNOB_R, width: KNOB_R * 2, height: KNOB_R * 2 + 4,
        transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale: clicked ? 0.93 : 1 }],
      }}
    >
      <Svg width={KNOB_R * 2} height={KNOB_R * 2 + 4}>
        <Defs>
          <LinearGradient id={`${id}rim`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={RUBBER_LIGHT} />
            <Stop offset="1" stopColor={RUBBER} />
          </LinearGradient>
          {/* Dished: darker at the top, catching light at the bottom, the reverse of a dome. */}
          <LinearGradient id={`${id}dish`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#0E1112" />
            <Stop offset="1" stopColor={RUBBER_LIGHT} />
          </LinearGradient>
        </Defs>
        <Circle cx={KNOB_R} cy={KNOB_R + 3} r={KNOB_R} fill={t.capShadow[0]} fillOpacity="0.85" />
        <Circle cx={KNOB_R} cy={KNOB_R} r={KNOB_R} fill={`url(#${id}rim)`} />
        {ticks.map((a) => (
          <Line
            key={a}
            x1={KNOB_R + Math.cos(a) * (KNOB_R - 2)} y1={KNOB_R + Math.sin(a) * (KNOB_R - 2)}
            x2={KNOB_R + Math.cos(a) * (KNOB_R - 7)} y2={KNOB_R + Math.sin(a) * (KNOB_R - 7)}
            stroke="#454C50" strokeWidth={1.5}
          />
        ))}
        <Circle cx={KNOB_R} cy={KNOB_R} r={KNOB_R - 11} fill={`url(#${id}dish)`} />
      </Svg>
    </Animated.View>
  );
});

// Depth shows as the style's accent colour rising through the rubber as the trigger is pulled.
const Trigger = memo(function Trigger({ b, label, depth, outerLeft, t }) {
  const corners = outerLeft
    ? { borderTopLeftRadius: 30, borderTopRightRadius: 12, borderBottomLeftRadius: 14, borderBottomRightRadius: 30 }
    : { borderTopRightRadius: 30, borderTopLeftRadius: 12, borderBottomRightRadius: 14, borderBottomLeftRadius: 30 };
  const fill = depth.interpolate({ inputRange: [0, 255], outputRange: [b.h, 0] });
  return (
    <View style={[styles.rubber, corners, { left: b.x, top: b.y, width: b.w, height: b.h }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.accent, transform: [{ translateY: fill }] }]} />
      <Text style={[styles.shoulderLabel, { color: t.text }]}>{label}</Text>
    </View>
  );
});

const Bumper = memo(function Bumper({ b, label, pressed, outerLeft, t }) {
  const corners = outerLeft
    ? { borderTopLeftRadius: 12, borderTopRightRadius: 26, borderBottomLeftRadius: 12, borderBottomRightRadius: 18 }
    : { borderTopRightRadius: 12, borderTopLeftRadius: 26, borderBottomRightRadius: 12, borderBottomLeftRadius: 18 };
  return (
    <View
      style={[styles.rubber, corners, {
        left: b.x, top: b.y, width: b.w, height: b.h,
        backgroundColor: pressed ? RUBBER_LIGHT : RUBBER,
        transform: pressed ? [{ translateY: 1.5 }] : [],
      }]}
    >
      <Text style={[styles.shoulderLabel, { color: t.text }]}>{label}</Text>
    </View>
  );
});

// The strips either side of the touchpad double as the connection light.
const Touchpad = memo(function Touchpad({ b, pressed, linked, t }) {
  const light = linked ? t.accent : WARNING;
  return (
    <>
      <View style={[styles.lightBar, { left: b.x - 8, top: b.y + 8, height: b.h - 16, backgroundColor: light }]} />
      <View style={[styles.lightBar, { left: b.x + b.w + 4, top: b.y + 8, height: b.h - 16, backgroundColor: light }]} />
      <View
        style={[styles.touchpad, {
          left: b.x, top: b.y, width: b.w, height: b.h,
          backgroundColor: pressed ? '#CDD0D7' : t.text,
          transform: pressed ? [{ translateY: 1.5 }] : [],
        }]}
      />
    </>
  );
});

function Engraved({ c, color, children }) {
  return <Text style={[styles.engraved, { left: c.x - 40, top: c.y + c.r + 7, color }]}>{children}</Text>;
}

// All live control surfaces. Buttons re-render only when a button changes; sticks and triggers
// move through Animated values, so a moving thumb costs no React work at all.
const Controls = memo(function Controls({ buttons, motion, linked, t }) {
  const L = t.layout;
  const on = (bit) => (buttons & bit) !== 0;
  const dpadBits = buttons & (BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT);
  return (
    <>
      <Trigger b={L.lt} label={t.names.lt} depth={motion.lt} outerLeft t={t} />
      <Trigger b={L.rt} label={t.names.rt} depth={motion.rt} t={t} />
      <Bumper b={L.lb} label={t.names.lb} pressed={on(BTN.LB)} outerLeft t={t} />
      <Bumper b={L.rb} label={t.names.rb} pressed={on(BTN.RB)} t={t} />
      {L.touchpad ? <Touchpad b={L.touchpad} pressed={on(BTN.TOUCHPAD)} linked={linked} t={t} /> : null}
      <Stick c={L.ls} id="ls" pan={motion.ls} clicked={on(BTN.L3)} t={t} />
      <Stick c={L.rs} id="rs" pan={motion.rs} clicked={on(BTN.R3)} t={t} />
      <DPad bits={dpadBits} t={t} />
      <RoundCap c={L.a} id="a" t={t} colors={t.cap} {...t.face.a} pressed={on(BTN.A)} />
      <RoundCap c={L.b} id="b" t={t} colors={t.cap} {...t.face.b} pressed={on(BTN.B)} />
      <RoundCap c={L.x} id="x" t={t} colors={t.cap} {...t.face.x} pressed={on(BTN.X)} />
      <RoundCap c={L.y} id="y" t={t} colors={t.cap} {...t.face.y} pressed={on(BTN.Y)} />
      <RoundCap c={L.back} id="back" t={t} colors={t.menuCap} pressed={on(BTN.BACK)} />
      <RoundCap c={L.guide} id="guide" t={t} colors={t.guideCap} label={t.guideLabel} color={t.text} size={15} pressed={on(BTN.GUIDE)} />
      <RoundCap c={L.start} id="start" t={t} colors={t.menuCap} pressed={on(BTN.START)} />
      <Engraved c={L.back} color={t.engraved}>{t.names.back}</Engraved>
      {t.names.guide ? <Engraved c={L.guide} color={t.engraved}>{t.names.guide}</Engraved> : null}
      <Engraved c={L.start} color={t.engraved}>{t.names.start}</Engraved>
    </>
  );
});

// Keeps one paired connection on the best link, retrying until told to stop.
function useLink({ pin, host, phoneId, enabled, attempt, wsRef, onRumble, onPaired }) {
  const [status, setStatus] = useState(() => ({ state: 'searching', link: null, rtt: null, since: Date.now() }));
  const rtt = useRef(null);

  useEffect(() => {
    if (!pin || !enabled) return undefined;
    let stopped = false;
    let socket = null;
    let retry = null;
    const metroHost = Constants.expoConfig?.hostUri?.split(':')[0];
    // A browser page came from the laptop itself, so that's the address to use.
    const hosts = ON_WEB ? [host, window.location.hostname] : [host, metroHost, ...HOTSPOT_HOSTS];

    const run = async () => {
      setStatus((s) => (s.state === 'searching' ? s : { state: 'searching', link: null, rtt: null, since: Date.now() }));
      const best = await findBestLink(hosts, ON_WEB ? window.location.port : PORT);
      if (stopped) { best?.ws.close(); return; }
      if (!best) { retry = setTimeout(run, 400); return; }
      socket = best.ws;
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (typeof message === 'number') {
          const sample = (Date.now() - message + 1e9) % 1e9;
          rtt.current = rtt.current === null ? sample : rtt.current * 0.8 + sample * 0.2;
        } else if (message.ok) {
          wsRef.current = socket;
          rtt.current = null;
          setStatus({ state: 'connected', link: best.link, player: message.player, rtt: null });
          onPaired();
        } else if (message.r) {
          onRumble(message.r[0], message.r[1]);
        }
      };
      socket.onclose = ({ code }) => {
        wsRef.current = null;
        onRumble(0, 0);
        if (stopped) return;
        if (code === 4001) setStatus({ state: 'badPin' });
        else if (code === 4002) setStatus({ state: 'replaced' });
        else if (code === 4003) setStatus({ state: 'full' });
        else run();
      };
      socket.send(JSON.stringify({ pin, id: phoneId }));
    };

    run();
    const ticker = setInterval(() => {
      if (rtt.current !== null) setStatus((s) => (s.state === 'connected' ? { ...s, rtt: Math.round(rtt.current) } : s));
    }, 1000);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ticker);
      wsRef.current = null;
      socket?.close();
      onRumble(0, 0);
    };
  }, [pin, host, phoneId, enabled, attempt, wsRef, onRumble, onPaired]);

  return status;
}

// Only its buttons take touches, so a thumb straying over the panel still counts in the test.
function CalibrationPanel({ t, text, actions }) {
  return (
    <View pointerEvents="box-none" style={[styles.panel, { top: t.hintTop, backgroundColor: t.setupFill }]}>
      <Text pointerEvents="none" style={[styles.panelText, { color: t.text }]}>{text}</Text>
      <View pointerEvents="box-none" style={styles.panelActions}>
        {actions.map(({ label, onPress, main }) => (
          <Pressable key={label} accessibilityRole="button" onPress={onPress} style={[styles.panelButton, main && { backgroundColor: t.text }]}>
            <Text style={[styles.panelLabel, { color: main ? t.onLight : t.text }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function FullscreenOption({ t }) {
  const [full, setFull] = useState(() => CAN_FULLSCREEN && Boolean(document.fullscreenElement));
  useEffect(() => {
    if (!CAN_FULLSCREEN) return undefined;
    const update = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  if (!CAN_FULLSCREEN) {
    if (!ON_WEB || IN_HOME_SCREEN_APP) return null;
    return <Text style={[styles.linkHow, styles.fullscreenHint, { color: t.muted }]}>For full screen on iPhone: tap Share, then Add to Home Screen.</Text>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => (full ? document.exitFullscreen().catch(() => {}) : enterFullscreen())}
      style={[styles.fullscreen, { backgroundColor: t.inputFill }]}
    >
      <Text style={[styles.panelLabel, { color: t.text }]}>{full ? 'Exit full screen' : 'Full screen'}</Text>
    </Pressable>
  );
}

function Setup({ pin, host, error, onConnect, onCancel, onThumbTest, onAdjust, status, skin, onSkin }) {
  const t = THEMES[skin];
  const [code, setCode] = useState(pin ?? '');
  const [address, setAddress] = useState(host);
  const ready = /^\d{6}$/.test(code);
  const inputStyle = [styles.input, { backgroundColor: t.inputFill, color: t.text }];
  return (
    <View style={[styles.setup, { backgroundColor: t.setupFill }]}>
      <View style={styles.setupForm}>
        <Text style={[styles.setupTitle, { color: t.text }]}>Connect to your laptop</Text>
        <Text style={[styles.fieldLabel, { color: t.muted }]}>Pairing code from the laptop window</Text>
        <TextInput
          accessibilityLabel="Pairing code"
          style={inputStyle}
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          keyboardAppearance="dark"
          placeholder="000000"
          placeholderTextColor={t.placeholder}
          autoFocus={!pin}
        />
        <Text style={[styles.fieldLabel, { color: t.muted }]}>Laptop address (optional)</Text>
        <TextInput
          accessibilityLabel="Laptop address"
          style={inputStyle}
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          keyboardAppearance="dark"
          placeholder="Found automatically"
          placeholderTextColor={t.placeholder}
        />
        {error ? <Text style={[styles.setupError, { color: t.error }]}>{error}</Text> : null}
        <View style={styles.setupActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready }}
            disabled={!ready}
            onPress={() => onConnect(code, address.trim())}
            style={[styles.connect, { backgroundColor: t.text }, !ready && { opacity: 0.4 }]}
          >
            <Text style={[styles.connectLabel, { color: t.onLight }]}>Connect</Text>
          </Pressable>
          {pin ? (
            <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel}>
              <Text style={[styles.cancelLabel, { color: t.text }]}>Back to controller</Text>
            </Pressable>
          ) : null}
        </View>
        <FullscreenOption t={t} />
      </View>
      <View style={styles.setupLinks}>
        <Text style={[styles.fieldLabel, { color: t.muted }]}>Controller style</Text>
        <View accessibilityRole="radiogroup" style={[styles.choices, { backgroundColor: t.inputFill }]}>
          {Object.keys(THEMES).map((key) => {
            const chosen = key === skin;
            return (
              <Pressable
                key={key}
                accessibilityRole="radio"
                aria-checked={chosen}
                onPress={() => onSkin(key)}
                style={[styles.choice, chosen && { backgroundColor: t.text }]}
              >
                <Text style={[styles.choiceLabel, { color: chosen ? t.onLight : t.text }]}>{SKIN_NAMES[key]}</Text>
              </Pressable>
            );
          })}
        </View>
        {pin ? (
          <>
            <Text style={[styles.fieldLabel, { color: t.muted }]}>Button positions</Text>
            <View style={styles.calibrateRow}>
              <Pressable accessibilityRole="button" onPress={onThumbTest} style={[styles.calibrate, { backgroundColor: t.inputFill }]}>
                <Text style={[styles.panelLabel, { color: t.text }]}>Redo thumb test</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={onAdjust} style={[styles.calibrate, { backgroundColor: t.inputFill }]}>
                <Text style={[styles.panelLabel, { color: t.text }]}>Adjust manually</Text>
              </Pressable>
            </View>
          </>
        ) : null}
        <Text style={[styles.linkName, { color: t.text }]}>USB cable  ·  fastest</Text>
        <Text style={[styles.linkHow, { color: t.muted }]}>Plug in the cable and turn on Personal Hotspot.</Text>
        <Text style={[styles.linkName, { color: t.text }]}>Wi-Fi</Text>
        <Text style={[styles.linkHow, { color: t.muted }]}>Join the same network as the laptop.</Text>
        <Text style={[styles.linkName, { color: t.text }]}>Bluetooth  ·  slowest</Text>
        <Text style={[styles.linkHow, { color: t.muted }]}>Pair with the laptop and turn on Personal Hotspot. On the laptop, join the Bluetooth network from this phone.</Text>
        {status.state === 'connected' ? <Text style={[styles.linkNow, { color: t.text }]}>Player {status.player}, connected over {status.link}</Text> : null}
      </View>
    </View>
  );
}

function statusText(status) {
  if (status.state === 'connected') {
    const where = `P${status.player}  ·  ${status.link}`;
    return status.rtt === null ? where : `${where}  ·  ${status.rtt} ms`;
  }
  if (status.state === 'badPin') return 'Wrong code';
  if (status.state === 'replaced') return 'Disconnected';
  if (status.state === 'full') return 'No free slot';
  return 'Searching';
}

export default function App() {
  useKeepAwake();
  const { width, height } = useWindowDimensions();

  const [saved, setSaved] = useState(null); // null until storage has been read
  const [skin, setSkin] = useState('ps5');
  const [setupOpen, setSetupOpen] = useState(false);
  const [foreground, setForeground] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [buttons, setButtons] = useState(0);
  const [stale, setStale] = useState(false);
  const [offsets, setOffsets] = useState({}); // saved calibration per style; a missing style hasn't been calibrated
  const [draft, setDraft] = useState(null); // offsets from the thumb test or manual adjusting, waiting for Done
  const [retest, setRetest] = useState(false); // the thumb test was asked for from the setup screen
  const [adjusting, setAdjusting] = useState(false); // dragging controls by hand, from the setup screen
  const [missedThumbs, setMissedThumbs] = useState(false);

  const placement = draft ?? offsets[skin];
  const t = useMemo(() => ({ ...THEMES[skin], layout: placeControls(THEMES[skin].layout, placement) }), [skin, placement]);
  const controller = useMemo(() => createController(t.layout), [t.layout]);
  const thumbTest = useRef(null);
  const grabs = useRef(new Map());
  const askedFullscreen = useRef(false); // once per visit, so leaving fullscreen stays left

  const wsRef = useRef(null);
  const padRef = useRef(NEUTRAL);
  const rumbleTimer = useRef(null);
  const [motion] = useState(() => ({
    ls: new Animated.ValueXY(), rs: new Animated.ValueXY(), lt: new Animated.Value(0), rt: new Animated.Value(0),
  }));

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    (async () => {
      let pin = null;
      let host = '';
      // Only tells phones apart, so it needs to be unique rather than secret.
      let phoneId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
      try {
        pin = INVITE_PIN ?? await Store.getItemAsync('pin');
        host = (await Store.getItemAsync('host')) ?? '';
        const savedSkin = await Store.getItemAsync('skin');
        if (THEMES[savedSkin]) setSkin(savedSkin);
        const savedOffsets = {};
        for (const key of Object.keys(THEMES)) {
          const read = readOffsets(await Store.getItemAsync(`layout.${key}`), THEMES[key].layout);
          if (read) savedOffsets[key] = read;
        }
        setOffsets(savedOffsets);
        const savedId = await Store.getItemAsync('phoneId');
        if (savedId) phoneId = savedId;
        else await Store.setItemAsync('phoneId', phoneId);
      } catch {
        // No saved pairing is the same as a first launch.
      }
      setSaved({ pin, host, phoneId });
      if (!pin) setSetupOpen(true);
    })();
    const subscription = AppState.addEventListener('change', (s) => setForeground(s === 'active'));
    return () => subscription.remove();
  }, []);

  const send = useCallback((s) => {
    const ws = wsRef.current;
    if (ws?.readyState === 1) ws.send(JSON.stringify([Date.now() % 1e9, wireButtons(s.buttons), s.lx, s.ly, s.rx, s.ry, s.lt, s.rt]));
  }, []);

  const onRumble = useCallback((large, small) => {
    clearInterval(rumbleTimer.current);
    const pattern = rumblePattern(large, small);
    if (!pattern) return;
    play(pattern.style);
    rumbleTimer.current = setInterval(() => play(pattern.style), pattern.everyMs);
  }, []);

  const onPaired = useCallback(() => {
    setSetupOpen(false);
    send(padRef.current);
  }, [send]);

  const status = useLink({
    pin: saved?.pin, host: saved?.host, phoneId: saved?.phoneId, enabled: foreground, attempt, wsRef, onRumble, onPaired,
  });

  // Also verifies the link once a second, so the latency readout stays live while idle.
  useEffect(() => {
    const heartbeat = setInterval(() => send(padRef.current), 1000);
    return () => clearInterval(heartbeat);
  }, [send]);

  // First successful pairing per style, or on request from the setup screen, until Done.
  const calibrating = draft !== null || retest || adjusting || (status.state === 'connected' && !setupOpen && !offsets[skin]);

  useEffect(() => {
    if (status.state !== 'searching') return undefined;
    const timer = setTimeout(() => setStale(true), 6000);
    return () => {
      clearTimeout(timer);
      setStale(false);
    };
  }, [status.state, status.since]);

  // Laid out in W x H points, then fitted to the screen. iOS 27 may ignore the landscape lock
  // and report portrait, so the controller rotates itself instead of relying on it.
  const portrait = height > width;
  const scale = portrait ? Math.min(height / W, width / H) : Math.min(width / W, height / H);

  const dragControls = (points) => {
    let next = placement ?? {};
    const seen = new Set();
    for (const p of points) {
      seen.add(p.id);
      const grab = grabs.current.get(p.id);
      if (!grab) {
        const group = groupAt(t.layout, p.x, p.y);
        grabs.current.set(p.id, { group, x: p.x, y: p.y, from: next[group] ?? [0, 0] });
      } else if (grab.group) {
        next = moveGroup(THEMES[skin].layout, next, grab.group, [grab.from[0] + p.x - grab.x, grab.from[1] + p.y - grab.y], keepOutFor(t));
      }
    }
    for (const id of grabs.current.keys()) if (!seen.has(id)) grabs.current.delete(id);
    if (next !== placement) setDraft(next);
  };

  const measureThumbs = (points) => {
    thumbTest.current ??= createThumbTest();
    const thumbs = thumbTest.current(points);
    if (!thumbs) return;
    thumbTest.current = null;
    const measured = calibrateFromThumbs(THEMES[skin].layout, thumbs, keepOutFor(t));
    setMissedThumbs(!measured);
    if (measured) setDraft(measured);
  };

  const applyTouches = (touches) => {
    const mapped = Array.from(touches, (touch) => {
      const dx = touch.pageX - width / 2;
      const dy = touch.pageY - height / 2;
      return {
        id: touch.identifier,
        x: W / 2 + (portrait ? dy : dx) / scale,
        y: H / 2 + (portrait ? -dx : dy) / scale,
      };
    });
    if (calibrating) {
      if (adjusting) dragControls(mapped);
      else if (draft === null) measureThumbs(mapped);
      return;
    }
    const previous = padRef.current;
    const next = controller(mapped);
    padRef.current = next;

    // Network first: nothing else on this path should delay the input.
    if (!sameOutput(previous, next)) send(next);
    for (const style of hapticsFor(previous, next)) play(style);
    motion.ls.setValue({ x: (next.lx / 32767) * KNOB_TRAVEL, y: (-next.ly / 32767) * KNOB_TRAVEL });
    motion.rs.setValue({ x: (next.rx / 32767) * KNOB_TRAVEL, y: (-next.ry / 32767) * KNOB_TRAVEL });
    motion.lt.setValue(next.lt);
    motion.rt.setValue(next.rt);
    if (previous.buttons !== next.buttons) setButtons(next.buttons);
  };

  const onTouch = (e) => applyTouches(e.nativeEvent.touches);
  const onTouchEnd = (e) => {
    // Some paths still list the lifted finger in touches, so subtract it explicitly.
    const lifted = new Set(Array.from(e.nativeEvent.changedTouches, (touch) => touch.identifier));
    applyTouches(Array.from(e.nativeEvent.touches).filter((touch) => !lifted.has(touch.identifier)));
    if (CAN_FULLSCREEN && !askedFullscreen.current) {
      askedFullscreen.current = true;
      enterFullscreen();
    }
  };

  const connect = async (pin, host) => {
    try {
      await Store.setItemAsync('pin', pin);
      await Store.setItemAsync('host', host);
    } catch {
      // Not saved means asking again next launch; the session itself still works.
    }
    setSaved((s) => ({ ...s, pin, host }));
    setAttempt((a) => a + 1);
    setStale(false);
  };

  const chooseSkin = (key) => {
    applyTouches([]); // nothing held in the old layout may carry over to the new one
    setSkin(key);
    Store.setItemAsync('skin', key).catch(() => {}); // not saved just means the default next launch
  };

  const startThumbTest = () => {
    thumbTest.current = null;
    setMissedThumbs(false);
    setDraft(null);
    setRetest(true);
  };

  const startAdjusting = () => {
    grabs.current.clear();
    setDraft(offsets[skin] ?? {});
    setAdjusting(true);
  };

  const finishCalibration = (chosen) => {
    thumbTest.current = null;
    grabs.current.clear();
    setMissedThumbs(false);
    setDraft(null);
    setRetest(false);
    setAdjusting(false);
    setOffsets((o) => ({ ...o, [skin]: chosen }));
    Store.setItemAsync(`layout.${skin}`, JSON.stringify(chosen)).catch(() => {}); // not saved means testing again next launch
  };

  const cancelAction = offsets[skin] ? [{ label: 'Cancel', onPress: () => finishCalibration(offsets[skin]) }] : [];
  let calibrationPanel;
  if (adjusting) {
    calibrationPanel = {
      text: 'Drag any control to move it.',
      actions: [
        { label: 'Reset', onPress: () => setDraft({}) },
        ...cancelAction,
        { label: 'Done', onPress: () => finishCalibration(placement ?? {}), main: true },
      ],
    };
  } else if (draft !== null) {
    calibrationPanel = {
      text: 'Buttons placed to fit your thumbs.',
      actions: [
        { label: 'Test again', onPress: startThumbTest },
        { label: 'Done', onPress: () => finishCalibration(draft), main: true },
      ],
    };
  } else {
    calibrationPanel = {
      text: missedThumbs
        ? 'Use both thumbs: rest them, sweep as far as is comfortable, then lift.'
        : 'Hold as you play. Rest both thumbs, sweep as far as is comfortable, then lift.',
      actions: [{ label: 'Use defaults', onPress: () => finishCalibration({}) }, ...cancelAction],
    };
  }

  const STATE_HINTS = {
    replaced: 'This phone connected again from another session. Tap the status to reconnect here.',
    full: 'Four phones are already connected. When one leaves, tap the status, then Connect.',
  };
  const hint = STATE_HINTS[status.state]
    ?? (stale ? (ON_WEB
      ? "Can't reach the laptop. Check that Phone Pad is open on it and this phone is on the same Wi-Fi."
      : "Can't find your laptop. Open Phone Pad on it, then turn on Personal Hotspot for USB or Bluetooth, or join its Wi-Fi.") : null);

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <View
        style={{
          position: 'absolute', left: (width - W) / 2, top: (height - H) / 2, width: W, height: H,
          transform: [{ rotate: portrait ? '90deg' : '0deg' }, { scale }],
        }}
      >
        <View
          style={StyleSheet.absoluteFill}
          pointerEvents="box-only"
          onTouchStart={onTouch}
          onTouchMove={onTouch}
          onTouchEnd={onTouchEnd}
          onTouchCancel={() => applyTouches([])}
        >
          <Shell t={t} />
          <Controls buttons={buttons} motion={motion} linked={status.state === 'connected'} t={t} />
          {hint && !calibrating ? <Text style={[styles.hint, { top: t.hintTop, color: t.text }]}>{hint}</Text> : null}
        </View>
        {calibrating ? <CalibrationPanel t={t} {...calibrationPanel} /> : null}
        {/* Stays visible while calibrating, because controls can't be placed under it. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Connection: ${statusText(status)}. Open connection settings.`}
          disabled={calibrating}
          hitSlop={8}
          onPress={() => setSetupOpen(true)}
          style={[styles.status, { top: t.statusTop, backgroundColor: t.statusFill }]}
        >
          <View style={[styles.statusDot, { backgroundColor: status.state === 'connected' ? (t.connected ?? t.accent) : WARNING }]} />
          <Text style={[styles.statusText, { color: t.text }]}>{statusText(status)}</Text>
        </Pressable>
      </View>
      {setupOpen && saved ? (
        <Setup
          pin={saved.pin}
          host={saved.host}
          status={status}
          skin={skin}
          onSkin={chooseSkin}
          error={status.state === 'badPin' ? "That code doesn't match. Check the code in the laptop window." : null}
          onConnect={connect}
          onCancel={() => setSetupOpen(false)}
          onThumbTest={() => {
            startThumbTest();
            setSetupOpen(false);
          }}
          onAdjust={() => {
            startAdjusting();
            setSetupOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: VOID, overflow: 'hidden' },
  capLabel: { fontFamily: LEGEND, fontWeight: LEGEND_WEIGHT, textAlign: 'center', paddingTop: Platform.OS === 'ios' ? 3 : 0 },
  rubber: {
    position: 'absolute', backgroundColor: RUBBER, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#000000', borderTopColor: '#3D4049', // raised, so lit from above
  },
  shoulderLabel: { fontFamily: LEGEND, fontWeight: LEGEND_WEIGHT, fontSize: 20, letterSpacing: 1 },
  touchpad: {
    position: 'absolute', borderRadius: 16, borderWidth: 1, borderColor: '#B4B7C0', borderBottomColor: '#000000',
  },
  lightBar: { position: 'absolute', width: 4, borderRadius: 2 },
  engraved: {
    position: 'absolute', width: 80, textAlign: 'center', fontFamily: LEGEND,
    fontWeight: LEGEND_WEIGHT, fontSize: 11, letterSpacing: 1,
  },
  hint: { position: 'absolute', left: 353, width: 220, textAlign: 'center', fontSize: 13, lineHeight: 17 },
  status: {
    position: 'absolute', left: W / 2 - 100, width: 200, height: 32, borderRadius: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontFamily: DATA, fontSize: 14 },
  panel: { position: 'absolute', left: 353, width: 220, height: 100, borderRadius: 12, padding: 6 },
  panelText: { fontSize: 13, lineHeight: 17, textAlign: 'center', marginBottom: 4 },
  panelActions: { flex: 1, flexDirection: 'row', gap: 6 },
  panelButton: { flex: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  panelLabel: { fontSize: 14, fontWeight: '700' },
  fullscreen: { height: 44, marginTop: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  fullscreenHint: { marginTop: 10 },
  calibrateRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  calibrate: { flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  setup: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', paddingHorizontal: 60, paddingTop: 22, gap: 44 },
  setupForm: { flex: 1 },
  setupTitle: { fontSize: 24, fontWeight: '700', marginBottom: 12 },
  fieldLabel: { fontSize: 13, marginBottom: 4 },
  input: { fontFamily: DATA, fontSize: 18, borderRadius: 10, paddingHorizontal: 12, height: 40, marginBottom: 10 },
  setupError: { fontSize: 13, marginBottom: 8 },
  setupActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  connect: { height: 44, paddingHorizontal: 26, borderRadius: 22, justifyContent: 'center' },
  connectLabel: { fontSize: 16, fontWeight: '700' },
  cancel: { height: 44, paddingHorizontal: 12, justifyContent: 'center' },
  cancelLabel: { fontSize: 15 },
  setupLinks: { flex: 1 },
  choices: { flexDirection: 'row', borderRadius: 12, padding: 3, marginBottom: 14 },
  choice: { flex: 1, height: 44, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  choiceLabel: { fontSize: 15, fontWeight: '700' },
  linkName: { fontSize: 14, fontWeight: '700', marginBottom: 1 },
  linkHow: { fontSize: 12, lineHeight: 16, marginBottom: 8 },
  linkNow: { fontFamily: DATA, fontSize: 14 },
});
