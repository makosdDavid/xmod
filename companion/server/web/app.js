// X4 Companion — app core: state store, WebSocket, navigation (views), dock modules, keyboard,
// in-game hotkeys, details polling, the game's theme and icons.
"use strict";
import { $, $$, el, num, money, dist, gameTime, loadSettings, saveSettings, throttle } from "./util.js";
import { MapView } from "./map.js";
import * as P from "./panels.js";
import { Dock } from "./dock.js";
import { iconEl, icon } from "./icons.js";
import { setIconIndex } from "./mapstyle.js";

// ---------------------------------------------------------------- event bus + store
const handlers = {};
export const bus = {
  on(name, fn) { (handlers[name] ||= []).push(fn); },
  emit(name, data) { for (const fn of handlers[name] || []) { try { fn(data); } catch (e) { console.error(name, e); } } },
};

export const S = {
  wsOpen: false, status: null, hello: null, control: false, originOk: true, theme: null,
  liveGalaxy: null, hwlinks: [],
  sectors: new Map(), clusters: new Map(), sectorByMacro: new Map(), links: [], stubs: [], gates: [], gatesBySector: new Map(),
  scans: {}, property: new Map(), propertyMeta: {}, details: {},
  log: [], ticker: [], readUpTo: {}, messages: null, missions: [], offers: [], factions: {}, factionList: [],
  economy: null, stats: null, player: null, playerAt: 0, prevPlayer: null, speedEst: null,
  yaw: { a: 0, b: 0, c: 0 }, selected: null, lastAck: null, icons: 0,
};
window.__x4c = S;   // for debugging in the browser console

const params = new URLSearchParams(location.search);
export const SINGLE = params.get("panel");   // "↗ külön ablakba": one module in its own window

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
  // gates seen in sector scans also give links (the gate list may lag behind)
  for (const [sid, sc] of Object.entries(S.scans)) for (const o of sc.objs || []) {
    if ((o.c === "gate" || o.c === "highwayentrygate") && o.ds) add(String(sid), String(o.ds), o.c === "gate" ? "gate" : "hw");
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
  S.playerAt = performance.now();
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
export function headingOf(yaw) {     // screen heading angle in world (x east, z north), radians from north
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
      if (m.theme) { S.theme = m.theme; bus.emit("theme"); }
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
    case "theme": S.theme = m; bus.emit("theme"); break;
    case "player": onPlayer(m); break;
    case "galaxy": S.liveGalaxy = m.clusters; rebuildGalaxy(); break;
    case "gates": S.gates = m.gates || []; rebuildLinks(); bus.emit("galaxy"); break;
    case "hwlinks": S.hwlinks = m.links || []; rebuildLinks(); bus.emit("galaxy"); break;
    case "sector": {
      const before = S.links.length;
      S.scans[m.sid] = m;
      if ((m.objs || []).some((o) => o.ds)) { rebuildLinks(); if (S.links.length !== before) bus.emit("galaxy"); }
      bus.emit("scan", m.sid);
      break;
    }
    case "property":
      for (const e of m.upd || []) S.property.set(String(e.id), e);
      for (const k of m.del || []) S.property.delete(String(k));
      if (m.meta) S.propertyMeta = m.meta;
      bus.emit("property");
      break;
    case "details": S.details[String(m.id)] = m; bus.emit("details", m.id); break;
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
    case "cmdreply": if (!m.ok && m.cmd !== "details") toast(`Parancs (${m.cmd}): ${m.msg}`, "bad"); break;
    case "ack":
      S.lastAck = m;
      if (m.cmd === "details") {
        if (!m.ok && detailsPending.has(m.seq)) { S.details[detailsPending.get(m.seq)] = null; bus.emit("details"); }
        detailsPending.delete(m.seq);
        break;
      }
      if (m.mine) toast(`${m.ok ? "✓" : "✗"} ${CMD_HU[m.cmd] || m.cmd}: ${m.msg || ""}`, m.ok ? "ok" : "bad");
      bus.emit("ack", m);
      break;
    default: break;
  }
}
const CMD_HU = { openmap: "játék térképe", select: "kijelölés", target: "célpont", guidance: "útvonal", guidance_end: "útvonal törlése", stop: "állj", flyto: "repülj ide" };

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
    applyWrapped(m);
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

// details (info panel + order lines): read-only, no control switch needed; refreshed while selected
const detailsPending = new Map();
function requestDetails(id) {
  if (!id || !/^\d+$/.test(id)) return;
  const myId = ++cmdId;
  send({ type: "cmd", cmd: "details", args: [id], id: myId });
  // the server tells the seq in cmdreply; remember by id until the ack arrives
  pendingById.set(myId, id);
}
const pendingById = new Map();
function applyWrapped(m) {
  if (m.type === "cmdreply" && m.cmd === "details" && pendingById.has(m.id)) {
    if (m.ok && m.seq) detailsPending.set(m.seq, pendingById.get(m.id));
    else S.details[pendingById.get(m.id)] = null;
    pendingById.delete(m.id);
  }
  apply(m);
}
setInterval(() => {
  const sel = S.selected;
  if (sel && sel.kind === "obj" && document.visibilityState === "visible") requestDetails(sel.id);
}, 4000);

// ---------------------------------------------------------------- toasts
export function toast(text, kind = "info", ms = 4000) {
  const box = $("#toasts");
  if (!box) return;
  const t = el("div", { class: "toast " + kind, text });
  box.appendChild(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 600);
  while (box.children.length > 5) box.firstChild.remove();
}

// ---------------------------------------------------------------- selection
export function select(sel) {      // { kind: "obj"|"sector", id, from }
  S.selected = sel;
  if (sel && sel.kind === "obj") {
    if (S.details[sel.id] === null) delete S.details[sel.id];
    requestDetails(sel.id);
  }
  bus.emit("select", sel);
}

// ---------------------------------------------------------------- modules, views, layout
const MODULES = [
  { id: "map", title: "Térkép", icon: "map" },
  { id: "objects", title: "Objektumok", icon: "objects" },
  { id: "info", title: "Info", icon: "info" },
  { id: "property", title: "Tulajdon", icon: "ships" },
  { id: "log", title: "Napló", icon: "log" },
  { id: "missions", title: "Küldetések", icon: "missions" },
  { id: "factions", title: "Frakciók", icon: "factions" },
  { id: "economy", title: "Gazdaság", icon: "economy" },
  { id: "diag", title: "Állapot", icon: "status" },
  { id: "hotkeys", title: "Gyorsgombok", icon: "keyboard" },
];
const PRESETS = {
  nav: { label: "Navigáció", mods: { map: [0, 0, 8, 12], objects: [8, 0, 4, 6], info: [8, 6, 4, 6] } },
  fleet: { label: "Flotta", mods: { map: [0, 0, 6, 12], property: [6, 0, 6, 7], info: [6, 7, 3, 5], log: [9, 7, 3, 5] } },
  combat: { label: "Harc", mods: { map: [0, 0, 8, 12], objects: [8, 0, 4, 5], info: [8, 5, 4, 4], log: [8, 9, 4, 3] } },
  all: { label: "Minden", mods: { map: [0, 0, 6, 7], objects: [6, 0, 3, 4], info: [9, 0, 3, 4], property: [6, 4, 6, 3],
                                 log: [0, 7, 4, 5], missions: [4, 7, 3, 5], factions: [7, 7, 3, 5], economy: [10, 7, 2, 5] } },
};
// navigation: 1-8; "map" and "galaxy" show the workspace, the others one module full size
const VIEWS = [
  { id: "map", label: "Térkép", icon: "map", key: "1" }, { id: "galaxy", label: "Galaxis", icon: "galaxy", key: "2" },
  { id: "property", label: "Tulajdon", icon: "ships", key: "3" }, { id: "log", label: "Napló", icon: "log", key: "4" },
  { id: "missions", label: "Küldetések", icon: "missions", key: "5" }, { id: "factions", label: "Frakciók", icon: "factions", key: "6" },
  { id: "economy", label: "Gazdaság", icon: "economy", key: "7" }, { id: "diag", label: "Állapot", icon: "status", key: "8" },
];
const layoutCfg = loadSettings("layout", { font: 100, view: "map" });
let dock = null, map = null, view = "map", lastList = "objects";

function setView(id) {
  if (!VIEWS.some((v) => v.id === id) && !MODULES.some((m) => m.id === id)) id = "map";
  view = id;
  if (id === "map" || id === "galaxy") {
    dock.unfocus();
    if (map) map.setMode(id === "galaxy" ? "galaxy" : "sector");
  } else {
    dock.focus(id);
    if (P.LISTS[id]) lastList = id;
  }
  layoutCfg.view = id; saveSettings("layout", layoutCfg);
  renderNav();
}
function viewStep(d) {
  const i = Math.max(0, VIEWS.findIndex((v) => v.id === view));
  setView(VIEWS[(i + d + VIEWS.length) % VIEWS.length].id);
}
function renderNav() {
  const mapMode = map ? map.mode : "sector";
  const active = (view === "map" || view === "galaxy") ? (mapMode === "galaxy" ? "galaxy" : "map") : view;
  for (const b of $$("#views .view")) {
    const on = b.dataset.view === active;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  document.body.classList.toggle("on-map", view === "map" || view === "galaxy");
  renderModulesMenu();
}
const badges = {};
function setBadge(id, n, alert) {
  badges[id] = { n, alert };
  const b = $(`#views .view[data-view="${id}"] .vbadge`);
  if (b) { b.textContent = n ? (n > 99 ? "99+" : String(n)) : ""; b.classList.toggle("alert", !!alert); }
}

function renderModulesMenu() {
  const pop = $("#menu-modules .menu-pop");
  if (!pop || !dock) return;
  pop.replaceChildren(...MODULES.map((m) => {
    const vis = !dock.layout.mods[m.id].hidden;
    const b = el("button", { class: "menu-item" + (vis ? " on" : ""), onclick: () => { dock.toggle(m.id); if (view !== "map" && view !== "galaxy") setView("map"); renderModulesMenu(); } });
    b.append(el("span", { class: "check" }, vis ? "✓" : ""), iconEl(m.icon, 15), el("span", {}, m.title));
    return b;
  }), el("div", { class: "menu-sep" }), el("div", { class: "menu-hint" }, "Modul: fejléc húzása = mozgatás, szél húzása = méret, dupla katt = teljes méret"));
}
function buildLayoutMenu() {
  const pop = $("#menu-layout .menu-pop");
  pop.replaceChildren(...Object.entries(PRESETS).map(([k, p]) => el("button", { class: "menu-item", onclick: () => { dock.applyPreset(k); setView("map"); closeMenus(); toast("Elrendezés: " + p.label, "info", 1500); } }, p.label)),
    el("div", { class: "menu-sep" }),
    el("button", { class: "menu-item", onclick: () => { dock.reset(); setView("map"); closeMenus(); toast("Elrendezés alaphelyzetben", "info", 1500); } }, "Alaphelyzet"));
}
function closeMenus() { for (const p of $$(".menu-pop")) p.hidden = true; }

function buildLayout() {
  document.documentElement.style.fontSize = (layoutCfg.font || 100) + "%";
  const ctx = { S, bus, select, sectorName, factionName, command, watchSector, whereText, yawConvention, send, setBadge,
                details: (id) => S.details[id], centerOn: (id) => { setView("map"); map && map.centerOn(id); },
                getMapSid: () => (map ? map.currentSid() : (S.player && S.player.sector ? S.player.sector.id : null)),
                infoVisible: () => dock && dock.isVisible("info") };
  const mounts = {
    map: (mod) => { map = new MapView(mod, { S, bus, select, sectorName, factionName, watchSector, headingOf, whereText }); window.__x4map = map; },
    objects: (mod) => P.mountObjects(mod, ctx), info: (mod) => P.mountInfo(mod, ctx), property: (mod) => P.mountProperty(mod, ctx),
    log: (mod) => P.mountLog(mod, ctx), missions: (mod) => P.mountMissions(mod, ctx), factions: (mod) => P.mountFactions(mod, ctx),
    economy: (mod) => P.mountEconomy(mod, ctx), diag: (mod) => P.mountDiag(mod, ctx), hotkeys: (mod) => P.mountHotkeys(mod, ctx),
  };
  dock = new Dock($("#work"), MODULES.map((m) => ({ ...m, mount: mounts[m.id] })),
    { presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, p])), defaultPreset: "nav", single: SINGLE,
      onChange: () => { renderNav(); bus.emit("layout"); } });
  window.__x4dock = dock;
  P.mountDrawer($("#drawer"), ctx);

  // navigation
  const views = $("#views");
  for (const v of VIEWS) {
    const b = el("button", { class: "view", role: "tab", "data-view": v.id, title: `${v.label} (${v.key})`, onclick: () => setView(v.id) });
    b.append(iconEl(v.icon, 17), el("span", { class: "vlabel" }, v.label), el("kbd", {}, v.key), el("span", { class: "vbadge" }));
    views.appendChild(b);
  }
  const back = el("button", { class: "backmap", title: "Vissza a térképre (Esc)", onclick: () => { setView("map"); } });
  back.append(iconEl("back", 16), el("span", {}, "Vissza a térképre"));
  views.after(back);
  for (const m of $$(".menu")) {
    m.querySelector(".menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = m.querySelector(".menu-pop");
      const was = pop.hidden;
      closeMenus();
      pop.hidden = !was;
    });
  }
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) closeMenus(); });
  buildLayoutMenu();
  bus.on("mapmode", () => { if (view === "map" || view === "galaxy") { view = map.mode === "galaxy" ? "galaxy" : "map"; } renderNav(); });

  $("#btn-help").appendChild(iconEl("keyboard", 17));
  $("#btn-help").addEventListener("click", () => setView("hotkeys"));
  $("#btn-control").addEventListener("click", () => {
    if (!S.control && !confirm("Vezérlés engedélyezése: a böngészőből parancsokat küldhetsz a játéknak (térkép megnyitása, célpont, útvonal; a mod engedélyezőlistája szerint). Bekapcsolod?")) return;
    setControl(!S.control);
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
    document.title = "X4 Companion – " + ((MODULES.find((m) => m.id === SINGLE) || {}).title || SINGLE);
  }
  setView(SINGLE ? "map" : (layoutCfg.view || "map"));

  // keyboard
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    const v = VIEWS.find((x) => x.key === e.key);
    if (v && !SINGLE) { e.preventDefault(); setView(v.id); return; }
    switch (e.key) {
      case "Escape":
        if (view !== "map" && view !== "galaxy") setView("map");
        else if (S.selected) select(null);
        else bus.emit("auto");
        break;
      case "+": case "=": case "Add": bus.emit("hotkey", { action: "zoom_in" }); break;
      case "-": case "_": case "Subtract": bus.emit("hotkey", { action: "zoom_out" }); break;
      case "0": bus.emit("hotkey", { action: "zoom_fit" }); break;
      case "g": bus.emit("hotkey", { action: "view_toggle" }); break;
      case "a": bus.emit("auto"); break;
      case "n": onHotkey({ action: "ship_next", local: true }); break;
      case "N": onHotkey({ action: "ship_prev", local: true }); break;
      case "ArrowDown": if (activeList()) { e.preventDefault(); activeList().move(1); } break;
      case "ArrowUp": if (activeList()) { e.preventDefault(); activeList().move(-1); } break;
      case "Enter": if (activeList()) { e.preventDefault(); activeList().activate(); } break;
      case "/": { e.preventDefault(); setView("property"); const s = $('.mod[data-id="property"] input[type=search]'); if (s) s.focus(); break; }
      case "?": setView("hotkeys"); break;
      default: break;
    }
  });
  document.addEventListener("pointerdown", (e) => {
    const mod = e.target.closest && e.target.closest(".mod");
    if (mod && P.LISTS[mod.dataset.id]) lastList = mod.dataset.id;
  }, true);
}

function activeList() {
  if (view !== "map" && view !== "galaxy" && P.LISTS[view]) return P.LISTS[view];
  if (P.LISTS[lastList] && dock.isVisible(lastList)) return P.LISTS[lastList];
  for (const id of ["objects", "property", "log", "missions"]) if (P.LISTS[id] && dock.isVisible(id)) return P.LISTS[id];
  return null;
}

// ---------------------------------------------------------------- in-game hotkeys
const HK_HU = Object.fromEntries(P.HOTKEY_HELP.map(([id, name]) => [id, name.replace("Companion: ", "")]));
let alertIdx = -1;
function onHotkey(m) {
  if (!m.local) toast("Gyorsgomb: " + (HK_HU[m.action] || m.action), "info", 1600);
  bus.emit("hotkeyraw", m);
  switch (m.action) {
    case "panel_next": viewStep(1); break;
    case "view_prev": viewStep(-1); break;
    case "view_map": setView("map"); break;
    case "view_toggle": if (view !== "map" && view !== "galaxy") setView("map"); bus.emit("hotkey", m); break;
    case "zoom_in": case "zoom_out": case "zoom_fit": if (view !== "map" && view !== "galaxy") setView("map"); bus.emit("hotkey", m); break;
    case "log_down": case "log_up": { const l = activeList(); if (l) l.move(m.action === "log_down" ? 1 : -1); break; }
    case "list_select": { const l = activeList(); if (l) l.activate(); break; }
    case "details": dock.toggle("info"); if (view !== "map" && view !== "galaxy") setView("map"); break;
    case "alert_next": {
      const al = P.alertEntries().filter((e) => e.ic);
      if (!al.length) { toast("Nincs riasztás objektummal", "info", 1500); break; }
      alertIdx = (alertIdx + 1) % al.length;
      const e = al[al.length - 1 - alertIdx];
      setView("map");
      select({ kind: "obj", id: String(e.ic), from: "hotkey" });
      toast("Riasztás: " + (e.ti || ""), "warn", 3000);
      break;
    }
    case "ack_alerts": P.markAllRead(); $("#alertbanner").hidden = true; break;
    case "auto": select(null); setView("map"); bus.emit("auto"); break;
    case "show_selected":
      if (m.obj) { setView("map"); select({ kind: "obj", id: String(m.obj), from: "hotkey" }); }
      else toast("A játékban nincs kijelölt / célzott objektum", "info", 1500);
      break;
    case "ship_next": case "ship_prev": {
      const ids = P.shipOrder();
      if (!ids.length) break;
      const cur = S.selected && S.selected.kind === "obj" ? ids.indexOf(S.selected.id) : -1;
      const d = m.action === "ship_next" ? 1 : -1;
      const i = cur < 0 ? (d > 0 ? 0 : ids.length - 1) : (cur + d + ids.length) % ids.length;
      if (view !== "map" && view !== "galaxy" && view !== "property") setView("map");
      select({ kind: "obj", id: ids[i], from: "hotkey" });
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------- top bar
function renderTop() {
  const p = S.player;
  const o = p && p.object;
  const st = S.status;
  const state = !S.wsOpen ? "noserver" : (st ? st.game : "disconnected");
  const STATE_HU = { live: "élő", paused: "szünet", background: "háttérben", disconnected: "nincs játék",
                     connected: "adatra vár", noserver: "nincs szerver" };
  document.body.dataset.state = state;
  $("#st-state").textContent = STATE_HU[state] || state;
  $("#st-state").className = "pill " + ({ live: "ok", paused: "warn", background: "warn", connected: "warn" }[state] || "bad");
  const age = st && st.last_rx_age;
  $("#st-age").textContent = age === null || age === undefined ? "" : (age < 2 ? "" : `${num(age)} mp`);
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
  $("#st-target").textContent = t ? `${t.name || "?"} · ${dist(t.dist)}${t.hull !== undefined && t.hull !== null ? " · " + num(t.hull) + "%" : ""}` : "nincs";
  $("#st-target").className = t ? (t.hostile ? "hostile" : t.enemy ? "enemy" : "") : "muted";
}
export function whereText(w) {
  if (!w) return "";
  const n = w.name || "?";
  const dock2 = w.docked ? `, dokkolva: ${w.docked}` : "";
  switch (w.mode) {
    case "pilot": return `Pilóta: ${n}${dock2}`;
    case "passenger": return `Utas: ${n} fedélzetén${dock2}`;
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
  b.textContent = S.control ? "Vezérlés: BE" : "Vezérlés";
  document.body.classList.toggle("control", S.control);
}

// ---------------------------------------------------------------- alert banner (visual only)
function showAlert(items) {
  const last = items[items.length - 1];
  const bn = $("#alertbanner");
  bn.replaceChildren(iconEl("alert", 16), el("span", {}, (last.ti || "Riasztás") + (items.length > 1 ? `  (+${items.length - 1})` : "")));
  bn.hidden = false;
  bn.onclick = () => { bn.hidden = true; if (last.ic) { setView("map"); select({ kind: "obj", id: String(last.ic), from: "alert" }); } else setView("log"); };
  bn.classList.remove("flash"); void bn.offsetWidth; bn.classList.add("flash");
  clearTimeout(showAlert.t);
  showAlert.t = setTimeout(() => { bn.hidden = true; }, 12000);
}

// ---------------------------------------------------------------- icons exported from the game
async function loadIcons() {
  try {
    const r = await fetch("/icons/index.json", { cache: "no-cache" });
    const d = await r.json();
    const names = Object.keys(d.icons || {});
    S.icons = names.length;
    setIconIndex(names.length ? names : null, throttle(() => bus.emit("icons"), 250));
    if (!names.length) toast("A játék térképikonjai nincsenek exportálva (export_icons.py) – rajzolt helyettesítők látszanak.", "warn", 8000);
  } catch (e) { setIconIndex(null); }
  bus.emit("icons");
}

bus.on("player", throttle(renderTop, 200));
bus.on("status", renderTop);
bus.on("ws", renderTop);
bus.on("control", renderControl);
bus.on("alert", showAlert);
bus.on("sectorchange", ({ to }) => toast("Ugrás: " + (to.name || "új szektor"), "info", 3000));
bus.on("gamestate", (g) => {
  if (g === "background") toast("A játék háttérben van vagy megállt – az utolsó ismert adatok látszanak.", "warn", 6000);
});

buildLayout();
renderTop();
renderControl();
loadIcons();
connect();
setInterval(renderTop, 1000);
