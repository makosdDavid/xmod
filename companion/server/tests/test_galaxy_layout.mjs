// Galaxy view geometry (node tests/test_galaxy_layout.mjs): every cluster is one flat-top hexagon,
// its sectors are non-overlapping hexagons inside it, slots follow the real offsets; checked on the
// real static map export (data/static_map.json, when present) and on synthetic clusters.
// Also: overlay modes per container size (M10). Exit code 1 on failure.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { clusterLayout, galaxyGeometry, staticClusterIndex, hexPoints, insideHex, polygonsOverlap, sectorMarkerSpots,
         overlayModes, CLUSTER_R, galaxyIndex } from "../web/mapstyle.js";

let pass = 0, fail = 0;
function check(ok, what) { if (ok) pass++; else fail++; console.log((ok ? "PASS " : "FAIL ") + what); }

const DRAW = CLUSTER_R * 0.97;
const EPS = 1e-6;
function verify(clusters, label) {
  // clusters: [{ id, x, z, sectors: [{ key, x, z }] }] -> sector polygons via clusterLayout
  const polys = [], cpolys = [];
  let inside = true, apart = true, badList = [];
  for (const c of clusters) {
    const lay = clusterLayout(c.sectors);
    const cp = hexPoints(c.x, c.z, DRAW);
    cpolys.push({ id: c.id, p: cp });
    const mine = [];
    for (const s of c.sectors) {
      const q = lay.slots[String(s.key)];
      const p = hexPoints(c.x + q.x * DRAW, c.z + q.z * DRAW, q.r * DRAW);
      if (!p.every(([x, z]) => insideHex(x, z, c.x, c.z, DRAW * (1 + EPS)))) { inside = false; badList.push(`${c.id}/${s.key} outside`); }
      for (const o of mine) if (polygonsOverlap(o.p, p)) { apart = false; badList.push(`${c.id}: ${o.key} x ${s.key}`); }
      mine.push({ key: s.key, p });
      polys.push({ key: c.id + "/" + s.key, p });
    }
  }
  let clApart = true;
  for (let i = 0; i < cpolys.length; i++) for (let j = i + 1; j < cpolys.length; j++) {
    const a = cpolys[i], b = cpolys[j];
    if (Math.hypot(a.p[0][0] - b.p[0][0], a.p[0][1] - b.p[0][1]) > 4 * CLUSTER_R) continue;
    if (polygonsOverlap(a.p, b.p)) { clApart = false; badList.push(`clusters ${a.id} x ${b.id}`); }
  }
  check(inside, `${label}: every sector hexagon lies inside its cluster hexagon`);
  check(apart, `${label}: no two sector hexagons of a cluster overlap`);
  check(clApart, `${label}: no two cluster hexagons overlap (so no sectors of different clusters either)`);
  if (badList.length) console.log("   " + badList.slice(0, 12).join("\n   "));
}

// ---------------------------------------------------------------- real export
const here = dirname(fileURLToPath(import.meta.url));
const staticPath = join(here, "..", "data", "static_map.json");
if (existsSync(staticPath)) {
  const st = JSON.parse(readFileSync(staticPath, "utf-8"));
  const clusters = st.clusters.map((c) => ({ id: c.macro, x: c.x, z: c.z, sectors: c.sectors.map((s) => ({ key: s.macro, x: s.x, z: s.z })) }));
  const ns = clusters.reduce((a, c) => a + c.sectors.length, 0);
  console.log(`static map: ${clusters.length} clusters, ${ns} sectors, sources: ${(st.sources || []).join(", ")}`);
  verify(clusters, "real static map");
  const maxN = Math.max(...clusters.map((c) => c.sectors.length));
  check(maxN <= 7, `real map: at most 7 sectors per cluster (max ${maxN}; the vanilla editor allows 3)`);
  // Land of Promise (mod inix_land_of_promise), as in the game's map: I top-left, II bottom-left, III right
  const lop = st.clusters.find((c) => c.macro === "inix_cl_c002_macro");
  if (lop) {
    const lay = clusterLayout(lop.sectors.map((s) => ({ key: s.name, x: s.x, z: s.z })));
    const ang = (k) => Math.round(Math.atan2(lay.slots[k].z, lay.slots[k].x) * 180 / Math.PI);
    check(lay.layout === "half" && ang("Land of Promise I") === 120 && ang("Land of Promise II") === -120 && ang("Land of Promise III") === 0,
          `Land of Promise: I top-left (120°), II bottom-left (240°), III right (0°) -> ${ang("Land of Promise I")}/${ang("Land of Promise II")}/${ang("Land of Promise III")}`);
    check(Math.abs(lay.slots["Land of Promise III"].x - 0.5) < 1e-9 && lay.slots["Land of Promise III"].r === 0.5,
          "half-radius sector: centre at R/2, its outer vertex = the cluster's vertex");
  } else console.log("SKIP Land of Promise not in this export");
  // discovery: only one sector of a 3-sector cluster known -> it keeps its slot (small hexagon), the rest is absent
  const ge = st.clusters.find((c) => c.macro === "cluster_01_macro");
  if (ge) {
    const idx = staticClusterIndex(st);
    const known = [{ id: "c1", name: ge.name, macro: ge.macro, x: ge.x, z: ge.z, sectors: [{ id: "s1", macro: ge.sectors[1].macro, x: ge.sectors[1].x, z: ge.sectors[1].z }] }];
    const g1 = galaxyGeometry(known, idx);
    const all = galaxyGeometry([{ ...known[0], sectors: ge.sectors.map((s, i) => ({ id: "s" + i, macro: s.macro, x: s.x, z: s.z })) }], idx);
    check(g1.sectors.size === 1 && g1.clusters.size === 1, "discovery: only the known sector is placed; the cluster outline is there");
    check(Math.abs(g1.sectors.get("s1").x - all.sectors.get("s1").x) < 1 && Math.abs(g1.sectors.get("s1").r - all.sectors.get("s1").r) < 1,
          "discovery: with the static map a sector keeps the same slot however many of its siblings are known");
    const g0 = galaxyGeometry(known, null);
    check(g0.sectors.get("s1").r === DRAW, "without the static map a lone known sector fills its cluster (live-data fallback)");
  }
} else {
  console.log("SKIP real static map: data/static_map.json not exported");
}

// ---------------------------------------------------------------- synthetic
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const synth = [];
for (let n = 1; n <= 12; n++) for (let k = 0; k < 6; k++) {
  const secs = [];
  for (let i = 0; i < n; i++) secs.push({ key: `s${i}`, x: (rnd() - 0.5) * 2e8, z: (rnd() - 0.5) * 2e8 });
  synth.push({ id: `n${n}k${k}`, x: (synth.length % 10) * 15e6 * 2, z: Math.floor(synth.length / 10) * 17.32e6 * 2, sectors: secs });
}
synth.push({ id: "zero", x: -9e8, z: 0, sectors: [{ key: "a", x: 0, z: 0 }, { key: "b", x: 0, z: 0 }, { key: "c", x: 0, z: 0 }] });
synth.push({ id: "line", x: -9e8, z: 9e7, sectors: [{ key: "a", x: -1e6, z: 0 }, { key: "b", x: 0, z: 0 }, { key: "c", x: 1e6, z: 0 }] });
verify(synth, "synthetic 1..12 sectors");
const two = clusterLayout([{ key: "I", x: 0, z: 0 }, { key: "III", x: 80377000, z: 27158380 }]);   // Hatikvah's Choice
check(two.slots.I.x < 0 && two.slots.III.x > 0, "two sectors: placed on opposite sides along their offset (Hatikvah's Choice I left, III right)");
const a1 = JSON.stringify(clusterLayout([{ key: "b", x: 1, z: 2 }, { key: "a", x: -5, z: 9 }, { key: "c", x: 3, z: -4 }]));
const a2 = JSON.stringify(clusterLayout([{ key: "c", x: 3, z: -4 }, { key: "a", x: -5, z: 9 }, { key: "b", x: 1, z: 2 }]));
check(a1 === a2, "layout is deterministic (input order does not matter)");

// markers drawn in the galaxy view stay inside their own sector hexagon at every size
let inOk = true;
for (const r of [8, 13, 18.5, 19, 20, 23, 40, 80, 160, 400]) {
  const s = sectorMarkerSpots(r);
  const box = [[s.count.x - s.count.size / 2, s.count.y - s.count.size / 2], [s.count.x + s.count.size / 2, s.count.y + s.count.size / 2],
               [s.count.x - s.count.size / 2, s.count.y + s.count.size / 2], [s.count.x + s.count.size / 2, s.count.y - s.count.size / 2]];
  const drawn = r > 18;       // map.js draws the counter only above this radius
  if (drawn && !box.every(([x, y]) => insideHex(x, y, 0, 0, r))) { inOk = false; console.log("   counter outside at r=" + r); }
  if (r > 20 && !(s.label.y - s.label.fs > -r * Math.sqrt(3) / 2 && s.label.maxW <= r * 1.5)) { inOk = false; console.log("   label outside at r=" + r); }
}
check(inOk, "galaxy markers (own-ship counter, name) stay inside the sector hexagon");
// galaxyIndex: gx/gz of a sector = its hexagon centre (inside its cluster)
const gi = galaxyIndex([{ id: "1", name: "C", macro: "m", x: 0, z: 0, sectors: [{ id: "10", name: "A", x: -1e6, z: 1e6 }, { id: "11", name: "B", x: 1e6, z: -1e6 }] }],
                       [{ s: "10", ds: "11", x: 1, z: 1 }], {}, []);
check(gi.sectors.get("10").gx < 0 && gi.sectors.get("11").gx > 0 && gi.links.length === 1 && gi.sectors.get("10").multi,
      "galaxyIndex builds sectors (hexagon centres), clusters and links like app.js");

// ---------------------------------------------------------------- overlay modes (M10)
const big = overlayModes(1900, 950), mid = overlayModes(940, 510), small = overlayModes(480, 360);
check(big.size === "full" && big.info === "full" && big.mini === "full" && big.legend === "panel" && big.back === "full",
      "1900x950: full overlays (unchanged look)");
check(mid.size === "medium" && mid.info === "pill" && mid.mini === "small" && mid.legend === "button" && mid.back === "icon",
      "940x510: info pill, small mini galaxy, legend and back as buttons");
check(small.size === "small" && small.mini === "button" && small.zoomBtn < big.zoomBtn, "480x360: mini galaxy on demand, smaller zoom buttons");
check(overlayModes(1000, 600).size === "full" && overlayModes(999, 600).size === "medium" && overlayModes(1200, 599).size === "medium" &&
      overlayModes(640, 400).size === "medium" && overlayModes(639, 900).size === "small", "mode thresholds: full >= 1000x600, medium >= 640x400");

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
