// Shell: the main window (top bar, navigation, workspace / focused view, overlays) or a pop-out window
// (/?panel=<id>): one module, standalone — its own websocket, its own init snapshot and (for the map)
// its own map instance, because every window runs its own copy of the store.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandPalette } from "@/components/CommandPalette";
import { NavBar } from "@/components/NavBar";
import { AlertBanner, InfoSheet, StaleBanner } from "@/components/Overlays";
import { LangFontControls, StateBadge, TopBar } from "@/components/TopBar";
import { ControlMenu } from "@/components/ControlMenu";
import { Workspace } from "@/components/Workspace";
import { installKeyboard } from "@/core/hotkeys";
import { isPanelId, type PanelId } from "@/core/layout";
import { initLayouts } from "@/core/savedLayouts";
import { select, startStore } from "@/core/store";
import { applyPreset, dropPanel, getUI, isMapView, setView, toggleMax, togglePanel, useUI } from "@/core/ui";
import { setLang } from "@/i18n";
import { PanelBody } from "@/panels/PanelBody";
import { PANEL_ICON } from "@/panels/registry";

const params = new URLSearchParams(location.search);
const rawPanel = params.get("panel");
export const SINGLE: PanelId | null = isPanelId(rawPanel) ? rawPanel : null;

function useFontScale() {
  const font = useUI((s) => s.font);
  useEffect(() => { document.documentElement.style.fontSize = font + "%"; }, [font]);
}

function FocusedView() {
  const view = useUI((s) => s.view);
  const epoch = useUI((s) => s.epoch);
  if (isMapView(view)) return <Workspace />;
  const id = (view as PanelId);
  return <div className="h-full p-1" key={view + epoch}><PanelBody id={id} mode="focus" collapsed={false} parentDir={null} /></div>;
}

function MainApp() {
  useEffect(() => { startStore(); void initLayouts(true); return installKeyboard(null); }, []);
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <NavBar />
      <main className="x4c-work min-h-0 flex-1 p-1.5"><FocusedView /></main>
      <InfoSheet />
      <CommandPalette />
    </div>
  );
}

function PopoutApp({ id }: { id: PanelId }) {
  const { t } = useTranslation();
  useEffect(() => { startStore(); void initLayouts(false); return installKeyboard(id); }, [id]);
  useEffect(() => { document.title = t("app.title_single", { panel: t("modules." + id) }); }, [id, t]);
  const Icon = PANEL_ICON[id];
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-input bg-card px-3">
        <span className="rounded-sm border border-primary x4-head px-1.5 text-[0.8rem] font-bold">X4</span>
        <Icon className="size-4 text-primary" /><span className="text-sm font-semibold tracking-[0.08em] uppercase">{t("modules." + id)}</span>
        <StateBadge />
        <div className="flex min-w-0 flex-1 justify-center gap-2"><StaleBanner inline /><AlertBanner inline /></div>
        <LangFontControls />
        <ControlMenu />
      </header>
      <main className="x4c-work min-h-0 flex-1"><PanelBody id={id} mode="single" collapsed={false} parentDir={null} /></main>
      {id !== "info" && <InfoSheet single />}
      <CommandPalette />
    </div>
  );
}

// debugging / automated screenshot hooks (browser console: __x4ui.applyPreset("all") etc.)
(window as unknown as Record<string, unknown>).__x4ui = { applyPreset, setView, toggleMax, setLang, togglePanel, dropPanel, getUI, select };

export default function App() {
  useFontScale();
  const { t } = useTranslation();
  useEffect(() => { if (!SINGLE) document.title = t("app.name"); }, [t]);
  return (
    <TooltipProvider delayDuration={350}>
      {SINGLE ? <PopoutApp id={SINGLE} /> : <MainApp />}
      <Toaster position="bottom-right" visibleToasts={5} closeButton />
    </TooltipProvider>
  );
}
