import { describe, expect, it } from "vitest";
import { joinParts, makeFmt, pct01, text, toNum } from "./format";

const BAD = [null, undefined, NaN, Infinity, -Infinity, "", "  ", "abc", {}, [], true];
const NEVER = /null|undefined|NaN|Infinity/;

describe("toNum / text", () => {
  it("accepts finite numbers and numeric strings only", () => {
    expect(toNum(5)).toBe(5);
    expect(toNum("12.5")).toBe(12.5);
    for (const v of BAD) expect(toNum(v)).toBeNull();
  });
  it("text drops empty and non-string values", () => {
    expect(text(" a ")).toBe("a");
    expect(text(3)).toBe("3");
    for (const v of [null, undefined, "", "  ", NaN, {}]) expect(text(v)).toBeNull();
  });
  it("pct01 clamps", () => {
    expect(pct01(150)).toBe(100);
    expect(pct01(-3)).toBe(0);
    expect(pct01(null)).toBeNull();
  });
  it("joinParts skips empty parts", () => {
    expect(joinParts(["a", null, "", undefined, false, "b"])).toBe("a · b");
    expect(joinParts([null, ""])).toBeNull();
  });
});

for (const lang of ["en", "hu"] as const) {
  describe(`formatters (${lang})`, () => {
    const f = makeFmt(lang);
    const all: [string, (v: unknown) => string | null][] = [
      ["num", (v) => f.num(v)], ["num1", (v) => f.num(v, 1)], ["signed", f.signed], ["pct", f.pct], ["money", (v) => f.money(v)],
      ["moneyShort", (v) => f.money(v, true)], ["dist", f.dist], ["speed", f.speed], ["seconds", (v) => f.seconds(v)],
      ["dur", f.dur], ["gameTime", f.gameTime], ["ago", (v) => f.ago(v, 1000)], ["ago2", (v) => f.ago(0, v)],
    ];
    it("return null (never a 'null'/'NaN' string) for missing values", () => {
      for (const [name, fn] of all) for (const v of BAD) {
        const r = fn(v);
        expect(r, `${name}(${String(v)})`).toBeNull();
      }
    });
    it("never print null/undefined/NaN for real values", () => {
      for (const [name, fn] of all) for (const v of [0, 1, -1, 12.34, 999999, 123456789, 5e9, "42"]) {
        const r = fn(v);
        if (r !== null) expect(r, `${name}(${v})`).not.toMatch(NEVER);
      }
    });
    it("formats per locale", () => {
      if (lang === "en") {
        expect(f.num(1234567)).toBe("1,234,567");
        expect(f.money(1500000)).toBe("1,500,000 Cr");
        expect(f.money(2500000, true)).toBe("2.5M Cr");
        expect(f.dist(25000)).toBe("25 km");
        expect(f.dist(950)).toBe("950 m");
        expect(f.gameTime(90061)).toBe("Day 1 01:01");
        expect(f.ago(0, 7200)).toBe("2 h ago");
        expect(f.seconds(3.25)).toBe("3.3 s");
      } else {
        expect(f.num(1234567)).toBe("1 234 567");
        expect(f.money(2500000, true)).toBe("2,5 M Cr");
        expect(f.dist(25500)).toBe("25,5 km");
        expect(f.gameTime(90061)).toBe("1. nap 01:01");
        expect(f.ago(0, 7200)).toBe("2 órája");
        expect(f.seconds(3.25)).toBe("3,3 mp");
      }
      expect(f.dur(3725)).toBe("1:02:05");
      expect(f.dur(65)).toBe("1:05");
      expect(f.dur(-1)).toBeNull();
      expect(f.signed(5)).toBe("+5");
      expect(f.pct(93.4)).toBe("93%");
    });
  });
}
