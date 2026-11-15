import type { LucideIcon } from "lucide-react";
import { Activity, BarChart3, Flag, Info, Keyboard, List, Map as MapIcon, ScrollText, Shield, Ship } from "lucide-react";
import type { PanelId } from "@/core/layout";

export const PANEL_ICON: Record<PanelId, LucideIcon> = {
  map: MapIcon, objects: List, info: Info, property: Ship, log: ScrollText, missions: Flag,
  factions: Shield, economy: BarChart3, diag: Activity, hotkeys: Keyboard,
};
