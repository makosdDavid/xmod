// Logbook read state + unread counters (shared by the Logbook panel, the nav badge and the hotkeys).
// Same storage as the old shell: localStorage x4c.log = { cat, read: { <cat>: <game time read up to> } }.
import { bus, S, type Any } from "./store";

export const LOG_TABS = ["all", "alerts", "general", "missions", "news", "diplomacy", "upkeep", "tips", "ticker", "inbox"] as const;
export type LogTab = (typeof LOG_TABS)[number];

interface LogCfg { cat: LogTab; read: Partial<Record<LogTab, number>> }
const KEY = "x4c.log";
function load(): LogCfg {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    return { cat: (LOG_TABS as readonly string[]).includes(raw?.cat) ? raw.cat : "all", read: raw && typeof raw.read === "object" && raw.read ? raw.read : {} };
  } catch { return { cat: "all", read: {} }; }
}
let cfg = load();
function persist() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* blocked */ } }

export function logCat(): LogTab { return cfg.cat; }
export function setLogCat(c: LogTab) { cfg = { ...cfg, cat: c }; persist(); bus.emit("logread"); }
export function readT(cat: LogTab): number { return cfg.read[cat] ?? -1; }

export function entries(cat: LogTab): Any[] {
  if (cat === "ticker") return S.ticker.map((e) => ({ ...e, cat: "ticker" }));
  if (cat === "inbox") return ((S.messages && S.messages.items) || []).map((e: Any) => ({ ...e, cat: "inbox", _unread: !e.rd }));
  return cat === "all" ? S.log : S.log.filter((e) => e.cat === cat);
}

export function unread(cat: LogTab): number {
  if (cat === "inbox") {
    const u = S.messages && S.messages.unread;
    return u ? (Number(u.highprio) || 0) + (Number(u.lowprio) || 0) : 0;
  }
  const l = entries(cat);
  const t = readT(cat);
  let n = 0;
  for (let i = l.length - 1; i >= 0 && n < 99; i--) { if ((l[i].t ?? 0) > t) n++; else break; }
  return n;
}

export function markAllRead() {
  const latest = S.log.length ? S.log[S.log.length - 1].t : 0;
  const lt = S.ticker.length ? S.ticker[S.ticker.length - 1].t : 0;
  const read: LogCfg["read"] = {};
  for (const k of LOG_TABS) read[k] = k === "ticker" ? lt : latest;
  cfg = { ...cfg, read };
  persist();
  bus.emit("logread");
  bus.emit("alertsack");
}

export function alertEntries(): Any[] { return S.log.filter((e) => e.cat === "alerts"); }
