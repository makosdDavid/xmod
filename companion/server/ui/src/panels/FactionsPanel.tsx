// Factions: relation (number, rank name, bar) and licences. A list that reflows: narrow = licences
// wrap under the name; wide = one line per faction. Never clipped, never a horizontal scrollbar.
import { useRef } from "react";
import { Lock, Shield } from "lucide-react";
import { Dot, Empty, factionColor } from "@/components/bits";
import { FitScroll } from "@/components/FitScroll";
import { useBus, useT } from "@/core/hooks";
import { useListNav } from "@/core/listnav";
import { S, type Any } from "@/core/store";
import { text, toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

export function FactionsPanel() {
  const { t, f } = useT();
  useBus(["factions"], 500);
  const box = useRef<HTMLDivElement | null>(null);
  const list = [...S.factionList].sort((a, b) => (toNum(b.rel) ?? 0) - (toNum(a.rel) ?? 0));
  const cur = useListNav("factions", list.map((x) => String(x.id)), () => {}, box);
  if (!list.length) return <Empty icon={Shield} title={t("factions.empty")} className="flex-1" />;
  return (
    <FitScroll ref={box} deps={list.length}>
      <div className="flex flex-col">
        {list.map((fa: Any) => {
          const rel = toNum(fa.rel) ?? 0;
          const pct = ((rel + 30) / 60) * 100;
          const tone = fa.h ? "hostile" : fa.e ? "enemy" : rel >= 10 ? "friend" : "";
          const lic: Any[] = Array.isArray(fa.lic) ? fa.lic : [];
          return (
            <div key={fa.id} data-key={String(fa.id)}
              className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border/40 px-3 py-1.5 text-[0.8rem]",
                "@[44rem]:grid-cols-[minmax(10rem,14rem)_7.5rem_7rem_minmax(0,1fr)]", String(fa.id) === cur && "x4-sel")}>
              <div className="flex min-w-0 items-center gap-1.5" title={fa.n || fa.id}>
                <Dot color={factionColor(fa.id)} />
                <span className="truncate font-medium">{fa.n || fa.id}</span>
                {text(fa.sn) && <span className="shrink-0 text-xs text-muted-foreground">[{fa.sn}]</span>}
                {fa.lk && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label={t("factions.locked")} />}
              </div>
              <div className={cn("text-right tabular-nums @[44rem]:text-left",
                tone === "hostile" && "text-bad", tone === "enemy" && "text-enemy", tone === "friend" && "text-friend")}>
                {f.signed(rel)} {text(fa.rn) && <span className="text-xs text-muted-foreground">{fa.rn}</span>}
              </div>
              <div className="col-span-2 @[44rem]:col-span-1">
                <span className="relative block h-1.5 w-full max-w-[7rem] bg-white/10">
                  <span className="absolute -top-0.5 -bottom-0.5 left-1/2 w-px bg-border" />
                  <span className={cn("absolute inset-y-0 bg-muted-foreground", tone === "friend" && "bg-friend", tone === "enemy" && "bg-enemy", tone === "hostile" && "bg-bad")}
                    style={{ left: `${Math.min(pct, 50)}%`, width: `${Math.abs(pct - 50)}%` }} />
                </span>
              </div>
              {lic.length > 0 && (
                <div className="col-span-2 flex min-w-0 flex-wrap gap-1 @[44rem]:col-span-1">
                  {lic.map((l, i) => {
                    const tip = [l.has ? t("factions.has") : t("factions.has_not"), f.money(l.pr) ? t("factions.price", { v: f.money(l.pr) }) : "",
                      toNum(l.mr) !== null ? t("factions.min_rel", { v: f.signed(l.mr) }) : ""].join("");
                    return (
                      <span key={(l.t || "") + i} title={(l.n || l.t || "") + " – " + tip}
                        className={cn("max-w-full truncate rounded-sm border px-1.5 text-[0.68rem]",
                          l.has ? "border-ok/45 text-ok" : "border-border text-muted-foreground")}>{l.n || l.t}</span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </FitScroll>
  );
}
