// X4 Companion — the game map's look: which icon and which colour an object gets.
// Pure functions (unit-tested with node: tests/test_mapstyle.mjs) + a small browser-only icon cache.
//
// Sources (vanilla 9.00):
//  - icon: the id the game reports per object, GetComponentData(obj, "icon") (menu_map.lua:20051, 7301),
//    sent by the bridge as "ic". When missing, the map legend's icon for that type (menu_map.lua:1533-1637).
//  - colour: the map legend (menu_map.lua:1543-1637) and the object list (getContainerNameAndColors,
//    menu_map.lua:7299-7376): mission target -> missioncolor, own -> playercolor (the ship you are in ->
//    currentplayershipcolor), hostile -> hostilecolor, enemy -> enemycolor, everything else (neutral)
//    -> friendcolor; jump gate / accelerator -> gatecolor, superhighway gate -> highwaygatecolor.
//    The values come from GetHoloMapColors() at runtime ("theme" message). The game's optional
//    "faction colours" filter (think_diplomacy_factioncolor, default off, menu_map.lua:1881) uses
//    GetFactionData(faction, "color") instead for non-own objects.
"use strict";

// Used only until the game's own colours arrive (theme message) - approximations, not game data.
export const FALLBACK_HOLO = {
  playercolor: { r: 0, g: 255, b: 162 }, friendcolor: { r: 153, g: 204, b: 255 }, enemycolor: { r: 255, g: 128, b: 0 },
  hostilecolor: { r: 255, g: 32, b: 32 }, missioncolor: { r: 255, g: 192, b: 0 }, currentplayershipcolor: { r: 255, g: 255, b: 255 },
  gatecolor: { r: 255, g: 255, b: 255 }, highwaygatecolor: { r: 64, g: 160, b: 255 }, superhighwaycolor: { r: 64, g: 160, b: 255 },
  highwaycolor: { r: 90, g: 140, b: 200 }, radarcolor: { r: 40, g: 90, b: 160 }, visitorcolor: { r: 200, g: 120, b: 255 },
  missilecolor: { r: 255, g: 64, b: 64 },
};

export function rgb(c, a = 1) {
  if (!c) return `rgba(200,210,220,${a})`;
  return a >= 1 ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${a})`;
}

export function holo(theme, name) {
  return (theme && theme.holo && theme.holo[name]) || FALLBACK_HOLO[name] || FALLBACK_HOLO.friendcolor;
}

// which holomap colour name an object gets (the game's rule, see header)
export function colorKey(o, { currentId = null } = {}) {
  if (!o) return "friendcolor";
  const c = o.c || o.class || "";
  if (c === "gate") return "gatecolor";
  if (c === "highwayentrygate") return "highwaygatecolor";
  if (o.mt) return "missioncolor";
  if (o.pl || o.o === "player" || o.k) return (currentId && o.id === currentId) ? "currentplayershipcolor" : "playercolor";
  if (o.h) return "hostilecolor";
  if (o.e) return "enemycolor";
  return "friendcolor";
}

// final colour {r,g,b}; factionColors: game option "Frakciószínek"
export function objColor(o, theme, opts = {}) {
  const key = colorKey(o, opts);
  if (opts.factionColors && key === "friendcolor" && o && o.o && opts.factions && opts.factions[o.o] && opts.factions[o.o].col) {
    return opts.factions[o.o].col;
  }
  return holo(theme, key);
}

const PURPOSE_ICON = { fight: "fight", trade: "trade", mine: "mine", build: "build", auxiliary: "auxiliary", salvage: "salvage" };
const SIZES = ["xs", "s", "m", "l", "xl"];
// existing ship_<size>_<purpose>_01 icons in libraries\icons.xml (base 9.00)
const SHIP_PURPOSE_OK = {
  xs: ["auxiliary", "build", "fight", "mine", "neutral", "trade"], s: ["auxiliary", "fight", "mine", "neutral", "trade"],
  m: ["auxiliary", "fight", "mine", "neutral", "salvage", "trade"], l: ["auxiliary", "fight", "mine", "neutral", "trade"],
  xl: ["auxiliary", "build", "fight", "mine", "neutral", "trade"],
};
const CLASS_ICON = {
  station: "mapob_factory", gate: "mapob_jumpgate", highwayentrygate: "mapob_superhighway", satellite: "mapob_satellite_01",
  navbeacon: "mapob_navbeacon", resourceprobe: "mapob_resourceprobe", lasertower: "mapob_lasertower_xs", mine: "mapob_mine",
  lockbox: "mapob_lockbox", drop: "mapob_drop", crate: "mapob_drop", collectablewares: "mapob_collectablewarecontainer",
  collectableammo: "mapob_collectableammo", collectableblueprints: "mapob_drop", collectableshieldrestore: "mapob_drop",
  buildstorage: "mapob_buildstorage", datavault: "mapob_vault_closed", spacesuit: "ship_xs_neutral_01",
};

// the icon id to draw: the game's own ("ic") or the legend icon for the type
export function iconFor(o) {
  if (!o) return "mapob_unknown";
  if (o.ic) return o.ic;
  const c = o.c || o.class || "";
  if (o.wr) return "mapob_scrap_tow";
  const m = /^ship_(xs|s|m|l|xl)$/.exec(c);
  if (m) {
    const p = PURPOSE_ICON[o.p] || "neutral";
    return `ship_${m[1]}_${SHIP_PURPOSE_OK[m[1]].includes(p) ? p : "neutral"}_01`;
  }
  return CLASS_ICON[c] || "mapob_unknown";
}

// on-screen icon size (px) - constant regardless of zoom, bigger classes bigger, like the game map
export function iconSize(o, scale = 1) {
  const c = o && (o.c || o.class) || "";
  const base = { ship_xs: 15, ship_s: 18, ship_m: 21, ship_l: 25, ship_xl: 29, spacesuit: 14, station: 30,
                 gate: 28, highwayentrygate: 24 }[c] || 17;
  return Math.round(base * scale);
}

export function isShip(o) { const c = o && (o.c || o.class) || ""; return c.startsWith("ship_") || c === "spacesuit"; }

// ---------------------------------------------------------------- radar coverage (hex cells)
// The game's map lights the area its own radars cover and leaves the rest dark, with a hex-stepped
// edge. The explored-hex data itself is not exposed to UI Lua (no such function in the 9.00 ui), so
// the coverage is rebuilt from each own object's position and maxradarrange: every hex cell whose
// centre lies inside any radar circle is lit. Pointy-top axial hex grid, cell = centre distance.
export function hexCellsInRange(sources, cell) {
  const lit = new Map();
  const w = cell, h = cell * Math.sqrt(3) / 2;        // row spacing for pointy-top
  for (const s of sources) {
    if (!(s.r > 0) || !Number.isFinite(s.x) || !Number.isFinite(s.z)) continue;
    const r2 = s.r * s.r;
    const row0 = Math.floor((s.z - s.r) / h) - 1, row1 = Math.ceil((s.z + s.r) / h) + 1;
    for (let row = row0; row <= row1; row++) {
      const cz = row * h;
      const off = (row & 1) ? w / 2 : 0;
      const col0 = Math.floor((s.x - s.r - off) / w) - 1, col1 = Math.ceil((s.x + s.r - off) / w) + 1;
      for (let col = col0; col <= col1; col++) {
        const cx = col * w + off;
        const dx = cx - s.x, dz = cz - s.z;
        if (dx * dx + dz * dz <= r2) lit.set(col + ":" + row, [cx, cz]);
      }
    }
  }
  return lit;
}

export function radarCell(sources) {
  let maxr = 0;
  for (const s of sources) if (s.r > maxr) maxr = s.r;
  return Math.max(2500, maxr / 10);
}

// ---------------------------------------------------------------- shortest gate route (galaxy)
export function route(links, from, to) {
  if (!from || !to) return null;
  if (from === to) return [from];
  const adj = new Map();
  for (const l of links) {
    if (!adj.has(l.a)) adj.set(l.a, []);
    if (!adj.has(l.b)) adj.set(l.b, []);
    adj.get(l.a).push(l.b); adj.get(l.b).push(l.a);
  }
  const prev = new Map([[from, null]]);
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    if (cur === to) break;
    for (const n of adj.get(cur) || []) if (!prev.has(n)) { prev.set(n, cur); q.push(n); }
  }
  if (!prev.has(to)) return null;
  const path = [];
  for (let c = to; c !== null; c = prev.get(c)) path.unshift(c);
  return path;
}

// ---------------------------------------------------------------- browser-only: textures + tinting
const IMG = new Map();        // name -> HTMLImageElement | "missing"
const TINT = new Map();       // name|r,g,b -> canvas
let INDEX = null;             // Set of exported icon names (null = not loaded / no export)
let onLoad = () => {};

export function setIconIndex(names, cb) {
  INDEX = names ? new Set(names) : null;
  if (cb) onLoad = cb;
}
export function hasIconExport() { return !!(INDEX && INDEX.size); }

function img(name) {
  if (typeof Image === "undefined" || !INDEX || !INDEX.has(name)) return null;
  let i = IMG.get(name);
  if (i === undefined) {
    i = new Image();
    i.onload = () => { TINT.forEach((_, k) => { if (k.startsWith(name + "|")) TINT.delete(k); }); onLoad(name); };
    i.onerror = () => { IMG.set(name, "missing"); };
    i.src = "/icons/" + name + ".png";
    IMG.set(name, i);
  }
  return i === "missing" || !i.complete || !i.naturalWidth ? null : i;
}

// The game's icon textures are white glyphs with a dark outline; the map multiplies them with the
// object's colour. Same here: multiply, then keep the texture's alpha.
export function tinted(name, col) {
  const key = name + "|" + col.r + "," + col.g + "," + col.b;
  let c = TINT.get(key);
  if (c) return c;
  const i = img(name);
  if (!i) return null;
  c = document.createElement("canvas");
  c.width = i.naturalWidth; c.height = i.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(i, 0, 0);
  g.globalCompositeOperation = "multiply";
  g.fillStyle = rgb(col);
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = "destination-in";
  g.drawImage(i, 0, 0);
  TINT.set(key, c);
  if (TINT.size > 1500) TINT.delete(TINT.keys().next().value);
  return c;
}

const URLS = new Map();
export function tintedURL(name, col) {
  const key = name + "|" + col.r + "," + col.g + "," + col.b;
  let u = URLS.get(key);
  if (u) return u;
  const c = tinted(name, col);
  if (!c) return null;
  u = c.toDataURL("image/png");
  URLS.set(key, u);
  return u;
}

// vector fallback in the legend's spirit when the texture is not exported
export function drawFallback(g, name, x, y, size, col) {
  const r = size / 2;
  g.save();
  g.fillStyle = rgb(col); g.strokeStyle = "rgba(0,0,0,0.9)"; g.lineWidth = Math.max(1.5, size / 10);
  g.beginPath();
  if (name.startsWith("ship_")) {
    g.moveTo(x, y - r); g.lineTo(x + r * 0.8, y + r * 0.7); g.lineTo(x, y + r * 0.35); g.lineTo(x - r * 0.8, y + r * 0.7);
  } else if (name.startsWith("mapob_jumpgate") || name.startsWith("mapob_transorbital") || name.startsWith("mapob_superhighway")) {
    g.arc(x, y, r * 0.8, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(x, y, r * 0.45, 0, Math.PI * 2);
  } else if (/^mapob_(factory|shipyard|wharf|equipmentdock|tradestation|defensestation|piratestation|playerhq|energy|food|refined|hightech|pharma|shiptech|agricultural|water|hive|constructionsite|buildstorage)/.test(name) || name.startsWith("maplegend_hq")) {
    for (let k = 0; k < 6; k++) { const a = Math.PI / 3 * k + Math.PI / 6; g.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); }
  } else {
    g.arc(x, y, r * 0.45, 0, Math.PI * 2);
  }
  g.closePath(); g.stroke(); g.fill();
  g.restore();
}

export function drawIcon(g, name, x, y, size, col, rot = 0) {
  const c = tinted(name, col) || (name !== iconFallbackOf(name) ? tinted(iconFallbackOf(name), col) : null);
  if (!c) { drawFallback(g, name, x, y, size, col); return; }
  if (rot) {
    g.save(); g.translate(x, y); g.rotate(rot); g.drawImage(c, -size / 2, -size / 2, size, size); g.restore();
  } else g.drawImage(c, x - size / 2, y - size / 2, size, size);
}

// a mod icon that was not exported -> the base game's generic icon of the same family
export function iconFallbackOf(name) {
  const m = /^ship_(xs|s|m|l|xl)_/.exec(name);
  if (m) return `ship_${m[1]}_neutral_01`;
  if (name.startsWith("ship_")) return "ship_m_neutral_01";
  if (name.startsWith("mapob_")) return "mapob_unknown";
  return name;
}
export { SIZES };
