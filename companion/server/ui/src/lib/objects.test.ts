// Objects list filter + the abandoned-ship rule shared with the map, and its tokens in both languages.
import { describe, expect, it } from "vitest";
import en from "@/i18n/en.json";
import hu from "@/i18n/hu.json";
import { isOwnerlessShip, OBJ_FILTERS, objMatches, OWNERLESS_CSS, wantsOwnerless } from "./objects";

const objs = [
  { id: "1", c: "ship_m", o: "ownerless", n: "Baku", ic: "ship_m_transporter_01" },   // live 9.00 data
  { id: "2", c: "ship_s", o: "argon", n: "Courier" },
  { id: "3", c: "gate", o: "ownerless", n: "Gate", ds: "9" },
  { id: "4", c: "lockbox", o: "ownerless", n: "Lockbox" },
  { id: "5", c: "satellite", o: "ownerless", n: "Satellite" },
  { id: "6", c: "station", o: "ownerless", n: "Station" },
  { id: "7", c: "ship_l", o: "ownerless", n: "Own", pl: true },
  { id: "8", c: "ship_xl", o: "ownerless", n: "Wreck", wr: true },
];

describe("abandoned (ownerless) ships", () => {
  it("are ship classes owned by 'ownerless' only", () => {
    expect(objs.filter(isOwnerlessShip).map((o) => o.id)).toEqual(["1"]);
  });
  it("have their own list filter", () => {
    expect(OBJ_FILTERS).toContain("ownerless");
    expect(objs.filter((o) => objMatches(o, "ownerless", "")).map((o) => o.id)).toEqual(["1"]);
    expect(objs.filter((o) => objMatches(o, "ships", "")).map((o) => o.id)).toEqual(["1", "2", "7", "8"]);
    expect(objs.filter((o) => objMatches(o, "ownerless", "bak")).map((o) => o.id)).toEqual(["1"]);
    expect(objs.filter((o) => objMatches(o, "ownerless", "zzz"))).toEqual([]);
  });
  it("are listed by the palette for 'ownerless' / 'gazdátlan' (and prefixes), not for other words", () => {
    for (const q of ["ownerless", "Owner", "gazdátlan", "gazdat", "abandon", "elhagyott"]) expect(wantsOwnerless(q)).toBe(true);
    for (const q of ["", "ow", "baku", "argon", "station"]) expect(wantsOwnerless(q)).toBe(false);
  });
  it("use the map's accent colour", () => {
    expect(OWNERLESS_CSS).toBe("rgb(206 255 38)");
  });
  it("have the filter, badge, details and palette texts in en and hu", () => {
    const keys = [["objects", "f_ownerless"], ["objects", "ownerless_badge"], ["objects", "ownerless_tip"], ["info", "status"],
                  ["info", "ownerless_claim"], ["palette", "ownerless"]] as const;
    for (const [a, b] of keys) {
      const e = (en as Record<string, Record<string, string>>)[a][b], h = (hu as Record<string, Record<string, string>>)[a][b];
      expect(e && h && e !== h, `${a}.${b}`).toBeTruthy();
    }
    expect(hu.info.ownerless_claim).toBe("Gazdátlan – elfoglalható");
    expect(en.info.ownerless_claim).toBe("Ownerless – can be claimed");
  });
});
