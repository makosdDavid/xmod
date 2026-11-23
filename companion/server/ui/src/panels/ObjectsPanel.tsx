// Sector objects: the game map's object list for the sector the map shows (filters, search, distance).
import { useMemo, useRef } from "react";
import { Search, Satellite } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Bar, Empty, GameIcon, listColorCss } from "@/components/bits";
import { FilterBar } from "@/components/FilterBar";
import { FitScroll } from "@/components/FitScroll";
import { useBus, useSettings, useT } from "@/core/hooks";
import { useListNav } from "@/core/listnav";
import { mapSid } from "@/core/mapHost";
import { factionName, S, sectorName, select, type Any } from "@/core/store";
import { toNum } from "@/lib/format";
import { isOwnerlessShip, OBJ_FILTERS, objMatches, OWNERLESS_CSS } from "@/lib/objects";
import { cn } from "@/lib/utils";


export function ObjectsPanel() {
  const { t, f } = useT();
  useBus(["scan", "player", "select", "factions", "galaxy", "mapsector", "mapmode", "theme", "icons"], 600);
  const [cfg, setCfg] = useSettings("objects", { f: "all", q: "" });
  const box = useRef<HTMLDivElement | null>(null);

  const sid = mapSid();
  const sc = sid ? S.scans[sid] : null;
  let all: Any[] = sc ? (sc.objs || sc.items || []) : [];
  if (!all.some((x) => x.c === "gate")) {
    all = all.concat((S.gatesBySector.get(String(sid)) || []).map((g) => ({
      id: g.id, c: g.hw ? "highwayentrygate" : "gate", n: g.hw ? t("objects.highway") : t("objects.gate"), x: g.x, z: g.z, ds: g.ds, du: g.du,
    })));
  }
  const p = S.player && S.player.object;
  const same = !!(p && S.player!.sector && S.player!.sector.id === sid);
  const q = (cfg.q || "").trim().toLowerCase();
  const rows = all.filter((o) => objMatches(o, cfg.f, q, factionName(o.o)));
  const dOf = (o: Any): number | null => {
    const ox = toNum(o.x), oz = toNum(o.z);
    if (ox === null || oz === null) return null;
    return same ? Math.hypot(ox - p.x, oz - p.z) : Math.hypot(ox, oz);
  };
  rows.sort((a, b) => (dOf(a) ?? Infinity) - (dOf(b) ?? Infinity));
  const shown = rows.slice(0, 600);
  const keys = useMemo(() => shown.map((o) => String(o.id)), [shown.map((o) => o.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = useListNav("objects", keys, (k) => {
    const o = shown.find((x) => String(x.id) === k);
    if (o) select({ kind: "obj", id: String(o.id), from: "objects", obj: o, sid });
  }, box);
  const selId = S.selected && S.selected.kind === "obj" ? S.selected.id : null;

  const summary = [t("objects.summary", { sector: sectorName(sid), count: f.num(rows.length) }),
    sc && toNum(sc.hidden) ? t("objects.hidden", { n: f.num(sc.hidden) }) : "",
    sid ? (same ? t("objects.dist_you") : t("objects.dist_center")) : ""].join("");

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-1.5">
        <div className="relative min-w-0 flex-1 @[34rem]:w-48 @[34rem]:flex-none">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={cfg.q} onChange={(e) => setCfg({ q: e.target.value })} placeholder={t("objects.filter")} className="h-7 pl-7 text-xs" />
        </div>
        <FilterBar value={cfg.f} onChange={(v) => setCfg({ f: v })} label={t("objects.filter")} wideAt="36rem"
          options={OBJ_FILTERS.map((k) => ({ value: k, label: t("objects.f_" + k) }))} className="w-28 min-w-0 shrink-0 @[36rem]:w-auto @[36rem]:flex-1" />
      </div>
      <div className="shrink-0 truncate px-3 pt-1.5 pb-1 text-xs text-muted-foreground" title={summary}>{summary}</div>
      <FitScroll ref={box} deps={shown.length}>
        {shown.map((o) => {
          const d = dOf(o);
          const dest = o.c === "gate" || o.c === "highwayentrygate" ? " → " + (o.ds ? sectorName(o.ds) : "?") : "";
          const cls = t("class." + o.c, { defaultValue: "" });
          const name = (o.n || cls || "?") + dest;
          const abandoned = isOwnerlessShip(o);
          const owner = o.pl ? t("objects.own") : ((S.factions[o.o] || {}).sn || (o.o === "ownerless" ? t("objects.ownerless") : o.o) || "");
          return (
            <div key={o.id} data-key={String(o.id)} onClick={() => select({ kind: "obj", id: String(o.id), from: "objects", obj: o, sid })}
              className={cn("grid cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/40 px-2.5 py-1 text-[0.8rem] hover:bg-primary/10",
                "@[22rem]:grid-cols-[1.5rem_minmax(0,1fr)_2.5rem_auto] @[30rem]:grid-cols-[1.5rem_minmax(0,1fr)_2.5rem_5rem_auto] @[38rem]:grid-cols-[1.5rem_minmax(0,1fr)_2.5rem_5rem_auto_6.5rem]",
                (String(o.id) === selId || String(o.id) === cur) && "x4-sel")}>
              <span className="flex justify-center"><GameIcon o={o} size={18} /></span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium" style={{ color: listColorCss(o) }} title={name}>{name}</span>
                {abandoned && (
                  <span data-badge="ownerless" title={t("objects.ownerless_tip")} style={{ color: OWNERLESS_CSS, borderColor: OWNERLESS_CSS }}
                    className="shrink-0 rounded-sm border border-dashed px-1.5 text-[0.65rem] leading-4 font-semibold uppercase">{t("objects.ownerless_badge")}</span>
                )}
              </span>
              <span className="hidden truncate text-xs text-muted-foreground @[22rem]:block">{cls}</span>
              <span className="hidden truncate text-xs text-muted-foreground @[30rem]:block" title={owner}>{owner}</span>
              <span className="text-right text-xs tabular-nums text-foreground/80">{f.dist(d) ?? ""}</span>
              <span className="hidden justify-end @[38rem]:flex"><Bar v={o.hull} kind="hull" width={44} /></span>
            </div>
          );
        })}
        {!shown.length && <Empty icon={Satellite} title={sc ? t("objects.empty_filter") : t("objects.empty_scan")} />}
      </FitScroll>
    </>
  );
}
