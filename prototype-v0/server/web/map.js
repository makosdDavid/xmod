// X4 WebMap — live 2D sector map (no build step, no external libraries).
// World: X4 sector coordinates in metres, x = east, z = north (drawn up), y (height) ignored.
// Heading: yaw in radians, direction vector (sin yaw, cos yaw) in the x/z plane
// (assumption — the first in-game test must confirm the marker points where the ship flies).
"use strict";

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const el = (id) => document.getElementById(id);

const CLASS_STYLE = {
  ship_xs: { r: 2.5, color: "#8fa3b8" },
  ship_s:  { r: 3.5, color: "#5fd0ff" },
  ship_m:  { r: 4.5, color: "#7cf0a0" },
  ship_l:  { r: 6,   color: "#ffd36b" },
  ship_xl: { r: 7.5, color: "#ff9a6b" },
};
const DEFAULT_STYLE = { r: 4, color: "#c0c8d0" };

const state = {
  snap: null,          // last snapshot
  snapAt: 0,           // performance.now() when it arrived
  status: null,        // last server status
  wsOpen: false,
  sectorId: undefined,
};
const view = { cx: 0, cz: 0, scale: 0.005, follow: true, labels: true, fitted: false };

// ---------------------------------------------------------------- WebSocket
let ws = null;
let retryMs = 500;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { state.wsOpen = true; retryMs = 500; updateBar(); };
  ws.onclose = () => {
    state.wsOpen = false; updateBar();
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "snapshot") onSnapshot(msg);
    else if (msg.type === "status") { state.status = msg; updateBar(); }
  };
}

function onSnapshot(s) {
  state.snap = s;
  state.snapAt = performance.now();
  const sid = s.sector ? s.sector.id : null;
  if (sid !== state.sectorId) {         // new sector: frame everything once
    state.sectorId = sid;
    view.fitted = false;
  }
  if (!view.fitted) view.fitted = fitAll();
  updateBar();
}

// ---------------------------------------------------------------- view helpers
function size() {
  return { w: canvas.clientWidth, h: canvas.clientHeight };
}
function toScreen(x, z) {
  const { w, h } = size();
  return [w / 2 + (x - view.cx) * view.scale, h / 2 - (z - view.cz) * view.scale];
}
function toWorld(sx, sy) {
  const { w, h } = size();
  return [view.cx + (sx - w / 2) / view.scale, view.cz - (sy - h / 2) / view.scale];
}
function points() {
  const s = state.snap;
  if (!s) return [];
  const pts = (s.ships || []).map((o) => [o.x, o.z]);
  if (s.player) pts.push([s.player.x, s.player.z]);
  return pts;
}
function fitAll() {
  const pts = points();
  if (!pts.length) return;
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of pts) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    minz = Math.min(minz, z); maxz = Math.max(maxz, z);
  }
  const { w, h } = size();
  if (w < 50 || h < 50) return false;     // not laid out yet (hidden tab / zero-size pane)
  const spanx = Math.max(maxx - minx, 20000), spanz = Math.max(maxz - minz, 20000);
  view.cx = (minx + maxx) / 2;
  view.cz = (minz + maxz) / 2;
  view.scale = Math.max(Math.min(Math.max(w - 120, 40) / spanx, Math.max(h - 160, 40) / spanz), 1e-6);
  return true;
}

// ---------------------------------------------------------------- input
let drag = null;
canvas.addEventListener("mousedown", (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: view.cx, cz: view.cz, moved: false };
  canvas.classList.add("dragging");
});
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3 && !drag.moved) { drag.moved = true; setFollow(false); }
  view.cx = drag.cx - dx / view.scale;
  view.cz = drag.cz + dy / view.scale;
});
window.addEventListener("mouseup", () => { drag = null; canvas.classList.remove("dragging"); });
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const [wx, wz] = toWorld(sx, sy);
  const f = Math.exp(-e.deltaY * 0.0015);
  view.scale = Math.min(Math.max(view.scale * f, 1e-6), 2);
  if (!view.follow) {                     // keep the point under the cursor fixed
    const [nx, nz] = toWorld(sx, sy);
    view.cx += wx - nx;
    view.cz += wz - nz;
  }
}, { passive: false });
canvas.addEventListener("dblclick", () => { setFollow(false); fitAll(); });

function setFollow(on) { view.follow = on; el("btnFollow").classList.toggle("on", on); }
function setLabels(on) { view.labels = on; el("btnLabels").classList.toggle("on", on); }
el("btnFollow").onclick = () => setFollow(!view.follow);
el("btnLabels").onclick = () => setLabels(!view.labels);
el("btnFit").onclick = () => { setFollow(false); fitAll(); };
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "f") { setFollow(false); fitAll(); }
  else if (k === "p") setFollow(!view.follow);
  else if (k === "l") setLabels(!view.labels);
});

// ---------------------------------------------------------------- status bar
function fmtAge(sec) {
  if (sec == null) return "–";
  if (sec < 1) return `${Math.round(sec * 1000)} ms`;
  if (sec < 120) return `${sec.toFixed(1)} s`;
  return `${Math.round(sec / 60)} perc`;
}
function setPill(id, cls, text) {
  const p = el(id);
  p.className = "pill " + cls;
  p.textContent = text;
}
function updateBar() {
  const s = state.snap, st = state.status;
  el("sector").textContent = s && s.sector ? s.sector.name : (s ? "nincs szektor (töltés?)" : "—");
  setPill("ws", state.wsOpen ? "ok" : "bad",
          state.wsOpen ? "böngésző ↔ szerver: OK" : "böngésző ↔ szerver: nincs (újrapróba…)");
  if (!state.wsOpen || !st) setPill("game", "bad", "játék: ismeretlen");
  else if (st.receiving) setPill("game", "ok", `játék: él (${st.rate_hz} Hz)`);
  else if (st.pipe_connected) setPill("game", "warn", "játék: pipe nyitva, adat nem jön");
  else setPill("game", "bad", "játék: nincs kapcsolat");
  if (s) {
    const n = (s.ships || []).filter((o) => !o.player).length;
    const extra = s.truncated ? " (levágva)" : "";
    el("info").textContent = `saját hajók: ${n}${extra} · forrás: ${s.src}${s.paused ? " · SZÜNET" : ""}`;
  }
}
function updateAge() {
  const p = el("age");
  if (!state.snap) { p.className = "pill"; p.textContent = "utolsó frissítés: –"; return; }
  const age = (performance.now() - state.snapAt) / 1000;
  p.className = "pill " + (age < 1.5 ? "ok" : age < 5 ? "warn" : "bad");
  p.textContent = `utolsó frissítés: ${fmtAge(age)}`;
}

// ---------------------------------------------------------------- drawing
function niceStep(rawMetres) {
  const p = Math.pow(10, Math.floor(Math.log10(rawMetres)));
  for (const m of [1, 2, 5, 10]) if (m * p >= rawMetres) return m * p;
  return 10 * p;
}
function fmtDist(m) { return m >= 1000 ? `${+(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }

function drawGrid(w, h) {
  const step = niceStep(80 / view.scale);
  const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#111b29";
  ctx.beginPath();
  for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
    const [sx] = toScreen(x, 0); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, h);
  }
  for (let z = Math.floor(z0 / step) * step; z <= z1; z += step) {
    const [, sy] = toScreen(0, z); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(w, Math.round(sy) + 0.5);
  }
  ctx.stroke();
  // sector origin
  const [ox, oy] = toScreen(0, 0);
  ctx.strokeStyle = "#243650";
  ctx.beginPath();
  ctx.moveTo(ox - 10, oy); ctx.lineTo(ox + 10, oy); ctx.moveTo(ox, oy - 10); ctx.lineTo(ox, oy + 10);
  ctx.stroke();
  // scale bar
  const px = step * view.scale;
  ctx.strokeStyle = "#7d8fa6"; ctx.fillStyle = "#7d8fa6";
  ctx.beginPath();
  ctx.moveTo(16, h - 18); ctx.lineTo(16 + px, h - 18);
  ctx.moveTo(16, h - 23); ctx.lineTo(16, h - 13); ctx.moveTo(16 + px, h - 23); ctx.lineTo(16 + px, h - 13);
  ctx.stroke();
  ctx.font = "12px Segoe UI, sans-serif";
  ctx.fillText(fmtDist(step), 22 + px, h - 14);
}

function drawShip(o) {
  const st = CLASS_STYLE[o.class] || DEFAULT_STYLE;
  const [sx, sy] = toScreen(o.x, o.z);
  ctx.fillStyle = st.color;
  ctx.beginPath(); ctx.arc(sx, sy, st.r, 0, Math.PI * 2); ctx.fill();
  if (typeof o.yaw === "number") {        // short heading tick
    const dx = Math.sin(o.yaw), dy = -Math.cos(o.yaw);
    ctx.strokeStyle = st.color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx + dx * st.r, sy + dy * st.r);
    ctx.lineTo(sx + dx * (st.r + 6), sy + dy * (st.r + 6)); ctx.stroke();
  }
  if (view.labels) {
    ctx.fillStyle = "#b8c6d6";
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.fillText(o.name || o.code || o.id, sx + st.r + 4, sy - st.r - 2);
  }
}

function drawPlayer(p) {
  const [sx, sy] = toScreen(p.x, p.z);
  const yaw = p.yaw || 0;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(yaw);                         // canvas rotate is clockwise = towards +x from "up"
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#4fb3ff";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(8, 9); ctx.lineTo(0, 4); ctx.lineTo(-8, 9); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 12px Segoe UI, sans-serif";
  ctx.fillText(p.name || "Játékos", sx + 14, sy + 4);
}

function frame() {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = size();
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#070b12";
  ctx.fillRect(0, 0, w, h);
  const s = state.snap;
  if (s && !view.fitted) view.fitted = fitAll();   // retry once the canvas has a size
  if (s && s.player && view.follow) { view.cx = s.player.x; view.cz = s.player.z; }
  drawGrid(w, h);
  if (s) {
    for (const o of s.ships || []) if (!o.player) drawShip(o);
    if (s.player) drawPlayer(s.player);
  } else {
    ctx.fillStyle = "#7d8fa6"; ctx.font = "16px Segoe UI, sans-serif";
    ctx.fillText("Várakozás a játék adataira…", w / 2 - 110, h / 2);
  }
  updateAge();
  requestAnimationFrame(frame);
}

connect();
updateBar();
requestAnimationFrame(frame);
