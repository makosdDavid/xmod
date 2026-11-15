// Map zoom regression tests (node tests/test_camera.mjs). Exit code 1 on failure.
// The v1.0 bug: "zoom in works, zoom out does not" - the follow-mode zoom bias kept growing past
// the scale limit, so zoom-out had to unwind invisible zoom first.
import { clampScale, wheelFactor, applyBias, zoomAt, fitScale, pinchFactor, LIMITS } from "../web/camera.js";

let pass = 0, fail = 0;
function check(ok, what) { if (ok) pass++; else fail++; console.log((ok ? "PASS " : "FAIL ") + what); }

const notchIn = wheelFactor(-100, 0), notchOut = wheelFactor(100, 0);
check(notchIn > 1 && notchOut < 1 && Math.abs(notchIn * notchOut - 1) < 1e-12, `wheel: one notch in/out are inverse (${notchIn.toFixed(3)} / ${notchOut.toFixed(3)})`);
check(wheelFactor(-3, 1) > 1 && wheelFactor(3, 1) < 1, "wheel in line mode (deltaMode 1) zooms both ways");
check(wheelFactor(-5000) < 2 && wheelFactor(5000) > 0.5, "one huge wheel event is capped");
check(Math.abs(wheelFactor(-1.5) - 1) < 0.01 && wheelFactor(-1.5) > 1, "touchpad pinch (small ctrl+wheel deltas) zooms smoothly");

for (const mode of ["sector", "galaxy"]) {
  // follow camera: base scale from the auto-fit, zoom via bias
  const w = 1000, h = 800;
  const base = fitScale(mode === "sector" ? 8000 : 7e7, w, h, mode, 1);
  let bias = 1;
  let scale = applyBias(base, bias, mode).scale;
  const s0 = scale;
  for (let i = 0; i < 60; i++) { const r = applyBias(base, bias * notchIn, mode); bias = r.bias; scale = r.scale; }
  check(scale === LIMITS[mode].max, `[${mode}] zoom in 60 notches reaches the upper limit`);
  const before = scale;
  const r1 = applyBias(base, bias * notchOut, mode);
  check(r1.scale < before, `[${mode}] the FIRST zoom-out notch after hitting the limit is visible (${before.toExponential(2)} -> ${r1.scale.toExponential(2)})`);
  bias = r1.bias; scale = r1.scale;
  for (let i = 0; i < 200; i++) { const r = applyBias(base, bias * notchOut, mode); bias = r.bias; scale = r.scale; }
  check(scale === LIMITS[mode].min, `[${mode}] zoom out reaches the lower limit`);
  const r2 = applyBias(base, bias * notchIn, mode);
  check(r2.scale > scale, `[${mode}] the first zoom-in notch after the lower limit is visible`);
  // back to start: 1:1 notches
  let b = 1, sc = s0;
  for (let i = 0; i < 5; i++) { const r = applyBias(base, b * notchIn, mode); b = r.bias; sc = r.scale; }
  for (let i = 0; i < 5; i++) { const r = applyBias(base, b * notchOut, mode); b = r.bias; sc = r.scale; }
  check(Math.abs(sc / s0 - 1) < 1e-9, `[${mode}] 5 in + 5 out returns to the same scale`);

  // manual camera: zoom around the cursor keeps the world point under the cursor
  const v = { cx: 1000, cz: -2000, scale: mode === "sector" ? 0.003 : 2e-6 };
  const sx = 700, sy = 200;
  const wx = v.cx + (sx - w / 2) / v.scale, wz = v.cz - (sy - h / 2) / v.scale;
  const z = zoomAt(v, notchOut, sx, sy, w, h, mode);
  const wx2 = z.cx + (sx - w / 2) / z.scale, wz2 = z.cz - (sy - h / 2) / z.scale;
  check(z.scale < v.scale && Math.abs(wx - wx2) < 1e-6 * Math.abs(wx) + 1e-3 && Math.abs(wz - wz2) < 1e-6 * Math.abs(wz) + 1e-3,
        `[${mode}] manual zoom-out around the cursor keeps the point under the cursor`);
  let mv = { ...v };
  for (let i = 0; i < 300; i++) mv = zoomAt(mv, notchIn, sx, sy, w, h, mode);
  const out1 = zoomAt(mv, notchOut, sx, sy, w, h, mode);
  check(out1.scale < mv.scale, `[${mode}] manual: zoom-out works immediately after saturating zoom-in`);
}

check(1000 / LIMITS.sector.min >= 2.5e8, "sector lower limit: 1000 px show at least 250 000 km (whole sector + neighbours)");
check(clampScale(NaN, "sector") === LIMITS.sector.min && clampScale(-1, "galaxy") === LIMITS.galaxy.min, "invalid scales are clamped");
check(pinchFactor(100, 150) === 1.5 && pinchFactor(0, 10) === 1, "pinch factor");

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
