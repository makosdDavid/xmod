// Logbook: the game's categories + notifications (ticker) + messages, unread counters, alerts.
import { useRef } from "react";
import { CheckCheck, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/bits";
import { FilterBar } from "@/components/FilterBar";
import { FitScroll } from "@/components/FitScroll";
import { useBus, useT } from "@/core/hooks";
import { entries, logCat, LOG_TABS, markAllRead, readT, setLogCat, unread, type LogTab } from "@/core/logbook";
import { useListNav } from "@/core/listnav";
import { S, select, type Any } from "@/core/store";
import { toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

const keyOf = (e: Any) => `${e.cat}|${e.t}|${e.ti}`;

export function LogPanel() {
  const { t, f } = useT();
  useBus(["log", "ticker", "messages", "logread"], 400);
  useBus(["player"], 15000);
  const box = useRef<HTMLDivElement | null>(null);
  const cat = logCat();
  const all = entries(cat);
  const rt = readT(cat);
  const now = S.player ? S.player.gametime : null;
  const shown: Any[] = [];
  for (let i = all.length - 1; i >= 0 && shown.length < 400; i--) shown.push(all[i]);
  const cur = useListNav("log", shown.map(keyOf), (k) => {
    const e = shown.find((x) => keyOf(x) === k);
    if (e && e.ic) select({ kind: "obj", id: String(e.ic), from: "log" });
  }, box);
  const alerts = unread("alerts");

  return (
    <>
      <div className="flex shrink-0 items-start gap-2 border-b px-2.5 py-2">
        <FilterBar value={cat} onChange={(v) => { setLogCat(v as LogTab); box.current?.scrollTo({ top: 0 }); }} label={t("log.category")} wideAt="44rem" className="min-w-0 flex-1"
          options={LOG_TABS.map((k) => ({ value: k, label: t("log.cat_" + k), badge: unread(k), alert: k === "alerts" && alerts > 0 }))} />
        <Button variant="ghost" size="sm" onClick={markAllRead} title={t("log.mark_read_tip")} className="h-7 shrink-0 gap-1 px-2 text-xs">
          <CheckCheck className="size-3.5" /><span className="hidden @[26rem]:inline">{t("log.mark_read")}</span>
        </Button>
      </div>
      <FitScroll ref={box} deps={shown.length + cat}>
        {shown.map((e) => {
          const k = keyOf(e);
          const isNew = cat === "inbox" ? e._unread : (toNum(e.t) ?? 0) > rt;
          const meta = [e.en, e.fa, e.so].filter((x) => typeof x === "string" && x.trim()).join(" · ");
          const mo = toNum(e.mo);
          return (
            <div key={k} data-key={k} onClick={e.ic ? () => select({ kind: "obj", id: String(e.ic), from: "log" }) : undefined}
              title={e.ic ? t("log.show_on_map") : undefined}
              className={cn("border-b border-border/40 px-3 py-1.5 text-[0.8rem]",
                e.ic && "cursor-pointer hover:bg-primary/10",
                isNew && "bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]",
                e.cat === "alerts" && "shadow-[inset_2px_0_0_var(--bad)]", e.cat === "alerts" && isNew && "bg-bad/10 shadow-[inset_3px_0_0_var(--bad)]",
                k === cur && "bg-primary/15")}>
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="hidden shrink-0 text-[0.65rem] tracking-wider text-muted-foreground uppercase @[24rem]:inline">{t("log.cat_" + e.cat, { defaultValue: e.cat || "" })}</span>
                <span className={cn("min-w-0 flex-1 truncate font-medium", e.hl && "text-[#ffc2bb]")} title={e.ti || ""}>{e.ti || ""}</span>
                <span className="shrink-0 text-[0.7rem] text-muted-foreground" title={f.gameTime(e.t) ?? ""}>{f.ago(e.t, now) ?? ""}</span>
              </div>
              {e.tx && <div className="line-clamp-2 text-foreground/75" title={e.tx}>{e.tx}</div>}
              {(meta || mo) && (
                <div className="truncate text-xs text-muted-foreground">
                  {meta}{mo ? <span className={mo >= 0 ? "text-pos" : "text-neg"}>{(meta ? " " : "") + (mo > 0 ? "+" : "") + (f.money(mo) ?? "")}</span> : null}
                </div>
              )}
            </div>
          );
        })}
        {!shown.length && <Empty icon={ScrollText} title={t("log.empty")} />}
      </FitScroll>
    </>
  );
}
