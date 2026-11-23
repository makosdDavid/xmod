// Overlays of the main window: the details sheet (when the Details module is not on screen), the
// alert banner (visual only, no sound) and the stale-data banner (paused / background / disconnected).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert, WifiOff, X, PauseCircle } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FitScroll } from "@/components/FitScroll";
import { InfoView } from "@/panels/InfoPanel";
import { useBus } from "@/core/hooks";
import { findPanel } from "@/core/layout";
import { bus, connState, select, S, type Any } from "@/core/store";
import { isMapView, setView, useUI } from "@/core/ui";
import { cn } from "@/lib/utils";

/** details as a non-modal side sheet while the Details module is hidden (or another view is open) */
export function InfoSheet({ single = false }: { single?: boolean }) {
  const { t } = useTranslation();
  useBus(["select"], 50);
  const tree = useUI((s) => s.tree);
  const view = useUI((s) => s.view);
  const maximized = useUI((s) => s.maximized);
  const infoOnScreen = !single && (view === "info" || (isMapView(view) && !!findPanel(tree, "info") && (!maximized || maximized === "info")));
  const open = !!S.selected && !infoOnScreen;
  return (
    <Sheet open={open} modal={false} onOpenChange={(o) => { if (!o) select(null); }}>
      <SheetContent side="right" className="top-24 bottom-3 h-auto w-[23rem] gap-0 rounded-l-sm border border-r-0 border-input p-0 sm:max-w-[23rem]"
        onInteractOutside={(e) => e.preventDefault()} onOpenAutoFocus={(e) => e.preventDefault()}>
        <SheetHeader className="border-b border-input x4-head px-4 py-2.5">
          <SheetTitle className="text-[0.8rem] font-semibold text-foreground">{t("modules.info")}</SheetTitle>
          <SheetDescription className="sr-only">{t("info.details_title")}</SheetDescription>
        </SheetHeader>
        <FitScroll className="@container"><InfoView /></FitScroll>
      </SheetContent>
    </Sheet>
  );
}

export function AlertBanner({ inline = false }: { inline?: boolean }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Any[] | null>(null);
  const [flash, setFlash] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const offA = bus.on("alert", (it: Any[]) => {
      setItems(it); setFlash((x) => x + 1);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setItems(null), 12000);
    });
    const offB = bus.on("alertsack", () => setItems(null));
    return () => { offA(); offB(); if (timer.current) clearTimeout(timer.current); };
  }, []);
  if (!items || !items.length) return null;
  const last = items[items.length - 1];
  const go = () => {
    setItems(null);
    if (last.ic) { setView("map"); select({ kind: "obj", id: String(last.ic), from: "alert" }); } else setView("log");
  };
  return (
    <div className={inline ? "flex min-w-0 justify-center" : "pointer-events-none fixed top-12 right-3 z-40"}>
      <div key={flash} role="alert" title={t("alert.tip")}
        className="alert-flash pointer-events-auto flex h-8 max-w-full min-w-0 items-center gap-2 rounded-sm border border-bad bg-black py-1 pr-1 pl-3 text-sm font-semibold text-white shadow-[0_0_10px_rgb(255_0_0/0.45)]">
        <button type="button" onClick={go} className="flex min-w-0 items-center gap-2">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="truncate">{last.ti || t("alert.default")}{items.length > 1 ? "  " + t("alert.more", { n: items.length - 1 }) : ""}</span>
        </button>
        <button type="button" onClick={() => setItems(null)} aria-label={t("alert.dismiss")} className="rounded-sm p-1 hover:bg-white/15"><X className="size-3.5" /></button>
      </div>
    </div>
  );
}

export function StaleBanner({ inline = false }: { inline?: boolean }) {
  const { t } = useTranslation();
  useBus(["status", "ws"], 300);
  const st = connState();
  useEffect(() => { document.body.dataset.state = st; }, [st]);
  if (!["paused", "background", "disconnected", "noserver"].includes(st)) return null;
  const bad = st === "disconnected" || st === "noserver";
  const Icon = bad ? WifiOff : PauseCircle;
  return (
    <div className={inline ? "flex min-w-0 justify-center" : "pointer-events-none fixed bottom-3.5 left-1/2 z-[39] -translate-x-1/2"}>
      <div title={t("stale." + st)} className={cn("flex h-8 min-w-0 items-center gap-2 rounded-sm border bg-black px-3 text-sm font-semibold",
        bad ? "border-bad text-bad" : "border-warn text-warn")}>
        <Icon className="size-4 shrink-0" /><span className="truncate">{t("stale." + st)}</span>
      </div>
    </div>
  );
}
