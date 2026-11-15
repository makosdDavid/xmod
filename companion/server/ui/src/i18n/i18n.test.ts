// Fails when the English and Hungarian token files differ (keys, or the {{placeholders}} a text uses).
import { describe, expect, it } from "vitest";
import en from "./en.json";
import hu from "./hu.json";
import { STRINGS } from "@web/map-strings.js";

type Tree = { [k: string]: string | Tree };
function flat(o: Tree, pre = "", out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(o)) {
    const key = pre ? `${pre}.${k}` : k;
    if (typeof v === "string") out[key] = v; else flat(v, key, out);
  }
  return out;
}
const vars = (s: string, re: RegExp) => [...s.matchAll(re)].map((m) => m[1]).sort().join(",");

describe("token files en.json / hu.json", () => {
  const E = flat(en as Tree), H = flat(hu as Tree);
  it("have the same key set", () => {
    const onlyEn = Object.keys(E).filter((k) => !(k in H));
    const onlyHu = Object.keys(H).filter((k) => !(k in E));
    expect({ onlyEn, onlyHu }).toEqual({ onlyEn: [], onlyHu: [] });
  });
  it("use the same placeholders in every text", () => {
    const bad = Object.keys(E).filter((k) => k in H && vars(E[k], /\{\{\s*(\w+)\s*\}\}/g) !== vars(H[k], /\{\{\s*(\w+)\s*\}\}/g));
    expect(bad).toEqual([]);
  });
  it("have no empty texts", () => {
    const empty = [...Object.entries(E), ...Object.entries(H)].filter(([k, v]) => !v.trim() && !k.startsWith("help.in_game")).map(([k]) => k);
    expect(empty).toEqual([]);
  });
});

describe("map texts (web/map-strings.js, injected through the shell's translator)", () => {
  it("en and hu have the same keys and {placeholders}", () => {
    const e = STRINGS.en, h = STRINGS.hu;
    expect(Object.keys(e).filter((k) => !(k in h))).toEqual([]);
    expect(Object.keys(h).filter((k) => !(k in e))).toEqual([]);
    expect(Object.keys(e).filter((k) => k in h && vars(e[k], /\{(\w+)\}/g) !== vars(h[k], /\{(\w+)\}/g))).toEqual([]);
  });
});
