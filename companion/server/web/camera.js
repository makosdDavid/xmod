// X4 Companion — map camera math (pure functions, unit-tested with node: tests/test_camera.mjs).
//
// v1.0 bug ("zoom in works, zoom out does not"): while following, the zoom factor (bias) kept
// growing after the scale had already hit its upper limit; zooming out then first had to "unwind"
// the invisible excess, so nothing visibly happened for many wheel notches. Fix: the bias is
// always re-derived from the clamped scale, so it never exceeds what is visible.
"use strict";

export const LIMITS = {
  sector: { min: 4e-6, max: 0.5 },      // px per metre: ~250 000 km .. 2 m across 1000 px
  galaxy: { min: 1e-8, max: 1.2e-4 },
};

export function clampScale(s, mode) {
  const l = LIMITS[mode] || LIMITS.sector;
  if (!Number.isFinite(s) || s <= 0) return l.min;
  return Math.max(l.min, Math.min(l.max, s));
}

// mouse wheel / touchpad -> multiplicative zoom factor (>1 = zoom in). deltaMode 1 = lines, 2 = pages.
export function wheelFactor(deltaY, deltaMode = 0) {
  let d = deltaY;
  if (deltaMode === 1) d *= 33;
  else if (deltaMode === 2) d *= 400;
  d = Math.max(-400, Math.min(400, d));      // one huge event never jumps more than ~x1.8
  return Math.exp(-d * 0.0015);
}

// following: scale = base * bias. Returns the clamped scale and the bias that actually produces it.
export function applyBias(base, bias, mode) {
  const scale = clampScale(base * bias, mode);
  return { scale, bias: scale / base };
}

// zoom by factor f around a screen point (sx, sy) of a view {cx, cz, scale} with size w x h.
// The world point under the cursor stays under the cursor.
export function zoomAt(view, f, sx, sy, w, h, mode) {
  const wx = view.cx + (sx - w / 2) / view.scale;
  const wz = view.cz - (sy - h / 2) / view.scale;
  const scale = clampScale(view.scale * f, mode);
  return { cx: wx - (sx - w / 2) / scale, cz: wz + (sy - h / 2) / scale, scale };
}

// scale that fits a box of half-extent `half` (metres) into the smaller screen side, with margin
export function fitScale(half, w, h, mode, margin = 0.9) {
  return clampScale((Math.min(w, h) / 2) * margin / Math.max(1, half), mode);
}

// distance between two touch points (pinch)
export function pinchFactor(d0, d1) {
  if (!(d0 > 0) || !(d1 > 0)) return 1;
  return d1 / d0;
}
