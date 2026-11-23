// Details of the selection (module "Részletek / Details" and the side sheet when the module is hidden).
// Built from lib/info.ts: a row / section / button exists only when it has a value.
import { Crosshair, ExternalLink, Map as MapIcon, Navigation, OctagonX, Ship, Target, Telescope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Bar, GameIcon, Hint, listColorCss, SectionTitle } from "@/components/bits";
import { FitScroll } from "@/components/FitScroll";
import { useBus, useT } from "@/core/hooks";
import { getMap, showGuidanceOnMap } from "@/core/mapHost";
import { command, factionName, S, sectorName, select, whereText } from "@/core/store";
import { setView } from "@/core/ui";
import { buildInfo, type Btn } from "@/lib/info";
import { cn } from "@/lib/utils";

const BTN_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  center: Crosshair, sector_view: MapIcon, openmap: ExternalLink, target: Target, guidance: Navigation, stop: OctagonX, flyto: Ship,
  guidance_show: Crosshair,
};

function ActionButton({ b }: { b: Btn }) {
  const { t } = useT();
  const Icon = BTN_ICON[b.key] || Crosshair;
  const needsControl = !!b.cmd && !S.control;
  const run = () => {
    if (b.local === "center") { setView("map"); getMap()?.centerOn(b.args[0]); return; }
    if (b.local === "sector") { setView("map"); select({ kind: "sector", id: b.args[0], from: "info" }); return; }
    if (b.local === "guidance") { showGuidanceOnMap(); return; }
    if (b.cmd) command(b.cmd, ...b.args);
  };
  const tip = b.tip + (b.allowed && needsControl ? t("info.needs_control") : "");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button size="sm" variant={b.cmd ? "secondary" : "default"} disabled={!b.allowed} onClick={run}
            className={cn("h-7 gap-1.5 px-2.5 text-xs", needsControl && b.allowed && "opacity-60")}>
            <Icon className="size-3.5" />{b.label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{tip}</TooltipContent>
    </Tooltip>
  );
}

export function InfoView({ compact = false }: { compact?: boolean }) {
  const { t, f } = useT();
  useBus(["select", "property", "scan", "hello", "details", "control", "theme", "icons", "player", "galaxy"], 700);
  const sel = S.selected;
  const det = sel && sel.kind === "obj" ? S.details[sel.id] : undefined;
  const m = buildInfo({ S, t: (k, v) => t(k, v as never) as unknown as string, f, sectorName, factionName, whereText }, sel, det);

  return (
    <div className={cn("flex flex-col gap-1 px-3.5 py-3", compact && "px-1")}>
      <div className="mb-1 flex min-w-0 items-center gap-2.5">
        {m.icon ? <GameIcon o={m.icon} size={30} /> : <Telescope className="size-6 text-primary" />}
        <div className="min-w-0">
          <h3 className="truncate text-base leading-tight font-semibold" style={m.icon ? { color: listColorCss(m.icon) } : undefined} title={m.title}>{m.title}</h3>
          {m.subtitle && <div className="truncate font-mono text-xs text-muted-foreground">{m.subtitle}</div>}
        </div>
      </div>
      {m.rows.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.8rem]">
          {m.rows.map((r) => (
            <div key={r.key} className="contents">
              <dt data-key={"r-" + r.key} className="whitespace-nowrap text-muted-foreground">{r.label}</dt>
              <dd className="min-w-0">
                {r.value.kind === "bar" ? <Bar v={r.value.pct} kind={r.value.bar} width={96} /> : (
                  <span className={cn("block truncate", r.value.tone === "neg" && "text-neg", r.value.tone === "pos" && "text-pos")} title={r.value.text}>{r.value.text}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {m.cargo && (
        <>
          <SectionTitle>{t("info.cargo")}</SectionTitle>
          {m.cargo.state === "list" ? (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-[0.8rem]">
              {m.cargo.items.map((c) => (
                <div key={c.key} className="contents">
                  <span data-key={"c-" + c.key} className="truncate" title={c.name}>{c.name}</span><span className="text-right tabular-nums">{c.amount}</span>
                </div>
              ))}
            </div>
          ) : <div className="text-xs text-muted-foreground">{t("info.cargo_" + m.cargo.state)}</div>}
        </>
      )}
      {m.buttons.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" data-key="buttons">
          {m.buttons.map((b) => <ActionButton key={b.key} b={b} />)}
        </div>
      )}
      {m.orders.length > 0 && (
        <>
          <SectionTitle right={<Badge variant="secondary" className="h-4 px-1.5 text-[0.65rem]">{f.num(m.orders.length)}</Badge>}>{t("info.order_queue_title")}</SectionTitle>
          <ol className="list-decimal space-y-0.5 pl-5 text-[0.8rem]">
            {m.orders.map((q) => (
              <li key={q.key} data-key={"o-" + q.key} className="truncate">{q.text}{q.meta && <span className="text-muted-foreground"> · {q.meta}</span>}</li>
            ))}
          </ol>
        </>
      )}
      {m.subordinates.length > 0 && (
        <>
          <SectionTitle right={<Badge variant="secondary" className="h-4 px-1.5 text-[0.65rem]">{f.num(m.subordinates.length)}</Badge>}>{t("info.subordinates_title")}</SectionTitle>
          <div className="flex flex-wrap gap-1">
            {m.subordinates.map((e) => (
              <button key={e.id} data-key={"s-" + e.id} type="button" onClick={() => select({ kind: "obj", id: e.id, from: "info" })}
                className="max-w-full truncate rounded-sm border border-input px-1.5 py-0.5 text-xs text-primary hover:border-primary hover:bg-accent">{e.label}</button>
            ))}
          </div>
        </>
      )}
      {m.ownHere.length > 0 && (
        <>
          <SectionTitle>{t("info.own_here")}</SectionTitle>
          <div className="flex flex-wrap gap-1">
            {m.ownHere.map((e) => (
              <button key={e.id} data-key={"h-" + e.id} type="button" onClick={() => select({ kind: "obj", id: e.id, from: "info" })}
                className="max-w-full truncate rounded-sm border border-input px-1.5 py-0.5 text-xs text-primary hover:border-primary hover:bg-accent">{e.label}</button>
            ))}
          </div>
        </>
      )}
      {m.hints.map((h, i) => <div key={h} data-key={"hint-" + i}><Hint>{h}</Hint></div>)}


    </div>
  );
}

export function InfoPanel() {
  return <FitScroll><InfoView /></FitScroll>;
}
