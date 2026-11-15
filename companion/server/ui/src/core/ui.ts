// UI state (views, workspace layout, font scale, palette, dragging) — a tiny external store used with
// useSyncExternalStore. Persisted in localStorage: x4c.ui (view, font) and x4c.layout.v3 (the tree).
import { useSyncExternalStore } from "react";
import {
  addPanel, DEFAULT_PRESET, findPanel, movePanel, panelsIn, parseTree, presetTree, removePanel, setCollapsed, setSizes,
  type LNode, type PanelId, type Side,
} from "./layout";
import { bus } from "./store";

export type ViewId = "map" | "galaxy" | "property" | "log" | "missions" | "factions" | "economy" | "diag" | "hotkeys" | "objects" | "info";

export const VIEWS: { id: ViewId; key: string; module: PanelId }[] = [
  { id: "map", key: "1", module: "map" }, { id: "galaxy", key: "2", module: "map" },
  { id: "property", key: "3", module: "property" }, { id: "log", key: "4", module: "log" },
  { id: "missions", key: "5", module: "missions" }, { id: "factions", key: "6", module: "factions" },
  { id: "economy", key: "7", module: "economy" }, { id: "diag", key: "8", module: "diag" },
];
export const FONT_STEPS = [80, 90, 100, 112, 125, 140, 160];

export interface UIState {
  view: ViewId;
  font: number;
  tree: LNode | null;
  maximized: PanelId | null;
  dragging: PanelId | null;
  paletteOpen: boolean;
  confirmControl: boolean;
  preset: string;
  epoch: number;
}

const UI_KEY = "x4c.ui";
const LAYOUT_KEY = "x4c.layout.v3";
function load<T>(key: string): T | null {
  try { const r = localStorage.getItem(key); return r ? (JSON.parse(r) as T) : null; } catch { return null; }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* blocked */ } }

const saved = load<{ view?: ViewId; font?: number }>(UI_KEY) || {};
const savedLayout = load<{ tree?: unknown; preset?: string }>(LAYOUT_KEY);
const initialTree = savedLayout && "tree" in savedLayout ? parseTree(savedLayout.tree ?? null) : presetTree(DEFAULT_PRESET);

let state: UIState = {
  view: (saved.view && (VIEWS.some((v) => v.id === saved.view) || saved.view === "hotkeys") ? saved.view : "map"),
  font: FONT_STEPS.includes(saved.font as number) ? (saved.font as number) : 100,
  tree: savedLayout ? initialTree : presetTree(DEFAULT_PRESET),
  maximized: null,
  dragging: null,
  paletteOpen: false,
  confirmControl: false,
  preset: savedLayout?.preset || DEFAULT_PRESET,
  epoch: 0,
};

const subs = new Set<() => void>();
function set(patch: Partial<UIState>) {
  state = { ...state, ...patch };
  if ("view" in patch || "font" in patch) save(UI_KEY, { view: state.view, font: state.font });
  if ("tree" in patch || "preset" in patch) save(LAYOUT_KEY, { tree: state.tree, preset: state.preset });
  for (const f of subs) f();
  if ("tree" in patch || "maximized" in patch || "view" in patch || "font" in patch) {
    // the map listens for this to re-measure its canvas
    requestAnimationFrame(() => window.dispatchEvent(new Event("x4c-layout")));
    bus.emit("layout");
  }
}
export const getUI = () => state;
export function useUI<T>(sel: (s: UIState) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => sel(state));
}

// ---------------------------------------------------------------- actions
export const isMapView = (v: ViewId) => v === "map" || v === "galaxy";

export function setView(id: ViewId) {
  const patch: Partial<UIState> = { view: id };
  // the map views need the map module: bring it back if it was hidden
  if (isMapView(id) && !findPanel(state.tree, "map")) patch.tree = addPanel(state.tree, "map");
  if (isMapView(id) && state.maximized && state.maximized !== "map") patch.maximized = null;
  set(patch);
  bus.emit("view", id);
}
export function viewStep(d: number) {
  const cur = state.view === "galaxy" || state.view === "map" ? state.view : state.view;
  const i = Math.max(0, VIEWS.findIndex((v) => v.id === cur));
  setView(VIEWS[(i + d + VIEWS.length) % VIEWS.length].id);
}
export function setFont(f: number) { set({ font: f }); }
export function fontStep(d: number) {
  const i = FONT_STEPS.indexOf(state.font);
  const n = FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, (i < 0 ? 2 : i) + d))];
  set({ font: n });
}

export function isShown(id: PanelId) { return !!findPanel(state.tree, id); }
export function shownPanels() { return panelsIn(state.tree); }
export function showPanel(id: PanelId) { if (!isShown(id)) set({ tree: addPanel(state.tree, id) }); }
export function hidePanel(id: PanelId) {
  set({ tree: removePanel(state.tree, id), maximized: state.maximized === id ? null : state.maximized });
}
export function togglePanel(id: PanelId) { if (isShown(id)) hidePanel(id); else showPanel(id); }
export function applyPreset(name: string) { set({ tree: presetTree(name), preset: name, maximized: null }); }
export function resetLayout() { applyPreset(DEFAULT_PRESET); }
export function toggleMax(id: PanelId) {
  if (!isMapView(state.view)) { setView("map"); }
  set({ maximized: state.maximized === id ? null : id });
}
export function setDragging(id: PanelId | null) { set({ dragging: id }); }
export function dropPanel(src: PanelId, target: PanelId, side: Side) {
  set({ tree: movePanel(state.tree, src, target, side), dragging: null });
}
export function saveSizes(splitId: string, sizes: Record<string, number>) {
  // sizes only: no re-render needed (the groups own their live sizes)
  state = { ...state, tree: setSizes(state.tree, splitId, sizes) };
  save(LAYOUT_KEY, { tree: state.tree, preset: state.preset });
}
export function markCollapsed(id: PanelId, collapsed: boolean) {
  const p = findPanel(state.tree, id);
  if (!p || !!p.collapsed === collapsed) return;
  set({ tree: setCollapsed(state.tree, id, collapsed) });
}
export function setPalette(open: boolean) { set({ paletteOpen: open }); }
export function setConfirmControl(open: boolean) { set({ confirmControl: open }); }

// collapse / expand go through the resizable panels' imperative API (registered by the workspace)
export interface CollapseHandle { collapse(): void; expand(): void; isCollapsed(): boolean }
const collapseHandles = new Map<PanelId, CollapseHandle>();
export function registerCollapse(id: PanelId, h: CollapseHandle | null) { if (h) collapseHandles.set(id, h); else collapseHandles.delete(id); }
export function canCollapse(id: PanelId) { return collapseHandles.has(id); }
export function toggleCollapse(id: PanelId) {
  const h = collapseHandles.get(id);
  if (!h) { const p = findPanel(state.tree, id); if (p) markCollapsed(id, !p.collapsed); return; }
  if (h.isCollapsed()) { h.expand(); markCollapsed(id, false); } else { h.collapse(); markCollapsed(id, true); }
}

/** apply a whole layout (saved user layout); bumps the epoch so every module re-reads its settings */
export function applyTree(tree: LNode | null, name: string) {
  set({ tree: parseTree(tree), preset: name, maximized: null, epoch: state.epoch + 1 });
}