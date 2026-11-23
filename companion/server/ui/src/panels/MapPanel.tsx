// The map module: a frame whose title / tools / body slots adopt the persistent map (core/mapHost).
// First-run hint (discoverability): a small callout anchored under the map's own "Layers" button
// (position from map.overlayRects(), so it never sits on the map's other overlays); shown until
// dismissed or until the Layers menu is opened once; skipped when the map is too small.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Layers, X } from "lucide-react";
import { PanelFrame, type FrameMode } from "@/components/PanelFrame";
import { attachMap, getMap, setMapCollapsed } from "@/core/mapHost";

const HINT_KEY = "x4c.hint.layers";
function hintSeen() { try { return localStorage.getItem(HINT_KEY) === "1"; } catch { return true; } }
interface Anchor { top: number; right: number }

export function MapPanel({ mode, collapsed, parentDir }: { mode: FrameMode; collapsed: boolean; parentDir: "row" | "col" | null }) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const toolsRef = useRef<HTMLSpanElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState(() => !hintSeen());
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const strip = collapsed && parentDir === "row" && mode === "dock";

  useEffect(() => {
    if (strip || !bodyRef.current) return;
    return attachMap({ body: bodyRef.current, title: titleRef.current, tools: toolsRef.current });
  }, [strip]);
  useEffect(() => { setMapCollapsed(collapsed); }, [collapsed]);

  const dismiss = () => { setHint(false); try { localStorage.setItem(HINT_KEY, "1"); } catch { /* blocked */ } };
  useEffect(() => {
    if (!hint || collapsed) return;
    const el = bodyRef.current;
    const onClick = (e: MouseEvent) => { if ((e.target as HTMLElement).closest?.(".layers-btn")) dismiss(); };
    el?.addEventListener("click", onClick, true);
    const place = () => {
      const r = getMap()?.overlayRects?.();
      const b = r && r.rects && r.rects.layersBtn;
      if (!r || !b || r.w < 640 || r.h < 400) { setAnchor(null); return; }
      setAnchor({ top: b.b + 8, right: Math.max(8, r.w - b.r) });
    };
    place();
    const iv = setInterval(place, 1000);
    return () => { el?.removeEventListener("click", onClick, true); clearInterval(iv); };
  }, [hint, collapsed]);

  return (
    <PanelFrame id="map" mode={mode} collapsed={collapsed} parentDir={parentDir}
      titleRef={strip ? undefined : titleRef} toolsRef={strip ? undefined : toolsRef}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={bodyRef} className="x4map-slot absolute inset-0 flex flex-col" />
        {hint && anchor && !collapsed && (
          <div role="note" className="absolute z-20 w-72 rounded-sm x4-float p-3 pt-0 text-xs"
            style={{ top: anchor.top, right: anchor.right }}>
            <div className="-mx-3 mb-2 flex items-center gap-2 x4-head px-3 py-1.5">
              <Layers className="size-4" />{t("maphint.title")}
              <button type="button" onClick={dismiss} aria-label={t("maphint.ok")} className="ml-auto rounded-sm p-0.5 text-foreground/80 hover:bg-selected hover:text-foreground"><X className="size-3.5" /></button>
            </div>
            <p className="text-muted-foreground">{t("maphint.text")}</p>
            <button type="button" onClick={dismiss} className="mt-2 rounded-sm border border-primary/70 bg-panel-head px-2.5 py-1 font-medium text-foreground hover:border-primary hover:x4-glow">{t("maphint.ok")}</button>
          </div>
        )}
      </div>
    </PanelFrame>
  );
}
