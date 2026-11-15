// Named user layouts (U8): stored by the server (GET/PUT/DELETE /api/layouts…, a JSON file under the
// tool's state\ folder, so they survive a browser profile reset), cached in localStorage
// (x4c.layouts.cache) for offline start. A saved layout = the split tree with sizes (which modules
// are open / collapsed) + the modules' view options (objects / property filters, logbook category,
// map layers and ship follow).
import { t } from "@/i18n";
import { recreateMap } from "./mapHost";
import { applyTree, getUI } from "./ui";
import { bus, toast, type Any } from "./store";
import { parseTree, type LNode } from "./layout";
import { LOG_TABS, setLogCat, type LogTab } from "./logbook";

export interface SavedLayout { tree: LNode | null; opts: Record<string, Any>; saved?: number }
export interface LayoutDoc { v: 1; default: string | null; items: Record<string, SavedLayout> }

const CACHE = "x4c.layouts.cache";
const OPT_KEYS = ["objects", "property", "map"] as const;   // localStorage x4c.<key>
export const NAME_RE = /^[\p{L}\p{N} _\-.()]{1,40}$/u;

let doc: LayoutDoc = readCache();
let online = false;

function readCache(): LayoutDoc {
  try {
    const d = JSON.parse(localStorage.getItem(CACHE) || "null");
    if (d && d.items && typeof d.items === "object") return { v: 1, default: typeof d.default === "string" ? d.default : null, items: d.items };
  } catch { /* ignore */ }
  return { v: 1, default: null, items: {} };
}
function writeCache() { try { localStorage.setItem(CACHE, JSON.stringify(doc)); } catch { /* blocked */ } }
function changed() { writeCache(); bus.emit("layouts"); }

export const layoutsDoc = () => doc;
export const layoutsOnline = () => online;

async function call(method: string, path: string, body?: unknown): Promise<LayoutDoc> {
  const r = await fetch(path, {
    method, cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text().catch(() => "")) || String(r.status));
  return (await r.json()) as LayoutDoc;
}

export async function loadLayouts(): Promise<void> {
  try { doc = await call("GET", "/api/layouts"); online = true; } catch { online = false; }
  changed();
}

function collectOpts(): Record<string, Any> {
  const o: Record<string, Any> = {};
  for (const k of OPT_KEYS) {
    try { const raw = localStorage.getItem("x4c." + k); if (raw) o[k] = JSON.parse(raw); } catch { /* ignore */ }
  }
  try { const lg = JSON.parse(localStorage.getItem("x4c.log") || "null"); if (lg && lg.cat) o.logcat = lg.cat; } catch { /* ignore */ }
  return o;
}

async function mutate(method: string, path: string, body: unknown, ok: string) {
  try { doc = await call(method, path, body); online = true; changed(); toast(ok, "ok", 2000); return true; }
  catch (e) { toast(t("saved.error", { msg: String((e as Error).message || e).slice(0, 160) }), "bad"); return false; }
}

export function saveLayout(name: string) {
  const n = name.trim();
  if (!NAME_RE.test(n)) { toast(t("saved.bad_name"), "warn"); return Promise.resolve(false); }
  const body: SavedLayout = { tree: getUI().tree, opts: collectOpts() };
  return mutate("PUT", "/api/layouts/" + encodeURIComponent(n), body, t("saved.saved", { name: n }));
}
export function deleteLayout(name: string) {
  return mutate("DELETE", "/api/layouts/" + encodeURIComponent(name), undefined, t("saved.deleted", { name }));
}
export function setDefaultLayout(name: string | null) {
  return mutate("PUT", "/api/layouts-default", { name }, name ? t("saved.default_set", { name }) : t("saved.default_cleared"));
}
export async function renameLayout(from: string, to: string) {
  const n = to.trim();
  const item = doc.items[from];
  if (!item || n === from) return false;
  if (!NAME_RE.test(n)) { toast(t("saved.bad_name"), "warn"); return false; }
  try {
    doc = await call("PUT", "/api/layouts/" + encodeURIComponent(n), { tree: item.tree, opts: item.opts });
    const wasDefault = doc.default === from;
    doc = await call("DELETE", "/api/layouts/" + encodeURIComponent(from));
    if (wasDefault) doc = await call("PUT", "/api/layouts-default", { name: n });
    online = true; changed(); toast(t("saved.renamed", { from, to: n }), "ok", 2000);
    return true;
  } catch (e) { toast(t("saved.error", { msg: String((e as Error).message || e).slice(0, 160) }), "bad"); return false; }
}

export function applyLayout(name: string, quiet = false) {
  const item = doc.items[name];
  if (!item) return;
  const opts = item.opts || {};
  for (const k of OPT_KEYS) if (opts[k] && typeof opts[k] === "object") {
    try { localStorage.setItem("x4c." + k, JSON.stringify(opts[k])); } catch { /* blocked */ }
  }
  if (typeof opts.logcat === "string" && (LOG_TABS as readonly string[]).includes(opts.logcat)) setLogCat(opts.logcat as LogTab);
  if (opts.map) recreateMap();
  applyTree(parseTree(item.tree ?? null), "user:" + name);
  if (!quiet) toast(t("layout.applied", { name }), "info", 1500);
}

/** main window start: fetch the saved layouts; apply the default one if set */
export async function initLayouts(applyDefault: boolean) {
  await loadLayouts();
  if (applyDefault && doc.default && doc.items[doc.default]) applyLayout(doc.default, true);
}
