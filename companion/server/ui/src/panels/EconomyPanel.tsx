// Economy: balance + last hour income / expenses (KPI cards that reflow), by type, largest items, traders.
import { Wallet } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Empty, SectionTitle } from "@/components/bits";
import { FitScroll } from "@/components/FitScroll";
import { useBus, useT } from "@/core/hooks";
import { S, type Any } from "@/core/store";
import { text, toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

function Kpi({ label, value, tone }: { label: string; value: string | null; tone?: "pos" | "neg" | "gold" }) {
  return (
    <Card className="min-w-0 gap-0 rounded-md px-3 py-2 shadow-none">
      <div className="truncate text-[0.65rem] tracking-wider text-muted-foreground uppercase" title={label}>{label}</div>
      <div className={cn("truncate text-base font-semibold tabular-nums", tone === "pos" && "text-pos", tone === "neg" && "text-neg", tone === "gold" && "text-gold")}
        title={value ?? ""}>{value ?? "–"}</div>
    </Card>
  );
}

export function EconomyPanel() {
  const { t, f } = useT();
  useBus(["economy"], 500);
  useBus(["player"], 5000);
  const e = S.economy;
  if (!e) return <Empty icon={Wallet} title={t("economy.empty")} className="flex-1" />;
  const inc = toNum(e.inc) ?? 0, exp = toNum(e.exp) ?? 0, net = inc - exp;
  const types: Any[] = Array.isArray(e.bytype) ? e.bytype : [];
  const maxAbs = Math.max(1, ...types.map((b) => Math.abs(toNum(b.mo) ?? 0)));
  const top: Any[] = Array.isArray(e.top) ? e.top : [];
  const partners: Any[] = Array.isArray(e.partners) ? e.partners : [];
  return (
    <FitScroll deps={top.length + types.length}>
      <div className="px-3 py-2.5">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2" data-key="kpis">
          <Kpi label={t("economy.balance")} value={f.money(S.player ? S.player.money : e.money)} tone="gold" />
          <Kpi label={t("economy.income")} value={f.money(inc)} tone="pos" />
          <Kpi label={t("economy.expense")} value={f.money(exp)} tone="neg" />
          <Kpi label={t("economy.net")} value={f.money(net)} tone={net >= 0 ? "pos" : "neg"} />
          <Kpi label={t("economy.transactions")} value={f.num(e.count)} />
        </div>
        {types.length > 0 && (
          <>
            <SectionTitle className="mt-4">{t("economy.by_type")}</SectionTitle>
            <div className="flex flex-col gap-1">
              {types.map((b, i) => {
                const mo = toNum(b.mo) ?? 0;
                return (
                  <div key={(b.n || "") + i} data-key={"t" + i} className="grid grid-cols-[minmax(0,9rem)_minmax(2rem,1fr)_auto] items-center gap-2 text-[0.8rem]">
                    <span className="truncate" title={b.n || ""}>{b.n || "?"}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-white/5">
                      <span className={cn("block h-full rounded-full", mo >= 0 ? "bg-pos" : "bg-neg")} style={{ width: `${(Math.abs(mo) / maxAbs) * 100}%` }} />
                    </span>
                    <span className={cn("text-right tabular-nums", mo >= 0 ? "text-pos" : "text-neg")}>{f.money(mo, true)}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
        <SectionTitle className="mt-4">{t("economy.top")}</SectionTitle>
        {top.length ? (
          <div className="flex flex-col text-[0.8rem]">
            {top.map((x, i) => {
              const mo = toNum(x.mo) ?? 0;
              const ware = text(x.wn) ? `${x.wn} ×${f.num(x.am) ?? "?"}` : "";
              return (
                <div key={i} data-key={"x" + i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-border/40 py-1 @[34rem]:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <span className="hidden text-xs text-muted-foreground @[34rem]:block">{f.ago(x.t, e.gt) ?? ""}</span>
                  <span className="min-w-0 truncate" title={[x.ty, x.pa].filter(Boolean).join(" · ")}>{text(x.ty) ?? ""}{text(x.pa) && <span className="text-muted-foreground"> · {x.pa}</span>}</span>
                  <span className="hidden min-w-0 truncate text-muted-foreground @[34rem]:block" title={ware}>{ware}</span>
                  <span className={cn("text-right tabular-nums", mo >= 0 ? "text-pos" : "text-neg")}>{f.money(mo)}</span>
                </div>
              );
            })}
          </div>
        ) : <div className="text-xs text-muted-foreground">{t("economy.none_rows")}</div>}
        {partners.length > 0 && (
          <>
            <SectionTitle className="mt-4">{t("economy.traders")}</SectionTitle>
            <div className="flex flex-col text-[0.8rem]">
              {partners.map((p, i) => {
                const mo = toNum(p.mo) ?? 0;
                return (
                  <div key={i} data-key={"p" + i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border/40 py-1">
                    <span className="truncate" title={p.n || ""}>{p.n || "?"}</span>
                    <span className={cn("text-right tabular-nums", mo >= 0 ? "text-pos" : "text-neg")}>{f.money(mo)}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </FitScroll>
  );
}
