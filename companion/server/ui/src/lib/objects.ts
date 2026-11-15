// Sector-object list rules (filters, search) shared by the Objects panel and the command palette.
// Abandoned ships: the map module's rule (web/mapstyle.js isOwnerlessShip: ship class + owner "ownerless").
import { isOwnerlessShip, OWNERLESS_COLOR } from "@web/mapstyle.js";
import type { Any } from "@/core/store";

export { isOwnerlessShip };

export const OBJ_FILTERS = ["all", "ships", "stations", "gates", "own", "hostile", "ownerless"] as const;
export type ObjFilter = (typeof OBJ_FILTERS)[number];

/** the map marker's accent (chartreuse), for badges in lists */
export const OWNERLESS_CSS = `rgb(${OWNERLESS_COLOR.r} ${OWNERLESS_COLOR.g} ${OWNERLESS_COLOR.b})`;

/** does an object pass the list filter + free-text search (q lower-case; `owner` = shown owner text) */
export function objMatches(o: Any, f: string, q: string, owner = ""): boolean {
  const ship = !!o.c && String(o.c).startsWith("ship");
  if (f === "ships" && !ship) return false;
  if (f === "stations" && o.c !== "station") return false;
  if (f === "gates" && o.c !== "gate" && o.c !== "highwayentrygate") return false;
  if (f === "own" && !o.pl) return false;
  if (f === "hostile" && !(o.h || o.e)) return false;
  if (f === "ownerless" && !isOwnerlessShip(o)) return false;
  if (q && !`${o.n || ""} ${o.code || ""} ${owner}`.toLowerCase().includes(q)) return false;
  return true;
}

// words that list every abandoned ship in the command palette (both languages, with / without accents)
const OWNERLESS_WORDS = ["ownerless", "abandoned", "claimable", "gazdátlan", "gazdatlan", "elhagyott", "elfoglalható", "elfoglalhato"];
export function wantsOwnerless(q: string): boolean {
  const s = q.trim().toLowerCase();
  return s.length >= 3 && OWNERLESS_WORDS.some((w) => w.startsWith(s) || s.startsWith(w));
}
