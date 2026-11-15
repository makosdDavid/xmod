import { PanelFrame, type FrameMode } from "@/components/PanelFrame";
import type { PanelId } from "@/core/layout";
import { MapPanel } from "./MapPanel";
import { ObjectsPanel } from "./ObjectsPanel";
import { InfoPanel } from "./InfoPanel";
import { PropertyPanel } from "./PropertyPanel";
import { LogPanel } from "./LogPanel";
import { MissionsPanel } from "./MissionsPanel";
import { FactionsPanel } from "./FactionsPanel";
import { EconomyPanel } from "./EconomyPanel";
import { DiagPanel } from "./DiagPanel";
import { HotkeysPanel } from "./HotkeysPanel";

const BODIES: Record<Exclude<PanelId, "map">, () => React.ReactElement> = {
  objects: ObjectsPanel, info: InfoPanel, property: PropertyPanel, log: LogPanel, missions: MissionsPanel,
  factions: FactionsPanel, economy: EconomyPanel, diag: DiagPanel, hotkeys: HotkeysPanel,
};

export function PanelBody({ id, mode, collapsed, parentDir }: { id: PanelId; mode: FrameMode; collapsed: boolean; parentDir: "row" | "col" | null }) {
  if (id === "map") return <MapPanel mode={mode} collapsed={collapsed} parentDir={parentDir} />;
  const Body = BODIES[id];
  return (
    <PanelFrame id={id} mode={mode} collapsed={collapsed} parentDir={parentDir}>
      <div className="@container flex min-h-0 flex-1 flex-col">
        <Body />
      </div>
    </PanelFrame>
  );
}
