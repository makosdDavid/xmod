// Missions: accepted missions (active first) + mission offers.
import { useRef } from "react";
import { Crosshair, Flag, Navigation } from "lucide-react";
import { guidanceModel } from "@web/mapstyle.js";
import { showGuidanceOnMap } from "@/core/mapHost";
import { guidanceSummary } from "@/lib/info";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, SectionTitle } from "@/components/bits";
import { FitScroll } from "@/components/FitScroll";
import { useBus, useT } from "@/core/hooks";
import { useListNav } from "@/core/listnav";
import { command, factionName, S, sectorName, select } from "@/core/store";
import { joinParts, text, toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

export function MissionsPanel() {
  const { t, f } = useT();
  useBus(["missions", "galaxy", "factions", "control", "player"], 500);
  const box = useRef<HTMLDivElement | null>(null);
  // v1.3: the active mission's guidance (where its target is, "show on map")
  const gm = guidanceModel(S);
  const gsum = guidanceSummary(gm, (k, v) => t(k, v as never) as unknown as string, sectorName);
  const ms = [...S.missions].sort((a, b) => (b.act ? 1 : 0) - (a.act ? 1 : 0));
  const offers = [...S.offers].sort((a, b) => (toNum(b.rw) || 0) - (toNum(a.rw) || 0));
  const keys = [...ms.map((m) => "m" + m.id), ...offers.map((o) => "o" + o.id)];
  const cur = useListNav("missions", keys, (k) => {
    const m = k.startsWith("m") ? ms.find((x) => "m" + x.id === k) : null;
    const o = k.startsWith("o") ? offers.find((x) => "o" + x.id === k) : null;
    const s = m ? m.acs : o ? o.s : null;
    if (s) select({ kind: "sector", id: String(s), from: "missions" });
  }, box);

  return (
    <FitScroll ref={box} deps={keys.length}>
      <div className="px-3 py-2.5">
        <SectionTitle right={<Badge variant="secondary" className="h-4 px-1.5 text-[0.65rem]">{f.num(ms.length)}</Badge>}>{t("missions.accepted_title")}</SectionTitle>
        <div className="flex flex-col gap-1.5">
          {ms.map((m) => {
            const reward = f.money(m.rw) ?? text(m.rt);
            const left = toNum(m.dur) && toNum(m.dur)! > 0 ? f.dur(m.dur) : null;
            const prog = toNum(m.pm) ? ` (${text(m.pn) ? m.pn + " " : ""}${f.num(m.pc) ?? "0"}/${f.num(m.pm)})` : "";
            return (
              <div key={m.id} data-key={"m" + m.id} onClick={() => m.acs && select({ kind: "sector", id: String(m.acs), from: "missions" })}
                className={cn("cursor-pointer rounded-sm border border-input/60 bg-white/[0.024] px-3 py-2 text-[0.8rem] hover:border-primary hover:bg-accent",
                  m.act && "border-gold/50 bg-gold/5", "m" + m.id === cur && "ring-1 ring-primary")}>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  {m.act && <Badge className="h-4 bg-ok/20 px-1.5 text-[0.65rem] text-ok">{t("missions.active")}</Badge>}
                  <b className="min-w-0 truncate font-semibold" title={m.n || ""}>{m.n || "–"}</b>
                  <span className="truncate text-xs text-muted-foreground">{joinParts([text(m.st) ?? text(m.mt), m.fa ? factionName(m.fa) : null])}</span>
                </div>
                {text(m.ob) && <div className="mt-0.5 truncate text-gold" title={m.ob + prog}>▸ {m.ob}{prog}</div>}
                {gsum && gm && gm.mid === String(m.id) && (
                  <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs" data-guidance={m.id}>
                    <Crosshair className="size-3 shrink-0 text-gold" />
                    <span className="min-w-0 truncate text-foreground/85" title={gsum.text}>{gsum.text}</span>
                    {gsum.canShow && (
                      <Button size="sm" variant="default" className="ml-auto h-6 shrink-0 gap-1 px-2 text-xs" title={t("guidance.show_tip")}
                        data-guidance-show={m.id} onClick={(ev) => { ev.stopPropagation(); showGuidanceOnMap(); }}>
                        <Crosshair className="size-3" />{t("guidance.show")}
                      </Button>
                    )}
                  </div>
                )}
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-foreground/75">
                  {reward && <span>{t("missions.reward", { v: reward })}</span>}
                  {left && <span>{t("missions.time_left_v", { v: left })}</span>}
                  {m.acs && <span className="truncate">{sectorName(m.acs)}</span>}
                  {m.ac && (
                    <Button size="sm" variant="secondary" className={cn("ml-auto h-6 gap-1 px-2 text-xs", !S.control && "opacity-60")} title={t("missions.guidance_tip")}
                      onClick={(ev) => { ev.stopPropagation(); command("guidance", m.ac); }}>
                      <Navigation className="size-3" />{t("missions.guidance")}
                    </Button>
                  )}
                </div>
                {text(m.d) && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={m.d}>{m.d}</div>}
              </div>
            );
          })}
          {!ms.length && <Empty icon={Flag} title={t("missions.none")} className="py-4" />}
        </div>
        <SectionTitle className="mt-5" right={<Badge variant="secondary" className="h-4 px-1.5 text-[0.65rem]">{f.num(offers.length)}</Badge>}>{t("missions.offers_title")}</SectionTitle>
        {offers.length ? (
          <Table className="table-fixed text-[0.8rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-7 px-2 text-[0.68rem] uppercase">{t("missions.c_offer")}</TableHead>
                <TableHead className="hidden h-7 px-2 text-[0.68rem] uppercase @[40rem]:table-cell">{t("missions.c_faction")}</TableHead>
                <TableHead className="h-7 w-[6.5rem] px-2 text-right text-[0.68rem] uppercase">{t("missions.c_reward")}</TableHead>
                <TableHead className="hidden h-7 px-2 text-[0.68rem] uppercase @[30rem]:table-cell">{t("missions.c_sector")}</TableHead>
                <TableHead className="hidden h-7 w-[4.5rem] px-2 text-[0.68rem] uppercase @[48rem]:table-cell">{t("missions.c_expires")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {offers.map((o) => (
                <TableRow key={o.id} data-key={"o" + o.id} onClick={() => o.s && select({ kind: "sector", id: String(o.s), from: "offers" })}
                  className={cn("cursor-pointer border-border/40", "o" + o.id === cur && "x4-sel")}>
                  <TableCell className="truncate px-2 py-1" title={o.n || ""}>{o.n || "–"}</TableCell>
                  <TableCell className="hidden truncate px-2 py-1 @[40rem]:table-cell">{o.fa ? factionName(o.fa) : ""}</TableCell>
                  <TableCell className="truncate px-2 py-1 text-right tabular-nums">{f.money(o.rw, true) ?? text(o.rt) ?? ""}</TableCell>
                  <TableCell className="hidden truncate px-2 py-1 @[30rem]:table-cell">{o.s ? sectorName(o.s) : "?"}</TableCell>
                  <TableCell className="hidden truncate px-2 py-1 tabular-nums @[48rem]:table-cell">{toNum(o.dur) && o.dur > 0 ? f.dur(o.dur) : ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <Empty title={t("missions.no_offers")} className="py-4" />}
      </div>
    </FitScroll>
  );
}
