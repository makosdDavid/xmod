// X4 Companion — modules: sector objects, info, property, logbook, missions, factions, economy, status,
// plus the details drawer (used when the Info module is not on screen). Each module gets its
// <section class="mod"> with .ptools (header tools) and .pbody. Lists support keyboard / hotkey
// navigation through ListNav (lista fel/le, kijelölés).
"use strict";
import { el, num, money, dist, dur, gameTime, ago, bar, throttle, loadSettings, saveSettings,
         CLASS_HU, PURPOSE_HU, LOGCAT_HU, relColor, factionColor } from "./util.js";
import { iconEl } from "./icons.js";
import { objColor, iconFor, tintedURL, rgb } from "./mapstyle.js";

// the game's map icon of an object, tinted with the game map's colour (img), or a drawn fallback
export function gameIcon(o, S, size = 18) {
  const col = objColor(o, S.theme, { currentId: S.player && S.player.object ? S.player.object.id : null });
  const url = tintedURL(iconFor(o), col);
  if (url) return el("img", { class: "gic", src: url, width: size, height: size, alt: "" });
  const sp = el("span", { class: "gic fb", style: { color: rgb(col), width: size + "px", height: size + "px" } });
  sp.appendChild(iconEl((o.c || "").startsWith("ship") ? "ship" : (o.c === "station" ? "station" : (o.c === "gate" || o.c === "highwayentrygate") ? "gate" : "info"), size - 2));
  return sp;
}
function colOf(o, S) { return rgb(objColor(o, S.theme, { currentId: S.player && S.player.object ? S.player.object.id : null })); }

export const LISTS = {};       // module id -> ListNav
let PROP = null;               // property context (shipOrder)
let LOG = null;

// ================================================================ list navigation
export class ListNav {
  constructor(container, rowSel) { this.c = container; this.sel = rowSel; this.key = null; }
  rows() { return [...this.c.querySelectorAll(this.sel)]; }
  move(d) {
    const rows = this.rows();
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.dataset.key === this.key);
    i = i < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + d));
    this.key = rows[i].dataset.key;
    this.mark(true);
  }
  mark(scroll) {
    let cur = null;
    for (const r of this.rows()) { const on = r.dataset.key === this.key; r.classList.toggle("cur", on); if (on) cur = r; }
    if (cur && scroll) cur.scrollIntoView({ block: "nearest" });
  }
  activate() { const r = this.rows().find((x) => x.dataset.key === this.key); if (r) r.click(); else this.move(1); }
}

function tools(mod) { return mod.querySelector(".ptools"); }
function body(mod) { return mod.querySelector(".pbody"); }
function chipRow(items, cur, onPick) {
  const row = el("div", { class: "chips" });
  for (const [k, label] of items) {
    row.appendChild(el("button", { class: "chip" + (cur === k ? " on" : ""), "data-f": k, onclick: () => {
      for (const b of row.children) b.classList.toggle("on", b.dataset.f === k); onPick(k);
    } }, label));
  }
  return row;
}

// ================================================================ sector objects (the game map's object list)
const OBJ_FILTERS = [["all", "Mind"], ["ships", "Hajók"], ["stations", "Állomások"], ["gates", "Kapuk"], ["own", "Saját"], ["hostile", "Ellenséges"]];
const CLASS_ICON = { station: "station", gate: "gate", highwayentrygate: "gate" };

export function mountObjects(mod, ctx) {
  const { S, bus, select, sectorName, factionName, getMapSid } = ctx;
  const cfg = loadSettings("objects", { f: "all", q: "" });
  const search = el("input", { type: "search", placeholder: "Szűrés…", value: cfg.q });
  tools(mod).prepend(search);
  const head = el("div", { class: "psummary" });
  const list = el("div", { class: "scroll olist" });
  body(mod).append(chipRow(OBJ_FILTERS, cfg.f, (k) => { cfg.f = k; saveSettings("objects", cfg); render(); }), head, list);
  const nav = LISTS.objects = new ListNav(list, ".orow");
  search.addEventListener("input", throttle(() => { cfg.q = search.value; saveSettings("objects", cfg); render(); }, 150));
  function objs() {
    const sid = getMapSid();
    const sc = sid ? S.scans[sid] : null;
    let o = sc ? (sc.objs || sc.items || []) : [];
    if (!o.some((x) => x.c === "gate")) {
      o = o.concat((S.gatesBySector.get(String(sid)) || []).map((g) => ({ id: g.id, c: g.hw ? "highwayentrygate" : "gate", n: g.hw ? "Szupersztráda" : "Ugrókapu", x: g.x, z: g.z, ds: g.ds, du: g.du })));
    }
    return { sid, sc, objs: o };
  }
  function render() {
    const { sid, sc, objs: all } = objs();
    const p = S.player && S.player.object;
    const same = p && S.player.sector && S.player.sector.id === sid;
    const q = (cfg.q || "").trim().toLowerCase();
    let rows = all.filter((o) => {
      const ship = o.c && o.c.startsWith("ship");
      if (cfg.f === "ships" && !ship) return false;
      if (cfg.f === "stations" && o.c !== "station") return false;
      if (cfg.f === "gates" && o.c !== "gate" && o.c !== "highwayentrygate") return false;
      if (cfg.f === "own" && !o.pl) return false;
      if (cfg.f === "hostile" && !(o.h || o.e)) return false;
      if (q && !`${o.n || ""} ${o.code || ""} ${factionName(o.o)}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const dOf = (o) => (same && o.x !== null && o.x !== undefined) ? Math.hypot(o.x - p.x, o.z - p.z) : Math.hypot(o.x || 0, o.z || 0);
    rows.sort((a, b) => dOf(a) - dOf(b));
    head.textContent = `${sectorName(sid)} · ${rows.length} objektum` + (sc && sc.hidden ? ` · ${sc.hidden} nem látható` : "") + (same ? " · távolság tőled" : " · távolság a középponttól");
    const selId = S.selected && S.selected.kind === "obj" ? S.selected.id : null;
    const frag = document.createDocumentFragment();
    for (const o of rows.slice(0, 600)) {
      const cls = colOf(o, S);
      const dest = (o.c === "gate" || o.c === "highwayentrygate") ? " → " + (o.ds ? sectorName(o.ds) : "?") : "";
      const r = el("div", { class: "orow" + (o.id === selId ? " sel" : ""), "data-key": o.id, onclick: () => select({ kind: "obj", id: o.id, from: "objects", obj: o, sid }) },
        el("span", { class: "oic" }, gameIcon(o, S, 18)),
        el("span", { class: "on", style: { color: cls } }, (o.n || CLASS_HU[o.c] || "?") + dest),
        el("span", { class: "ocls" }, CLASS_HU[o.c] || ""),
        el("span", { class: "oown" }, o.pl ? "saját" : ((S.factions[o.o] || {}).sn || o.o || "")),
        el("span", { class: "odist" }, dist(dOf(o))),
        o.hull !== undefined && o.hull !== null ? bar(o.hull, "hull") : el("span"));
      frag.appendChild(r);
    }
    list.replaceChildren(frag);
    if (!rows.length) list.appendChild(el("div", { class: "empty" }, sc ? "Nincs a szűrésnek megfelelő objektum." : "Még nincs szektorkép erről a szektorról."));
    nav.mark(false);
  }
  const r = throttle(render, 600);
  for (const e of ["scan", "player", "select", "factions", "galaxy", "mapsector", "theme", "icons"]) bus.on(e, r);
  render();
}

// ================================================================ info (selected object) — module and drawer share this
function findObj(S, sel) {
  const p = S.property.get(sel.id);
  if (p) return { o: p, sid: p.s };
  for (const [sid, sc] of Object.entries(S.scans)) {
    const o = (sc.objs || sc.items || []).find((x) => x.id === sel.id);
    if (o) return { o, sid };
  }
  if (sel.obj) return { o: sel.obj, sid: sel.sid };
  const pl = S.player && S.player.object;
  if (pl && pl.id === sel.id) return { o: { ...pl, c: pl.class, n: pl.name, pl: true }, sid: S.player.sector && S.player.sector.id };
  return null;
}

function renderInfo(box, ctx, sel) {
  const { S, select, sectorName, factionName, command, details } = ctx;
  const kv = (rows) => el("table", { class: "kv" }, el("tbody", {}, rows.filter(Boolean).map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, v instanceof Node ? v : String(v))))));
  const btn = (label, icon, cmd, args, tip) => {
    const allowed = !S.hello || !S.hello.allow || S.hello.allow.includes(cmd);
    const b = el("button", { class: "ctl" + (allowed ? "" : " disabled"), title: allowed ? tip : tip + " – a modban kikapcsolva (CFG.allow)", disabled: !allowed || undefined,
                             onclick: () => command(cmd, ...args) });
    b.append(iconEl(icon, 15), el("span", {}, label));
    return b;
  };
  if (!sel) {
    const p = S.player;
    const o = p && p.object;
    box.replaceChildren(el("div", { class: "infohead" }, el("h2", {}, o ? (o.name || "A hajód") : "Nincs kijelölés")),
      o ? kv([["Hol", ctx.whereText(p.where)], ["Szektor", p.sector ? p.sector.name : "–"], ["Burkolat", bar(o.hull, "hull")], ["Pajzs", bar(o.shield, "shield")],
              ["Célpont", p.target ? `${p.target.name || "?"} · ${dist(p.target.dist)}` : "nincs"], ["Küldetés", p.mission ? p.mission.name || "–" : "–"]]) : null,
      el("div", { class: "hint" }, "Válassz objektumot a térképen, az Objektumok vagy a Tulajdon listában (gyorsgomb: lista fel/le + kijelölés)."));
    return;
  }
  if (sel.kind === "sector") {
    const s = S.sectors.get(String(sel.id));
    const own = [...S.property.values()].filter((e) => e.s === String(sel.id));
    box.replaceChildren(
      el("div", { class: "infohead" }, iconEl("galaxy", 22), el("h2", {}, s ? s.name : "Szektor"), el("span", { class: "muted" }, s ? (s.cname || "") : "")),
      kv([["Tulajdonos", factionName(s && s.owner)], ["Saját hajók", own.filter((e) => e.k === "ship").length], ["Saját állomások", own.filter((e) => e.k === "station").length],
          ["Nyersanyagok", s && s.res ? s.res.map((r) => `${r.w} ${r.m ? Math.round(r.c / r.m * 100) + "%" : ""}`).join(", ") : "–"],
          ["Kapcsolatok", S.links.filter((l) => l.a === String(sel.id) || l.b === String(sel.id)).map((l) => sectorName(l.a === String(sel.id) ? l.b : l.a) + (l.kind === "hw" ? " (sztráda)" : "")).join(", ") || "–"]]),
      el("div", { class: "dbtns" },
        el("button", { onclick: () => select({ kind: "sector", id: sel.id, from: "info" }), title: "Szektornézet (figyelt szektor)" }, "Szektornézet"),
        btn("Játék térképén", "map", "openmap", [sel.id], "A játék saját térképe erre a szektorra fókuszálva")),
      own.length ? el("h3", {}, "Saját objektumok itt") : null,
      own.length ? el("div", { class: "dlist" }, own.slice(0, 80).map((e) => el("a", { href: "#", onclick: (ev) => { ev.preventDefault(); select({ kind: "obj", id: e.id, from: "info" }); } }, (e.k === "station" ? "▣ " : "") + (e.n || e.id)))) : null);
    return;
  }
  const f = findObj(S, sel);
  const det = details(sel.id);
  if (!f && !det) { box.replaceChildren(el("h2", {}, "Objektum"), el("div", { class: "muted" }, "Nincs (már) látható adat erről az objektumról.")); return; }
  const o = Object.assign({}, det || {}, f ? f.o : {});
  const sid = f ? f.sid : det && det.s;
  const cls = o.c || o.class || "";
  const isShip = cls.startsWith("ship");
  const own = !!(o.pl || o.k);
  const subs = [...S.property.values()].filter((e) => e.cmd === o.id);
  const p = S.player && S.player.object;
  const d = p && S.player.sector && sid === S.player.sector.id && o.x !== undefined && o.x !== null ? Math.hypot(o.x - p.x, o.z - p.z) : null;
  const order = o.on || (det && det.oname);
  const cargo = det ? det.cargo : null;
  const cargoBox = det === undefined ? el("div", { class: "muted" }, "rakomány: betöltés…")
    : (!det ? el("div", { class: "muted" }, "rakomány: nincs adat (régebbi híd?)")
      : (!det.cwl ? el("div", { class: "muted" }, "rakomány: ismeretlen (a játékban sincs feloldva)")
        : (cargo && cargo.length ? el("table", { class: "grid small" }, el("tbody", {}, cargo.map((c) => el("tr", {}, el("td", {}, c.n || c.w), el("td", { class: "num" }, c.a === null || c.a === undefined ? "?" : num(c.a))))))
          : el("div", { class: "muted" }, "üres raktér"))));
  box.replaceChildren(
    el("div", { class: "infohead" }, el("span", { class: "oic" }, gameIcon({ ...o, c: cls }, S, 30)),
      el("h2", { style: { color: colOf({ ...o, c: cls }, S) } }, o.n || o.name || "Objektum"), el("span", { class: "muted" }, o.code || "")),
    kv([
      ["Osztály", CLASS_HU[cls] || cls || "–"], ["Szektor", sectorName(sid)],
      ["Tulajdonos", own ? "saját" : (o.on && det ? det.on : factionName(o.o))],
      o.r !== undefined ? ["Kapcsolat", (o.r > 0 ? "+" : "") + o.r] : null,
      o.hull !== undefined && o.hull !== null ? ["Burkolat", bar(o.hull, "hull")] : null,
      o.shield !== undefined && o.shield !== null ? ["Pajzs", bar(o.shield, "shield")] : null,
      o.p ? ["Szerep", PURPOSE_HU[o.p] || o.p] : null,
      order ? ["Parancs", `${order}${o.os ? " · " + o.os : ""}${o.oq ? ` (sor: ${o.oq})` : ""}${o.odf ? " (alapparancs)" : ""}`] : null,
      o.fl ? ["Flotta", o.fl] : null, o.cmd ? ["Parancsnok", (S.property.get(o.cmd) || {}).n || o.cmd] : null,
      cls === "station" && own ? ["Modulok", num(o.mods)] : null, o.money !== undefined && own ? ["Számla", money(o.money)] : null,
      o.wfc ? ["Munkaerő", `${num(o.wf)} / ${num(o.wfc)}`] : null, d !== null ? ["Távolság tőled", dist(d)] : null,
      o.ds ? ["Cél", sectorName(o.ds)] : (o.du ? ["Cél", "? (ismeretlen szektor)"] : null),
      o.rr ? ["Radar hatótáv", dist(o.rr)] : (det && det.rr ? ["Radar hatótáv", dist(det.rr)] : null),
      o.mt ? ["Küldetés", "küldetés célpontja"] : null,
    ]),
    (isShip || cls === "station") ? el("h3", {}, "Rakomány") : null,
    (isShip || cls === "station") ? cargoBox : null,
    el("div", { class: "dbtns" },
      el("button", { onclick: () => ctx.centerOn(o.id), title: "Középre a térképen" }, iconEl("target", 15), el("span", {}, "Térképen")),
      btn("Játék térképén", "map", "openmap", [o.id], "A játék saját térképe erre az objektumra fókuszálva, kijelölve"),
      btn("Célpont", "target", "target", [o.id], "Célpontnak jelöli a játékban"),
      btn("Útvonal", "back", "guidance", [o.id], "Útvonal (guidance) erre az objektumra"),
      isShip && own ? btn("Állj", "close", "stop", [o.id], "A vanilla „Összes parancs törlése” útja") : null,
      isShip && own && S.player && S.player.sector && sid !== S.player.sector.id ? btn("Repülj ide", "ship", "flyto", [o.id, S.player.sector.id], "MoveWait parancs a te szektorodba") : null),
    det && det.orders && det.orders.length ? el("h3", {}, `Parancssor (${det.orders.length})`) : null,
    det && det.orders && det.orders.length ? el("ol", { class: "orders" }, det.orders.map((q) => el("li", {}, q.n || q.d || "?",
      q.st ? el("span", { class: "muted" }, " · " + q.st) : null,
      q.pt ? el("span", { class: "muted" }, " · " + sectorName(q.pt.s)) : null))) : null,
    det && det.orders && det.orders.some((q) => q.pt) ? el("div", { class: "hint" }, "A parancsok útvonala a térképen szaggatott vonallal látszik (Útvonalak réteg).") : null,
    subs.length ? el("h3", {}, `Alárendeltek (${subs.length})`) : null,
    subs.length ? el("div", { class: "dlist" }, subs.map((e) => el("a", { href: "#", onclick: (ev) => { ev.preventDefault(); select({ kind: "obj", id: e.id, from: "info" }); } }, e.n || e.id))) : null,
    S.control ? null : el("div", { class: "hint" }, "A parancsgombokhoz kapcsold be a vezérlést (felső sáv)."));
}

export function mountInfo(mod, ctx) {
  const { S, bus } = ctx;
  const box = el("div", { class: "scroll pad infobox" });
  body(mod).append(box);
  const render = () => renderInfo(box, ctx, S.selected);
  bus.on("select", render);
  const r = throttle(render, 1000);
  for (const e of ["property", "scan", "hello", "details", "control", "theme", "icons"]) bus.on(e, r);
  bus.on("player", throttle(() => { if (!S.selected) render(); }, 1000));
  render();
}

export function mountDrawer(root, ctx) {
  const { S, bus, select } = ctx;
  const box = el("div", { class: "dbody" });
  const close = el("button", { class: "dclose", title: "Bezárás (Esc)", onclick: () => select(null) });
  close.appendChild(iconEl("close", 16));
  root.append(close, box);
  const render = () => {
    const open = !!S.selected && !ctx.infoVisible();
    root.classList.toggle("open", open);
    if (open) renderInfo(box, ctx, S.selected);
  };
  bus.on("select", render);
  bus.on("layout", render);
  const r = throttle(() => { if (S.selected) render(); }, 1000);
  for (const e of ["property", "scan", "hello", "details", "control"]) bus.on(e, r);
}

// ================================================================ property
const PROP_COLS = [
  ["n", "Név"], ["code", "Azon."], ["c", "Oszt."], ["p", "Szerep"], ["s", "Szektor"], ["hull", "Burk."],
  ["shield", "Pajzs"], ["on", "Parancs"], ["fl", "Flotta / parancsnok"],
];
const FILTERS = [["all", "Mind"], ["ship", "Hajók"], ["station", "Állomások"], ["ship_s", "S"], ["ship_m", "M"], ["ship_l", "L"],
                 ["ship_xl", "XL"], ["trade", "Keresk."], ["mine", "Bány."], ["fight", "Harci"], ["damaged", "Sérült"], ["here", "Itt"]];

export function mountProperty(mod, ctx) {
  PROP = ctx;
  const { S, bus, select, sectorName } = ctx;
  const cfg = loadSettings("property", { sort: "n", dir: 1, filter: "all", q: "", tree: false });
  const search = el("input", { type: "search", placeholder: "Keresés ( / )", value: cfg.q, title: "Név, azonosító, szektor, parancs" });
  const treeBtn = el("button", { class: "chip" + (cfg.tree ? " on" : ""), title: "Flottafa: alárendeltek a parancsnokuk alatt" }, "Flottafa");
  tools(mod).prepend(search, treeBtn);
  const summary = el("div", { class: "psummary" });
  const table = el("table", { class: "grid" });
  const thead = el("thead");
  const tr = el("tr");
  for (const [k, label] of PROP_COLS) {
    tr.appendChild(el("th", { "data-k": k, onclick: () => { if (cfg.sort === k) cfg.dir = -cfg.dir; else { cfg.sort = k; cfg.dir = 1; } save(); render(); } }, label));
  }
  thead.appendChild(tr);
  const tbody = el("tbody");
  table.append(thead, tbody);
  const scroller = el("div", { class: "scroll" }, table);
  body(mod).append(chipRow(FILTERS, cfg.filter, (k) => { cfg.filter = k; save(); render(); }), summary, scroller);
  const nav = LISTS.property = new ListNav(tbody, "tr[data-key]");
  function save() { cfg.q = search.value; saveSettings("property", cfg); }
  search.addEventListener("input", throttle(() => { save(); render(); }, 150));
  treeBtn.addEventListener("click", () => { cfg.tree = !cfg.tree; treeBtn.classList.toggle("on", cfg.tree); save(); render(); });

  ctx.rows = [];
  function matches(e, q, here) {
    const f = cfg.filter;
    if (f === "ship" && e.k !== "ship") return false;
    if (f === "station" && e.k !== "station") return false;
    if (f.startsWith("ship_") && e.c !== f) return false;
    if (["trade", "mine", "fight"].includes(f) && e.p !== f) return false;
    if (f === "damaged" && !((e.hull ?? 100) < 70)) return false;
    if (f === "here" && e.s !== here) return false;
    if (!q) return true;
    const hay = `${e.n || ""} ${e.code || ""} ${sectorName(e.s)} ${e.on || ""} ${e.fl || ""} ${CLASS_HU[e.c] || e.c || ""}`.toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }
  function val(e, k) {
    if (k === "s") return sectorName(e.s);
    if (k === "c") return ({ ship_xs: 0, ship_s: 1, ship_m: 2, ship_l: 3, ship_xl: 4, station: 5 })[e.c] ?? 9;
    if (k === "fl") return e.fl || (e.cmd ? (S.property.get(e.cmd) || {}).n || "" : "");
    return e[k] ?? "";
  }
  function render() {
    const q = search.value.trim().toLowerCase();
    const here = S.player && S.player.sector ? S.player.sector.id : null;
    let list = [...S.property.values()].filter((e) => matches(e, q, here));
    const k = cfg.sort, d = cfg.dir;
    list.sort((a, b) => {
      const va = val(a, k), vb = val(b, k);
      return (typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "hu")) * d;
    });
    if (cfg.tree && !q) {
      const byCmd = new Map();
      const ids = new Set(list.map((e) => e.id));
      for (const e of list) if (e.cmd && ids.has(e.cmd)) { if (!byCmd.has(e.cmd)) byCmd.set(e.cmd, []); byCmd.get(e.cmd).push(e); }
      const out = [];
      const walk = (e, depth) => { e._depth = depth; out.push(e); for (const c of byCmd.get(e.id) || []) if (depth < 6) walk(c, depth + 1); };
      for (const e of list) if (!(e.cmd && ids.has(e.cmd))) walk(e, 0);
      list = out;
    } else for (const e of list) e._depth = 0;
    ctx.rows = list.map((e) => e.id);
    for (const th of thead.querySelectorAll("th")) { th.classList.toggle("sorted", th.dataset.k === k); th.classList.toggle("desc", th.dataset.k === k && d < 0); }
    const frag = document.createDocumentFragment();
    const selId = S.selected && S.selected.kind === "obj" ? S.selected.id : null;
    for (const e of list.slice(0, 1500)) {
      frag.appendChild(el("tr", { "data-key": e.id, class: (e.id === selId ? "sel " : "") + ((e.hull ?? 100) < 40 ? "dmg" : ""), onclick: () => select({ kind: "obj", id: e.id, from: "property" }) },
        el("td", { class: "name", style: { paddingLeft: (8 + e._depth * 14) + "px" } }, e._depth ? el("span", { class: "tree" }, "└") : "", gameIcon(e, S, 16), " ", e.n || "–"),
        el("td", { class: "mono" }, e.code || ""),
        el("td", {}, CLASS_HU[e.c] || e.c || ""),
        el("td", {}, PURPOSE_HU[e.p] || e.p || (e.k === "station" ? (e.mods ? e.mods + " modul" : "") : "")),
        el("td", { class: e.s === here ? "here" : "" }, sectorName(e.s)),
        el("td", {}, bar(e.hull, "hull")),
        el("td", {}, e.k === "ship" ? bar(e.shield, "shield") : (e.money !== undefined ? money(e.money, true) : "")),
        el("td", { title: e.od || "" }, e.k === "ship" ? (e.on || "–") + (e.odf ? " (alap)" : "") : (e.wfc ? `munkaerő ${num(e.wf)}/${num(e.wfc)}` : "")),
        el("td", {}, e.fl || (e.cmd ? "↑ " + ((S.property.get(e.cmd) || {}).n || "?") : ""))));
    }
    tbody.replaceChildren(frag);
    nav.mark(false);
    const ships = [...S.property.values()].filter((e) => e.k === "ship").length;
    summary.textContent = `${ships} hajó · ${S.property.size - ships} állomás` + (list.length !== S.property.size ? ` · szűrve: ${list.length}` : "") +
      (S.propertyMeta && S.propertyMeta.at ? "" : " · várakozás a játékra…");
  }
  const r = throttle(render, 700);
  bus.on("property", r);
  bus.on("galaxy", r);
  bus.on("icons", r);
  bus.on("theme", r);
  bus.on("select", () => {
    r();
    const id = S.selected && S.selected.kind === "obj" ? S.selected.id : null;
    if (id) setTimeout(() => { const row = tbody.querySelector(`tr[data-key="${id}"]`); if (row) row.scrollIntoView({ block: "nearest" }); }, 750);
  });
  render();
}

export function shipOrder() {
  if (!PROP) return [];
  const rows = PROP.rows && PROP.rows.length ? PROP.rows : [...PROP.S.property.keys()];
  return rows.filter((id) => (PROP.S.property.get(id) || {}).k === "ship");
}

// ================================================================ logbook / notifications
const LOG_TABS = ["all", "alerts", "general", "missions", "news", "diplomacy", "upkeep", "tips", "ticker", "inbox"];

export function mountLog(mod, ctx) {
  const { S, bus, select } = ctx;
  const cfg = loadSettings("log", { cat: "all", read: {} });
  const root = body(mod);
  root.classList.add("logpanel");
  const tabs = el("div", { class: "chips logtabs" });
  const list = el("div", { class: "scroll loglist" });
  const readBtn = el("button", { class: "chip", onclick: () => LOG.markAllRead(), title: "Minden olvasott (játékbeli gyorsgomb: riasztások nyugtázása)" }, "Mind olvasott");
  tools(mod).prepend(readBtn);
  root.append(tabs, list);
  const btns = {};
  for (const k of LOG_TABS) {
    btns[k] = el("button", { class: "chip", "data-c": k, onclick: () => setCat(k) }, LOGCAT_HU[k], el("span", { class: "badge" }));
    tabs.appendChild(btns[k]);
  }
  const nav = LISTS.log = new ListNav(list, ".logentry");
  function readT(cat) { return cfg.read[cat] ?? -1; }
  function entries(cat) {
    if (cat === "ticker") return S.ticker.map((e) => ({ ...e, cat: "ticker" }));
    if (cat === "inbox") return (S.messages && S.messages.items || []).map((e) => ({ ...e, cat: "inbox", _unread: !e.rd }));
    return cat === "all" ? S.log : S.log.filter((e) => e.cat === cat);
  }
  function unread(cat) {
    if (cat === "inbox") return S.messages && S.messages.unread ? (S.messages.unread.highprio || 0) + (S.messages.unread.lowprio || 0) : 0;
    const l = entries(cat);
    const t = readT(cat);
    let n = 0;
    for (let i = l.length - 1; i >= 0 && n < 99; i--) { if ((l[i].t ?? 0) > t) n++; else break; }
    return n;
  }
  function setCat(c) {
    cfg.cat = c; saveSettings("log", cfg);
    render(true);
  }
  function render(scrollTop) {
    const cat = cfg.cat;
    const all = entries(cat);
    const t = readT(cat);
    const frag = document.createDocumentFragment();
    const now = S.player ? S.player.gametime : null;
    for (let i = all.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
      const e = all[i];
      const isNew = cat === "inbox" ? e._unread : (e.t ?? 0) > t;
      const div = el("div", { class: "logentry cat-" + e.cat + (isNew ? " unread" : "") + (e.hl ? " hl" : ""), "data-key": `${e.cat}|${e.t}|${e.ti}` },
        el("div", { class: "lhead" }, el("span", { class: "lcat" }, LOGCAT_HU[e.cat] || e.cat || ""), el("span", { class: "ltitle" }, e.ti || ""),
          el("span", { class: "ltime", title: gameTime(e.t) }, ago(e.t, now))),
        e.tx ? el("div", { class: "ltext" }, e.tx) : null,
        (e.en || e.fa || e.so || e.mo) ? el("div", { class: "lmeta" }, [e.en, e.fa, e.so].filter(Boolean).join(" · "),
          e.mo ? el("span", { class: e.mo >= 0 ? "pos" : "neg" }, (e.mo > 0 ? " +" : " ") + money(e.mo)) : null) : null);
      if (e.ic) {
        div.classList.add("clickable");
        div.title = "Megjelenítés a térképen";
        div.addEventListener("click", () => select({ kind: "obj", id: e.ic, from: "log" }));
      }
      frag.appendChild(div);
    }
    list.replaceChildren(frag);
    if (!all.length) list.appendChild(el("div", { class: "empty" }, "Nincs bejegyzés ebben a kategóriában."));
    if (scrollTop) list.scrollTop = 0;
    nav.mark(false);
    let alerts = 0;
    for (const k of LOG_TABS) {
      const n = unread(k);
      if (k === "alerts") alerts = n;
      btns[k].querySelector(".badge").textContent = n ? (n >= 99 ? "99+" : String(n)) : "";
      btns[k].classList.toggle("has", n > 0);
      btns[k].classList.toggle("on", k === cfg.cat);
    }
    btns.alerts.classList.toggle("alert", alerts > 0);
    ctx.setBadge && ctx.setBadge("log", unread("all") + (alerts ? 0 : 0), alerts > 0);
  }
  LOG = {
    markAllRead() {
      const latest = S.log.length ? S.log[S.log.length - 1].t : 0;
      const lt = S.ticker.length ? S.ticker[S.ticker.length - 1].t : 0;
      for (const k of LOG_TABS) cfg.read[k] = k === "ticker" ? lt : latest;
      saveSettings("log", cfg); render();
    },
    focus(cat) { setCat(cat); mod.classList.add("flash"); setTimeout(() => mod.classList.remove("flash"), 3000); },
    alertEntries() { return S.log.filter((e) => e.cat === "alerts"); },
  };
  const r = throttle(() => render(false), 400);
  bus.on("log", r); bus.on("ticker", r); bus.on("messages", r); bus.on("player", throttle(() => render(false), 15000));
  setCat(cfg.cat);
}
export function markAllRead() { if (LOG) LOG.markAllRead(); }
export function focusLogCategory(cat) { if (LOG) LOG.focus(cat); }
export function alertEntries() { return LOG ? LOG.alertEntries() : []; }

// ================================================================ missions
export function mountMissions(mod, ctx) {
  const { S, bus, select, sectorName, factionName, command } = ctx;
  const box = el("div", { class: "scroll" });
  body(mod).append(box);
  const nav = LISTS.missions = new ListNav(box, ".mission, tr[data-key]");
  function render() {
    const frag = document.createDocumentFragment();
    frag.appendChild(el("h3", {}, `Elfogadott küldetések (${S.missions.length})`));
    const ms = [...S.missions].sort((a, b) => (b.act ? 1 : 0) - (a.act ? 1 : 0));
    for (const m of ms) {
      frag.appendChild(el("div", { class: "mission" + (m.act ? " active" : ""), "data-key": "m" + m.id, onclick: () => m.acs && select({ kind: "sector", id: m.acs, from: "missions" }) },
        el("div", { class: "mhead" }, m.act ? el("span", { class: "pill ok" }, "aktív") : null, el("b", {}, m.n || "–"),
          el("span", { class: "muted" }, ` ${m.st || m.mt || ""} · ${factionName(m.fa)}`)),
        m.ob ? el("div", { class: "mobj" }, "▸ " + m.ob + (m.pm ? ` (${m.pn || ""} ${num(m.pc)}/${num(m.pm)})` : "")) : null,
        el("div", { class: "mmeta" }, `Jutalom: ${m.rw ? money(m.rw) : (m.rt || "–")}`, m.dur && m.dur > 0 ? ` · hátralévő idő: ${dur(m.dur)}` : "",
          m.acs ? el("span", {}, " · " + sectorName(m.acs)) : null,
          m.ac ? el("button", { class: "ctl", title: "Útvonal a küldetés célpontjához (vezérlés)", onclick: (ev) => { ev.stopPropagation(); command("guidance", m.ac); } }, "Útvonal") : null),
        m.d ? el("div", { class: "mdesc muted" }, m.d) : null));
    }
    if (!ms.length) frag.appendChild(el("div", { class: "empty" }, "Nincs elfogadott küldetés."));
    frag.appendChild(el("h3", {}, `Ajánlatok (${S.offers.length})`));
    const tbl = el("table", { class: "grid small" }, el("thead", {}, el("tr", {}, el("th", {}, "Ajánlat"), el("th", {}, "Frakció"), el("th", {}, "Jutalom"), el("th", {}, "Szektor"), el("th", {}, "Lejár"))));
    const tb = el("tbody");
    for (const o of [...S.offers].sort((a, b) => (b.rw || 0) - (a.rw || 0))) {
      tb.appendChild(el("tr", { "data-key": "o" + o.id, onclick: () => o.s && select({ kind: "sector", id: o.s, from: "offers" }) },
        el("td", {}, o.n || "–"), el("td", {}, factionName(o.fa)), el("td", { class: "num" }, o.rw ? money(o.rw, true) : (o.rt || "")),
        el("td", {}, o.s ? sectorName(o.s) : "?"), el("td", {}, o.dur > 0 ? dur(o.dur) : "")));
    }
    tbl.appendChild(tb);
    frag.appendChild(tbl);
    box.replaceChildren(frag);
    nav.mark(false);
  }
  bus.on("missions", throttle(render, 500));
  bus.on("galaxy", throttle(render, 2000));
  render();
}

// ================================================================ factions
export function mountFactions(mod, ctx) {
  const { S, bus } = ctx;
  const box = el("div", { class: "scroll" });
  body(mod).append(box);
  const nav = LISTS.factions = new ListNav(box, "tr[data-key]");
  function render() {
    const list = [...S.factionList].sort((a, b) => (b.rel ?? 0) - (a.rel ?? 0));
    const tbl = el("table", { class: "grid" }, el("thead", {}, el("tr", {}, el("th", {}, "Frakció"), el("th", {}, "Kapcsolat"), el("th", {}, ""), el("th", {}, "Engedélyek"))));
    const tb = el("tbody");
    for (const f of list) {
      const rel = f.rel ?? 0;
      const pct = ((rel + 30) / 60) * 100;
      const cls = f.h ? "hostile" : f.e ? "enemy" : rel >= 10 ? "friend" : "";
      tb.appendChild(el("tr", { "data-key": f.id },
        el("td", {}, el("span", { class: "dot", style: { background: factionColor(f.id, S.factions) } }), " ", f.n || f.id, f.sn ? el("span", { class: "muted" }, ` [${f.sn}]`) : null, f.lk ? el("span", { class: "muted", title: "rögzített kapcsolat" }, " 🔒") : null),
        el("td", { class: "num " + cls }, (rel > 0 ? "+" : "") + num(rel), " ", el("span", { class: "muted" }, f.rn || "")),
        el("td", {}, el("span", { class: "relbar" }, el("span", { class: cls, style: { left: Math.min(pct, 50) + "%", width: Math.abs(pct - 50) + "%" } }))),
        el("td", { class: "lics" }, (f.lic || []).map((l) => el("span", { class: "lic " + (l.has ? "has" : "no"), title: (l.has ? "megvan" : "nincs") + (l.pr ? " · ár: " + money(l.pr) : "") + (l.mr !== undefined ? " · min. kapcsolat: " + l.mr : "") }, l.n || l.t)))));
    }
    tbl.appendChild(tb);
    box.replaceChildren(list.length ? tbl : el("div", { class: "empty" }, "Még nincs frakcióadat (20 mp-enként frissül)."));
    nav.mark(false);
  }
  bus.on("factions", render);
  render();
}

// ================================================================ economy
export function mountEconomy(mod, ctx) {
  const { S, bus } = ctx;
  const box = el("div", { class: "scroll pad" });
  body(mod).append(box);
  function kpi(label, value, cls = "") { return el("div", { class: "kpi" }, el("div", { class: "kl" }, label), el("div", { class: "kv " + cls }, value)); }
  function render() {
    const e = S.economy;
    if (!e) { box.replaceChildren(el("div", { class: "empty" }, "Még nincs számlaadat (30 mp-enként frissül).")); return; }
    const maxAbs = Math.max(1, ...(e.bytype || []).map((b) => Math.abs(b.mo)));
    box.replaceChildren(
      el("div", { class: "kpis" },
        kpi("Egyenleg", money(S.player ? S.player.money : e.money)),
        kpi("Bevétel (1 óra)", money(e.inc), "pos"), kpi("Kiadás (1 óra)", money(e.exp), "neg"),
        kpi("Nettó", money((e.inc || 0) - (e.exp || 0)), (e.inc - e.exp) >= 0 ? "pos" : "neg"), kpi("Tranzakciók", num(e.count))),
      el("h3", {}, "Típus szerint"),
      el("div", { class: "hbars" }, (e.bytype || []).map((b) => el("div", { class: "hbar" }, el("span", { class: "hl" }, b.n),
        el("span", { class: "ht" }, el("span", { class: b.mo >= 0 ? "pos" : "neg", style: { width: (Math.abs(b.mo) / maxAbs * 100) + "%" } })),
        el("span", { class: "hv " + (b.mo >= 0 ? "pos" : "neg") }, money(b.mo, true))))),
      el("h3", {}, "Legnagyobb tételek"),
      el("table", { class: "grid small" }, el("thead", {}, el("tr", {}, el("th", {}, "Idő"), el("th", {}, "Típus"), el("th", {}, "Partner"), el("th", {}, "Áru"), el("th", {}, "Összeg"))),
        el("tbody", {}, (e.top || []).map((t) => el("tr", {}, el("td", {}, ago(t.t, e.gt)), el("td", {}, t.ty || ""), el("td", {}, t.pa || ""),
          el("td", {}, t.wn ? `${t.wn} ×${num(t.am)}` : ""), el("td", { class: "num " + (t.mo >= 0 ? "pos" : "neg") }, money(t.mo)))))),
      el("h3", {}, "Legjobb kereskedők (nettó)"),
      el("table", { class: "grid small" }, el("tbody", {}, (e.partners || []).map((p) => el("tr", {}, el("td", {}, p.n), el("td", { class: "num " + (p.mo >= 0 ? "pos" : "neg") }, money(p.mo)))))));
  }
  bus.on("economy", render);
  bus.on("player", throttle(render, 5000));
  render();
}

// ================================================================ status / diagnostics
export function mountDiag(mod, ctx) {
  const { S, bus, yawConvention, send } = ctx;
  const box = el("div", { class: "scroll pad" });
  body(mod).append(box);
  function render() {
    const st = S.status || {};
    const h = S.hello || {};
    const s = S.stats;
    const rows = [
      ["Játék állapota", st.game || "–"], ["Pipe", st.pipe_connected ? `csatlakozva (${st.pipe_connects} kapcsolódás)` : "nincs"],
      ["Üzenetek", `${num(st.msgs)} (${num(st.rate_hz, 1)} /s), hibás: ${num(st.bad)}`], ["Utolsó adat", st.last_rx_age === null || st.last_rx_age === undefined ? "–" : num(st.last_rx_age, 1) + " mp"],
      ["Híd", h.mod ? `${h.mod} v${h.ver} · munkamenet ${h.session}` : "–"],
      ["Időmérés", s ? (s.hires === false || s.timer === "frame" || s.timer === "realtime"
        ? `${s.timer}: nincs nagy felbontású óra – a költség motorhívásban (ops) mérve, ${num(s.frame.ops, 1)} hívás / képkocka`
        : `${s.timer} (nagy felbontású) · ${num(s.frame.ops, 1)} motorhívás / képkocka`) : (h.timer || "–")],
      ["Engedélyezett parancsok", (h.allow || []).join(", ") || "–"],
      ["Gyorsgombok (Native Hotkey API)", s ? `${s.hk} regisztrálva` : (h.hotkeys ?? "–")], ["Lua Log API", h.loglib ? "van" : "nincs"],
      ["Kapuk (MD)", s ? `${s.gates} · MD ${s.gates_md ?? "?"} kaput talált, átvéve ${s.gates_rx ?? "?"} + ${s.gates_hw ?? 0} sztráda · ismert ${num(s.ngates)}` : "–"],
      ["Tick", s ? `frame ${num(s.nframe)} · md ${num(s.nmd)}` : "–"],
      ["Yaw-konvenció", `${yawConvention()} (szavazat a/b/c: ${S.yaw.a}/${S.yaw.b}/${S.yaw.c})`],
      ["Híd költsége / képkocka", s ? `átlag ${s.frame.avg} ms · max ${s.frame.max} ms` : "–"],
      ["Küldve", s ? `${num(s.sent)} üzenet · ${num(s.bytes / 1024)} KB · eldobva ${num(s.dropped)} · írási hiba ${num(s.wfail)}` : "–"],
      ["Kikapcsolt források", s && s.srcoff && s.srcoff.length ? s.srcoff.join(", ") : "nincs"],
    ];
    const t = el("table", { class: "grid small kv" }, el("tbody", {}, rows.map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, String(v))))));
    const ch = s ? el("table", { class: "grid small" },
      el("thead", {}, el("tr", {}, ["Csatorna", "átlag ms/kocka", "max ms", "menet ms", "hívás/kocka", "hívás/menet", "intervallum s", "futás", "hiba"].map((x) => el("th", {}, x)))),
      el("tbody", {}, Object.entries(s.ch).sort().map(([k, c]) => el("tr", { class: c.off ? "dmg" : "" },
        el("td", {}, k + (c.off ? " (KI)" : "")), el("td", { class: "num" }, String(c.avg)), el("td", { class: "num" }, String(c.max)),
        el("td", { class: "num" }, String(c.pass)), el("td", { class: "num" }, c.ops === undefined ? "–" : String(c.ops)),
        el("td", { class: "num" }, c.pops === undefined ? "–" : num(c.pops)), el("td", { class: "num" }, String(c.iv)), el("td", { class: "num" }, num(c.runs)),
        el("td", { class: "num", title: c.le || "" }, num(c.err)))))) : el("div", { class: "empty" }, "Még nincs statisztika a hídtól.");
    box.replaceChildren(t, el("h3", {}, "Csatornák (a híd méri)"), ch,
      el("div", { class: "pad" }, el("button", { onclick: () => send({ type: "resync" }), title: "A híd mindent újraküld" }, "Teljes újraküldés")));
  }
  bus.on("stats", throttle(render, 1000)); bus.on("status", throttle(render, 1000)); bus.on("hello", render);
  render();
}

// ================================================================ in-game hotkeys (help)
// ids = x4_companion.lua HOTKEYS (registered with the Native Hotkey API as "x4companion_<id>")
export const HOTKEY_HELP = [
  ["panel_next", "Companion: következő nézet", "A felső navigáció következő nézete (Térkép → Galaxis → Tulajdon → …)."],
  ["view_prev", "Companion: előző nézet", "Az előző nézet."],
  ["view_map", "Companion: vissza a térképre", "Bármelyik nézetből vissza a térképre (mint az Esc a böngészőben)."],
  ["view_toggle", "Companion: galaxis / szektor", "A térkép szektor- és galaxisnézete között vált."],
  ["zoom_in", "Companion: nagyítás", "A térkép nagyítása."],
  ["zoom_out", "Companion: kicsinyítés", "A térkép kicsinyítése."],
  ["zoom_fit", "Companion: illesztés (minden látsszon)", "A teljes szektor / galaxis a képernyőn."],
  ["log_down", "Companion: lista lefelé", "Az aktív lista (napló, objektumok, tulajdon, küldetések) következő sora."],
  ["log_up", "Companion: lista felfelé", "Az aktív lista előző sora."],
  ["list_select", "Companion: kijelölés a listában", "A listában kiemelt sor kijelölése: a térkép odaugrik, a részletek megnyílnak."],
  ["details", "Companion: részletek nyit / zár", "A kijelölt objektum részletei (Info modul) be / ki."],
  ["alert_next", "Companion: következő riasztás", "A következő riasztás a naplóban, a hozzá tartozó objektum a térképen."],
  ["ship_next", "Companion: következő saját hajó", "Végiglépked a saját hajóidon (Tulajdon lista sorrendje)."],
  ["ship_prev", "Companion: előző saját hajó", "Visszafelé lépked a saját hajóidon."],
  ["show_selected", "Companion: játékban kijelölt / célzott objektum", "A játékban éppen kijelölt (térkép) vagy célzott objektumot mutatja."],
  ["auto", "Companion: vissza a hajómra (automata)", "Követés újra: a térkép a hajódra áll."],
  ["ack_alerts", "Companion: riasztások nyugtázása", "Minden naplóbejegyzés olvasott, a riasztás-sáv eltűnik."],
];

export function mountHotkeys(mod, ctx) {
  const { S, bus } = ctx;
  const box = el("div", { class: "scroll pad hkhelp" });
  body(mod).append(box);
  function render() {
    const n = S.stats ? S.stats.hk : (S.hello ? S.hello.hotkeys : null);
    box.replaceChildren(
      el("p", {}, "A játékból egér nélkül is vezérelheted a Companiont. A gyorsgombokat a ",
        el("b", {}, "Native Hotkey API"), " mod adja: a játékban ", el("b", {}, "Beállítások → Hotkey Management → Hotkey Bindings"),
        " (csak betöltött mentésnél látszik). Kattints egy sorra, nyomd le a billentyűt. Ha egy sor „Waiting (pool full)”, a ",
        el("b", {}, "Hotkey Requests"), " oldalon tilts le egy kevésbé fontos kérést, majd Apply."),
      el("p", { class: "muted" }, n === null || n === undefined ? "A híd még nem jelentett." :
        `A híd ${n} gyorsgombot regisztrált` + (n === 0 ? " – a Native Hotkey API nincs telepítve vagy még nem kérte le (betöltés után ~15 mp)." : ".")),
      el("table", { class: "grid small" }, el("thead", {}, el("tr", {}, el("th", {}, "Név a játékban"), el("th", {}, "Mit csinál"))),
        el("tbody", {}, HOTKEY_HELP.map(([id, name, what]) => el("tr", { "data-key": id }, el("td", {}, name), el("td", {}, what))))),
      el("h3", {}, "Billentyűk a böngészőben"),
      el("table", { class: "grid small" }, el("tbody", {}, [
        ["1 – 8", "Nézetek: Térkép, Galaxis, Tulajdon, Napló, Küldetések, Frakciók, Gazdaság, Állapot"],
        ["Esc", "Vissza a térképre; a térképen: kijelölés törlése, majd vissza a hajódra"],
        ["+ / −, görgő, csippentés", "Nagyítás / kicsinyítés"], ["0", "Illesztés"], ["a", "Vissza a hajómra"],
        ["g", "Galaxis / szektor"], ["n / N", "Következő / előző saját hajó"], ["↓ / ↑, Enter", "Lista lépkedés, kijelölés"],
        ["/", "Keresés a tulajdonban"], ["?", "Ez a súgó"],
      ].map(([k, v]) => el("tr", {}, el("td", { class: "mono" }, k), el("td", {}, v))))));
  }
  bus.on("stats", throttle(render, 5000)); bus.on("hello", render);
  render();
}
