// X4 Companion — data store, event bus and websocket (framework-free; ported 1:1 from web/app.js).
// The state object `S` keeps exactly the shape the old shell had, because the framework-free map module
// (web/map.js) reads it directly. Every browser window (main or pop-out) runs its own copy of this
// module: its own websocket, its own init snapshot (the server sends the whole state on connect) and
// its own icon index.
import { galaxyIndex, setIconIndex, staticClusterIndex, takeSectorExtras } from "@web/mapstyle.js";
import { toast as sonner } from "sonner";
import { t } from "@/i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = Record<string, any>;
type Handler = (d?: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------- event bus
const handlers: Record<string, Handler[]> = {};
export const bus = {
  on(name: string, fn: Handler): () => void {
    (handlers[name] ||= []).push(fn);
    return () => { handlers[name] = (handlers[name] || []).filter((f) => f !== fn); };
  },
  emit(name: string, data?: unknown) {
    for (const fn of handlers[name] || []) {
      try { fn(data); } catch (e) { console.error(name, e); }
    }
  },
};

export interface Selection { kind: "obj" | "sector"; id: string; from?: string; obj?: Any; sid?: string | null }

export interface State {
  wsOpen: boolean; status: Any | null; hello: Any | null; control: boolean; originOk: boolean; theme: Any | null;
  liveGalaxy: Any[] | null; hwlinks: [string, string][]; staticMap: Any | null;
  sectors: Map<string, Any>; clusters: Map<string, Any>; sectorByMacro: Map<string, string>;
  links: { a: string; b: string; kind: string }[]; stubs: Any[]; gates: Any[]; gatesBySector: Map<string, Any[]>;
  scans: Record<string, Any>; resources?: Record<string, Any>; sectorInfo?: Record<string, Any>; property: Map<string, Any>; propertyMeta: Any; details: Record<string, Any | null | undefined>;
  log: Any[]; ticker: Any[]; messages: Any | null; missions: Any[]; offers: Any[]; factions: Record<string, Any>; factionList: Any[];
  economy: Any | null; stats: Any | null; player: Any | null; playerAt: number; prevPlayer: Any | null; speedEst: number | null;
  yaw: { a: number; b: number; c: number }; selected: Selection | null; lastAck: Any | null; icons: number; iconsLoaded: boolean;
}

export const S: State = {
  wsOpen: false, status: null, hello: null, control: false, originOk: true, theme: null,
  liveGalaxy: null, hwlinks: [], staticMap: null,
  sectors: new Map(), clusters: new Map(), sectorByMacro: new Map(), links: [], stubs: [], gates: [], gatesBySector: new Map(),
  scans: {}, property: new Map(), propertyMeta: {}, details: {},
  log: [], ticker: [], messages: null, missions: [], offers: [], factions: {}, factionList: [],
  economy: null, stats: null, player: null, playerAt: 0, prevPlayer: null, speedEst: null,
  yaw: { a: 0, b: 0, c: 0 }, selected: null, lastAck: null, icons: 0, iconsLoaded: false,
};
(window as unknown as Any).__x4c = S; // for debugging in the browser console

// ---------------------------------------------------------------- galaxy indexes
// Built by the map module's own galaxyIndex() (web/mapstyle.js, MAP-API.md "Data"), so the sector
// positions match the map's cluster hexagons. Only discovered data goes in: the live galaxy message.
function rebuildLinks() {
  const st = S.staticMap && Array.isArray(S.staticMap.clusters) && S.staticMap.clusters.length ? staticClusterIndex(S.staticMap) : null;
  const idx = galaxyIndex(S.liveGalaxy || [], S.gates || [], S.scans || {}, S.hwlinks || [], st);
  S.sectors = idx.sectors; S.clusters = idx.clusters; S.sectorByMacro = idx.sectorByMacro;
  S.links = idx.links; S.stubs = idx.stubs; S.gatesBySector = idx.gatesBySector;
}
function rebuildGalaxy() {
  rebuildLinks();
  bus.emit("galaxy");
}

export function sectorName(id: unknown): string {
  if (id === null || id === undefined || id === "") return "–";
  const s = S.sectors.get(String(id));
  return s && s.name ? String(s.name) : "?";
}
export function factionName(id: unknown): string {
  if (id === null || id === undefined || id === "") return "–";
  const f = S.factions[String(id)];
  if (!f && String(id) === "ownerless") return t("objects.ownerless");
  return f && f.n ? String(f.n) : String(id);
}

export function whereText(w: Any | null | undefined): string {
  if (!w) return "";
  const n = w.name || "?";
  const docked = w.docked ? t("where.docked", { name: w.docked }) : "";
  switch (w.mode) {
    case "pilot": return t("where.pilot", { name: n }) + docked;
    case "passenger": return t("where.passenger", { name: n }) + docked;
    case "station": return t("where.station", { name: n });
    case "aboard": return t("where.aboard", { name: n });
    case "spacesuit": return t("where.spacesuit");
    default: return String(n);
  }
}

// ---------------------------------------------------------------- applying server messages
const LOG_ALERT_CATS = new Set(["alerts"]);

function addLog(items: Any[], initial: boolean) {
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

function angDiff(a: number, b: number) { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; }

function onPlayer(p: Any) {
  const prev = S.player;
  if (prev && prev.object && p.object && prev.sector && p.sector && prev.sector.id === p.sector.id) {
    const dt = (p.t ?? 0) - (prev.t ?? 0);
    if (dt > 0.05 && dt < 5) {
      const dx = p.object.x - prev.object.x, dz = p.object.z - prev.object.z;
      const v = Math.hypot(dx, dz) / dt;
      if (Number.isFinite(v)) S.speedEst = S.speedEst === null ? v : S.speedEst * 0.6 + v * 0.4;
      // yaw convention vote: compare the motion heading with (sin yaw, cos yaw) and its mirror
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

export function yawConvention(): "a" | "b" | "c" {
  const { a, b, c } = S.yaw;
  if (a + b + c < 5) return "a";
  if (b > a && b > c) return "b";
  if (c > a && c > b) return "c";
  return "a";
}
export function headingOf(yaw: number): number {
  const conv = yawConvention();
  if (conv === "b") return -yaw;
  if (conv === "c") return yaw * Math.PI / 180;
  return yaw;
}

// server-side reply texts (server.py) -> tokens; texts from the mod itself are shown as they come
const SRV_MSG: Record<string, string> = {
  "érvénytelen parancs": "srv.invalid",
  "a parancsokhoz böngésző-Origin kell": "srv.need_origin",
  "a vezérlés nincs engedélyezve ezen a lapon": "srv.need_control",
  "túl sok parancs, lassíts": "srv.rate",
  "a mod ezt a parancsot nem engedi (CFG.allow)": "srv.not_allowed",
  "elküldve": "srv.sent",
  "a játék nincs csatlakozva": "srv.no_game",
};
export function serverText(msg: unknown): string {
  const s = typeof msg === "string" ? msg : "";
  return SRV_MSG[s] ? t(SRV_MSG[s]) : s;
}
export function cmdLabel(cmd: string): string {
  const k = "cmd." + cmd;
  const v = t(k);
  return v === k ? cmd : v;
}

function apply(m: Any) {
  switch (m.type) {
    case "init":
      S.hwlinks = m.hwlinks || [];
      S.staticMap = m.staticmap || null;
      S.hello = m.hello;
      S.liveGalaxy = m.galaxy;
      S.gates = m.gates || [];
      S.scans = Object.fromEntries(Object.entries(m.sectors || {}).map(([k, v]) => [k, takeSectorExtras(S, v)]));
      S.property = new Map((m.property || []).map((e: Any) => [String(e.id), e]));
      S.propertyMeta = m.property_meta || {};
      S.log = [];
      addLog(m.log || [], true);
      S.ticker = m.ticker || [];
      if (m.theme) { S.theme = m.theme; bus.emit("theme"); }
      if (m.player) onPlayer(m.player);
      for (const k of ["messages", "missions", "offers", "factions", "economy", "stats"]) if (m[k]) apply(m[k]);
      if (m.status) apply(m.status);
      rebuildGalaxy();
      bus.emit("property"); bus.emit("ticker"); bus.emit("scan", null); bus.emit("hello"); bus.emit("staticmap");
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
    case "staticmap": S.staticMap = { clusters: m.clusters || [] }; rebuildLinks(); bus.emit("staticmap"); bus.emit("galaxy"); break;
    case "sector": {
      const before = S.links.length;
      S.scans[m.sid] = takeSectorExtras(S, m);       // v1.2 bridge: resource areas + sector info ride along
      if ((m.objs || []).some((o: Any) => o.ds)) { rebuildLinks(); if (S.links.length !== before) bus.emit("galaxy"); }
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
    case "hotkey": bus.emit("ingamehotkey", m); break;
    case "control": S.control = !!m.enabled; S.originOk = m.origin_ok !== false; bus.emit("control"); break;
    case "cmdreply":
      if (!m.ok && m.cmd !== "details") toast(t("cmd.reply", { cmd: cmdLabel(m.cmd), msg: serverText(m.msg) }), "bad");
      break;
    case "ack":
      S.lastAck = m;
      if (m.cmd === "details") {
        if (!m.ok && detailsPending.has(m.seq)) { S.details[detailsPending.get(m.seq)!] = null; bus.emit("details"); }
        detailsPending.delete(m.seq);
        break;
      }
      if (m.mine) toast(`${cmdLabel(m.cmd)}${m.msg ? ": " + serverText(m.msg) : ""}`, m.ok ? "ok" : "bad");
      bus.emit("ack", m);
      break;
    default: break;
  }
}

// ---------------------------------------------------------------- WebSocket
let ws: WebSocket | null = null;
let retryMs = 500;
let watchSid: string | null = null;
let started = false;
let wsFailed = false;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    S.wsOpen = true; retryMs = 500; bus.emit("ws");
    if (S.control) send({ type: "control", enabled: true });
    if (watchSid) send({ type: "watch", sid: watchSid });
  };
  ws.onclose = () => {
    S.wsOpen = false; wsFailed = true; bus.emit("ws");
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
  ws.onerror = () => { try { ws && ws.close(); } catch { /* ignore */ } };
  ws.onmessage = (ev) => {
    let m: Any;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m && typeof m === "object") applyWrapped(m);
  };
}

export function send(obj: Any): boolean {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

let cmdId = 0;
export function command(cmd: string, ...args: unknown[]) {
  if (!S.control) { toast(t("control.need"), "warn"); return; }
  send({ type: "cmd", cmd, args: args.map(String), id: ++cmdId });
}
export function setControl(on: boolean) {
  S.control = !!on;
  send({ type: "control", enabled: !!on });
  bus.emit("control");
}
export function watchSector(sid: unknown) {
  let s = sid ? String(sid) : null;
  if (s && S.player && S.player.sector && S.player.sector.id === s) s = null;
  if (s === watchSid) return;
  watchSid = s;
  send({ type: "watch", sid: s || "0" });
}
export function resync() { send({ type: "resync" }); }

// details (info panel + order lines): read-only, no control switch needed; refreshed while selected
const detailsPending = new Map<number, string>();
const pendingById = new Map<number, string>();
function requestDetails(id: string) {
  if (!id || !/^\d+$/.test(id)) return;
  const myId = ++cmdId;
  if (send({ type: "cmd", cmd: "details", args: [id], id: myId })) pendingById.set(myId, id);
  if (pendingById.size > 200) pendingById.delete(pendingById.keys().next().value as number);
}
function applyWrapped(m: Any) {
  if (m.type === "cmdreply" && m.cmd === "details" && pendingById.has(m.id)) {
    const id = pendingById.get(m.id)!;
    if (m.ok && m.seq) detailsPending.set(m.seq, id);
    else S.details[id] = null;
    pendingById.delete(m.id);
  }
  apply(m);
}

// ---------------------------------------------------------------- toasts (sonner)
export type ToastKind = "info" | "ok" | "bad" | "warn";
export function toast(text: string, kind: ToastKind = "info", ms = 4000) {
  const o = { duration: ms };
  if (kind === "ok") sonner.success(text, o);
  else if (kind === "bad") sonner.error(text, o);
  else if (kind === "warn") sonner.warning(text, o);
  else sonner(text, o);
}

// ---------------------------------------------------------------- selection
export function select(sel: Selection | null) {
  S.selected = sel;
  if (sel && sel.kind === "obj") {
    if (S.details[sel.id] === null) delete S.details[sel.id];
    requestDetails(sel.id);
  }
  bus.emit("select", sel);
}

// ---------------------------------------------------------------- icons exported from the game
function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = 0; let timer: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); fn(...a); }, ms - (now - last));
  };
}
async function loadIcons() {
  try {
    const r = await fetch("/icons/index.json", { cache: "no-cache" });
    const d = await r.json();
    const names = Object.keys(d.icons || {});
    S.icons = names.length;
    setIconIndex(names.length ? names : null, throttle(() => bus.emit("icons"), 250));
    if (!names.length) toast(t("toast.no_icons"), "warn", 8000);
  } catch { setIconIndex(null); }
  S.iconsLoaded = true;
  bus.emit("icons");
}

// ---------------------------------------------------------------- start (once per window)
export function startStore() {
  if (started) return;
  started = true;
  loadIcons();
  connect();
  setInterval(() => {
    const sel = S.selected;
    if (sel && sel.kind === "obj" && document.visibilityState === "visible") requestDetails(sel.id);
  }, 4000);
  bus.on("sectorchange", ({ to }: Any) => toast(t("toast.jump", { name: (to && to.name) || t("toast.jump_new") }), "info", 3000));
  bus.on("gamestate", (g: string) => { if (g === "background") toast(t("toast.background"), "warn", 6000); });
}

/** the connection state shown in the UI (and in body[data-state], which the map reads) */
export function connState(): string {
  if (!S.wsOpen) return wsFailed ? "noserver" : "starting";
  return S.status ? String(S.status.game || "disconnected") : "disconnected";
}
