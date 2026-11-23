// Small shared presentational pieces: game icon, hull/shield bar, empty state, key/value list, section title.
import * as React from "react";
import { Box, CircleDot, Diamond, Square, Triangle } from "lucide-react";
import { iconFor, listColor, objColor, rgb, tintedURL } from "@web/mapstyle.js";
import { S, type Any } from "@/core/store";
import { cn } from "@/lib/utils";
import { pct01 } from "@/lib/format";

const curShip = () => (S.player && S.player.object ? S.player.object.id : null);

/** the game's icon of an object in a LIST row: the game draws it inline in the row's text colour
 *  (menu_map.lua:7371-7377), so it follows listColor (neutral = white); a drawn fallback without the export */
export function GameIcon({ o, size = 18, className }: { o: Any; size?: number; className?: string }) {
  const col = listColor(o, S.theme, { currentId: curShip() });
  const url = tintedURL(iconFor(o), col);
  if (url) return <img src={url} width={size} height={size} alt="" className={cn("inline-block shrink-0 align-middle", className)} />;
  const c = String(o.c || o.class || "");
  const Ico = c.startsWith("ship") ? Triangle : c === "station" ? Square : c === "gate" || c === "highwayentrygate" ? Diamond : c ? CircleDot : Box;
  return <Ico style={{ color: rgb(col), width: size - 2, height: size - 2 }} className={cn("inline-block shrink-0", className)} aria-hidden />;
}
/** the map ICON colour of an object (holomap colours, neutral = friendcolor), as the map draws it */
export function objColorCss(o: Any) {
  return rgb(objColor(o, S.theme, { currentId: curShip() }));
}
/** the object LIST text colour, the game's rule (menu_map.lua:7317-7364): mission > own (current ship) >
 *  hostile > enemy with the live holomap colours, everything else text_normal (white) */
export function listColorCss(o: Any) {
  return rgb(listColor(o, S.theme, { currentId: curShip() }));
}

/** hull / shield bar with the number; renders nothing without a value */
export function Bar({ v, kind, width = 64, showText = true, className }: { v: unknown; kind: "hull" | "shield"; width?: number; showText?: boolean; className?: string }) {
  const p = pct01(v);
  if (p === null) return null;
  const low = kind === "hull" && p < 35;
  return (
    <span className={cn("inline-flex items-center gap-1.5 align-middle", className)} title={`${Math.round(p)}%`}>
      <span className="relative inline-block h-1.5 overflow-hidden bg-white/10" style={{ width }}>
        <span className={cn("absolute inset-y-0 left-0 transition-[width] duration-300",
          kind === "shield" ? "bg-shield" : low ? "bg-bad" : "bg-hull")} style={{ width: `${p}%` }} />
      </span>
      {showText && <span className={cn("tabular-nums text-xs", low ? "text-bad" : "text-muted-foreground")}>{Math.round(p)}%</span>}
    </span>
  );
}

export function Empty({ icon: Icon, title, hint, className }: { icon?: React.ComponentType<{ className?: string }>; title: string; hint?: string | null; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center text-muted-foreground", className)}>
      {Icon && <Icon className="size-8 opacity-40" />}
      <div className="text-sm font-medium text-foreground/80">{title}</div>
      {hint && <div className="max-w-sm text-xs">{hint}</div>}
    </div>
  );
}

export function SectionTitle({ children, className, right }: { children: React.ReactNode; className?: string; right?: React.ReactNode }) {
  return (
    <div className={cn("mt-4 mb-1.5 flex min-h-[2.2em] items-center justify-center gap-2 bg-section px-2 py-0.5 font-bold text-foreground first:mt-0", className)}>
      <span>{children}</span>
      {right}
    </div>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 rounded-r-sm border-l-2 border-primary bg-sub-head/60 px-3 py-2 text-xs text-foreground">{children}</div>;
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block size-2.5 shrink-0 rounded-full align-middle" style={{ background: color }} />;
}

export function factionColor(id: string | null | undefined): string {
  const f = id ? S.factions[id] : null;
  if (f && f.col) return `rgb(${f.col.r},${f.col.g},${f.col.b})`;
  if (!id) return "#55606e";
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h},45%,50%)`;
}
