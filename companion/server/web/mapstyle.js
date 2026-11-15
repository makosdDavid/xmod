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

// Abandoned, claimable ships: a ship class owned by the "ownerless" faction (the bridge sends the
// owner as "o"; live 9.00 data: {"c":"ship_m","o":"ownerless","n":"Baku","ic":"ship_m_transporter_01"}).
// Not: gates / accelerators / highways, lockboxes, wares, satellites, beacons, mines (ownerless by
// nature, not ships), spacesuits, wrecks ("wr") and anything of the player.
const OWNERLESS_SHIP = /^ship_(xs|s|m|l|xl)$/;
export function isOwnerlessShip(o) {
  if (!o || o.pl || o.wr || o.k) return false;
  return o.o === "ownerless" && OWNERLESS_SHIP.test(o.c || o.class || "");
}
// the marker's accent: chartreuse, used by no holomap relation colour (player teal-green, neutral
// light blue, enemy orange, hostile red, mission amber, visitor violet) and bright on blue/purple
export const OWNERLESS_COLOR = { r: 206, g: 255, b: 38 };

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

// ---------------------------------------------------------------- ship heading
// Bridge "yaw" (GetObjectPositionInSector -> UIPosRot.yaw, radians) -> canvas rotation (radians,
// clockwise on screen, 0 = icon points north/+z). Checked against live movement in the real game:
// the bearing atan2(dx, dz) between consecutive positions equals yaw (see tests/test_mapstyle.mjs).
export function headingFromYaw(yaw) {
  return Number.isFinite(yaw) ? yaw : 0;
}

// ---------------------------------------------------------------- galaxy: cluster hexagons
// Clusters sit on a flat-top hex grid whose edge length is 1e7 m (menu_mapeditor.lua:163
// clusterGridEdgeLength; galaxy.xml positions step 15e6 m in x and 8.66e6 m in z). Each cluster is
// one flat-top hexagon of that radius; its sectors are smaller hexagons inside it (the game's
// galaxy map): 1 sector fills it, 2-3 sectors are half-radius hexagons whose outer vertex is a
// cluster vertex (centre R/2 from the cluster centre, three of them meet in the middle), 4-7 sectors
// a third-radius "flower" (centre + 6 around). Which slot a sector gets follows its real offset
// inside the cluster (relative to the centroid of the cluster's sectors), never its name.
export const CLUSTER_R = 1e7;

const HALF_SLOTS = [0, 1, 2, 3, 4, 5].map((k) => {
  const a = Math.PI / 3 * k;
  return { x: 0.5 * Math.cos(a), z: 0.5 * Math.sin(a), r: 0.5 };
});
const FLOWER_SLOTS = [{ x: 0, z: 0, r: 1 / 3 }].concat([0, 1, 2, 3, 4, 5].map((k) => {
  const a = Math.PI / 6 + Math.PI / 3 * k;
  return { x: Math.cos(a) / Math.sqrt(3), z: Math.sin(a) / Math.sqrt(3), r: 1 / 3 };
}));

// flat-top hex lattice slots of radius r that fit into the unit hex (for > 7 sectors)
function latticeSlots(r) {
  const out = [];
  const dx = 1.5 * r, dz = Math.sqrt(3) * r;
  const n = Math.ceil(1 / r) + 2;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const x = i * dx, z = j * dz + (i & 1 ? dz / 2 : 0);
    if (hexPoints(x, z, r).every(([px, pz]) => insideHex(px, pz, 0, 0, 1 + 1e-9))) out.push({ x, z, r });
  }
  return out;
}

// is (x, z) inside the flat-top hexagon of radius r centred at (cx, cz)
export function insideHex(x, z, cx, cz, r) {
  const ax = Math.abs(x - cx), az = Math.abs(z - cz);
  const h = r * Math.sqrt(3) / 2;
  return az <= h && Math.sqrt(3) * ax + az <= Math.sqrt(3) * r;
}

// flat-top hexagon corners [[x, z], ...] (vertex 0 points east, counter-clockwise in world space)
export function hexPoints(cx, cz, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i; pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]); }
  return pts;
}

function sepOk(slots) {            // half-radius slots must be >= 120 degrees apart (else they overlap)
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
    const d = Math.abs(slots[i] - slots[j]) % 6;
    if (Math.min(d, 6 - d) < 2) return false;
  }
  return true;
}

// sectors: [{ key, x, z }] = sector offsets inside the cluster (metres, any order).
// Returns { layout: "full"|"half"|"flower"|"lattice", slots: { [key]: { slot, x, z, r } } } with x, z, r
// in units of the cluster radius (multiply by the drawn cluster radius). Deterministic.
export function clusterLayout(sectors) {
  const list = (sectors || []).filter((s) => s && s.key !== undefined && s.key !== null)
    .map((s) => ({ key: String(s.key), x: +s.x || 0, z: +s.z || 0 }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const n = list.length;
  const out = {};
  if (!n) return { layout: "full", slots: out };
  if (n === 1) { out[list[0].key] = { slot: -1, x: 0, z: 0, r: 1 }; return { layout: "full", slots: out }; }
  let layout, cand;
  if (n <= 3) { layout = "half"; cand = HALF_SLOTS; }
  else if (n <= 7) { layout = "flower"; cand = FLOWER_SLOTS; }
  else {
    layout = "lattice";
    let r = 1 / 5;
    cand = latticeSlots(r);
    while (cand.length < n) { r *= 0.85; cand = latticeSlots(r); }
  }
  // positions relative to the centroid, scaled so the farthest sector sits on the slot ring
  const mx = list.reduce((a, s) => a + s.x, 0) / n, mz = list.reduce((a, s) => a + s.z, 0) / n;
  const ring = layout === "half" ? 0.5 : Math.max(...cand.map((c) => Math.hypot(c.x, c.z)));
  let m = 0;
  for (const s of list) m = Math.max(m, Math.hypot(s.x - mx, s.z - mz));
  const p = list.map((s) => (m < 1 ? { x: 0, z: 0 } : { x: (s.x - mx) / m * ring, z: (s.z - mz) / m * ring }));
  const cost = (i, k) => (p[i].x - cand[k].x) ** 2 + (p[i].z - cand[k].z) ** 2;
  let best = null, bestCost = Infinity;
  if (n <= 7) {
    const used = new Array(cand.length).fill(false), pick = [];
    const rec = (i, acc) => {
      if (acc >= bestCost - 1e-12) return;
      if (i === n) {
        if (layout === "half" && !sepOk(pick)) return;
        bestCost = acc; best = pick.slice(); return;
      }
      for (let k = 0; k < cand.length; k++) {
        if (used[k]) continue;
        used[k] = true; pick.push(k);
        rec(i + 1, acc + cost(i, k));
        pick.pop(); used[k] = false;
      }
    };
    rec(0, 0);
  } else {          // many sectors (only possible with mods): greedy, farthest first
    best = new Array(n);
    const used = new Set();
    const order = list.map((_, i) => i).sort((a, b) => Math.hypot(p[b].x, p[b].z) - Math.hypot(p[a].x, p[a].z) || a - b);
    for (const i of order) {
      let bk = -1, bc = Infinity;
      for (let k = 0; k < cand.length; k++) if (!used.has(k) && cost(i, k) < bc - 1e-12) { bc = cost(i, k); bk = k; }
      used.add(bk); best[i] = bk;
    }
  }
  list.forEach((s, i) => { const c = cand[best[i]]; out[s.key] = { slot: best[i], x: c.x, z: c.z, r: c.r }; });
  return { layout, slots: out };
}

// The layout source per cluster: the static export (all sectors, independent of discovery) when it
// has the cluster, else the known sectors of the live data. Returns Map(sectorId -> {x, z, r, cid})
// in world metres (x, z = sector hexagon centre in galaxy space, r = its drawn radius), plus
// Map(clusterId -> {x, z, r, n}) for the cluster outlines. drawR = drawn cluster radius.
export function galaxyGeometry(liveGalaxy, staticByMacro = null, drawR = CLUSTER_R * 0.97) {
  const sectors = new Map(), clusters = new Map();
  for (const c of liveGalaxy || []) {
    const cx = +c.x || 0, cz = +c.z || 0;
    const known = c.sectors || [];
    const st = staticByMacro && c.macro ? staticByMacro.get(String(c.macro).toLowerCase()) : null;
    let lay = null;
    if (st && known.every((s) => s.macro && st.some((q) => q.macro === String(s.macro).toLowerCase()))) {
      lay = clusterLayout(st.map((q) => ({ key: q.macro, x: q.x, z: q.z })));
    }
    const byMacro = !!lay;
    if (!lay) lay = clusterLayout(known.map((s) => ({ key: String(s.id), x: s.x, z: s.z })));
    clusters.set(String(c.id), { id: String(c.id), x: cx, z: cz, r: drawR, layout: lay.layout, name: c.name, macro: c.macro });
    for (const s of known) {
      const k = byMacro ? String(s.macro).toLowerCase() : String(s.id);
      const q = lay.slots[k] || { x: 0, z: 0, r: 1, slot: -1 };
      sectors.set(String(s.id), { x: cx + q.x * drawR, z: cz + q.z * drawR, r: q.r * drawR, cid: String(c.id), slot: q.slot });
    }
  }
  return { sectors, clusters };
}

// static_map.json (or its {clusters:[{macro, sectors:[{macro,x,z}]}]} subset) -> Map(clusterMacro -> [{macro,x,z}])
export function staticClusterIndex(json) {
  const m = new Map();
  for (const c of (json && json.clusters) || []) {
    if (!c || !c.macro) continue;
    m.set(String(c.macro).toLowerCase(), (c.sectors || []).filter((s) => s && s.macro)
      .map((s) => ({ macro: String(s.macro).toLowerCase(), x: +s.x || 0, z: +s.z || 0 })));
  }
  return m;
}

// Galaxy indexes for a host shell (same result as app.js rebuildGalaxy + rebuildLinks; gx/gz are the
// sector hexagon centres of galaxyGeometry). Only discovered data goes in: the live galaxy message.
export function galaxyIndex(liveGalaxy, gates = [], scans = {}, hwlinks = [], staticByMacro = null) {
  const geo = galaxyGeometry(liveGalaxy, staticByMacro);
  const sectors = new Map(), clusters = new Map(), sectorByMacro = new Map();
  for (const c of liveGalaxy || []) {
    const secs = c.sectors || [];
    clusters.set(String(c.id), { id: String(c.id), name: c.name, macro: c.macro, gx: c.x || 0, gz: c.z || 0, n: secs.length });
    for (const s of secs) {
      const g = geo.sectors.get(String(s.id));
      const rec = { id: String(s.id), name: s.name, macro: (s.macro || "").toLowerCase(), owner: s.owner, res: s.res,
                    cid: String(c.id), cname: c.name, multi: secs.length > 1, gx: g.x, gz: g.z, gr: g.r,
                    rx: (c.x || 0) + (s.x || 0), rz: (c.z || 0) + (s.z || 0) };
      sectors.set(rec.id, rec);
      if (rec.macro) sectorByMacro.set(rec.macro, rec.id);
    }
  }
  const seen = new Set(), links = [], stubs = [], gatesBySector = new Map();
  const add = (a, b, kind) => {
    if (!a || !b || a === b || !sectors.has(a) || !sectors.has(b)) return;
    const key = [a, b].sort().join("|") + kind;
    if (seen.has(key)) return;
    seen.add(key); links.push({ a, b, kind });
  };
  for (const g of gates || []) {
    if (g.ds) add(String(g.s), String(g.ds), g.hw ? "hw" : "gate");
    else if (g.du && !g.hw) stubs.push({ s: String(g.s), x: g.x || 0, z: g.z || 0 });
    if (!gatesBySector.has(String(g.s))) gatesBySector.set(String(g.s), []);
    gatesBySector.get(String(g.s)).push(g);
  }
  for (const [sid, sc] of Object.entries(scans || {})) for (const o of (sc && sc.objs) || []) {
    if ((o.c === "gate" || o.c === "highwayentrygate") && o.ds) add(String(sid), String(o.ds), o.c === "gate" ? "gate" : "hw");
  }
  for (const [a, b] of hwlinks || []) add(String(a), String(b), "hw");
  return { sectors, clusters, sectorByMacro, links, stubs, gatesBySector };
}

// where the galaxy view puts things inside a sector hexagon of screen radius r (y down, relative to its
// centre): own ship/station counter (icon box), the player's icon, the name's text box (top centre)
export function sectorMarkerSpots(r) {
  const inr = r * Math.sqrt(3) / 2;
  const isz = Math.max(9, Math.min(18, r / 3));
  const psz = Math.max(10, Math.min(20, r * 0.5));
  const fs = Math.max(9, Math.min(14, r / 5));
  return {
    count: { x: -isz * 0.6, y: inr * 0.55, size: isz, textX: isz * 0.1, textY: inr * 0.55 + 4 },
    player: { x: 0, y: 0, size: psz },
    label: { y: -inr + fs + 4, fs, maxW: r * 1.45 },
  };
}

// ---------------------------------------------------------------- v1.2 bridge extras in the sector scan
// The server forwards only message types it knows, so the bridge appends two pseudo object classes to
// the player's sector scan: x4c_sectorinfo (MD: sector.coresize / coreposition / iscontested) and
// x4c_resarea (discovered resource areas: {w, cell, pts:[x_km, z_km, amount, ...]}). A host takes them
// out of the object list with this before storing the scan; S.sectorInfo / S.resources keep the last
// ones per sector (a scan without them leaves them as they are). Old bridges send neither.
export function takeSectorExtras(S, scan) {
  if (!scan) return scan;
  const objs = scan.objs || scan.items || [];
  if (!objs.some((o) => o && typeof o.c === "string" && o.c.startsWith("x4c_"))) return scan;
  const real = [], res = [], hws = [];
  let si = null;
  for (const o of objs) {
    if (o && o.c === "x4c_highway") hws.push(o);
    else if (o && o.c === "x4c_resarea") res.push(o);
    else if (o && o.c === "x4c_sectorinfo") si = o;
    else if (!(o && typeof o.c === "string" && o.c.startsWith("x4c_"))) real.push(o);
  }
  const sid = String(scan.sid);
  S.sectorInfo = S.sectorInfo || {};
  S.resources = S.resources || {};
  S.highways = S.highways || {};
  if (hws.length) S.highways[sid] = hws.map((h) => h.pts || []);
  if (si) S.sectorInfo[sid] = { core: +si.core || null, cx: +si.cx || 0, cz: +si.cz || 0, contested: !!si.contested };
  if (res.length) {
    const byWare = {};
    for (const r of res) if (r.w) (byWare[r.w] = byWare[r.w] || []).push(...(r.pts || []));
    S.resources[sid] = { cell: +res[0].cell || 10000, gen: res[0].gen, areas: Object.entries(byWare).map(([w, pts]) => ({ w, pts })) };
  }
  const out = { ...scan, objs: real };
  if (scan.items) out.items = real;
  return out;
}

// the game map's resource colours with the mining filter on "all" (parameters.xml <resources>
// mineralmapcolor / gasmapcolor / scrapmapcolor -> colors.xml orange_dark / cyan_dark / grey_192)
export const RESOURCE_CATEGORY = {
  ore: "mineral", silicon: "mineral", ice: "mineral", nividium: "mineral",
  hydrogen: "gas", helium: "gas", methane: "gas", rawscrap: "scrap", rawkhaakscrap: "scrap",
};
export const RESOURCE_COLOR = { mineral: { r: 179, g: 97, b: 0 }, gas: { r: 0, g: 175, b: 179 }, scrap: { r: 192, g: 192, b: 192 } };
export const resourceCategory = (w) => RESOURCE_CATEGORY[w] || "mineral";

// ---------------------------------------------------------------- sector border (sector view)
// The game frames a sector with a flat-top hexagon around its explored area. The 9.00 UI Lua exposes
// no sector extent (the holomap draws it natively; MD has sector.coresize/coreposition, which the
// bridge does not send), so this is an APPROXIMATION: the hexagon centred on the sector origin whose
// apothem circumscribes every known object and own radar circle with a margin, never below a minimum.
export const SECTOR_HEX_MIN = 60000;           // m, apothem
export const SECTOR_HEX_MARGIN = 1.06;
export function sectorHexApothem(points = [], circles = [], min = SECTOR_HEX_MIN, margin = SECTOR_HEX_MARGIN) {
  // a point (x, z) is inside the flat-top hexagon of apothem a iff its "hex norm" <= a
  const hexNorm = (x, z) => Math.max(Math.abs(z), (Math.sqrt(3) * Math.abs(x) + Math.abs(z)) / 2);
  let a = 0;
  for (const p of points) if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) a = Math.max(a, hexNorm(p.x, p.z));
  for (const c of circles) if (c && Number.isFinite(c.x) && Number.isFinite(c.z) && c.r > 0) a = Math.max(a, hexNorm(c.x, c.z) + c.r);
  return Math.max(min, a * margin);
}
// apothem -> vertex radius of a flat-top hexagon
export const hexRadiusOfApothem = (a) => a * 2 / Math.sqrt(3);

// polygons (convex, any orientation) overlap with a positive area? (separating axis test)
export function polygonsOverlap(a, b, eps = 1e-6) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
      const nx = z2 - z1, nz = x1 - x2;
      const len = Math.hypot(nx, nz) || 1;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const [x, z] of a) { const d = (x * nx + z * nz) / len; amin = Math.min(amin, d); amax = Math.max(amax, d); }
      for (const [x, z] of b) { const d = (x * nx + z * nz) / len; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
      const scale = Math.max(1, Math.abs(amin), Math.abs(amax), Math.abs(bmin), Math.abs(bmax));
      if (amax <= bmin + eps * scale || bmax <= amin + eps * scale) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- responsive map overlays (M10)
// Map container size (CSS px) -> how the map's own overlays are shown. "full" keeps the v1.1 look;
// smaller containers get a one-line info pill, a smaller (or on-demand) mini galaxy, the legend and
// the back-to-ship action as buttons, smaller zoom buttons. map.js places them so they never overlap.
export function overlayModes(w, h) {
  const size = w >= 1000 && h >= 600 ? "full" : (w >= 640 && h >= 400 ? "medium" : "small");
  const full = size === "full";
  return {
    size,
    info: full ? "full" : "pill",
    mini: full ? "full" : size === "medium" ? "small" : "button",
    miniW: full ? 210 : 150, miniH: full ? 150 : 100,
    legend: full ? "panel" : "button",
    back: full ? "full" : "icon",
    zoomBtn: size === "small" ? 30 : 38,
  };
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
