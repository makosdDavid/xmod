// Map look regression tests (node tests/test_mapstyle.mjs): the game's colour rule, icon choice,
// radar hex coverage and gate routing. Exit code 1 on failure.
import { colorKey, objColor, iconFor, iconSize, hexCellsInRange, radarCell, route, holo, FALLBACK_HOLO, iconFallbackOf } from "../web/mapstyle.js";

let pass = 0, fail = 0;
function check(ok, what) { if (ok) pass++; else fail++; console.log((ok ? "PASS " : "FAIL ") + what); }

// colours: menu_map.lua legend + getContainerNameAndColors order
check(colorKey({ c: "ship_s", pl: true, h: true }) === "playercolor", "own object -> playercolor even if flagged hostile");
check(colorKey({ c: "ship_s", pl: true, id: "7" }, { currentId: "7" }) === "currentplayershipcolor", "the ship you are in -> currentplayershipcolor");
check(colorKey({ c: "ship_m", h: true, e: true }) === "hostilecolor", "hostile before enemy");
check(colorKey({ c: "ship_m", e: true }) === "enemycolor", "enemy -> enemycolor");
check(colorKey({ c: "station", o: "argon" }) === "friendcolor", "neutral -> friendcolor (legend: Neutral = friendcolor)");
check(colorKey({ c: "ship_m", mt: true, h: true }) === "missioncolor", "mission target first (as the object list)");
check(colorKey({ c: "gate" }) === "gatecolor" && colorKey({ c: "highwayentrygate" }) === "highwaygatecolor", "gates: gatecolor / highwaygatecolor");
check(colorKey({ k: "ship", c: "ship_l" }) === "playercolor", "property entries count as own");
const theme = { holo: { friendcolor: { r: 1, g: 2, b: 3 } } };
check(objColor({ c: "ship_s" }, theme).r === 1 && objColor({ c: "ship_s", pl: true }, theme) === FALLBACK_HOLO.playercolor,
      "game colours from the theme message, fallback only for missing names");
const facs = { argon: { col: { r: 9, g: 9, b: 9 } } };
check(objColor({ c: "ship_s", o: "argon" }, theme, { factionColors: true, factions: facs }).r === 9 &&
      objColor({ c: "ship_s", o: "argon", h: true }, theme, { factionColors: true, factions: facs }) !== facs.argon.col,
      "faction-colour option recolours neutral objects only");
check(holo(null, "nonexistent") === FALLBACK_HOLO.friendcolor, "unknown colour name -> neutral fallback");

// icons: the game's id first, legend icon per type otherwise
check(iconFor({ ic: "ship_l_destroyer_01", c: "ship_l" }) === "ship_l_destroyer_01", "game icon id is used as is");
check(iconFor({ c: "ship_m", p: "fight" }) === "ship_m_fight_01" && iconFor({ c: "ship_s", p: "build" }) === "ship_s_neutral_01",
      "ship fallback: size + purpose, neutral when that icon does not exist");
check(iconFor({ c: "gate" }) === "mapob_jumpgate" && iconFor({ c: "satellite" }) === "mapob_satellite_01" &&
      iconFor({ c: "navbeacon" }) === "mapob_navbeacon" && iconFor({ c: "weird" }) === "mapob_unknown", "deployables / gates / unknown");
check(iconFor({ c: "ship_m", wr: true }) === "mapob_scrap_tow", "wreck icon");
check(iconFallbackOf("ship_cpsdo_l_x") === "ship_m_neutral_01" && iconFallbackOf("ship_xl_modded_01") === "ship_xl_neutral_01", "unexported mod icon -> base family icon");
check(iconSize({ c: "ship_xl" }) > iconSize({ c: "ship_s" }) && iconSize({ c: "ship_s" }, 2) === 2 * iconSize({ c: "ship_s" }), "icon size per class, scalable, independent of zoom");

// radar hex coverage
const cell = radarCell([{ x: 0, z: 0, r: 40000 }]);
const lit = hexCellsInRange([{ x: 0, z: 0, r: 40000 }], cell);
const area = lit.size * cell * cell * Math.sqrt(3) / 2;
check(Math.abs(area / (Math.PI * 40000 * 40000) - 1) < 0.12, `hex cells cover the radar circle (${lit.size} cells, area ratio ${(area / (Math.PI * 1.6e9)).toFixed(3)})`);
check([...lit.values()].every(([x, z]) => Math.hypot(x, z) <= 40000), "every lit cell centre lies inside the range");
const two = hexCellsInRange([{ x: 0, z: 0, r: 40000 }, { x: 10000, z: 0, r: 40000 }], cell);
check(two.size > lit.size && two.size < 2 * lit.size, "overlapping radars are unioned, not doubled");
check(hexCellsInRange([{ x: 0, z: 0, r: 0 }, { x: NaN, z: 0, r: 5 }], 1000).size === 0, "no range / bad position -> nothing lit");

// routing over known gate links
const links = [{ a: "1", b: "2" }, { a: "2", b: "3" }, { a: "3", b: "4" }, { a: "1", b: "5" }, { a: "5", b: "4" }, { a: "6", b: "7" }];
const r = route(links, "1", "4");
check(r && r.length === 3 && r[0] === "1" && r[2] === "4", `shortest route 1 -> 4: ${r}`);
check(route(links, "1", "7") === null && route(links, "3", "3").length === 1, "no route into an unconnected part; same sector");

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
