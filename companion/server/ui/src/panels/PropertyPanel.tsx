// Property: every own ship and station — sort, filters, search ("/"), fleet tree. Columns appear by
// priority as the panel gets wider (container queries); maximize (header double-click) shows all.
import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, Network, Search, Ship } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bar, Empty, GameIcon, listColorCss } from "@/components/bits";
import { FilterBar } from "@/components/FilterBar";
import { FitScroll } from "@/components/FitScroll";
import { useBus, useSettings, useT } from "@/core/hooks";
import { setPropertyOrder } from "@/core/hotkeys";
import { useListNav } from "@/core/listnav";
import { S, sectorName, select, type Any } from "@/core/store";
import { toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

// column -> container width from which it is shown (priority order)
const COLS: { k: string; at: string | null; w?: string }[] = [
  { k: "n", at: null }, { k: "hull", at: "@[20rem]:table-cell", w: "w-[6.5rem]" }, { k: "s", at: "@[28rem]:table-cell" },
  { k: "on", at: "@[38rem]:table-cell" }, { k: "c", at: "@[46rem]:table-cell", w: "w-[4rem]" }, { k: "p", at: "@[54rem]:table-cell", w: "w-[6.5rem]" },
  { k: "shield", at: "@[62rem]:table-cell", w: "w-[6.5rem]" }, { k: "fl", at: "@[72rem]:table-cell" }, { k: "code", at: "@[80rem]:table-cell", w: "w-[6rem]" },
];
const FILTERS = ["all", "ship", "station", "ship_s", "ship_m", "ship_l", "ship_xl", "trade", "mine", "fight", "damaged", "here"];
const CAP = 600;

export function PropertyPanel() {
  const { t, f } = useT();
  useBus(["property", "galaxy", "icons", "theme", "select", "player"], 700);
  const [cfg, setCfg] = useSettings("property", { sort: "n", dir: 1, filter: "all", q: "", tree: false });
  const body = useRef<HTMLDivElement | null>(null);
  const here = S.player && S.player.sector ? String(S.player.sector.id) : null;
  const q = (cfg.q || "").trim().toLowerCase();
  const cls = (c: string) => t("class." + c, { defaultValue: c || "" });
  const purpose = (p: string) => t("purpose." + p, { defaultValue: p || "" });

  const matches = (e: Any) => {
    const fl = cfg.filter;
    if (fl === "ship" && e.k !== "ship") return false;
    if (fl === "station" && e.k !== "station") return false;
    if (fl.startsWith("ship_") && e.c !== fl) return false;
    if (["trade", "mine", "fight"].includes(fl) && e.p !== fl) return false;
    if (fl === "damaged" && !((toNum(e.hull) ?? 100) < 70)) return false;
    if (fl === "here" && String(e.s) !== here) return false;
    if (!q) return true;
    const hay = `${e.n || ""} ${e.code || ""} ${sectorName(e.s)} ${e.on || ""} ${e.fl || ""} ${cls(e.c)}`.toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  };
  const val = (e: Any, k: string): string | number => {
    if (k === "s") return sectorName(e.s);
    if (k === "c") return ({ ship_xs: 0, ship_s: 1, ship_m: 2, ship_l: 3, ship_xl: 4, station: 5 } as Record<string, number>)[e.c] ?? 9;
    if (k === "fl") return e.fl || (e.cmd ? (S.property.get(String(e.cmd)) || {}).n || "" : "");
    if (k === "hull" || k === "shield") return toNum(e[k]) ?? -1;
    return e[k] ?? "";
  };
  let list = [...S.property.values()].filter(matches);
  list.sort((a, b) => {
    const va = val(a, cfg.sort), vb = val(b, cfg.sort);
    return (typeof va === "number" && typeof vb === "number" ? va - vb : f.compare(String(va), String(vb))) * cfg.dir;
  });
  const depth = new Map<string, number>();
  if (cfg.tree && !q) {
    const byCmd = new Map<string, Any[]>();
    const ids = new Set(list.map((e) => String(e.id)));
    for (const e of list) if (e.cmd && ids.has(String(e.cmd))) { const k = String(e.cmd); if (!byCmd.has(k)) byCmd.set(k, []); byCmd.get(k)!.push(e); }
    const out: Any[] = [];
    const walk = (e: Any, d: number) => { depth.set(String(e.id), d); out.push(e); for (const c of byCmd.get(String(e.id)) || []) if (d < 6) walk(c, d + 1); };
    for (const e of list) if (!(e.cmd && ids.has(String(e.cmd)))) walk(e, 0);
    list = out;
  }
  const ids = list.map((e) => String(e.id));
  useEffect(() => { setPropertyOrder(ids); });
  const shown = list.slice(0, CAP);
  // squad leaders (an own ship others are assigned to) get row_background_blue, as the game list (menu_map.lua:7326)
  const leaders = new Set<string>(); for (const x of S.property.values()) if (x.cmd) leaders.add(String(x.cmd));
  const cur = useListNav("property", shown.map((e) => String(e.id)), (k) => select({ kind: "obj", id: k, from: "property" }), body);
  const selId = S.selected && S.selected.kind === "obj" ? S.selected.id : null;
  useEffect(() => {
    if (!selId || !body.current) return;
    const row = body.current.querySelector(`[data-key="${CSS.escape(selId)}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selId]);

  const ships = [...S.property.values()].filter((e) => e.k === "ship").length;
  const summary = t("property.summary", { ships: f.num(ships), stations: f.num(S.property.size - ships) })
    + (list.length !== S.property.size ? t("property.filtered", { n: f.num(list.length) }) : "")
    + (S.propertyMeta && S.propertyMeta.at ? "" : t("property.waiting"));
  const sortBy = (k: string) => setCfg(cfg.sort === k ? { dir: -cfg.dir } : { sort: k, dir: 1 });

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 @[72rem]:flex-none">
          <div className="relative min-w-0 flex-1 @[72rem]:w-56 @[72rem]:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={cfg.q} onChange={(e) => setCfg({ q: e.target.value })} placeholder={t("property.search")} title={t("property.search_tip")} className="h-7 pl-7 text-xs" />
          </div>
          <Toggle size="sm" pressed={!!cfg.tree} onPressedChange={(v) => setCfg({ tree: v })} title={t("property.tree_tip")}
            className="h-7 shrink-0 gap-1 border border-input px-2 text-xs data-[state=on]:x4-on">
            <Network className="size-3.5" /><span className="hidden @[26rem]:inline">{t("property.tree")}</span>
          </Toggle>
        </div>
        <FilterBar value={cfg.filter} onChange={(v) => setCfg({ filter: v })} label={t("property.filter_label")} wideAt="72rem" className="w-32 min-w-0 shrink-0 @[72rem]:w-auto @[72rem]:flex-1"
          options={FILTERS.map((k) => ({ value: k, label: k.startsWith("ship_") ? t("class." + k) : t("property.f_" + k), tip: k === "here" ? t("property.f_here_tip") : k === "damaged" ? t("property.f_damaged_tip") : undefined }))} />
      </div>
      <div className="shrink-0 truncate px-3 pt-1.5 pb-1 text-xs text-muted-foreground" title={summary}>{summary}</div>
      <FitScroll ref={body} deps={shown.length}>
        {shown.length > 0 ? (
          <Table className="table-fixed text-[0.8rem]">
            <TableHeader className="sticky top-0 z-[1]">
              <TableRow className="hover:bg-transparent">
                {COLS.map((c) => (
                  <TableHead key={c.k} onClick={() => sortBy(c.k)} title={t("property.sort_tip")}
                    className={cn("h-7 cursor-pointer px-2 text-[0.68rem] font-semibold whitespace-nowrap text-muted-foreground select-none",
                      c.at ? "hidden " + c.at : "", c.w, cfg.sort === c.k && "text-primary")}>
                    <span className="inline-flex max-w-full items-center gap-0.5 truncate">
                      {t("property.c_" + c.k)}
                      {cfg.sort === c.k && (cfg.dir > 0 ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />)}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((e) => {
                const id = String(e.id), d = depth.get(id) || 0;
                const hull = toNum(e.hull);
                const order = e.k === "ship" ? (e.on ? e.on + (e.odf ? t("property.default_short") : "") : "")
                  : (toNum(e.wfc) ? t("property.workforce", { a: f.num(e.wf) ?? "?", b: f.num(e.wfc) }) : "");
                const fleet = e.fl || (e.cmd ? "↑ " + ((S.property.get(String(e.cmd)) || {}).n || "?") : "");
                const role = e.p ? purpose(e.p) : (e.k === "station" && toNum(e.mods) ? t("property.modules_n", { n: f.num(e.mods) }) : "");
                const cell = (k: string) => cn("truncate px-2 py-1", COLS.find((c) => c.k === k)!.at ? "hidden " + COLS.find((c) => c.k === k)!.at : "");
                return (
                  <TableRow key={id} data-key={id} onClick={() => select({ kind: "obj", id, from: "property" })}
                    className={cn("cursor-pointer", leaders.has(id) && "bg-sub-head", hull !== null && hull < 40 && "text-warn",
                      (id === selId || id === cur) && "x4-sel")}>
                    <TableCell className="truncate px-2 py-1" style={{ paddingLeft: `${0.5 + d * 0.9}rem` }} title={e.n || ""}>
                      {d > 0 && <span className="mr-1 text-muted-foreground">└</span>}
                      <GameIcon o={e} size={16} className="mr-1.5" /><span data-list-name style={{ color: listColorCss(e) }}>{e.n || "–"}</span>
                    </TableCell>
                    <TableCell className={cell("hull")}><Bar v={e.hull} kind="hull" width={40} /></TableCell>
                    <TableCell className={cn(cell("s"), String(e.s) === here && "text-primary")} title={sectorName(e.s)}>{sectorName(e.s)}</TableCell>
                    <TableCell className={cell("on")} title={e.od || order}>{order}</TableCell>
                    <TableCell className={cell("c")}>{cls(e.c)}</TableCell>
                    <TableCell className={cell("p")} title={role}>{role}</TableCell>
                    <TableCell className={cell("shield")}>{e.k === "ship" ? <Bar v={e.shield} kind="shield" width={40} /> : (f.money(e.money, true) ?? "")}</TableCell>
                    <TableCell className={cell("fl")} title={fleet}>{fleet}</TableCell>
                    <TableCell className={cn(cell("code"), "font-mono text-xs")}>{e.code || ""}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : <Empty icon={Ship} title={S.property.size ? t("property.empty") : t("property.empty_none")} />}
        {list.length > CAP && <div className="px-3 py-2 text-center text-xs text-muted-foreground">{t("property.capped", { n: f.num(CAP) })}</div>}
      </FitScroll>
    </>
  );
}
