// Workspace layout model (pure, unit-tested in layout.test.ts).
// A tree of splits: a split lays its children out in a row (side by side) or a column (stacked),
// each child with a size in percent of its parent. Leaves are modules. Modules not in the tree are
// hidden. The tree is rendered with shadcn Resizable (react-resizable-panels) groups and persisted
// in localStorage. Rearranging = dropping a module on another module's edge (left/right/top/bottom)
// or centre (swap).

export const PANEL_IDS = ["map", "objects", "info", "property", "log", "missions", "factions", "economy", "diag", "hotkeys"] as const;
export type PanelId = (typeof PANEL_IDS)[number];
export type Dir = "row" | "col";
export type Side = "left" | "right" | "top" | "bottom" | "center";

export interface PanelNode { t: "p"; id: PanelId; size: number; collapsed?: boolean }
export interface SplitNode { t: "s"; id: string; dir: Dir; size: number; kids: LNode[] }
export type LNode = PanelNode | SplitNode;

export const isPanelId = (v: unknown): v is PanelId => typeof v === "string" && (PANEL_IDS as readonly string[]).includes(v);

const P = (id: PanelId, size: number): PanelNode => ({ t: "p", id, size });
let seq = 0;
const S = (dir: Dir, size: number, kids: LNode[]): SplitNode => ({ t: "s", id: "s" + (++seq).toString(36) + Math.random().toString(36).slice(2, 6), dir, size, kids });

// the four presets of the original 12x12 grid, as split trees with the same proportions
export const PRESETS = ["nav", "fleet", "combat", "all"] as const;
export type PresetId = (typeof PRESETS)[number];
export function presetTree(name: string): LNode {
  switch (name) {
    case "fleet": // map 6 cols | property on top, info + log side by side below
      return S("row", 100, [P("map", 50), S("col", 50, [P("property", 58.3), S("row", 41.7, [P("info", 50), P("log", 50)])])]);
    case "combat":
      return S("row", 100, [P("map", 66.7), S("col", 33.3, [P("objects", 41.7), P("info", 33.3), P("log", 25)])]);
    case "all":
      return S("col", 100, [
        S("row", 58.3, [P("map", 50), S("col", 50, [S("row", 57, [P("objects", 50), P("info", 50)]), P("property", 43)])]),
        S("row", 41.7, [P("log", 33.3), P("missions", 25), P("factions", 25), P("economy", 16.7)]),
      ]);
    case "nav":
    default:
      return S("row", 100, [P("map", 66.7), S("col", 33.3, [P("objects", 50), P("info", 50)])]);
  }
}
export const DEFAULT_PRESET: PresetId = "nav";

export function panelsIn(n: LNode | null): PanelId[] {
  if (!n) return [];
  return n.t === "p" ? [n.id] : n.kids.flatMap(panelsIn);
}
export function findPanel(n: LNode | null, id: PanelId): PanelNode | null {
  if (!n) return null;
  if (n.t === "p") return n.id === id ? n : null;
  for (const k of n.kids) { const f = findPanel(k, id); if (f) return f; }
  return null;
}
/** parent split of the node with this key (panel id or split id) */
export function parentOf(n: LNode | null, key: string): SplitNode | null {
  if (!n || n.t === "p") return null;
  for (const k of n.kids) {
    if (nodeKey(k) === key) return n;
    const f = parentOf(k, key);
    if (f) return f;
  }
  return null;
}
export const nodeKey = (n: LNode) => (n.t === "p" ? "p-" + n.id : n.id);

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function scale(kids: LNode[]) {
  const sum = kids.reduce((a, k) => a + (k.size > 0 ? k.size : 0), 0);
  if (!kids.length) return;
  if (sum <= 0) { for (const k of kids) k.size = 100 / kids.length; return; }
  for (const k of kids) k.size = Math.round(((k.size > 0 ? k.size : 0) / sum) * 1000) / 10;
}

/** tidy: drop empty splits, lift single children, merge same-direction nesting, sizes sum to 100 */
export function normalize(n: LNode | null): LNode | null {
  if (!n) return null;
  if (n.t === "p") return isPanelId(n.id) ? n : null;
  let kids: LNode[] = [];
  for (const k of n.kids) {
    const c = normalize(k);
    if (!c) continue;
    if (c.t === "s" && c.dir === n.dir) {
      // merge: the grand-children take their share of the child's size
      for (const g of c.kids) kids.push({ ...g, size: (g.size * c.size) / 100 });
    } else kids.push(c);
  }
  // a module may appear only once
  const seen = new Set<string>();
  kids = kids.filter((k) => { const key = nodeKey(k); if (seen.has(key)) return false; seen.add(key); return true; });
  if (!kids.length) return null;
  if (kids.length === 1) return { ...kids[0], size: n.size };
  scale(kids);
  return { ...n, kids };
}

export function removePanel(tree: LNode | null, id: PanelId): LNode | null {
  if (!tree) return null;
  const t = clone(tree);
  const strip = (n: LNode): LNode | null => {
    if (n.t === "p") return n.id === id ? null : n;
    n.kids = n.kids.map(strip).filter((k): k is LNode => !!k);
    return n;
  };
  const r = strip(t);
  return normalize(r ? { ...r, size: 100 } : null);
}

/** show a hidden module: appended to the right-most column (or next to the whole tree) */
export function addPanel(tree: LNode | null, id: PanelId): LNode {
  if (findPanel(tree, id)) return tree!;
  const node: PanelNode = P(id, 30);
  if (!tree) return { ...node, size: 100 };
  const t = clone(tree);
  if (t.t === "s" && t.dir === "row") {
    const last = t.kids[t.kids.length - 1];
    if (last.t === "s" && last.dir === "col") {
      const n = last.kids.length + 1;
      last.kids.push({ ...node, size: 100 / n });
      for (const k of last.kids) if (k !== last.kids[last.kids.length - 1]) k.size = k.size * (n - 1) / n;
    } else {
      t.kids[t.kids.length - 1] = S("col", last.size, [{ ...last, size: 50 }, { ...node, size: 50 }]);
    }
    return normalize(t)!;
  }
  return normalize(S("row", 100, [{ ...t, size: 70 }, { ...node, size: 30 }]))!;
}

/** move module `src` next to module `target` (side) or swap them (center) */
export function movePanel(tree: LNode | null, src: PanelId, target: PanelId, side: Side): LNode | null {
  if (!tree || src === target) return tree;
  if (!findPanel(tree, target)) return tree;
  if (side === "center") {
    const t = clone(tree);
    const a = findPanel(t, src), b = findPanel(t, target);
    if (!a || !b) return tree;
    a.id = target; b.id = src;
    const ac = a.collapsed; a.collapsed = b.collapsed; b.collapsed = ac;
    return t;
  }
  const without = findPanel(tree, src) ? removePanel(tree, src) : clone(tree);
  if (!without) return tree;
  const dir: Dir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  const place = (n: LNode, parent: SplitNode | null): LNode => {
    if (n.t === "s") { n.kids = n.kids.map((k) => place(k, n)); return n; }
    if (n.id !== target) return n;
    const moved: PanelNode = P(src, 50);
    if (parent && parent.dir === dir) {
      // sibling in the same split: split the target's share in two
      const i = parent.kids.indexOf(n);
      const half = n.size / 2;
      n.size = half;
      moved.size = half;
      (parent as SplitNode & { _ins?: [number, LNode] })._ins = [before ? i : i + 1, moved];
      return n;
    }
    return S(dir, n.size, before ? [moved, { ...n, size: 50 }] : [{ ...n, size: 50 }, moved]);
  };
  const t = place(without, null);
  const applyIns = (n: LNode) => {
    if (n.t !== "s") return;
    const x = n as SplitNode & { _ins?: [number, LNode] };
    if (x._ins) { n.kids.splice(x._ins[0], 0, x._ins[1]); delete x._ins; }
    n.kids.forEach(applyIns);
  };
  applyIns(t);
  return normalize({ ...t, size: 100 });
}

/** store the sizes the user dragged (keys = nodeKey of the children) */
export function setSizes(tree: LNode | null, splitId: string, sizes: Record<string, number>): LNode | null {
  if (!tree) return tree;
  const t = clone(tree);
  const walk = (n: LNode) => {
    if (n.t !== "s") return;
    if (n.id === splitId) for (const k of n.kids) { const v = sizes[nodeKey(k)]; if (typeof v === "number" && Number.isFinite(v)) k.size = v; }
    n.kids.forEach(walk);
  };
  walk(t);
  return t;
}
export function setCollapsed(tree: LNode | null, id: PanelId, collapsed: boolean): LNode | null {
  if (!tree) return tree;
  const t = clone(tree);
  const p = findPanel(t, id);
  if (p) p.collapsed = collapsed || undefined;
  return t;
}

/** validate something loaded from storage; null if unusable */
export function parseTree(raw: unknown): LNode | null {
  const ok = (n: unknown): n is LNode => {
    if (!n || typeof n !== "object") return false;
    const x = n as Record<string, unknown>;
    if (typeof x.size !== "number" || !Number.isFinite(x.size)) return false;
    if (x.t === "p") return isPanelId(x.id);
    if (x.t === "s") return typeof x.id === "string" && (x.dir === "row" || x.dir === "col") && Array.isArray(x.kids) && x.kids.every(ok);
    return false;
  };
  if (raw === null) return null;
  return ok(raw) ? normalize(clone(raw)) : null;
}
