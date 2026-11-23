// One module's frame: header (icon, title, tools slot, collapse / maximize / pop-out / close) + body.
// In the workspace the header is the drag handle for re-arranging: drop it on another module's edge
// (dock next to it) or centre (swap); a preview of the target area is drawn while hovering.
import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, ChevronUp, ExternalLink, GripVertical, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { PanelId, Side } from "@/core/layout";
import { dropPanel, hidePanel, setDragging, toggleCollapse, toggleMax, useUI } from "@/core/ui";
import { touchList } from "@/core/listnav";
import { toast } from "@/core/store";
import { PANEL_ICON } from "@/panels/registry";

export type FrameMode = "dock" | "max" | "focus" | "single" | "narrow";
const DND = "application/x-x4c-panel";

export function IconBtn({ tip, onClick, children, className, active, ...rest }:
  { tip: string; onClick?: (e: React.MouseEvent) => void; children: React.ReactNode; className?: string; active?: boolean } & Omit<React.ComponentProps<typeof Button>, "onClick">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={tip} onClick={onClick} draggable={false}
          className={cn("size-7 text-muted-foreground hover:text-foreground", active && "x4-on", className)} {...rest}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export function popOut(id: PanelId) {
  const w = window.open(`/?panel=${id}`, "x4c_" + id, "width=1280,height=900");
  if (!w) toast(String(document.documentElement.lang === "hu" ? "A böngésző letiltotta az új ablakot." : "The browser blocked the new window."), "warn");
}

function DropZones({ id }: { id: PanelId }) {
  const { t } = useTranslation();
  const [hover, setHover] = React.useState<Side | null>(null);
  const zoneOf = (e: React.DragEvent): Side => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const edge = Math.min(x, 1 - x, y, 1 - y);
    if (edge > 0.25) return "center";
    if (edge === x) return "left";
    if (edge === 1 - x) return "right";
    return edge === y ? "top" : "bottom";
  };
  const preview: Record<Side, string> = {
    left: "inset-y-1 left-1 w-[calc(50%-0.5rem)]", right: "inset-y-1 right-1 w-[calc(50%-0.5rem)]",
    top: "inset-x-1 top-1 h-[calc(50%-0.5rem)]", bottom: "inset-x-1 bottom-1 h-[calc(50%-0.5rem)]", center: "inset-6",
  };
  return (
    <div className="absolute inset-0 z-30 rounded-sm"
      onDragOver={(e) => { if (!e.dataTransfer.types.includes(DND)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; const z = zoneOf(e); if (z !== hover) setHover(z); }}
      onDragLeave={() => setHover(null)}
      onDrop={(e) => {
        const src = e.dataTransfer.getData(DND) as PanelId;
        e.preventDefault();
        setHover(null);
        if (src && src !== id) dropPanel(src, id, zoneOf(e));
        else setDragging(null);
      }}>
      <div className="absolute inset-0 rounded-sm bg-background/30 ring-1 ring-input ring-inset" />
      {hover && (
        <div className={cn("pointer-events-none absolute flex items-center justify-center rounded-sm border-2 border-primary bg-primary/15 text-sm x4-glow transition-all", preview[hover])}>
          <span className="rounded-sm border border-primary x4-head px-2 py-0.5">{t("panel.drop_" + hover)}</span>
        </div>
      )}
    </div>
  );
}

export interface PanelFrameProps {
  id: PanelId;
  mode: FrameMode;
  collapsed?: boolean;
  parentDir?: "row" | "col" | null;
  /** header slots for the map (its own title / tools nodes are re-parented into them) */
  titleRef?: React.Ref<HTMLSpanElement>;
  toolsRef?: React.Ref<HTMLSpanElement>;
  children: React.ReactNode;
}

export function PanelFrame({ id, mode, collapsed = false, parentDir = null, titleRef, toolsRef, children }: PanelFrameProps) {
  const { t } = useTranslation();
  const dragging = useUI((s) => s.dragging);
  const maximized = useUI((s) => s.maximized);
  const Icon = PANEL_ICON[id];
  const title = t("modules." + id);
  const dock = mode === "dock";
  const canCollapse = dock || mode === "narrow";
  const showDrop = dock && dragging !== null && dragging !== id;

  // collapsed inside a row: a slim vertical strip
  if (collapsed && parentDir === "row" && dock) {
    return (
      <section data-panel={id} className="relative flex h-full flex-col items-center gap-2 overflow-hidden rounded-sm border border-frame bg-card py-2">
        <IconBtn tip={t("panel.expand")} onClick={() => toggleCollapse(id)}><ChevronRight /></IconBtn>
        <Icon className="size-4 text-primary" />
        <span className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase [writing-mode:vertical-rl]">{title}</span>
        {showDrop && <DropZones id={id} />}
      </section>
    );
  }

  return (
    <section data-panel={id} onPointerDownCapture={() => touchList(id)}
      className={cn("relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-sm border border-frame bg-card",
        mode === "single" && "rounded-none border-0")}>
      <header
        draggable={dock}
        onDragStart={(e) => { e.dataTransfer.setData(DND, id); e.dataTransfer.effectAllowed = "move"; setDragging(id); }}
        onDragEnd={() => setDragging(null)}
        onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button,input,select,a") && (dock || mode === "max")) toggleMax(id); }}
        className={cn("flex h-10 shrink-0 items-center gap-2 border-b border-input x4-head pr-1.5 pl-2 select-none",
          dock && "cursor-grab active:cursor-grabbing", collapsed && "border-b-0")}>
        {dock && (
          <Tooltip>
            <TooltipTrigger asChild><GripVertical className="size-4 shrink-0 text-foreground/50" aria-hidden /></TooltipTrigger>
            <TooltipContent>{t("panel.drag")}</TooltipContent>
          </Tooltip>
        )}
        <Icon className="size-4 shrink-0 text-foreground" aria-hidden />
        {titleRef ? <span ref={titleRef} className="min-w-0 truncate text-[0.8rem] font-semibold" />
                  : <h2 className="min-w-0 truncate text-[0.8rem] font-semibold">{title}</h2>}
        <span ref={toolsRef} className="panel-tools ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden" />
        <span className={cn("flex shrink-0 items-center", !toolsRef && "ml-auto")}>
          {canCollapse && (
            <IconBtn tip={collapsed ? t("panel.expand") : t("panel.collapse")} onClick={() => toggleCollapse(id)}>
              {collapsed ? <ChevronDown /> : <ChevronUp />}
            </IconBtn>
          )}
          {(dock || mode === "max") && (
            <IconBtn tip={maximized === id ? t("panel.restore") : t("panel.maximize")} onClick={() => toggleMax(id)}>
              {maximized === id ? <Minimize2 /> : <Maximize2 />}
            </IconBtn>
          )}
          {mode !== "single" && <IconBtn tip={t("panel.popout")} onClick={() => popOut(id)}><ExternalLink /></IconBtn>}
          {(dock || mode === "max" || mode === "narrow") && <IconBtn tip={t("panel.close")} onClick={() => hidePanel(id)}><X /></IconBtn>}
        </span>
      </header>
      <div className={cn("relative flex min-h-0 flex-1 flex-col", collapsed && "hidden")}>{children}</div>
      {showDrop && <DropZones id={id} />}
    </section>
  );
}
