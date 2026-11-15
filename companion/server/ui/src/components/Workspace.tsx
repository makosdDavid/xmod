// The map-view workspace: the layout tree rendered with shadcn Resizable groups (react-resizable-panels).
// Resize = drag the dividers (grab handles); collapse = header button (to the header / a slim strip),
// maximize = header double-click; re-arrange = drag a header onto another module (see PanelFrame).
// Narrow windows (< 1100 px) stack the modules vertically instead.
import { Fragment, useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid } from "lucide-react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Empty } from "@/components/bits";
import type { FrameMode } from "@/components/PanelFrame";
import { nodeKey, panelsIn, type LNode, type PanelId, type SplitNode } from "@/core/layout";
import { markCollapsed, registerCollapse, saveSizes, useUI } from "@/core/ui";
import { PanelBody } from "@/panels/PanelBody";

const COLLAPSED_COL = "2.5rem";   // header height (rem: follows the font scale)
const COLLAPSED_ROW = "2.75rem";  // slim vertical strip
const MIN_PANEL_COL = "9.5rem";
const MIN_PANEL_ROW = "14rem";
const MIN_SPLIT = "10rem";

function useNarrow() {
  return useSyncExternalStore(
    (f) => { const m = window.matchMedia("(max-width: 1099px)"); m.addEventListener("change", f); return () => m.removeEventListener("change", f); },
    () => window.matchMedia("(max-width: 1099px)").matches,
  );
}

export function Module({ id, mode, collapsed, parentDir }: { id: PanelId; mode: FrameMode; collapsed?: boolean; parentDir?: "row" | "col" | null }) {
  return <PanelBody id={id} mode={mode} collapsed={!!collapsed} parentDir={parentDir ?? null} />;
}

function PanelLeaf({ node, parent }: { node: Extract<LNode, { t: "p" }>; parent: SplitNode }) {
  const ref = useRef<PanelImperativeHandle | null>(null);
  useEffect(() => {
    registerCollapse(node.id, {
      collapse: () => ref.current?.collapse(),
      expand: () => ref.current?.expand(),
      isCollapsed: () => !!ref.current?.isCollapsed(),
    });
    return () => registerCollapse(node.id, null);
  }, [node.id]);
  const collapsedSize = parent.dir === "col" ? COLLAPSED_COL : COLLAPSED_ROW;
  return (
    <ResizablePanel id={nodeKey(node)} panelRef={ref} collapsible collapsedSize={collapsedSize}
      minSize={parent.dir === "col" ? MIN_PANEL_COL : MIN_PANEL_ROW}
      defaultSize={node.collapsed ? collapsedSize : `${node.size}%`}
      onResize={() => { const c = !!ref.current?.isCollapsed(); if (c !== !!node.collapsed) markCollapsed(node.id, c); }}
      className="p-1">
      <Module id={node.id} mode="dock" collapsed={node.collapsed} parentDir={parent.dir} />
    </ResizablePanel>
  );
}

function Split({ node }: { node: SplitNode }) {
  const sig = node.dir + ":" + node.kids.map(nodeKey).join(",");
  return (
    <ResizablePanelGroup key={sig} id={node.id} orientation={node.dir === "row" ? "horizontal" : "vertical"}
      onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction) saveSizes(node.id, meta.requestedLayout ?? layout); }}>
      {node.kids.map((k, i) => (
        <Fragment key={nodeKey(k)}>
          {i > 0 && <ResizableHandle withHandle />}
          {k.t === "p" ? <PanelLeaf node={k} parent={node} /> : (
            <ResizablePanel id={nodeKey(k)} defaultSize={`${k.size}%`} minSize={MIN_SPLIT}>
              <Split node={k} />
            </ResizablePanel>
          )}
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

function flatten(n: LNode | null): { id: PanelId; collapsed: boolean }[] {
  if (!n) return [];
  if (n.t === "p") return [{ id: n.id, collapsed: !!n.collapsed }];
  return n.kids.flatMap(flatten);
}

export function Workspace() {
  const { t } = useTranslation();
  const tree = useUI((s) => s.tree);
  const maximized = useUI((s) => s.maximized);
  const epoch = useUI((s) => s.epoch);
  const narrow = useNarrow();

  if (maximized && panelsIn(tree).includes(maximized)) {
    return <div className="h-full p-1" key={"max-" + epoch}><Module id={maximized} mode="max" /></div>;
  }
  if (!tree) {
    return <Empty icon={LayoutGrid} title={t("layout.empty")} hint={t("layout.empty_hint")} className="h-full" />;
  }
  if (narrow) {
    return (
      <div className="no-scrollbar flex h-full flex-col gap-2 overflow-y-auto p-1" key={"narrow-" + epoch}>
        {flatten(tree).map(({ id, collapsed }) => (
          <div key={id} className={collapsed ? "shrink-0" : id === "map" ? "h-[72vh] shrink-0" : "h-[60vh] shrink-0"}>
            <Module id={id} mode="narrow" collapsed={collapsed} parentDir="col" />
          </div>
        ))}
      </div>
    );
  }
  if (tree.t === "p") return <div className="h-full p-1" key={"one-" + epoch}><Module id={tree.id} mode="dock" /></div>;
  return <div className="h-full" key={"ws-" + epoch}><Split node={tree} /></div>;
}
