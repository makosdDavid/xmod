import { describe, expect, it } from "vitest";
import { addPanel, findPanel, movePanel, normalize, panelsIn, parseTree, PRESETS, presetTree, removePanel, setSizes, type LNode } from "./layout";

const sum = (n: LNode): boolean => n.t === "p" || (Math.abs(n.kids.reduce((a, k) => a + k.size, 0) - 100) < 0.5 && n.kids.every(sum));

describe("layout tree", () => {
  it("presets contain the old presets' modules", () => {
    expect(panelsIn(presetTree("nav")).sort()).toEqual(["info", "map", "objects"]);
    expect(panelsIn(presetTree("fleet")).sort()).toEqual(["info", "log", "map", "property"]);
    expect(panelsIn(presetTree("combat")).sort()).toEqual(["info", "log", "map", "objects"]);
    expect(panelsIn(presetTree("all")).sort()).toEqual(["economy", "factions", "info", "log", "map", "missions", "objects", "property"]);
    for (const p of PRESETS) expect(sum(presetTree(p))).toBe(true);
  });
  it("remove + add keep sizes valid", () => {
    let t: LNode | null = presetTree("nav");
    t = removePanel(t, "objects");
    expect(panelsIn(t)).toEqual(["map", "info"]);
    expect(sum(t!)).toBe(true);
    t = addPanel(t, "log");
    expect(panelsIn(t)).toContain("log");
    expect(sum(t!)).toBe(true);
    expect(removePanel(removePanel(removePanel(t, "map"), "info"), "log")).toBeNull();
    expect(addPanel(null, "map")).toMatchObject({ t: "p", id: "map" });
  });
  it("move to an edge docks next to the target; centre swaps", () => {
    const t = presetTree("nav");
    const right = movePanel(t, "objects", "map", "right")!;
    expect(panelsIn(right)).toEqual(["map", "objects", "info"]);
    const below = movePanel(t, "info", "map", "bottom")!;
    const p = below.t === "s" ? below.kids[0] : null;
    expect(p && p.t === "s" && p.dir === "col" && panelsIn(p)).toEqual(["map", "info"]);
    const sw = movePanel(t, "info", "map", "center")!;
    expect(panelsIn(sw)).toEqual(["info", "objects", "map"]);
    expect(sum(right) && sum(below) && sum(sw)).toBe(true);
    expect(movePanel(t, "map", "map", "left")).toBe(t);
  });
  it("normalize merges nesting and drops duplicates", () => {
    const n = normalize({ t: "s", id: "a", dir: "row", size: 100, kids: [
      { t: "s", id: "b", dir: "row", size: 50, kids: [{ t: "p", id: "map", size: 50 }, { t: "p", id: "log", size: 50 }] },
      { t: "p", id: "map", size: 50 },
    ] })!;
    expect(panelsIn(n)).toEqual(["map", "log"]);
    expect(sum(n)).toBe(true);
  });
  it("setSizes stores dragged sizes", () => {
    const t = presetTree("nav") as Extract<LNode, { t: "s" }>;
    const s = setSizes(t, t.id, { "p-map": 70, [t.kids[1].t === "s" ? t.kids[1].id : ""]: 30 })!;
    expect(findPanel(s, "map")!.size).toBe(70);
  });
  it("parseTree rejects malformed / old-format data", () => {
    expect(parseTree({ name: "nav", mods: { map: { x: 0 } } })).toBeNull();    // old x4c.dock.v2 format
    expect(parseTree({ t: "p", id: "evil", size: 100 })).toBeNull();
    expect(parseTree("x")).toBeNull();
    expect(parseTree(presetTree("all"))).not.toBeNull();
  });
});
