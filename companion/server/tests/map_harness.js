// Browser integration tests of the real map module (web/map.js) with a fake store/bus.
// Run by tests/test_map_browser.py in headless Chromium; results in window.__results.
import { MapView } from "../web/map.js";
import { galaxyIndex, insideHex } from "../web/mapstyle.js";
import { LIMITS } from "../web/camera.js";
import { createTranslator } from "../web/map-strings.js";

const results = [];
const check = (ok, what) => results.push({ ok: !!ok, what });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = document.getElementById("host");

function makeBus() {
  const h = {};
  return {
    h,
    on(n, fn) { (h[n] ||= []).push(fn); return () => { h[n] = h[n].filter((f) => f !== fn); }; },
    emit(n, d) { for (const fn of (h[n] || []).slice()) fn(d); },
    count() { return Object.values(h).reduce((a, l) => a + l.length, 0); },
  };
}
function makeS() {
  const liveGalaxy = [
    { id: "c1", name: "Alpha", macro: "cl_a", x: 0, z: 0, sectors: [
      { id: "s1", name: "Alpha I", macro: "sa1", owner: "argon", x: -1e6, z: 1e6 },
      { id: "s2", name: "Alpha II", macro: "sa2", owner: "teladi", x: 1e6, z: -1e6 }] },
    { id: "c2", name: "Beta", macro: "cl_b", x: 15e6, z: 8.66e6, sectors: [{ id: "s3", name: "Beta", macro: "sb", owner: "argon", x: 0, z: 0 }] },
  ];
  const gates = [{ id: "g1", s: "s1", ds: "s3", x: 50000, z: 0 }, { id: "g2", s: "s3", ds: "s1", x: -50000, z: 0 }];
  const scans = { s1: { n: 6, hidden: 2, objs: [
    { id: "st1", c: "station", n: "Station One", o: "argon", x: 10000, z: 10000 },
    { id: "sh1", c: "ship_m", n: "Trader", o: "teladi", x: 10000, z: 10000, yaw: 1 },
    { id: "sh2", c: "ship_s", n: "Mine", pl: true, x: 30000, z: -20000, yaw: 0.5 },
    { id: "g1", c: "gate", n: "Gate", x: 50000, z: 0, ds: "s3" },
  ] } };
  const S = { liveGalaxy, gates, scans, hwlinks: [], property: new Map(), theme: null, factions: {}, selected: null, details: {},
              status: { game: "live" }, wsOpen: true,
              player: { sector: { id: "s1", name: "Alpha I" }, object: { id: "p1", x: -40000, z: -30000, yaw: 0, class: "ship_m", name: "Me" },
                        where: { mode: "pilot", name: "Me" } } };
  Object.assign(S, galaxyIndex(liveGalaxy, gates, scans, []));
  return S;
}
function box(w, h) {
  const b = document.createElement("div");
  b.className = "box";
  b.style.width = w + "px"; b.style.height = h + "px";
  host.appendChild(b);
  return b;
}
const frame = (m) => { m.dirty = true; m.frame(performance.now()); };
const same = (a, b) => Math.abs(a.cx - b.cx) < 1e-6 && Math.abs(a.cz - b.cz) < 1e-6 && Math.abs(a.scale - b.scale) < 1e-12;

async function run() {
  try { localStorage.clear(); } catch (e) { /* file:// */ }

  // ---------------- M4: any container, 0x0 -> real size, destroy
  {
    const S = makeS(), bus = makeBus();
    const b = box(0, 0);
    const n0 = bus.count();
    const m = new MapView(b, { S, bus });
    frame(m);
    check(m.w === 0 && m.h === 0, "M4: mounted in a 0x0 plain container without errors (waits)");
    b.style.width = "800px"; b.style.height = "500px";
    await sleep(150);                        // ResizeObserver, no manual call
    frame(m);
    check(m.w === 800 && m.h === 500 && m.canvas.width >= 800 && m.canvas.height >= 500, `M4: 0x0 -> 800x500 picked up by the ResizeObserver (${m.w}x${m.h})`);
    check(b.querySelector(".x4map-body canvas.mapcanvas") && b.querySelector(".x4map-tools .segs"), "M4: plain container gets its own body + tools bar");
    // half-sized (w>0, h=0) must not be treated as drawable (v1.1 drew into a 0-high canvas forever)
    b.style.height = "0px"; await sleep(150); frame(m);
    check(m.h === 0 && m.w === 0, "M4: width without height counts as not laid out");
    b.style.height = "500px"; await sleep(150); frame(m);
    check(m.h === 500, "M4: comes back after a 0-height phase");
    const nOn = bus.count();
    m.destroy();
    await sleep(50);
    check(bus.count() === n0 && nOn > n0, `M4: destroy() removes every bus handler (${nOn - n0} -> ${bus.count() - n0})`);
    check(b.children.length === 0, "M4: destroy() removes all DOM the map added");
    const rafBefore = m.raf; await sleep(80);
    check(m._dead && m.raf === rafBefore, "M4: animation loop stopped");
    b.remove();
  }

  // ---------------- M5: translator
  {
    const S = makeS(), bus = makeBus();
    const b = box(900, 500);
    const m = new MapView(b, { S, bus });
    frame(m);
    check(m.segSector.textContent === "Sector" && m.title === null, "M5: English is the default without a translator");
    m.setTranslator(createTranslator("hu"));
    check(m.segSector.textContent === "Szektor" && m.retLbl.textContent === "Hajókövetés", "M5: setTranslator(hu) re-renders the texts");
    m.setTranslator((k) => (k === "map.seg.galaxy" ? "GALAXY!" : undefined));
    check(m.segGalaxy.textContent === "GALAXY!" && m.segSector.textContent === "Sector", "M5: a partial host translator falls back to English");
    const opts = [...m.selRet.options].map((o) => o.textContent);
    check(opts.includes("Manual – camera stays put") && opts.includes("Back to ship after 5 s"), "M9: self-explanatory ship-follow options");
    m.destroy(); b.remove();
  }

  // ---------------- M1: stations above ships, player above all; hit-testing in the same order
  {
    const S = makeS(), bus = makeBus();
    const b = box(1100, 700);
    const m = new MapView(b, { S, bus });
    m.toManual(); m.manualUntil = Infinity;
    Object.assign(m.view, { cx: 0, cz: 0, scale: 0.005 });
    frame(m);
    const idx = (id) => m.hit.findIndex((h) => h.o.id === id);
    check(idx("st1") > idx("sh1") && idx("st1") > idx("sh2") && idx("g1") > idx("sh2"), `M1: drawing order ship < gate < station (${idx("sh1")},${idx("sh2")},${idx("g1")},${idx("st1")})`);
    const [sx, sy] = m.toScreen(10000, 10000);
    check(m.pick(sx, sy) && m.pick(sx, sy).id === "st1", "M1: a click on a ship under a station hits the station (topmost)");
    S.player.object.x = 10000; S.player.object.z = 10000;
    frame(m);
    check(m.pick(sx, sy) && m.pick(sx, sy).id === "p1", "M1: the player's marker stays on top of everything");
    check(m.hit[m.hit.length - 1].o.id === "p1", "M1: the player is drawn last");
    m.destroy(); b.remove();
  }

  // ---------------- M8: jump gate names at every zoom
  {
    const S = makeS(), bus = makeBus();
    const b = box(1100, 700);
    const m = new MapView(b, { S, bus });
    m.toManual(); m.manualUntil = Infinity;
    m.cfg.labels = "off";
    for (const [nm, sc] of [["min", LIMITS.sector.min], ["max", LIMITS.sector.max]]) {
      Object.assign(m.view, { cx: 50000, cz: 0, scale: sc });
      frame(m);
      const g = (m.lastLabels || []).find((l) => l.gate);
      check(g && g.text === "Beta", `M8: gate label (destination sector) drawn at ${nm} zoom ${sc} ("${g && g.text}")`);
    }
    // collision with the player's label: gate right next to the player
    S.player.object.x = 50000 - 400; S.player.object.z = 0;
    Object.assign(m.view, { cx: 50000, cz: 0, scale: 0.02 });
    frame(m);
    check((m.lastLabels || []).some((l) => l.gate), "M8: gate label kept next to the player's label");
    m.destroy(); b.remove();
  }

  // ---------------- M7: manual camera is never moved by the app
  {
    const S = makeS(), bus = makeBus();
    const b = box(1000, 650);
    const m = new MapView(b, { S, bus });
    m.cfg.ret = 0; m.save();
    frame(m);
    m.toManual();
    Object.assign(m.view, { cx: 1234, cz: -5678, scale: 0.0123 });
    Object.assign(m.gview, { cx: 7e6, cz: 3e6, scale: 3e-6 });
    const v0 = { ...m.view }, g0 = { ...m.gview };
    for (let i = 0; i < 25; i++) {
      S.player.object.x += 900; S.player.object.z -= 300;
      bus.emit("player", S.player); bus.emit("scan", "s1"); bus.emit("galaxy"); frame(m);
    }
    check(same(m.view, v0), "M7: 25 snapshots (player/scan/galaxy) leave centre and zoom unchanged");
    b.style.width = "700px"; b.style.height = "420px"; await sleep(150); frame(m);
    check(same(m.view, v0), "M7: a container resize leaves centre and zoom unchanged");
    const prev = S.player;
    S.prevPlayer = prev;
    S.player = { ...prev, sector: { id: "s3", name: "Beta" } };
    bus.emit("sectorchange", { from: prev.sector, to: S.player.sector }); bus.emit("player", S.player);
    for (let i = 0; i < 5; i++) frame(m);
    check(same(m.view, v0) && m.cam === "manual", "M7: a player sector change leaves the manual camera where it was");
    m.setStaticMap({ clusters: [] }); frame(m);
    m.setMode("galaxy"); frame(m); frame(m);
    check(same(m.gview, g0), "M7: switching to the galaxy view keeps its own manual camera");
    m.setMode("sector"); frame(m); frame(m);
    check(same(m.view, v0), "M7: static map arrival + view switch back leave the sector camera unchanged");
    m.viewSector = "s2"; m.lastInteract = performance.now() - 120000; frame(m);
    check(same(m.view, v0) && m.viewSector === "s2" && m.cam === "manual", "M7: no automatic 60 s return while manual");
    await sleep(400);                          // saveCam is throttled
    const m2 = new MapView(box(1000, 650), { S, bus, settingsKey: "map" });
    check(m2.cam === "manual" && same(m2.view, m.view), "M7: the manual camera is restored by a new instance (reload / pop-out)");
    m2.destroy(); m.destroy(); b.remove();
    try { localStorage.clear(); } catch (e) { /* */ }
  }

  // ---------------- M6: new sector before the galaxy message: name, owner placeholder, minimap at once
  {
    const S = makeS(), bus = makeBus();
    const b = box(1100, 700);
    const m = new MapView(b, { S, bus });
    frame(m);
    const prev = S.player;
    S.prevPlayer = prev;
    S.player = { ...prev, sector: { id: "s9", name: "Newland" }, object: { ...prev.object, x: -55000, z: 0 } };
    S.scans.s9 = { n: 1, hidden: 0, objs: [{ id: "g9", c: "gate", x: -60000, z: 0, ds: "s1" }] };
    bus.emit("sectorchange", { from: prev.sector, to: S.player.sector }); bus.emit("player", S.player);
    frame(m);
    const txt = m.info.innerText;
    check(txt.startsWith("Newland") && !txt.includes("–\n"), `M6: info box shows the new sector in the same frame ("${txt.split("\n")[0]}")`);
    check(m.miniDrawn, "M6: mini galaxy drawn in the same frame");
    const est = m.sectorGeo("s9");
    const s1 = m.geo().sectors.get("s1");
    check(est && est.estimated && !est.unplaced && est.x > s1.x, "M6: position estimated from the gate's known destination (s1 lies west -> we are east)");
    // the galaxy message arrives -> refined
    S.liveGalaxy = S.liveGalaxy.concat([{ id: "c9", name: "New", macro: "cl_n", x: 30e6, z: 0, sectors: [{ id: "s9", name: "Newland", macro: "sn", owner: "teladi", x: 0, z: 0 }] }]);
    Object.assign(S, galaxyIndex(S.liveGalaxy, S.gates, S.scans, []));
    bus.emit("galaxy"); frame(m);
    check(m.info.innerText.includes("teladi") && !m.sectorGeo("s9").estimated, "M6: refined when the galaxy data arrives");
    m.destroy(); b.remove();
  }

  // ---------------- M2: galaxy view hit test inside the small hexagons
  {
    const S = makeS(), bus = makeBus();
    const b = box(1100, 700);
    const m = new MapView(b, { S, bus });
    m.setMode("galaxy"); m.toManual(); m.manualUntil = Infinity;
    Object.assign(m.gview, { cx: 0, cz: 0, scale: 2.5e-5 });
    frame(m);
    const g = m.geo();
    const a = g.sectors.get("s1"), c = g.sectors.get("s2"), cl = g.clusters.get("c1");
    check(a.r < cl.r && c.r < cl.r && insideHex(a.x, a.z, cl.x, cl.z, cl.r) && insideHex(c.x, c.z, cl.x, cl.z, cl.r), "M2: two sectors of a cluster are small hexagons inside it");
    const [ax, ay] = m.toScreen(a.x, a.z), [cx, cy] = m.toScreen(c.x, c.z);
    check(m.pickSector(ax, ay) && m.pickSector(ax, ay).id === "s1" && m.pickSector(cx, cy).id === "s2", "M2: click inside a small sector hexagon picks that sector");
    m.destroy(); b.remove();
  }

  // ---------------- header tools in a narrow panel (React shell PanelFrame structure)
  {
    const S = makeS(), bus = makeBus();
    const sec = document.createElement("section");
    sec.style.cssText = "display:flex;flex-direction:column;height:460px;overflow:hidden;border:1px solid #345;margin:4px";
    sec.innerHTML = `<header style="display:flex;height:40px;flex-shrink:0;align-items:center;gap:8px;padding:0 6px 0 8px">
        <span style="width:16px;height:16px;flex-shrink:0;background:#468"></span><span style="width:16px;height:16px;flex-shrink:0;background:#468"></span>
        <span class="ttl" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600"></span>
        <span class="panel-tools" style="margin-left:auto;display:flex;min-width:0;align-items:center;gap:6px;overflow:hidden"></span>
        <span style="display:flex;flex-shrink:0;align-items:center"><button style="width:28px;height:28px"></button><button style="width:28px;height:28px"></button><button style="width:28px;height:28px"></button><button style="width:28px;height:28px"></button></span>
      </header><div class="bd" style="position:relative;display:flex;flex-direction:column;flex:1;min-height:0"></div>`;
    host.appendChild(sec);
    const title = document.createElement("span"); title.className = "x4map-title";
    const tools = document.createElement("span"); tools.className = "x4map-toolslot";
    const root = document.createElement("div"); root.className = "x4map-root";
    sec.querySelector(".ttl").append(title); sec.querySelector(".panel-tools").append(tools); sec.querySelector(".bd").append(root);
    const m = new MapView(root, { S, bus, titleEl: title, toolsEl: tools });
    const hdr = sec.querySelector("header"), pt = sec.querySelector(".panel-tools");
    for (const lang of ["en", "hu"]) {
      m.setTranslator(lang === "hu" ? createTranslator("hu") : null);
      for (const w of [1100, 512, 360]) {
        sec.style.width = w + "px";
        await sleep(120); m.resize(); frame(m);
        const H = hdr.getBoundingClientRect(), P = pt.getBoundingClientRect();
        const ctl = m.toolControls().map((c) => [c === m.segSector ? "sector" : c === m.segGalaxy ? "galaxy" : c === m.retLbl ? "label" : c === m.selRet ? "select" : "followBtn", c.getBoundingClientRect()]);
        const bad = [];
        for (let i = 0; i < ctl.length; i++) {
          const [n, a] = ctl[i];
          if (a.left < H.left - 0.5 || a.right > H.right + 0.5 || a.left < P.left - 0.5 || a.right > P.right + 0.5) bad.push(n + " clipped/outside");
          for (let j = i + 1; j < ctl.length; j++) {
            const b = ctl[j][1];
            if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) bad.push(n + " x " + ctl[j][0]);
          }
        }
        const g = m.segGalaxy.getBoundingClientRect();
        const hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2);
        const clickable = hit && (hit === m.segGalaxy || m.segGalaxy.contains(hit));
        const hasFollow = !m.selRet.hidden || !m.followBtn.hidden;
        check(!bad.length && clickable && hasFollow && ctl.some((c) => c[0] === "sector") && ctl.some((c) => c[0] === "galaxy"),
              `tools ${lang} ${w}px (${m.toolsMode}): switch + ship follow inside the header, no overlap, Galaxy clickable${bad.length ? " - " + bad.join("; ") : ""}`);
      }
    }
    // the compact follow button opens a menu and sets the mode
    sec.style.width = "360px"; await sleep(120); m.resize();
    if (!m.followBtn.hidden) {
      m.followBtn.click();
      const items = m.followMenu ? [...m.followMenu.querySelectorAll("button")] : [];
      const manual = items.find((b) => b.textContent.includes("Kézi"));
      if (manual) manual.click();
      check(items.length === 5 && m.cfg.ret === 0 && !m.followMenu, "narrow header: ship follow as a button with a menu (sets the mode)");
    } else check(false, "narrow header: expected the compact follow button at 360 px");
    m.segGalaxy.click();
    check(m.mode === "galaxy", "narrow header: the Galaxy switch works");
    m.destroy(); sec.remove();
  }

  // ---------------- UI font scale (the shell sets the root font-size %): popovers + hit-testing
  for (const [pct, bw, bh] of [80, 90, 100, 110, 125, 150].flatMap((p) => [[p, 900, 560], [p, 1600, 900], [p, 1600, 1150], [p, 300, 640]])) {
    document.documentElement.style.fontSize = pct + "%";
    try { localStorage.clear(); } catch (e) { /* isolation: no camera / settings from earlier tests */ }
    const S = makeS(), bus = makeBus();
    const root = document.createElement("div"); root.className = "x4map-root";
    const b = box(bw, bh); b.append(root);
    const m = new MapView(root, { S, bus });
    m.setMode("sector"); m.cfg.legend = true; m.cfg.mini = true;
    m.toManual(); m.manualUntil = Infinity;
    Object.assign(m.view, { cx: 0, cz: 0, scale: 0.005 });
    await sleep(60); m.resize(); frame(m); m.renderLegend();
    m.togglePop("layers");
    await sleep(60); frame(m);
    const C = m.body.getBoundingClientRect(), L = m.layers.getBoundingClientRect();
    const full = m.layers.clientHeight >= m.layers.scrollHeight - 1;
    const scrolls = !full && m.win.getComputedStyle(m.layers).overflowY !== "visible" && m.layers.clientHeight >= 60;
    const inside = L.top >= C.top - 0.5 && L.bottom <= C.bottom + 0.5 && L.left >= C.left - 0.5 && L.right <= C.right + 0.5;
    const R = m.overlayRects(), lay = R.rects.layers, clash = [];
    for (const k of ["legend", "mini", "scale", "zoom", "legendBtn", "miniBtn", "info"]) {
      const o = R.rects[k];
      if (lay && o && lay.l < o.r - 0.5 && lay.r > o.l + 0.5 && lay.t < o.b - 0.5 && lay.b > o.t + 0.5) clash.push(k);
    }
    const mh = m.win.getComputedStyle(m.layers).maxHeight;
    check(lay && inside && (full || scrolls) && !clash.length && /px$/.test(mh) && L.height >= Math.min(m.layers.scrollHeight, 60),
          `scale ${pct}% ${bw}x${bh}: Layers popover inside the map, ${Math.round(L.height)} px for ${m.layers.scrollHeight} px of chips${full ? "" : " (scrolls)"}, max-height ${mh}, no clash${clash.length ? " - " + clash.join(",") : ""}`);
    // click / hover / wheel / sharpness
    m.togglePop("layers"); frame(m);
    const [ox, oy] = m.toScreen(30000, -20000);              // the own ship sh2
    const cr = m.canvas.getBoundingClientRect();
    const opt = { clientX: cr.left + ox, clientY: cr.top + oy, pointerId: 7, bubbles: true, button: 0 };
    const diag = JSON.stringify({ n: (m.hit || []).length, mode: m.mode, sid: m.currentSid(), vs: m.viewSector, w: m.w, h: m.h, cam: m.cam, sh2: (m.hit || []).filter((q) => q.o.id === "sh2").map((q) => [Math.round(q.x), Math.round(q.y)]) });
    m.canvas.dispatchEvent(new PointerEvent("pointerdown", opt)); m.canvas.dispatchEvent(new PointerEvent("pointerup", opt));
    m.canvas.dispatchEvent(new PointerEvent("pointermove", { ...opt, pointerId: 8 }));
    const tip = m.tip.getBoundingClientRect();
    const [wx0, wz0] = m.toWorld(ox, oy);
    m.canvas.dispatchEvent(new WheelEvent("wheel", { clientX: cr.left + ox, clientY: cr.top + oy, deltaY: -200, bubbles: true, cancelable: true }));
    const [wx1, wz1] = m.toWorld(ox, oy);
    const dpr = window.devicePixelRatio || 1;
    check(S.selected && S.selected.id === "sh2" && !m.tip.hidden && Math.abs(tip.left - (cr.left + ox + 14)) < 2 && Math.abs(tip.top - (cr.top + oy + 12)) < 2
          && Math.hypot(wx1 - wx0, wz1 - wz0) < 1 && m.canvas.width === Math.round(m.canvas.clientWidth * dpr),
          `scale ${pct}% ${bw}x${bh}: click selects the object under the pointer, tooltip at the pointer, wheel zooms around it, canvas backing store = CSS size x dpr` + ` [sel ${S.selected && S.selected.id} tip ${Math.round(tip.left - cr.left - ox)},${Math.round(tip.top - cr.top - oy)} hidden ${m.tip.hidden} wheel ${Math.round(Math.hypot(wx1 - wx0, wz1 - wz0))} canvas ${m.canvas.width}/${m.canvas.clientWidth} at ${Math.round(ox)},${Math.round(oy)} hits ${diag}]`);
    m.destroy(); b.remove();
  }
  document.documentElement.style.fontSize = "";

  // ---------------- M10: overlays never overlap / leave the container
  for (const [w, h] of [[1900, 950], [940, 510], [480, 360]]) {
    const S = makeS(), bus = makeBus();
    const b = box(w, h);
    const m = new MapView(b, { S, bus });
    m.setMode("sector"); m.cfg.legend = true; m.cfg.mini = true;
    m.toManual(); m.manualUntil = Infinity;
    frame(m); m.renderLegend();
    const states = [["layers", () => m.togglePop("layers")], ["legend", () => { if (m.ov.size !== "full") m.togglePop("legend"); }],
                    ["mini", () => { if (m.ov.mini === "button") m.togglePop("mini"); }]];
    const bad = [];
    for (const [nm, act] of states) {
      act(); frame(m);
      const R = m.overlayRects(), names = Object.keys(R.rects);
      for (let i = 0; i < names.length; i++) {
        const A = R.rects[names[i]];
        if (A.l < -0.5 || A.t < -0.5 || A.r > R.w + 0.5 || A.b > R.h + 0.5) bad.push(`${nm}: ${names[i]} leaves`);
        for (let j = i + 1; j < names.length; j++) {
          const B = R.rects[names[j]];
          if ((names[i] === "layersBtn" && names[j] === "layers") || (names[i] === "layers" && names[j] === "layersBtn")) continue;
          if (A.l < B.r - 0.5 && A.r > B.l + 0.5 && A.t < B.b - 0.5 && A.b > B.t + 0.5) bad.push(`${nm}: ${names[i]} x ${names[j]}`);
        }
      }
      if (!R.rects.scale) bad.push(`${nm}: scale bar missing`);
    }
    check(!bad.length, `M10: ${w}x${h} (${m.ov.size}): no overlay overlaps another or leaves the map${bad.length ? " - " + bad.join("; ") : ""}`);
    m.destroy(); b.remove();
  }
}

run().then(() => { window.__results = results; }, (e) => { results.push({ ok: false, what: "harness crashed: " + (e && e.stack || e) }); window.__results = results; });
