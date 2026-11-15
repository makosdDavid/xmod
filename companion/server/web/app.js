// X4 Companion — app core: state store, WebSocket, layout, display mode, in-game hotkeys.
"use strict";
import { $, $$, el, num, money, dist, gameTime, loadSettings, saveSettings, LOGCAT_HU, throttle } from "./util.js";
import { MapView } from "./map.js";
import * as P from "./panels.js";

// ---------------------------------------------------------------- event bus + store
const handlers = {};
export const bus = {
  on(name, fn) { (handlers[name] ||= []).push(fn); },
  emit(name, data) { for (const fn of handlers[name] || []) { try { fn(data); } catch (e) { console.error(name, e); } } },
};

export const S = {
  wsOpen: false, status: null, hello: null, control: false, originOk: true,
  liveGalaxy: null, hwlinks: [],
  sectors: new Map(), clusters: new Map(), sectorByMacro: new Map(), links: [], stubs: [], gates: [], gatesBySector: new Map(),
  scans: {}, property: new Map(), propertyMeta: {},
  log: [], ticker: [], readUpTo: {}, messages: null, missions: [], offers: [], factions: {}, factionList: [],
  economy: null, stats: null, player: null, playerAt: 0, prevPlayer: null, speedEst: null,
  yaw: { a: 0, b: 0, c: 0 }, selected: null, lastAck: null,
};
window.__x4c = S;   // for debugging in the browser console

const params = new URLSearchParams(location.search);
export const SINGLE = params.get("panel");   // pop-out window: map | property | log | missions | factions | economy | diag | player

// ---------------------------------------------------------------- galaxy indexes
function rebuildGalaxy() {
  // only what the game reports as discovered: the bridge sends known clusters/sectors only, and
  // the server never forwards the static map export as geometry (see server.Store.hw_links)
  S.sectors.clear(); S.clusters.clear(); S.sectorByMacro.clear();
  const src = S.liveGalaxy || [];
  for (const c of src) {
    const secs = c.sectors || [];
    const maxOff = Math.max(1, ...secs.map((s) => Math.hypot(s.x || 0, s.z || 0)));
    const k = secs.length > 1 ? Math.min(1, 6.2e6 / maxOff) : 0;
    S.clusters.set(String(c.id), { id: String(c.id), name: c.name, macro: c.macro, gx: c.x || 0, gz: c.z || 0, n: secs.length });
    for (const s of secs) {
      const rec = { id: String(s.id), name: s.name, macro: (s.macro || "").toLowerCase(), owner: s.owner, res: s.res,
                    cid: String(c.id), cname: c.name, multi: secs.length > 1,
                    gx: (c.x || 0) + (s.x || 0) * k, gz: (c.z || 0) + (s.z || 0) * k,
                    rx: (c.x || 0) + (s.x || 0), rz: (c.z || 0) + (s.z || 0) };
      S.sectors.set(rec.id, rec);
      if (rec.macro) S.sectorByMacro.set(rec.macro, rec.id);
    }
  }
  rebuildLinks();
  bus.emit("galaxy");
}

function rebuildLinks() {
  const seen = new Set();
  S.links = [];
  S.stubs = [];
  S.gatesBySector = new Map();
  const add = (a, b, kind) => {
    if (!a || !b || a === b || !S.sectors.has(a) || !S.sectors.has(b)) return;
    const key = [a, b].sort().join("|") + kind;
    if (seen.has(key)) return;
    seen.add(key);
    S.links.push({ a, b, kind });
  };
  for (const g of S.gates || []) {
    if (g.ds) add(String(g.s), String(g.ds), g.hw ? "hw" : "gate");
    else if (g.du && !g.hw) S.stubs.push({ s: String(g.s), x: g.x || 0, z: g.z || 0 });   // known gate, unknown destination: "?"
    if (!S.gatesBySector.has(String(g.s))) S.gatesBySector.set(String(g.s), []);
    S.gatesBySector.get(String(g.s)).push(g);
  }
  for (const [a, b] of S.hwlinks || []) add(String(a), String(b), "hw");
}

export function sectorName(id) {
  if (!id) return "–";
  const s = S.sectors.get(String(id));
  return s ? s.name : "?";
}
export function factionName(id) {
  if (!id) return "–";
  const f = S.factions[id];
  return f ? f.n : id;
}

// ---------------------------------------------------------------- applying server messages
const LOG_ALERT_CATS = new Set(["alerts"]);

function addLog(items, initial) {
  let alerts = 0;
  for (const e of items) {
    e._new = !initial;
    S.log.push(e);
    if (!initial && LOG_ALERT_CATS.has(e.cat)) alerts++;
  }
  S.log.sort((a, b) => (a.t || 0) - (b.t || 0));
  if (S.log.length > 3000) S.log.splice(0, S.log.length - 3000);
  bus.emit("log", { items, initial });
  if (alerts) bus.emit("alert", items.filter((e) => LOG_ALERT_CATS.has(e.cat)));
}

function onPlayer(p) {
  const now = performance.now();
  const prev = S.player;
  if (prev && prev.object && p.object && prev.sector && p.sector && prev.sector.id === p.sector.id) {
    const dt = (p.t ?? 0) - (prev.t ?? 0);
    if (dt > 0.05 && dt < 5) {
      const dx = p.object.x - prev.object.x, dz = p.object.z - prev.object.z;
      const v = Math.hypot(dx, dz) / dt;
      S.speedEst = S.speedEst === null ? v : S.speedEst * 0.6 + v * 0.4;
      // yaw convention vote: compare motion heading with (sin yaw, cos yaw) and its mirror
      if (v > 30 && typeof p.object.yaw === "number") {
        const hm = Math.atan2(dx, dz);
        const da = angDiff(hm, p.object.yaw), db = angDiff(hm, -p.object.yaw), dc = angDiff(hm, p.object.yaw * Math.PI / 180);
        const best = Math.min(da, db, dc);
        if (best < 0.35) { if (best === da) S.yaw.a++; else if (best === db) S.yaw.b++; else S.yaw.c++; }
      }
    }
  } else if (prev && prev.sector && p.sector && prev.sector.id !== p.sector.id) {
    bus.emit("sectorchange", { from: prev.sector, to: p.sector });
  }
  S.prevPlayer = prev;
  S.player = p;
  S.playerAt = now;
  bus.emit("player", p);
}
function angDiff(a, b) { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; }

export function yawConvention() {
  const { a, b, c } = S.yaw;
  if (a + b + c < 5) return "a";
  if (b > a && b > c) return "b";
  if (c > a && c > b) return "c";
  return "a";
}
export function headingOf(yaw) {     // returns screen heading angle in world (x east, z north), radians from north
  const conv = yawConvention();
  if (conv === "b") return -yaw;
  if (conv === "c") return yaw * Math.PI / 180;
  return yaw;
}

function apply(m) {
  switch (m.type) {
    case "init":
      S.hwlinks = m.hwlinks || [];
      S.hello = m.hello;
      S.liveGalaxy = m.galaxy;
      S.gates = m.gates || [];
      S.scans = m.sectors || {};
      S.property = new Map((m.property || []).map((e) => [String(e.id), e]));
      S.propertyMeta = m.property_meta || {};
      S.log = [];
      addLog(m.log || [], true);
      S.ticker = m.ticker || [];
      if (m.player) onPlayer(m.player);
      for (const k of ["messages", "missions", "offers", "factions", "economy", "stats"]) if (m[k]) apply(m[k]);
      if (m.status) apply(m.status);
      rebuildGalaxy();
      bus.emit("property"); bus.emit("ticker"); bus.emit("scan", null);
      break;
    case "status": {
      const prevGame = S.status && S.status.game;
      S.status = m;
      bus.emit("status", m);
      if (prevGame !== m.game) bus.emit("gamestate", m.game);
      break;
    }
    case "hello": S.hello = m.hello; bus.emit("hello"); break;
    case "player": onPlayer(m); break;
    case "galaxy": S.liveGalaxy = m.clusters; rebuildGalaxy(); break;
    case "gates": S.gates = m.gates || []; rebuildLinks(); bus.emit("galaxy"); break;
    case "hwlinks": S.hwlinks = m.links || []; rebuildLinks(); bus.emit("galaxy"); break;
    case "sector": S.scans[m.sid] = m; bus.emit("scan", m.sid); break;
    case "property":
      for (const e of m.upd || []) S.property.set(String(e.id), e);
      for (const k of m.del || []) S.property.delete(String(k));
      if (m.meta) S.propertyMeta = m.meta;
      bus.emit("property");
      break;
    case "log": addLog(m.items || [], !!m.initial); break;
    case "ticker":
      S.ticker.push(...(m.items || []));
      if (S.ticker.length > 600) S.ticker.splice(0, S.ticker.length - 600);
      bus.emit("ticker", m.items);
      break;
    case "messages": S.messages = m; bus.emit("messages"); break;
    case "missions": S.missions = m.items || []; bus.emit("missions"); break;
    case "offers": S.offers = m.items || []; bus.emit("missions"); break;
    case "factions":
      S.factionList = m.items || [];
      S.factions = Object.fromEntries(S.factionList.map((f) => [f.id, f]));
      bus.emit("factions");
      break;
    case "economy": S.economy = m; bus.emit("economy"); break;
    case "stats": S.stats = m; bus.emit("stats"); break;
    case "hotkey": onHotkey(m); break;
    case "control": S.control = !!m.enabled; S.originOk = m.origin_ok; bus.emit("control"); break;
    case "cmdreply": if (!m.ok) toast(`Parancs (${m.cmd}): ${m.msg}`, "bad"); break;
    case "ack":
      S.lastAck = m;
      if (m.mine) toast(`${m.ok ? "✓" : "✗"} ${m.cmd}: ${m.msg || ""}`, m.ok ? "ok" : "bad");
      bus.emit("ack", m);
      break;
    default: break;
  }
}

// ---------------------------------------------------------------- WebSocket
let ws = null;
let retryMs = 500;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    S.wsOpen = true; retryMs = 500; bus.emit("ws");
    if (S.control) send({ type: "control", enabled: true });
    if (watchSid) send({ type: "watch", sid: watchSid });
  };
  ws.onclose = () => {
    S.wsOpen = false; bus.emit("ws");
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    apply(m);
  };
}
export function send(obj) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}
let cmdId = 0;
export function command(cmd, ...args) {
  if (!S.control) { toast("A vezérlés nincs engedélyezve (felső sáv: „Vezérlés”).", "warn"); return; }
  send({ type: "cmd", cmd, args: args.map(String), id: ++cmdId });
}
export function setControl(on) {
  S.control = !!on;
  send({ type: "control", enabled: !!on });
  bus.emit("control");
}
let watchSid = null;
export function watchSector(sid) {
  sid = sid ? String(sid) : null;
  if (sid && S.player && S.player.sector && S.player.sector.id === sid) sid = null;
  if (sid === watchSid) return;
  watchSid = sid;
  send({ type: "watch", sid: sid || "0" });
}

// ---------------------------------------------------------------- toasts / banners
export function toast(text, kind = "info", ms = 4000) {
  const box = $("#toasts");
  if (!box) return;
  const t = el("div", { class: "toast " + kind, text });
  box.appendChild(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 600);
  while (box.children.length > 5) box.firstChild.remove();
}

// ---------------------------------------------------------------- selection / drawer
export function select(sel) {      // { kind: "obj"|"sector", id, from }
  S.selected = sel;
  bus.emit("select", sel);
}

// ---------------------------------------------------------------- in-game hotkeys
const HK_HU = {
  panel_next: "következő panel", view_toggle: "galaxis / szektor", zoom_in: "nagyítás", zoom_out: "kicsinyítés",
  ship_next: "következő saját hajó", ship_prev: "előző saját hajó", log_down: "napló lejjebb", log_up: "napló feljebb",
  show_selected: "kijelölt objektum", auto: "automata kijelző", ack_alerts: "riasztások nyugtázva",
};
function onHotkey(m) {
  toast("Gyorsgomb: " + (HK_HU[m.action] || m.action), "info", 1800);
  bus.emit("hotkey", m);
  switch (m.action) {
    case "panel_next": sideNext(); break;
    case "ack_alerts": P.markAllRead(); break;
    case "auto": select(null); bus.emit("auto"); break;
    case "show_selected":
      if (m.obj) select({ kind: "obj", id: String(m.obj), from: "hotkey" });
      break;
    case "ship_next": case "ship_prev": {
      const ids = P.shipOrder();
      if (!ids.length) break;
      const cur = S.selected && S.selected.kind === "obj" ? ids.indexOf(S.selected.id) : -1;
      const d = m.action === "ship_next" ? 1 : -1;
      const i = cur < 0 ? (d > 0 ? 0 : ids.length - 1) : (cur + d + ids.length) % ids.length;
      select({ kind: "obj", id: ids[i], from: "hotkey" });
      break;
    }
    default: break;   // view/zoom/log handled by the map / log panel listeners
  }
}

// ---------------------------------------------------------------- side tabs
const SIDE_TABS = [["log", "Napló"], ["missions", "Küldetések"], ["factions", "Frakciók"], ["economy", "Gazdaság"], ["diag", "Állapot"]];
const layoutCfg = loadSettings("layout", { side: "log", font: 100, auto: true });
let sideTab = layoutCfg.side;
function setSide(tab) {
  sideTab = tab;
  layoutCfg.side = tab;
  saveSettings("layout", layoutCfg);
  for (const b of $$("#sidetabs button")) b.classList.toggle("on", b.dataset.tab === tab);
  for (const p of $$("#side .tabpanel")) p.hidden = p.dataset.tab !== tab;
  bus.emit("sidetab", tab);
}
function sideNext() {
  const i = SIDE_TABS.findIndex(([k]) => k === sideTab);
  setSide(SIDE_TABS[(i + 1) % SIDE_TABS.length][0]);
}
export function showSide(tab) { setSide(tab); }

// ---------------------------------------------------------------- top bar
function renderTop() {
  const p = S.player;
  const o = p && p.object;
  const st = S.status;
  const state = !S.wsOpen ? "noserver" : (st ? st.game : "disconnected");
  const STATE_HU = { live: "élő", paused: "játék szünetel", background: "játék háttérben", disconnected: "nincs kapcsolat a játékkal",
                     connected: "csatlakozva, adatra vár", noserver: "nincs kapcsolat a szerverrel" };
  document.body.dataset.state = state;
  $("#st-state").textContent = STATE_HU[state] || state;
  $("#st-state").className = "pill " + ({ live: "ok", paused: "warn", background: "warn", connected: "warn" }[state] || "bad");
  const age = st && st.last_rx_age;
  $("#st-age").textContent = age === null || age === undefined ? "" : (age < 2 ? "" : `utolsó adat ${num(age)} mp`);
  $("#st-name").textContent = p ? (p.name || "–") : "–";
  $("#st-money").textContent = p ? money(p.money) : "–";
  $("#st-sector").textContent = p && p.sector ? p.sector.name : "–";
  $("#st-time").textContent = p ? gameTime(p.gametime) : "–";
  $("#st-ship").textContent = o ? `${o.name || "–"}${o.code ? " (" + o.code + ")" : ""}` : "–";
  $("#st-where").textContent = p ? whereText(p.where) : "";
  setBar("#st-hull", o && o.hull); setBar("#st-shield", o && o.shield);
  const sp = (o && typeof o.speed === "number") ? o.speed : S.speedEst;
  $("#st-speed").textContent = sp === null || sp === undefined ? "–" : num(sp) + " m/s";
  const t = p && p.target;
  $("#st-target").textContent = t ? `${t.name || "?"} · ${dist(t.dist)}${t.hull !== undefined && t.hull !== null ? " · " + num(t.hull) + "%" : ""}` : "nincs célpont";
  $("#st-target").className = t ? (t.hostile ? "hostile" : t.enemy ? "enemy" : "") : "muted";
  $("#st-mission").textContent = p && p.mission ? (p.mission.name || "küldetés") : "";
}
export function whereText(w) {
  if (!w) return "";
  const n = w.name || "?";
  const dock = w.docked ? `, dokkolva: ${w.docked}` : "";
  switch (w.mode) {
    case "pilot": return `Pilóta: ${n}${dock}`;
    case "passenger": return `Utas: ${n} fedélzetén${dock}`;
    case "station": return `Gyalog: ${n} állomáson`;
    case "aboard": return `Gyalog: ${n} fedélzetén`;
    case "spacesuit": return "Űrruhában";
    default: return n;
  }
}
function setBar(sel, v) {
  const e = $(sel);
  if (!e) return;
  const pct = v === null || v === undefined ? 0 : Math.max(0, Math.min(100, v));
  e.firstChild.style.width = pct + "%";
  e.title = v === null || v === undefined ? "–" : num(v) + " %";
}

function renderControl() {
  const b = $("#btn-control");
  b.classList.toggle("on", S.control);
  b.textContent = S.control ? "Vezérlés: BE" : "Vezérlés engedélyezése";
  document.body.classList.toggle("control", S.control);
}

// ---------------------------------------------------------------- alert banner (no sound, visual only)
function showAlert(items) {
  const last = items[items.length - 1];
  const bn = $("#alertbanner");
  bn.textContent = "⚠ " + (last.ti || "Riasztás") + (items.length > 1 ? `  (+${items.length - 1})` : "");
  bn.hidden = false;
  bn.classList.remove("flash"); void bn.offsetWidth; bn.classList.add("flash");
  clearTimeout(showAlert.t);
  showAlert.t = setTimeout(() => { bn.hidden = true; }, 12000);
  if (layoutCfg.auto && !SINGLE) {
    if (sideTab !== "log") { showAlert.prevTab = sideTab; setSide("log"); setTimeout(() => { if (showAlert.prevTab) setSide(showAlert.prevTab); showAlert.prevTab = null; }, 15000); }
    P.focusLogCategory("alerts");
  }
}

// ---------------------------------------------------------------- layout
function buildLayout() {
  document.documentElement.style.fontSize = (layoutCfg.font || 100) + "%";
  const side = $("#side");
  const tabs = $("#sidetabs");
  for (const [k, label] of SIDE_TABS) {
    tabs.appendChild(el("button", { "data-tab": k, onclick: () => setSide(k), title: "Panel: " + label }, label));
    side.appendChild(el("div", { class: "tabpanel", "data-tab": k, hidden: true }));
  }
  const map = new MapView($("#map-panel"), { S, bus, select, sectorName, factionName, watchSector, headingOf, whereText, single: SINGLE === "map" });
  window.__x4map = map;
  P.mountProperty($("#property-panel"), { S, bus, select, sectorName, factionName });
  P.mountLog($('#side .tabpanel[data-tab="log"]'), { S, bus, select });
  P.mountMissions($('#side .tabpanel[data-tab="missions"]'), { S, bus, select, sectorName, factionName, command });
  P.mountFactions($('#side .tabpanel[data-tab="factions"]'), { S, bus });
  P.mountEconomy($('#side .tabpanel[data-tab="economy"]'), { S, bus });
  P.mountDiag($('#side .tabpanel[data-tab="diag"]'), { S, bus, yawConvention, send });
  P.mountDrawer($("#drawer"), { S, bus, select, sectorName, factionName, command, watchSector });
  setSide(sideTab);

  for (const b of $$(".popout")) {
    b.addEventListener("click", () => {
      const panel = b.dataset.panel === "side" ? sideTab : b.dataset.panel;
      window.open(`/?panel=${panel}`, "x4c_" + panel, "width=1200,height=900");
    });
  }
  $("#btn-control").addEventListener("click", () => {
    if (!S.control && !confirm("Vezérlés engedélyezése: a böngészőből parancsokat küldhetsz a játéknak (térkép megnyitása, célpont, útvonal; a mod engedélyezőlistája szerint). Bekapcsolod?")) return;
    setControl(!S.control);
  });
  $("#btn-auto").classList.toggle("on", layoutCfg.auto);
  $("#btn-auto").addEventListener("click", () => {
    layoutCfg.auto = !layoutCfg.auto; saveSettings("layout", layoutCfg);
    $("#btn-auto").classList.toggle("on", layoutCfg.auto);
    bus.emit("autocfg", layoutCfg.auto);
  });
  $("#btn-font").addEventListener("click", () => {
    const steps = [90, 100, 112, 125, 140];
    layoutCfg.font = steps[(steps.indexOf(layoutCfg.font) + 1) % steps.length] || 100;
    document.documentElement.style.fontSize = layoutCfg.font + "%";
    saveSettings("layout", layoutCfg);
    bus.emit("resize");
  });
  if (SINGLE) {
    document.body.classList.add("single");
    const map = { map: "#map-panel", property: "#property-panel", player: "#topbar" };
    if (map[SINGLE]) document.body.dataset.single = SINGLE;
    else if (SIDE_TABS.some(([k]) => k === SINGLE)) { document.body.dataset.single = "side"; setSide(SINGLE); }
    document.title = "X4 Companion – " + SINGLE;
  }

  // keyboard: "/" search, Esc close drawer, g/s map view, +/- zoom, f auto-follow
  window.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (e.key === "/") { e.preventDefault(); const s = $("#property-panel input[type=search]"); if (s) s.focus(); }
    else if (e.key === "Escape") select(null);
    else if (e.key === "g") bus.emit("hotkey", { action: "view_toggle" });
    else if (e.key === "+" || e.key === "=") bus.emit("hotkey", { action: "zoom_in" });
    else if (e.key === "-") bus.emit("hotkey", { action: "zoom_out" });
    else if (e.key === "a") bus.emit("auto");
    else if (e.key === "n") onHotkey({ action: "ship_next" });
    else if (e.key === "Tab" && !SINGLE) { e.preventDefault(); sideNext(); }
  });
}

bus.on("player", throttle(renderTop, 200));
bus.on("status", renderTop);
bus.on("ws", renderTop);
bus.on("control", renderControl);
bus.on("alert", showAlert);
bus.on("sectorchange", ({ to }) => toast("Ugrás: " + (to.name || "új szektor"), "info", 3500));
bus.on("gamestate", (g) => {
  if (g === "background") toast("A játék háttérben van vagy megállt – az utolsó ismert adatok látszanak.", "warn", 6000);
});

buildLayout();
renderTop();
renderControl();
connect();
setInterval(renderTop, 1000);
