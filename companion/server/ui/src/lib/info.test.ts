// The info panel must never show "null"/"undefined"/"NaN", and must not produce rows, sections or
// buttons without a value (the old shell printed "nullnull" and empty hull/shield rows for a satellite).
import { describe, expect, it } from "vitest";
import en from "@/i18n/en.json";
import hu from "@/i18n/hu.json";
import { makeFmt, fill } from "./format";
import { buildInfo, type InfoModel } from "./info";

type Tree = { [k: string]: string | Tree };
function tr(dict: Tree) {
  return (key: string, vars?: Record<string, unknown>) => {
    let o: string | Tree | undefined = dict;
    for (const p of key.split(".")) o = o && typeof o === "object" ? o[p] : undefined;
    return typeof o === "string" ? fill(o, (vars || {}) as Record<string, string>) : key;
  };
}

function mkS(extra: Record<string, unknown> = {}) {
  return {
    property: new Map<string, Record<string, unknown>>([
      ["100", { id: "100", k: "ship", c: "ship_m", n: "Own Ship", s: "1", hull: 80, shield: 50, on: "Trade", od: "TradeRoutine", money: 12345 }],
      ["101", { id: "101", k: "ship", c: "ship_s", n: "Wing", s: "1", cmd: "100" }],
    ]),
    scans: {
      "1": { objs: [
        { id: "200", c: "satellite", n: "Sat", o: "player", pl: true, x: 10, z: 10, hull: 0, shield: 0 },
        { id: "201", c: "ship_l", n: "NPC freighter", o: "argon", x: 500, z: 500 },
        { id: "202", c: "gate", x: 0, z: 0, ds: "2" },
      ] },
    },
    sectors: new Map([["1", { id: "1", name: "Argon Prime", cname: "Argon Prime", owner: "argon", res: [{ w: "ore", n: "Ore", c: 50, m: 100 }] }],
                      ["2", { id: "2", name: "Second", cname: "Second" }]]),
    links: [{ a: "1", b: "2", kind: "gate" }],
    factions: { argon: { n: "Argon Federation" } },
    player: { name: "Cap", sector: { id: "1", name: "Argon Prime" }, object: { id: "999", name: "Player ship", x: 0, z: 0, hull: 93, shield: 100 }, where: { mode: "pilot", name: "Player ship" } },
    hello: { allow: ["openmap", "target", "guidance"] },
    control: false,
    ...extra,
  };
}

const NEVER = /\bnull\b|\bundefined\b|NaN/;
// every string the panel would display
function shown(m: InfoModel): string[] {
  const out = [m.title, ...(m.subtitle !== null ? [m.subtitle] : []), ...m.hints];
  for (const r of m.rows) out.push(r.label, r.value.kind === "text" ? r.value.text : String(r.value.pct));
  for (const b of m.buttons) out.push(b.label, b.tip);
  if (m.cargo && m.cargo.state === "list") for (const c of m.cargo.items) out.push(c.name, c.amount);
  for (const o of m.orders) out.push(o.text, ...(o.meta !== null ? [o.meta] : []));
  for (const l of [...m.subordinates, ...m.ownHere]) out.push(l.label);
  return out;
}
function check(m: InfoModel) {
  for (const s of shown(m)) {
    expect(typeof s).toBe("string");
    expect(s).not.toMatch(NEVER);
  }
  if (m.subtitle !== null) expect(m.subtitle.trim()).not.toBe("");
  for (const r of m.rows) {
    if (r.value.kind === "text") expect(r.value.text.trim().length).toBeGreaterThan(0);
    else expect(Number.isFinite(r.value.pct)).toBe(true);
  }
  for (const b of m.buttons) { expect(b.label.trim()).not.toBe(""); for (const a of b.args) expect(a).toMatch(/^\d+$/); }
}

for (const [lang, dict] of [["en", en], ["hu", hu]] as const) {
  describe(`info model (${lang})`, () => {
    const t = tr(dict as Tree);
    const base = (S: ReturnType<typeof mkS>) => ({
      S, t, f: makeFmt(lang), sectorName: (id: unknown) => (S.sectors.get(String(id))?.name as string) || "?",
      factionName: (id: unknown) => ((S.factions as Record<string, { n: string }>)[String(id)]?.n) || String(id),
      whereText: () => "Pilot",
    });
    it("satellite: no hull / shield rows, no cargo, no null text", () => {
      const S = mkS();
      const m = buildInfo(base(S), { kind: "obj", id: "200" }, { id: "200", c: "satellite", hull: 0, shield: 0, on: "Player" });
      check(m);
      expect(m.rows.map((r) => r.key)).not.toContain("hull");
      expect(m.rows.map((r) => r.key)).not.toContain("shield");
      expect(m.cargo).toBeNull();
      expect(m.orders).toEqual([]);
    });
    it("own ship: rows with values, order name from the property entry, subordinates", () => {
      const S = mkS();
      const m = buildInfo(base(S), { kind: "obj", id: "100" }, { id: "100", on: "Player Faction", oname: "Trade", cwl: true, cargo: [{ w: "ore", n: "Ore", a: null }], orders: [{ n: "Trade", pt: { s: "2" } }, { d: "MoveWait" }] });
      check(m);
      const keys = m.rows.map((r) => r.key);
      expect(keys).toEqual(expect.arrayContaining(["class", "sector", "owner", "hull", "shield", "order", "account"]));
      expect(m.rows.find((r) => r.key === "order")!.value).toMatchObject({ text: expect.stringContaining("Trade") });
      expect(m.subordinates.map((s) => s.id)).toEqual(["101"]);
      expect(m.cargo).toMatchObject({ state: "list" });
      expect(m.orders).toHaveLength(2);
    });
    it("NPC with details: owner is the details' owner name, never shown as the order", () => {
      const S = mkS();
      const m = buildInfo(base(S), { kind: "obj", id: "201" }, { id: "201", on: "Argon Federation", cwl: false });
      check(m);
      expect(m.rows.find((r) => r.key === "owner")!.value).toMatchObject({ text: "Argon Federation" });
      expect(m.rows.find((r) => r.key === "order")).toBeUndefined();
      expect(m.cargo).toEqual({ state: "locked" });
    });
    it("details still loading / failed", () => {
      const S = mkS();
      check(buildInfo(base(S), { kind: "obj", id: "201" }, undefined));
      check(buildInfo(base(S), { kind: "obj", id: "201" }, null));
    });
    it("object without any data", () => {
      const m = buildInfo(base(mkS()), { kind: "obj", id: "555" }, undefined);
      check(m);
      expect(m.kind).toBe("gone");
      expect(m.buttons).toEqual([]);
    });
    it("sector and nothing selected", () => {
      const S = mkS();
      const sm = buildInfo(base(S), { kind: "sector", id: "1" }, undefined);
      check(sm);
      expect(sm.rows.map((r) => r.key)).toEqual(expect.arrayContaining(["owner", "own_ships", "resources", "links"]));
      const nm = buildInfo(base(S), null, undefined);
      check(nm);
      expect(nm.kind).toBe("player");
      const empty = buildInfo(base(mkS({ player: null })), null, undefined);
      check(empty);
      expect(empty.rows).toEqual([]);
    });
    it("garbage values are dropped", () => {
      const S = mkS();
      S.scans["1"].objs.push({ id: "300", c: "ship_s", n: "", o: null, x: NaN, z: undefined, hull: "x", shield: null, rr: NaN, wfc: 0 } as never);
      const m = buildInfo(base(S), { kind: "obj", id: "300" }, { id: "300", cwl: true, cargo: [] });
      check(m);
      expect(m.rows.map((r) => r.key)).not.toContain("hull");
      expect(m.rows.map((r) => r.key)).not.toContain("distance");
      expect(m.cargo).toEqual({ state: "empty" });
    });
  });
}
