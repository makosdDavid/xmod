// Top bar: brand, connection state, captain, credits, sector, ship (hull / shield / speed), target,
// game time, and the global controls (search, language, font size, help, game commands).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AArrowDown, AArrowUp, Keyboard, Languages, Maximize, Minimize, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Bar } from "@/components/bits";
import { ControlMenu } from "@/components/ControlMenu";
import { useBus, useT, useTick } from "@/core/hooks";
import { connState, S } from "@/core/store";
import { FONT_STEPS, fontStep, setFont, setPalette, setView, useUI } from "@/core/ui";
import { setLang } from "@/i18n";
import { joinParts, text, toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATE_TONE: Record<string, string> = {
  live: "border-ok/50 bg-ok/10 text-ok", paused: "border-warn/50 bg-warn/10 text-warn", background: "border-warn/50 bg-warn/10 text-warn",
  connected: "border-warn/50 bg-warn/10 text-warn", starting: "border-border text-muted-foreground",
};

function Group({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 overflow-hidden", className)}>
      <span className="hidden shrink-0 text-[0.65rem] font-medium tracking-[0.09em] text-muted-foreground uppercase lg:inline">{label}</span>
      {children}
    </div>
  );
}

export function StateBadge() {
  const { t, f } = useT();
  useBus(["status", "ws"], 300);
  useTick(1000);
  const st = connState();
  const age = toNum(S.status && S.status.last_rx_age);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Badge variant="outline" className={cn("h-5 rounded-full px-2 text-[0.7rem] font-semibold", STATE_TONE[st] || "border-bad/50 bg-bad/10 text-bad")}
        title={t("state.tip", { state: t("state." + st) })}>
        <span className={cn("mr-1 inline-block size-1.5 rounded-full bg-current", st === "live" && "animate-pulse")} />
        {t("state." + st)}
      </Badge>
      {age !== null && age >= 2 && <span className="text-xs tabular-nums text-muted-foreground">{t("state.age", { age: f.num(age) })}</span>}
    </span>
  );
}

export function LangFontControls() {
  const { t, i18n } = useTranslation();
  const font = useUI((s) => s.font);
  return (
    <>
      <Select value={i18n.language === "hu" ? "hu" : "en"} onValueChange={(v) => setLang(v as "en" | "hu")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <SelectTrigger size="sm" className="h-7 w-auto gap-1 px-2 text-xs" aria-label={t("lang.label")}>
              <Languages className="size-3.5" /><SelectValue>{i18n.language === "hu" ? "HU" : "EN"}</SelectValue>
            </SelectTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("lang.label")}</TooltipContent>
        </Tooltip>
        <SelectContent align="end">
          <SelectItem value="en">EN · {t("lang.en")}</SelectItem>
          <SelectItem value="hu">HU · {t("lang.hu")}</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex items-center rounded-md border" role="group" aria-label={t("font.label")}>
        <Tooltip><TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 rounded-r-none" disabled={font <= FONT_STEPS[0]} onClick={() => fontStep(-1)} aria-label={t("font.smaller")}><AArrowDown /></Button>
        </TooltipTrigger><TooltipContent>{t("font.smaller")}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild>
          <button type="button" onClick={() => setFont(100)} className="h-7 min-w-11 border-x px-1 text-[0.7rem] tabular-nums text-muted-foreground hover:text-foreground">{font}%</button>
        </TooltipTrigger><TooltipContent>{t("font.reset")}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 rounded-l-none" disabled={font >= FONT_STEPS[FONT_STEPS.length - 1]} onClick={() => fontStep(1)} aria-label={t("font.larger")}><AArrowUp /></Button>
        </TooltipTrigger><TooltipContent>{t("font.larger")}</TooltipContent></Tooltip>
      </div>
    </>
  );
}

// Full screen (Fullscreen API with webkit fallbacks). Hidden when the API is unavailable
// (e.g. an iframe without allow="fullscreen"); the icon follows fullscreenchange, so Esc / F11 exits update it.
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
const fsDoc = () => document as FsDoc;
const fsActive = () => !!(document.fullscreenElement || fsDoc().webkitFullscreenElement);
const fsAvailable = () => {
  const d = fsDoc(), el = document.documentElement as FsEl;
  return !!((d.fullscreenEnabled || d.webkitFullscreenEnabled) && (el.requestFullscreen || el.webkitRequestFullscreen));
};
function toggleFullscreen() {
  const d = fsDoc(), el = document.documentElement as FsEl;
  try {
    const r = fsActive()
      ? (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.())
      : (el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.());
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
  } catch { /* refused (no user gesture / policy) - nothing to do */ }
}

export function FullscreenButton() {
  const { t } = useTranslation();
  const [on, setOn] = useState(fsActive);
  useEffect(() => {
    const h = () => setOn(fsActive());
    document.addEventListener("fullscreenchange", h);
    document.addEventListener("webkitfullscreenchange", h);
    return () => { document.removeEventListener("fullscreenchange", h); document.removeEventListener("webkitfullscreenchange", h); };
  }, []);
  if (!fsAvailable()) return null;
  const label = t(on ? "top.fullscreen_exit" : "top.fullscreen");
  return (
    <Tooltip><TooltipTrigger asChild>
      <Button variant="ghost" size="icon" className="size-7" onClick={toggleFullscreen} aria-label={label} aria-pressed={on}>{on ? <Minimize /> : <Maximize />}</Button>
    </TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
  );
}

export function TopBar() {
  const { t, f } = useT();
  useBus(["player", "status", "ws"], 250);
  useTick(1000);
  const p = S.player;
  const o = p && p.object;
  const sp = o && toNum(o.speed) !== null ? toNum(o.speed) : S.speedEst;
  const tg = p && p.target;
  const shipName = o ? joinParts([text(o.name), text(o.code) ? `(${o.code})` : null], " ") : null;
  const targetText = tg ? joinParts([text(tg.name) ?? "?", f.dist(tg.dist), f.pct(tg.hull)]) : null;
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 overflow-hidden border-b bg-gradient-to-b from-[oklch(0.2_0.04_255)] to-[oklch(0.16_0.03_255)] px-3 whitespace-nowrap">
      <div className="flex shrink-0 items-center gap-2 font-semibold tracking-wide">
        <span className="rounded bg-gradient-to-br from-[#46b3ff] to-[#1f6fd6] px-1.5 text-[0.8rem] font-extrabold text-white">X4</span>
        <span className="hidden 2xl:inline">Companion</span>
      </div>
      <StateBadge />
      <Separator orientation="vertical" className="h-6" />
      <Group label={t("top.captain")} className="hidden min-[1700px]:flex"><b className="truncate font-semibold">{text(p && p.name) ?? "–"}</b></Group>
      <Group label={t("top.credits")} className="shrink-0"><b className="font-semibold text-gold tabular-nums">{(p && f.money(p.money)) ?? "–"}</b></Group>
      <Group label={t("top.sector")} className="min-w-0 shrink"><b className="truncate font-semibold" title={text(p && p.sector && p.sector.name) ?? ""}>{text(p && p.sector && p.sector.name) ?? "–"}</b></Group>
      <Group label={t("top.ship")} className="min-w-0 shrink-[2]">
        <b className="truncate font-semibold" title={shipName ?? ""}>{shipName ?? "–"}</b>
        {o && (
          <span className="hidden shrink-0 flex-col gap-0.5 lg:flex" title={`${t("top.hull")} ${f.pct(o.hull) ?? "–"} · ${t("top.shield")} ${f.pct(o.shield) ?? "–"}`}>
            <Bar v={o.hull} kind="hull" width={56} showText={false} /><Bar v={o.shield} kind="shield" width={56} showText={false} />
          </span>
        )}
        {sp !== null && <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground 2xl:inline">{f.speed(sp)}</span>}
      </Group>
      <Group label={t("top.target")} className="hidden min-w-0 shrink min-[1800px]:flex">
        <span className={cn("truncate text-sm", !tg && "text-muted-foreground", tg && tg.hostile && "text-bad", tg && !tg.hostile && tg.enemy && "text-warn")} title={targetText ?? ""}>
          {targetText ?? t("top.none")}
        </span>
      </Group>
      <div className="flex-1" />
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground 2xl:inline" title={t("top.gametime")}>{(p && f.gameTime(p.gametime)) ?? ""}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Tooltip><TooltipTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => setPalette(true)}>
            <Search className="size-3.5" /><span className="hidden 2xl:inline">{t("top.search_short")}</span><Kbd className="hidden 2xl:inline-flex">Ctrl K</Kbd>
          </Button>
        </TooltipTrigger><TooltipContent>{t("top.palette")}</TooltipContent></Tooltip>
        <LangFontControls />
        <Tooltip><TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" onClick={() => setView("hotkeys")} aria-label={t("top.help")}><Keyboard /></Button>
        </TooltipTrigger><TooltipContent>{t("top.help")}</TooltipContent></Tooltip>
        <FullscreenButton />
        <ControlMenu />
      </div>
    </header>
  );
}
