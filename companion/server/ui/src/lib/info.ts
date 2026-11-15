// Info panel model (pure; unit-tested in info.test.ts). Builds the rows / sections / buttons for the
// selected object, sector or (nothing selected) the player's ship. Rule: a row, section or button is
// only produced when it has a real value — the old shell printed "null" for missing sections
// (Element.replaceChildren(null) stringifies) and empty bars for objects without hull/shield.
import { joinParts, pct01, text, toNum, type Fmt } from "./format";
import { isOwnerlessShip } from "./objects";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;
export type Tr = (key: string, vars?: Record<string, unknown>) => string;

export type RowValue = { kind: "text"; text: string; tone?: "pos" | "neg" | "hostile" | "enemy" } | { kind: "bar"; bar: "hull" | "shield"; pct: number };
export interface Row { key: string; label: string; value: RowValue }
export interface Btn { key: string; label: string; tip: string; cmd: string | null; args: string[]; allowed: boolean; local?: "center" | "sector" }
export interface LinkItem { id: string; label: string; station?: boolean }
export type Cargo =
  | { state: "loading" | "nodata" | "locked" | "empty" }
  | { state: "list"; items: { key: string; name: string; amount: string }[] };

export interface InfoModel {
  kind: "none" | "player" | "sector" | "obj" | "gone";
  title: string;
  subtitle: string | null;
  icon: Any | null;          // object for the game icon (null = none)
  rows: Row[];
  cargo: Cargo | null;
  buttons: Btn[];
  orders: { key: string; text: string; meta: string | null }[];
  subordinates: LinkItem[];
  ownHere: LinkItem[];
  hints: string[];
}

export interface InfoCtx {
  S: Any;
  t: Tr;
  f: Fmt;
  sectorName: (id: unknown) => string;
  factionName: (id: unknown) => string;
  whereText: (w: Any) => string;
}

const SHIPISH = (c: string) => c.startsWith("ship") || c === "spacesuit";
export const DEPLOYABLE = new Set(["satellite", "navbeacon", "resourceprobe", "mine", "lasertower", "lockbox", "collectablewares",
  "collectableammo", "drop", "crate", "datavault", "buildstorage"]);

const txt = (s: string | null | undefined, tone?: "pos" | "neg" | "hostile" | "enemy"): RowValue | null =>
  (s === null || s === undefined || s === "" ? null : { kind: "text", text: s, ...(tone ? { tone } : {}) });

/** hull / shield bar row: only with a real percentage; deployables without a hull/shield report 0 → hidden */
function barRow(key: string, label: string, v: unknown, cls: string, which: "hull" | "shield"): Row | null {
  const p = pct01(v);
  if (p === null) return null;
  if (DEPLOYABLE.has(cls) && p === 0) return null;
  if (!SHIPISH(cls) && cls !== "station" && !DEPLOYABLE.has(cls) && p === 0) return null;
  return { key, label, value: { kind: "bar", bar: which, pct: p } };
}

function push(rows: Row[], key: string, label: string, v: RowValue | null) { if (v) rows.push({ key, label, value: v }); }

function findObj(S: Any, sel: Any): { o: Any; sid: string | null } | null {
  const p = S.property.get(sel.id);
  if (p) return { o: p, sid: p.s ?? null };
  for (const [sid, sc] of Object.entries(S.scans as Record<string, Any>)) {
    const o = ((sc && (sc.objs || sc.items)) || []).find((x: Any) => x.id === sel.id);
    if (o) return { o, sid };
  }
  if (sel.obj) return { o: sel.obj, sid: sel.sid ?? null };
  const pl = S.player && S.player.object;
  if (pl && pl.id === sel.id) return { o: { ...pl, c: pl.class, n: pl.name, pl: true }, sid: S.player.sector ? S.player.sector.id : null };
  return null;
}

function allowed(S: Any, cmd: string) {
  return !S.hello || !Array.isArray(S.hello.allow) || S.hello.allow.includes(cmd);
}

export function buildInfo(ctx: InfoCtx, sel: Any | null, det: Any | null | undefined): InfoModel {
  const { S, t, f, sectorName, factionName } = ctx;
  const m: InfoModel = { kind: "none", title: "", subtitle: null, icon: null, rows: [], cargo: null, buttons: [], orders: [], subordinates: [], ownHere: [], hints: [] };
  const mkBtn = (key: string, label: string, tip: string, cmd: string, args: unknown[]): Btn => {
    const ok = allowed(S, cmd);
    const ids = args.map((a) => String(a));
    return { key, label, cmd, args: ids, allowed: ok && ids.every((a) => /^\d+$/.test(a)), tip: ok ? tip : tip + t("info.disabled_in_mod") };
  };

  // ---------------------------------------------------------- nothing selected: your ship
  if (!sel) {
    const p = S.player;
    const o = p && p.object;
    m.kind = o ? "player" : "none";
    m.title = o ? (text(o.name) ?? t("info.your_ship")) : t("info.no_selection");
    if (o) {
      push(m.rows, "where", t("info.where"), txt(text(ctx.whereText(p.where))));
      push(m.rows, "sector", t("info.sector"), txt(p.sector ? text(p.sector.name) : null));
      const h = barRow("hull", t("info.hull"), o.hull, "ship_m", "hull"); if (h) m.rows.push(h);
      const s = barRow("shield", t("info.shield"), o.shield, "ship_m", "shield"); if (s) m.rows.push(s);
      const tg = p.target;
      push(m.rows, "target", t("info.target"), txt(tg ? joinParts([text(tg.name) ?? "?", f.dist(tg.dist)]) : t("top.none")));
      push(m.rows, "mission", t("info.mission"), txt(p.mission ? text(p.mission.name) : null));
    }
    m.hints.push(t("info.pick_hint"));
    return m;
  }

  // ---------------------------------------------------------- sector
  if (sel.kind === "sector") {
    const id = String(sel.id);
    const s = S.sectors.get(id);
    const own = [...S.property.values()].filter((e: Any) => String(e.s) === id);
    m.kind = "sector";
    m.title = s ? (text(s.name) ?? "?") : sectorName(id);
    m.subtitle = s ? text(s.cname) : null;
    push(m.rows, "owner", t("info.owner"), txt(s && s.owner ? factionName(s.owner) : null));
    const ships = own.filter((e: Any) => e.k === "ship").length, stations = own.filter((e: Any) => e.k === "station").length;
    push(m.rows, "own_ships", t("info.own_ships"), txt(f.num(ships)));
    push(m.rows, "own_stations", t("info.own_stations"), txt(f.num(stations)));
    const res = s && Array.isArray(s.res) ? s.res.map((r: Any) => {
      const c = toNum(r.c), mx = toNum(r.m);
      return joinParts([text(r.n) ?? text(r.w), c !== null && mx ? f.pct((c / mx) * 100) : null], " ");
    }).filter(Boolean).join(", ") : "";
    push(m.rows, "resources", t("info.resources"), txt(res || null));
    const links = (S.links as Any[]).filter((l) => l.a === id || l.b === id)
      .map((l) => sectorName(l.a === id ? l.b : l.a) + (l.kind === "hw" ? t("info.highway_suffix") : "")).join(", ");
    push(m.rows, "links", t("info.links"), txt(links || null));
    m.buttons.push({ key: "sector_view", label: t("info.sector_view"), tip: t("info.sector_view_tip"), cmd: null, args: [id], allowed: true, local: "sector" });
    m.buttons.push(mkBtn("openmap", t("info.game_map"), t("info.game_map_tip_sector"), "openmap", [id]));
    m.ownHere = own.slice(0, 80).map((e: Any) => ({ id: String(e.id), label: text(e.n) ?? String(e.id), station: e.k === "station" }));
    if (!S.control) m.hints.push(t("info.control_hint"));
    return m;
  }

  // ---------------------------------------------------------- object
  const found = findObj(S, sel);
  if (!found && !det) {
    m.kind = "gone";
    m.title = t("info.object");
    m.hints.push(t("info.no_data"));
    return m;
  }
  // property / scan entries win over the details reply for live values; but "on" means different
  // things: in property entries it is the order name, in the details reply the owner's name
  const base: Any = found ? found.o : {};
  const o: Any = { ...(det || {}), ...base };
  const sid: string | null = found ? found.sid : (det && det.s) || null;
  const cls: string = String(o.c || o.class || "");
  const isShip = SHIPISH(cls);
  const own = !!(o.pl || o.k || o.o === "player");
  const ownerName = own ? t("info.own") : (det && text(det.on)) || (o.o === "ownerless" ? t("objects.ownerless") : o.o ? factionName(o.o) : null);
  const orderName = text(base.k ? base.on : null) || (det ? text(det.oname) : null);
  m.kind = "obj";
  m.title = text(o.n) ?? text(o.name) ?? t("info.object");
  m.subtitle = text(o.code);
  m.icon = { ...o, c: cls };

  push(m.rows, "class", t("info.class"), txt(cls ? (t("class." + cls) !== "class." + cls ? t("class." + cls) : cls) : null));
  push(m.rows, "sector", t("info.sector"), txt(sid ? sectorName(sid) : null));
  push(m.rows, "owner", t("info.owner"), txt(ownerName));
  if (isOwnerlessShip({ ...o, c: cls })) push(m.rows, "ownerless", t("info.status"), txt(t("info.ownerless_claim"), "pos"));
  const rel = toNum(o.r);
  if (rel !== null && !own) push(m.rows, "relation", t("info.relation"), txt(f.signed(rel), rel < 0 ? "neg" : rel > 0 ? "pos" : undefined));
  const h = barRow("hull", t("info.hull"), o.hull, cls, "hull"); if (h) m.rows.push(h);
  const s = barRow("shield", t("info.shield"), o.shield, cls, "shield"); if (s) m.rows.push(s);
  if (text(o.p)) push(m.rows, "purpose", t("info.purpose"), txt(t("purpose." + o.p) !== "purpose." + o.p ? t("purpose." + o.p) : String(o.p)));
  if (orderName) {
    const oq = toNum(o.oq);
    push(m.rows, "order", t("info.order"), txt(orderName + (text(o.os) ? " · " + text(o.os) : "") + (oq ? t("info.order_queue_n", { n: f.num(oq) }) : "") + (o.odf ? t("info.order_default") : "")));
  }
  push(m.rows, "fleet", t("info.fleet"), txt(text(o.fl)));
  if (o.cmd) push(m.rows, "commander", t("info.commander"), txt(text((S.property.get(String(o.cmd)) || {}).n) ?? String(o.cmd)));
  if (cls === "station" && own) push(m.rows, "modules", t("info.modules"), txt(f.num(o.mods)));
  if (own) push(m.rows, "account", t("info.account"), txt(f.money(o.money)));
  if (toNum(o.wfc)) push(m.rows, "workforce", t("info.workforce"), txt(joinParts([f.num(o.wf) ?? "?", f.num(o.wfc)], " / ")));
  const p = S.player && S.player.object;
  const px = p ? toNum(p.x) : null, pz = p ? toNum(p.z) : null, ox = toNum(o.x), oz = toNum(o.z);
  if (p && S.player.sector && sid === S.player.sector.id && px !== null && pz !== null && ox !== null && oz !== null && p.id !== o.id) {
    push(m.rows, "distance", t("info.distance"), txt(f.dist(Math.hypot(ox - px, oz - pz))));
  }
  if (o.ds) push(m.rows, "destination", t("info.destination"), txt(sectorName(o.ds)));
  else if (o.du) push(m.rows, "destination", t("info.destination"), txt(t("info.unknown_sector")));
  const rr = toNum(o.rr) || (det ? toNum(det.rr) : null);
  if (rr) push(m.rows, "radar", t("info.radar"), txt(f.dist(rr)));
  if (o.mt) push(m.rows, "mission", t("info.mission"), txt(t("info.mission_target")));

  // cargo (ships and stations only)
  if (isShip || cls === "station") {
    if (det === undefined) m.cargo = { state: "loading" };
    else if (!det) m.cargo = { state: "nodata" };
    else if (!det.cwl) m.cargo = { state: "locked" };
    else if (Array.isArray(det.cargo) && det.cargo.length) {
      m.cargo = { state: "list", items: det.cargo.map((c: Any, i: number) => ({
        key: String(c.w ?? i), name: text(c.n) ?? text(c.w) ?? "?", amount: f.num(c.a) ?? t("info.cargo_unknown_amount"),
      })) };
    } else m.cargo = { state: "empty" };
  }

  // buttons: only meaningful ones; the object must have a numeric id
  const oid = String(o.id ?? sel.id);
  m.buttons.push({ key: "center", label: t("info.on_map"), tip: t("info.on_map_tip"), cmd: null, args: [oid], allowed: true, local: "center" });
  if (/^\d+$/.test(oid)) {
    m.buttons.push(mkBtn("openmap", t("info.game_map"), t("info.game_map_tip_obj"), "openmap", [oid]));
    m.buttons.push(mkBtn("target", t("info.set_target"), t("info.set_target_tip"), "target", [oid]));
    m.buttons.push(mkBtn("guidance", t("info.guidance"), t("info.guidance_tip"), "guidance", [oid]));
    if (isShip && own) m.buttons.push(mkBtn("stop", t("info.stop"), t("info.stop_tip"), "stop", [oid]));
    if (isShip && own && S.player && S.player.sector && sid && sid !== S.player.sector.id) {
      m.buttons.push(mkBtn("flyto", t("info.flyto"), t("info.flyto_tip"), "flyto", [oid, S.player.sector.id]));
    }
  }

  if (det && Array.isArray(det.orders)) {
    m.orders = det.orders.map((q: Any, i: number) => ({
      key: String(i),
      text: text(q.n) ?? text(q.d) ?? "?",
      meta: joinParts([text(q.st), q.pt && q.pt.s ? sectorName(q.pt.s) : null]),
    }));
    if (det.orders.some((q: Any) => q && q.pt)) m.hints.push(t("info.orders_hint"));
  }
  m.subordinates = [...S.property.values()].filter((e: Any) => e.cmd && String(e.cmd) === oid)
    .map((e: Any) => ({ id: String(e.id), label: text(e.n) ?? String(e.id) }));
  if (!S.control && m.buttons.some((b) => b.cmd)) m.hints.push(t("info.control_hint"));
  return m;
}
