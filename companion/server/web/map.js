// X4 Companion — canvas map, modelled on the game's own map (M):
//   sector view: the game's icons (exported from the user's catalogs, see export_icons.py) tinted with
//   the game map's colours (GetHoloMapColors via the bridge), constant icon size at every zoom, hull
//   bar above the icon, names only when zoomed in / selected / hovered, own radar coverage lit on a
//   dark "not seen" background with a hex-stepped edge, plotted course, target line and the order
//   lines of a selected own ship. Ship icons point where the ship is heading. Stations are drawn above
//   ships, the player's marker above everything; hit-testing follows the drawing order.
//   galaxy view: one hexagon per cluster with the owner-coloured "system edge", the sectors inside it
//   as smaller hexagons (mapstyle.clusterLayout), gate / superhighway connections, the plotted route,
//   where your ships and stations are.
// Camera modes: follow (your ship, default) | focus (a selected object) | fit (whole sector / galaxy)
// | manual (after dragging; returns to follow after the configured idle time).
// World coordinates: X4 metres, x = east, z = north (drawn up), height ignored.
// Public API: web/MAP-API.md (stable, additions only).
"use strict";
import { loadSettings, saveSettings, factionColor } from "./util.js";
import { clampScale, wheelFactor, applyBias, zoomAt, fitScale, pinchFactor } from "./camera.js";
import { iconEl } from "./icons.js";
import { objColor, holo, rgb, iconFor, iconSize, isShip, drawIcon, hexCellsInRange, radarCell, route,
         headingFromYaw, galaxyGeometry, staticClusterIndex, insideHex, overlayModes, sectorMarkerSpots, CLUSTER_R } from "./mapstyle.js";
import { withFallback } from "./map-strings.js";

const HEX = CLUSTER_R;           // cluster grid edge length (vanilla menu_mapeditor.lua:163)
const DRAW_R = HEX * 0.97;       // drawn cluster radius (a thin gap between neighbouring clusters)
const GRID_STEPS = [500, 1000, 2000, 5000, 10000, 20000, 25000, 50000, 100000, 200000, 500000, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7];
const FONT = '"Segoe UI", "Inter", system-ui, sans-serif';
// the v1.1 defaults, unchanged (stored settings are not migrated)
const DEFAULTS = { labels: "auto", npc: true, grid: true, mini: true, radar: true, lines: true, hull: true,
                   factioncol: false, rotate: false, iconscale: 1, mode: "sector", ret: 8, legend: false };

export function migrateMapSettings(raw) {
  const cfg = Object.assign({}, DEFAULTS, raw || {});
  if (typeof cfg.labels === "boolean") cfg.labels = cfg.labels ? "auto" : "off";
  return cfg;
}

// draw layer of a sector-view object (bottom -> top); the player's marker is drawn after all of them
export function drawLayer(o) {
  const c = (o && (o.c || o.class)) || "";
  if (c === "station") return 4;
  if (c === "gate" || c === "highwayentrygate") return 3;
  if (isShip(o)) return o.pl ? 2 : 1;
  return 0;
}

export class MapView {
  constructor(root, ctx = {}) {
    this.root = root;
    this.c = ctx;
    this.S = ctx.S;
    this.doc = root.ownerDocument || document;
    this.win = this.doc.defaultView || window;
    this.t = withFallback(ctx.t);
    this.settingsKey = ctx.settingsKey || "map";
    this.cfg = migrateMapSettings(loadSettings(this.settingsKey, {}));
    saveSettings(this.settingsKey, this.cfg);
    this.view = { cx: 0, cz: 0, scale: 0.002 };
    this.gview = { cx: 0, cz: 0, scale: 2e-6 };
    this.viewSector = null;           // null = the player's sector
    this.cam = "follow";              // follow | focus | fit | manual
    this.manualUntil = 0;
    this.zoomBias = 1;
    this.lastInteract = 0;
    this.focusObj = null;
    this.hover = null;
    this.pulses = new Map();
    this.dirty = true;
    this.radarCache = { key: "", cells: null, cell: 0 };
    this.staticIdx = null;
    this.geoCache = { src: undefined, st: undefined, geo: null };
    this._unsub = [];
    this._added = [];
    this._dead = false;
    this.w = 0; this.h = 0;
    this.build();
    this.restoreCam();
    this.bind();
    this.raf =this.win.requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- small helpers
  mk(tag, attrs = {}, ...kids) {
    const e = this.doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false || kid === "") continue;
      e.appendChild(typeof kid === "string" || typeof kid === "number" ? this.doc.createTextNode(String(kid)) : kid);
    }
    return e;
  }
  on(name, fn) {
    const guarded = (d) => { if (!this._dead) fn(d); };
    const r = this.c.bus.on(name, guarded);
    if (typeof r === "function") this._unsub.push(r);
    else if (typeof this.c.bus.off === "function") this._unsub.push(() => this.c.bus.off(name, guarded));
  }
  emit(name, d) { if (this.c.bus && this.c.bus.emit) this.c.bus.emit(name, d); }
  sectorName(id) {
    if (this.c.sectorName) return this.c.sectorName(id);
    if (!id) return this.t("map.none");
    const s = this.S.sectors && this.S.sectors.get(String(id));
    if (s) return s.name;
    const p = this.S.player;
    if (p && p.sector && String(p.sector.id) === String(id) && p.sector.name) return p.sector.name;
    return this.t("map.unknown");
  }
  factionName(id) {
    if (this.c.factionName) return this.c.factionName(id);
    if (!id) return this.t("map.none");
    const f = this.S.factions && this.S.factions[id];
    return f ? f.n : id;
  }
  whereText(w) {
    if (this.c.whereText) return this.c.whereText(w);
    if (!w) return "";
    const name = w.name || "?";
    const docked = w.docked ? this.t("map.where.docked", { name: w.docked }) : "";
    const k = { pilot: 1, passenger: 1, station: 1, aboard: 1, spacesuit: 1 }[w.mode] ? "map.where." + w.mode : null;
    return k ? this.t(k, { name, docked }) : name;
  }
  heading(yaw) { return (this.c.headingOf || headingFromYaw)(yaw); }
  select(sel) {
    if (this.c.select) this.c.select(sel);
    else { this.S.selected = sel; this.emit("select", sel); }
  }
  watch(sid) { if (this.c.watchSector) this.c.watchSector(sid); }
  className(c) { const k = "map.class." + c; const s = this.t(k); return s === k ? "" : s; }
  fmtNum(v) { return (v === null || v === undefined || Number.isNaN(+v)) ? this.t("map.none") : new Intl.NumberFormat(this.t("map.locale"), { maximumFractionDigits: 0 }).format(+v); }
  fmtDist(m) {
    if (m === null || m === undefined) return this.t("map.none");
    const loc = this.t("map.locale");
    return m >= 10000 ? new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }).format(m / 1000) + " km" : new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(m) + " m";
  }
  fmtKm(m) {
    const a = Math.abs(m);
    if (a >= 1000) return (m / 1000).toLocaleString(this.t("map.locale"), { maximumFractionDigits: a >= 10000 ? 0 : 1 }) + " km";
    return Math.round(m) + " m";
  }

  // ---------------------------------------------------------------- DOM
  build() {
    const r = this.root;
    const T = this.t;
    // legacy dock module (.ptitle/.ptools/.pbody) or any container
    let body = r.querySelector(":scope > .pbody") || r.querySelector(".pbody");
    this.ownsBody = !body;
    if (!body) {
      body = this.mk("div", { class: "x4map-body" });
      Object.assign(body.style, { position: "relative", flex: "1 1 auto", width: "100%", height: "100%", minHeight: "0", overflow: "hidden" });
      r.appendChild(body); this._added.push(body);
    }
    this.body = body;
    this.title = this.c.titleEl || r.querySelector(".ptitle");
    let tools = this.c.toolsEl || r.querySelector(".ptools");
    // header tools: Sector/Galaxy switch + ship follow; layoutTools() fits them to the header width
    const segBtn = (cls, icon, fn) => {
      const b = this.mk("button", { class: cls, onclick: fn });
      b._ic = iconEl(icon, 14); b._ic.style.display = "none"; b._ic.style.verticalAlign = "-2px";
      b._lbl = this.mk("span", {});
      b.append(b._ic, b._lbl);
      Object.assign(b.style, { flex: "0 0 auto", whiteSpace: "nowrap" });
      return b;
    };
    this.segSector = segBtn("seg on", "map", () => this.setMode("sector"));
    this.segGalaxy = segBtn("seg", "galaxy", () => this.setMode("galaxy"));
    this.selRet = this.mk("select", { class: "small", onchange: () => { this.cfg.ret = +this.selRet.value; this.save(); this.layoutTools(); } },
      ...[5, 8, 15, 30, 0].map((v) => this.mk("option", { value: v, selected: (this.cfg.ret ?? 8) === v })));
    this.segs = this.mk("span", { class: "segs" }, this.segSector, this.segGalaxy);
    this.retLbl = this.mk("span", { class: "muted small retlbl" });
    this.followBtn = this.mk("button", { class: "followbtn", hidden: true, onclick: (e) => { e.stopPropagation(); this.toggleFollowMenu(); } });
    this.followBtn.appendChild(iconEl("auto", 15));
    Object.assign(this.segs.style, { flex: "0 0 auto", display: "inline-flex" });
    Object.assign(this.retLbl.style, { flex: "0 0 auto", whiteSpace: "nowrap" });
    Object.assign(this.selRet.style, { flex: "0 0 auto", minWidth: "0", textOverflow: "ellipsis" });
    Object.assign(this.followBtn.style, { flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 6px" });
    this.toolsMode = "full";
    this.ownTools = !tools;
    if (!tools) {
      tools = this.mk("div", { class: "x4map-tools" });
      Object.assign(tools.style, { position: "absolute", left: "50%", top: "10px", transform: "translateX(-50%)", zIndex: "4", display: "flex", gap: "6px", alignItems: "center", whiteSpace: "nowrap" });
      body.appendChild(tools);
      this.toolsBar = tools;
    }
    tools.prepend(this.segs, this.retLbl, this.selRet, this.followBtn);
    this._added.push(this.segs, this.retLbl, this.selRet, this.followBtn);
    this.toolsEl = tools;

    this.canvas = this.mk("canvas", { class: "mapcanvas", tabindex: "-1" });
    Object.assign(this.canvas.style, { position: "absolute", left: "0", top: "0", display: "block", touchAction: "none" });
    this.info = this.mk("div", { class: "mapinfo" });
    const zbtn = (icon, fn) => { const b = this.mk("button", { class: "zbtn", onclick: fn }); b.appendChild(iconEl(icon, 18)); return b; };
    this.zIn = zbtn("plus", () => this.zoom(1.5));
    this.zOut = zbtn("minus", () => this.zoom(1 / 1.5));
    this.zFit = zbtn("fit", () => this.fit());
    this.backIcon = zbtn("ship", () => this.auto());          // compact containers: back-to-ship as a round button
    this.backIcon.hidden = true;
    this.zoomBox = this.mk("div", { class: "zoombox" }, this.backIcon, this.zIn, this.zOut, this.zFit);
    // compact containers: legend / mini galaxy on demand
    this.legendBtn = this.mk("button", { class: "zbtn mapmini-btn", hidden: true, onclick: () => this.togglePop("legend") });
    this.legendBtn.appendChild(iconEl("info", 16));
    this.miniBtn = this.mk("button", { class: "zbtn mapmini-btn", hidden: true, onclick: () => this.togglePop("mini") });
    this.miniBtn.appendChild(iconEl("galaxy", 16));
    for (const b of [this.legendBtn, this.miniBtn]) Object.assign(b.style, { position: "absolute", zIndex: "4" });
    this.legendOpen = false; this.miniOpen = false;
    this.chips = {};
    const chip = (key) => {
      const b = this.mk("button", { class: "chip" + (this.cfg[key] ? " on" : ""), onclick: () => {
        this.cfg[key] = !this.cfg[key]; b.classList.toggle("on", !!this.cfg[key]); this.save(); this.dirty = true;
        if (key === "legend" || key === "mini") { this.legendOpen = this.legendOpen && !!this.cfg.legend; this.renderLegend(); }
      } });
      this.chips[key] = b;
      return b;
    };
    this.lblBtn = this.mk("button", { class: "chip", onclick: () => {
      this.cfg.labels = { auto: "all", all: "off", off: "auto" }[this.cfg.labels] || "auto";
      this.lblBtn.textContent = T("map.labels." + this.cfg.labels); this.save(); this.dirty = true;
    } });
    this.layersBtn = this.mk("button", { class: "chip layers-btn", onclick: () => this.togglePop("layers") });
    this.layers = this.mk("div", { class: "layers", hidden: true },
      chip("radar"), chip("lines"), chip("npc"), chip("hull"), chip("factioncol"), chip("rotate"), chip("grid"), chip("mini"),
      this.lblBtn, chip("legend"));
    this.legendBox = this.mk("div", { class: "maplegend2", hidden: true });
    this.followBadge = this.mk("div", { class: "followbadge" });
    this.backBtn = this.mk("button", { class: "backbtn", onclick: () => this.auto() });
    this.backLbl = this.mk("span", {});
    this.backBtn.append(iconEl("ship", 18), this.backLbl);
    this.tip = this.mk("div", { class: "maptip", hidden: true });
    this.bodyHadClass = body.classList.contains("mapbody");
    body.classList.add("mapbody");
    if (!body.style.position && this.win.getComputedStyle && this.win.getComputedStyle(body).position === "static") body.style.position = "relative";
    this.layerBox = this.mk("div", { class: "layerbox" }, this.layersBtn, this.layers);
    const kids = [this.canvas, this.info, this.layerBox, this.legendBox, this.zoomBox, this.legendBtn, this.miniBtn, this.followBadge, this.backBtn, this.tip];
    body.prepend(...kids);
    this._added.push(...kids);
    this.ctx2d = this.canvas.getContext("2d");
    this.applyTexts();
    this.setMode(this.cfg.mode || "sector");
  }

  save() { saveSettings(this.settingsKey, this.cfg); }

  // every user-facing text of the chrome (re-run by setTranslator)
  applyTexts() {
    const T = this.t;
    const set = (e, text, tip) => { if (text !== undefined) e.textContent = text; if (tip !== undefined) { e.title = tip; e.setAttribute("aria-label", tip); } };
    this.segSector._lbl.textContent = T("map.seg.sector"); set(this.segSector, undefined, T("map.seg.sector.tip"));
    this.segGalaxy._lbl.textContent = T("map.seg.galaxy"); set(this.segGalaxy, undefined, T("map.seg.galaxy.tip"));
    set(this.followBtn, undefined, T("map.ret.tip"));
    this.selRet.title = T("map.ret.tip");
    this.selRet.setAttribute("aria-label", T("map.ret"));
    this.retLbl.textContent = T("map.ret");
    this.retLbl.title = T("map.ret.tip");
    set(this.backIcon, undefined, T("map.back.tip"));
    set(this.legendBtn, undefined, T("map.chip.legend"));
    set(this.miniBtn, undefined, T("map.chip.mini"));
    for (const o of this.selRet.options) o.textContent = +o.value ? T("map.ret.sec", { n: o.value }) : T("map.ret.manual");
    this.canvas.setAttribute("aria-label", T("map.aria"));
    set(this.zIn, undefined, T("map.zoom.in")); set(this.zOut, undefined, T("map.zoom.out")); set(this.zFit, undefined, T("map.zoom.fit"));
    for (const [k, b] of Object.entries(this.chips)) set(b, T("map.chip." + k), T("map.chip." + k + ".tip"));
    set(this.lblBtn, T("map.labels." + (this.cfg.labels || "auto")), T("map.labels.tip"));
    set(this.layersBtn, T("map.layers"), T("map.layers.tip"));
    this.backBtn.title = T("map.back.tip");
    this.backLbl.textContent = T("map.back");
    this._fbText = null; this._infoKey = null; this._title = null;
    this.renderLegend();
    this.layoutTools();
    this.dirty = true;
  }

  // ---------------------------------------------------------------- header tools fit the header width
  // Modes, largest first: full (label + switch + select) -> nolabel (select shrinks, ellipsis) -> icon
  // (follow select becomes a button with a menu) -> compact (switch shows icons). The first mode in
  // which no control is clipped by the header / tools slot and none overlaps another wins.
  toolsClip() {
    const t = this.toolsEl;
    if (!t || !t.isConnected) return null;
    let clip = null;
    const cut = (r) => { clip = clip ? { l: Math.max(clip.l, r.left), t: Math.max(clip.t, r.top), r: Math.min(clip.r, r.right), b: Math.min(clip.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    let e = t, depth = 0;
    while (e && depth < 4) {
      const st = this.win.getComputedStyle(e);
      if (e === t.parentElement || e === this.root || st.overflowX !== "visible" || (t === this.toolsBar && e === this.body)) cut(e.getBoundingClientRect());
      if (this.toolsBar ? e === this.body : (e.tagName === "HEADER" || e.classList.contains("phead"))) { cut(e.getBoundingClientRect()); break; }
      e = e.parentElement; depth++;
    }
    return clip && clip.r - clip.l > 0 ? clip : null;
  }
  toolControls() {
    return [this.segSector, this.segGalaxy, this.retLbl, this.selRet, this.followBtn].filter((c) => !c.hidden && c.getClientRects().length);
  }
  toolsFit(clip) {
    const rs = this.toolControls().map((c) => c.getBoundingClientRect());
    for (let i = 0; i < rs.length; i++) {
      const a = rs[i];
      if (a.width < 1 || a.left < clip.l - 0.5 || a.right > clip.r + 0.5) return false;
      for (let j = i + 1; j < rs.length; j++) {
        const b = rs[j];
        if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) return false;
      }
    }
    return true;
  }
  applyToolsMode(m) {
    this.toolsMode = m;
    this.retLbl.hidden = m !== "full";
    this.selRet.hidden = m === "icon" || m === "compact";
    this.followBtn.hidden = !this.selRet.hidden;
    this.selRet.style.maxWidth = "";
    for (const b of [this.segSector, this.segGalaxy]) {
      b._ic.style.display = m === "compact" ? "inline-block" : "none";
      b._lbl.style.display = m === "compact" ? "none" : "";
    }
    if (this.selRet.hidden) this.closeFollowMenu();
  }
  // the header row that holds the tools (React shell <header>, legacy .phead): the width left for the
  // title + tools after everything else in it (grip, icon, window buttons, gaps, padding)
  toolsHeader() {
    const t = this.toolsEl;
    if (!t || this.toolsBar) return null;
    let hdr = t.parentElement, depth = 0;
    while (hdr && depth < 4 && !(hdr.tagName === "HEADER" || hdr.classList.contains("phead"))) { hdr = hdr.parentElement; depth++; }
    if (!hdr || depth >= 4) return null;
    const branch = (e) => { while (e && e.parentElement !== hdr) e = e.parentElement; return e; };
    const toolsB = branch(t), titleB = this.title ? branch(this.title) : null;
    return {
      titleB,
      room: () => {
        const st = this.win.getComputedStyle(hdr);
        const kids = [...hdr.children].filter((k) => k.getClientRects().length);
        const gap = parseFloat(st.columnGap) || 0;
        let used = (parseFloat(st.paddingLeft) || 0) + (parseFloat(st.paddingRight) || 0) + gap * Math.max(0, kids.length - 1);
        for (const k of kids) if (k !== toolsB && k !== titleB) used += k.getBoundingClientRect().width;
        return hdr.clientWidth - used;
      },
    };
  }
  layoutTools() {
    if (this._dead || !this.toolsEl) return;
    const clip0 = this.toolsClip();
    if (!clip0) return;                          // parked / not laid out: keep the last mode
    const hdr = this.toolsHeader();
    const titleEl = hdr && hdr.titleB ? this.title : null;
    const MIN_TITLE = 64;
    for (const m of ["full", "nolabel", "icon", "compact"]) {
      this.applyToolsMode(m);
      if (hdr) {
        // the tools never get squeezed by the flex row: the title gives way (ellipsis) first
        let need = this.toolsEl.scrollWidth;
        let titleMax = hdr.room() - need - 2;
        if (m === "nolabel" && titleMax < MIN_TITLE) {      // the select shrinks (ellipsis) before it turns into a button
          const sw = this.selRet.getBoundingClientRect().width, want = Math.floor(sw - (MIN_TITLE - titleMax));
          if (want >= 96) { this.selRet.style.maxWidth = want + "px"; need = this.toolsEl.scrollWidth; titleMax = hdr.room() - need - 2; }
        }
        if (m !== "compact" && titleMax < MIN_TITLE) continue;
        if (titleEl) { titleEl.style.maxWidth = Math.max(0, Math.floor(titleMax)) + "px"; titleEl.style.overflow = "hidden"; titleEl.style.textOverflow = "ellipsis"; }
      }
      const clip = this.toolsClip();
      if (clip && this.toolsFit(clip)) return;
    }
  }
  toggleFollowMenu() {
    if (this.followMenu) { this.closeFollowMenu(); return; }
    const r = this.followBtn.getBoundingClientRect();
    const menu = this.mk("div", { class: "x4map-followmenu", role: "menu" });
    Object.assign(menu.style, { position: "fixed", zIndex: "1000", top: Math.round(r.bottom + 4) + "px", minWidth: "12rem",
      background: "rgba(6,12,24,0.97)", border: "1px solid rgba(120,170,230,0.35)", borderRadius: "6px", padding: "4px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", gap: "2px" });
    menu.append(this.mk("div", { style: { padding: "2px 8px", fontSize: "0.75rem", opacity: "0.7" } }, this.t("map.ret")));
    for (const o of this.selRet.options) {
      const on = o.value === this.selRet.value;
      menu.append(this.mk("button", { role: "menuitemradio", "aria-checked": on ? "true" : "false",
        style: { textAlign: "left", whiteSpace: "nowrap", padding: "4px 8px", fontWeight: on ? "600" : "" },
        onclick: () => { this.selRet.value = o.value; this.selRet.dispatchEvent(new Event("change")); this.closeFollowMenu(); } },
        (on ? "✓ " : "   ") + o.textContent));
    }
    this.doc.body.appendChild(menu);
    const vw = this.win.innerWidth;
    menu.style.left = Math.round(Math.max(4, Math.min(r.right - menu.offsetWidth, vw - menu.offsetWidth - 4))) + "px";
    this.followMenu = menu;
    this._menuAway = (e) => { if (!menu.contains(e.target) && e.target !== this.followBtn && !this.followBtn.contains(e.target)) this.closeFollowMenu(); };
    this.doc.addEventListener("pointerdown", this._menuAway, true);
  }
  closeFollowMenu() {
    if (!this.followMenu) return;
    this.followMenu.remove(); this.followMenu = null;
    this.doc.removeEventListener("pointerdown", this._menuAway, true);
  }

  setTranslator(t) { this.t = withFallback(t); this.applyTexts(); }

  setStaticMap(json) {
    this.staticIdx = json ? staticClusterIndex(json) : null;
    this.dirty = true;
  }

  setTitle(text) {
    if (text === this._title) return;
    this._title = text;
    if (this.title) this.title.textContent = text;
    if (this.c.onTitle) this.c.onTitle(text);
  }

  // ---------------------------------------------------------------- responsive overlays (M10)
  // layers list, legend and (compact) mini galaxy are popovers; in compact containers only one is open
  togglePop(which) {
    const compact = this.ov && this.ov.size !== "full";
    if (which === "layers") {
      this.layers.hidden = !this.layers.hidden;
      if (!this.layers.hidden && compact) this.legendOpen = false;
    } else if (which === "legend") {
      this.legendOpen = !this.legendOpen;
      if (this.legendOpen && compact) this.layers.hidden = true;
    } else if (which === "mini") {
      this.miniOpen = !this.miniOpen;
      if (this.miniOpen && compact) { this.legendOpen = false; }
    }
    this.layersBtn.classList.toggle("on", !this.layers.hidden);
    this.renderLegend();
    this.dirty = true;
  }

  // places every overlay for the current container size; nothing overlaps, nothing leaves the container
  layoutOverlays() {
    const W = this.w, H = this.h;
    if (!W || !H) return;
    const ov = overlayModes(W, H);
    const prevSize = this.ov && this.ov.size;
    this.ov = ov;
    if (prevSize && prevSize !== ov.size) { this.legendOpen = false; this.miniOpen = false; }
    const px = (n) => Math.round(n) + "px";
    const st = (e, o) => Object.assign(e.style, o);
    const M = 10, zb = ov.zoomBtn;
    const rel = (e) => { const r = e.getBoundingClientRect(), b = this.body.getBoundingClientRect(); return { l: r.left - b.left, t: r.top - b.top, r: r.right - b.left, b: r.bottom - b.top }; };
    // tools bar of a plain container (top centre)
    let top0 = M;
    if (this.toolsBar) { top0 = M + this.toolsBar.offsetHeight + 6; }
    // info: full box or one-line pill (top left)
    const pill = ov.info === "pill";
    this.info.classList.toggle("pill", pill);
    st(this.info, { top: px(top0), left: px(M), maxWidth: px(pill ? Math.min(W * 0.42, 340) : Math.min(280, W * 0.42)),
                    whiteSpace: pill ? "nowrap" : "", overflow: pill ? "hidden" : "", textOverflow: pill ? "ellipsis" : "",
                    padding: pill ? "3px 10px" : "", borderRadius: pill ? "999px" : "" });
    if (pill !== this._pill) { this._pill = pill; this._infoKey = null; }
    // layers button (top right)
    st(this.layerBox, { top: px(top0), right: px(M) });
    const lb = rel(this.layersBtn), ib = rel(this.info);
    // follow banner: centred in the top row if it fits, else its own row below, always truncated
    const infoR = M + (pill ? Math.min(W * 0.42, 340) : Math.min(280, W * 0.42)) + 26;   // its widest possible extent (+padding)
    const avail = W - 2 * Math.max(infoR, ib.r, W - lb.l) - 16;
    let row2 = 0;
    if (avail >= 120 && !this.toolsBar) {
      st(this.followBadge, { top: px(top0), left: "50%", transform: "translateX(-50%)", maxWidth: px(Math.min(avail, W * 0.46)) });
    } else {
      const t = Math.max(ib.b, lb.b) + 6;
      st(this.followBadge, { top: px(t), left: px(M), transform: "none", maxWidth: px(W - M - (zb + 24)) });
      row2 = t + (this.followBadge.offsetHeight || 24);
    }
    // bottom-left: mini galaxy (canvas) or its button
    this.miniBtn.hidden = !(ov.mini === "button" && this.cfg.mini && this.mode === "sector");
    st(this.miniBtn, { left: px(M), bottom: px(M), width: px(zb), height: px(zb) });
    const miniShown = this.cfg.mini && this.mode === "sector" && (ov.mini !== "button" || this.miniOpen);
    const miniY = H - ov.miniH - (ov.mini === "button" ? zb + M + 6 : 12);
    this.miniRect = miniShown ? { l: 12, t: miniY, r: 12 + ov.miniW, b: miniY + ov.miniH } : null;
    // legend: panel (full) or button + popover (compact), right of centre, above the scale bar
    const legendOn = !!this.cfg.legend;
    this.legendBtn.hidden = !(legendOn && ov.legend === "button");
    st(this.legendBtn, { right: px(12), bottom: px(40), width: px(zb), height: px(zb) });
    const showLegend = legendOn && (ov.legend === "panel" || this.legendOpen);
    this.legendBox.hidden = !showLegend;
    // zoom column (right edge), vertically centred between the top row and the bottom row
    const nz = this.backIcon.hidden ? 3 : 4;
    for (const b of [this.zIn, this.zOut, this.zFit, this.backIcon]) st(b, { width: px(zb), height: px(zb) });
    const colH = nz * zb + (nz - 1) * 6;
    const zTop = lb.b + 8, zBot = H - 40 - (this.legendBtn.hidden ? 0 : zb + 8);
    const zt = Math.max(zTop, Math.min(zBot - colH, (zTop + zBot) / 2 - colH / 2));
    st(this.zoomBox, { top: px(zt), right: px(12), transform: "none" });
    const zCol = { l: W - 12 - zb, t: zt, r: W - 12, b: zt + colH };
    // scale bar keeps the bottom-right corner (drawn on the canvas: x up to W-64, y H-30..H-10)
    const scaleTop = H - 34;
    // legend popover / panel
    if (showLegend) {
      if (ov.legend === "panel") st(this.legendBox, { right: px(60), bottom: px(44), maxHeight: px(Math.max(60, H - 44 - (lb.b + 8))), maxWidth: px(W - 70 - M), overflow: "auto" });
      else {
        const lim = Math.max(row2, lb.b) + 8;
        st(this.legendBox, { right: px(zb + 24), bottom: px(40), maxHeight: px(Math.max(60, H - 40 - lim)), maxWidth: px(W - zb - 24 - M), overflow: "auto" });
      }
    }
    // layers popover: under its button if it ends above the zoom column, else left of the column
    const popTop = Math.max(lb.b + 6, row2 ? row2 + 6 : 0);
    // Always an explicit px max-height: a host stylesheet's percentage max-height (the React shell has
    // `.layers { max-height: calc(100% - 3.5rem) }`) would resolve against the layer box, which is only
    // as tall as the Layers button because the list is absolutely positioned -> a ~10 px sliver.
    st(this.layers, { position: "absolute", right: "0px", top: px(popTop - top0), maxHeight: "none", overflowY: "auto", width: "max-content", whiteSpace: "nowrap", maxWidth: px(W - zb - 34 - M) });
    if (!this.layers.hidden) {
      const nat = this.layers.scrollHeight;
      const lgR = showLegend ? rel(this.legendBox) : null;
      if (popTop + nat <= zCol.t - 8 && !row2) {
        st(this.layers, { right: "0px", maxHeight: px(zCol.t - 8 - popTop) });
      } else {
        let limit = scaleTop;
        if (lgR) limit = Math.min(limit, lgR.t);
        if (this.backBtn && !this.backBtn.hidden) limit = Math.min(limit, rel(this.backBtn).t);
        const mr = this.miniRect;
        const popL = W - (zb + 24) - (this.layers.offsetWidth || 180);
        if (mr && popL < mr.r) limit = Math.min(limit, mr.t);
        st(this.layers, { right: px(zb + 24 - M), maxHeight: px(Math.max(60, limit - 8 - popTop)), overflowY: "auto" });
      }
    }
    // a compact legend popover hides an overlapping mini galaxy while it is open
    if (showLegend && ov.legend === "button" && this.miniRect) {
      const L = rel(this.legendBox), m = this.miniRect;
      if (L.l < m.r && L.r > m.l && L.t < m.b && L.b > m.t) this.miniRect = null;
    }
    this.dirty = true;
  }

  // named rectangles of every visible overlay, in container px (used by tests / host layouts)
  overlayRects() {
    const b = this.body.getBoundingClientRect();
    const out = {};
    const add = (name, e) => {
      if (!e || e.hidden || !e.isConnected) return;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return;
      out[name] = { l: r.left - b.left, t: r.top - b.top, r: r.right - b.left, b: r.bottom - b.top };
    };
    add("info", this.info); add("layersBtn", this.layersBtn);
    if (!this.layers.hidden) add("layers", this.layers);
    add("legend", this.legendBox); add("legendBtn", this.legendBtn); add("miniBtn", this.miniBtn);
    add("zoom", this.zoomBox); add("follow", this.followBadge); add("back", this.backBtn); add("tools", this.toolsBar);
    if (this.mode === "sector" && this.miniRect && this.miniDrawn) out.mini = { ...this.miniRect };
    if (this.mode === "sector" && this.scaleRect) out.scale = { ...this.scaleRect };
    return { w: this.w, h: this.h, rects: out };
  }

  renderLegend() {
    if (this.cfg.legend) this.buildLegend();
    if (this.w) this.layoutOverlays(); else this.legendBox.hidden = !this.cfg.legend;
  }

  buildLegend() {
    const th = this.S.theme;
    const T = this.t;
    const rows = [
      ["ship_s_fight_01", "playercolor", "own"], ["ship_s_fight_01", "friendcolor", "neutral"],
      ["ship_s_fight_01", "enemycolor", "enemy"], ["ship_s_fight_01", "hostilecolor", "hostile"],
      ["ship_s_fight_01", "missioncolor", "mission"], ["mapob_jumpgate", "gatecolor", "gate"],
      ["mapob_superhighway", "highwaygatecolor", "highwaygate"], ["mapob_shipyard", "friendcolor", "shipyard"],
      ["mapob_tradestation", "friendcolor", "tradestation"], ["mapob_satellite_01", "playercolor", "satellite"],
    ];
    const box = this.mk("div", { class: "lgrid" });
    for (const [ic, ck, label] of rows) {
      const cv = this.mk("canvas", { width: 22, height: 22 });
      drawIcon(cv.getContext("2d"), ic, 11, 11, 20, holo(th, ck));
      box.append(this.mk("span", { class: "lgi" }, cv, this.mk("span", {}, T("map.legend." + label))));
    }
    box.append(this.mk("span", { class: "lgi" }, this.mk("span", { class: "swatch radar" }), this.mk("span", {}, T("map.legend.radar"))));
    this.legendBox.replaceChildren(this.mk("div", { class: "lgtitle" }, T("map.legend.title") + (th && !th.sim ? T("map.legend.gameColors") : T("map.legend.approx"))), box);
  }

  bind() {
    const cv = this.canvas;
    const pointers = new Map();
    let drag = null, pinch = null;
    cv.addEventListener("pointerdown", (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        drag = null;
      } else {
        drag = { x: e.clientX, y: e.clientY, moved: false };
        cv.classList.add("dragging");
      }
    });
    cv.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) { this.onHover(e); return; }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const f = pinchFactor(pinch.d, d);
        if (Math.abs(f - 1) > 0.01) {
          const rect = cv.getBoundingClientRect();
          this.zoom(f, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
          pinch.d = d;
        }
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) <= 4) return;
      drag.moved = true;
      drag.x = e.clientX; drag.y = e.clientY;
      this.toManual();
      const v = this.v();
      v.cx -= dx / v.scale; v.cz += dy / v.scale;
      this.dirty = true;
    });
    const end = (e) => {
      if (drag && !drag.moved && !pinch && e.type === "pointerup") this.click(e);
      if (drag && drag.moved) this.saveCam();
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) { drag = null; cv.classList.remove("dragging"); }
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("pointerleave", () => { if (this.hover) { this.hover = null; this.tip.hidden = true; this.dirty = true; } });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      // mouse wheel and touchpad pinch (ctrl+wheel) both zoom, both directions
      const r = cv.getBoundingClientRect();      // client coordinates: independent of offsetX quirks / host scaling
      this.zoom(wheelFactor(e.deltaY, e.deltaMode), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    cv.addEventListener("dblclick", (e) => {
      if (this.mode === "galaxy") {
        const r = cv.getBoundingClientRect();
        const s = this.pickSector(e.clientX - r.left, e.clientY - r.top);
        if (s) this.showSector(s.id);
      } else this.auto();
    });
    const RO = this.win.ResizeObserver || (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
    if (RO) {
      this.ro = new RO(() => this.resize()); this.ro.observe(this.body);
      // overlays / tools change size with the host's font scale (root font-size %) even when the map
      // container does not: re-place them on the next frame (coalesced)
      this.ro2 = new RO(() => {
        if (this._relayout) return;
        this._relayout = this.win.requestAnimationFrame(() => { this._relayout = 0; if (this._dead) return; this.layoutTools(); if (this.w) this.layoutOverlays(); });
      });
      for (const e of [this.layersBtn, this.info, this.followBadge, this.segs, this.legendBox]) this.ro2.observe(e);
    }
    this._onLayout = () => this.win.setTimeout(() => { if (!this._dead) this.resize(); }, 0);
    this.win.addEventListener("x4c-layout", this._onLayout);
    this.win.addEventListener("resize", this._onLayout);
    for (const ev of ["player", "scan", "galaxy", "property", "factions", "status", "details", "icons"]) this.on(ev, () => { this.dirty = true; });
    this.on("theme", () => { this.dirty = true; this.renderLegend(); });
    this.on("icons", () => this.renderLegend());
    this.on("hotkey", (m) => {
      if (m.action === "view_toggle") this.toggleMode();
      else if (m.action === "zoom_in") this.zoom(1.6);
      else if (m.action === "zoom_out") this.zoom(1 / 1.6);
      else if (m.action === "zoom_fit") this.fit();
    });
    this.on("auto", () => this.auto());
    this.on("select", (sel) => this.onSelect(sel));
    this.on("sectorchange", () => {
      // manual camera (M7): centre and zoom stay exactly where the user left them
      if (this.cam === "manual") { this._infoKey = null; this.dirty = true; return; }
      // the player jumped: go to the new sector and the ship
      this.viewSector = null; this.watch(null); this.cam = "follow"; this.zoomBias = 1;
      this.focusObj = null; this.fitPending = true; this._infoKey = null;
      if (this.mode === "galaxy") this.dirty = true;   // the galaxy view stays, it follows the new sector
      else this.setMode("sector");
    });
    this.on("alert", (items) => {
      const until = performance.now() + 20000;
      for (const e of items || []) if (e.ic) this.pulses.set(String(e.ic), until);
    });
    this.on("resize", () => this.resize());
  }

  destroy() {
    if (this._dead) return;
    this._dead = true;
    if (this.raf) this.win.cancelAnimationFrame(this.raf);
    if (this._camTimer) this.win.clearTimeout(this._camTimer);
    this.closeFollowMenu();
    if (this.title && this.title.style) this.title.style.maxWidth = "";
    if (this.ro) this.ro.disconnect();
    if (this.ro2) this.ro2.disconnect();
    if (this._relayout) this.win.cancelAnimationFrame(this._relayout);
    this.win.removeEventListener("x4c-layout", this._onLayout);
    this.win.removeEventListener("resize", this._onLayout);
    for (const u of this._unsub) { try { u(); } catch (e) { /* ignore */ } }
    this._unsub = [];
    for (const e of this._added) if (e && e.parentNode) e.parentNode.removeChild(e);
    this._added = [];
    if (this.body && !this.ownsBody && !this.bodyHadClass) this.body.classList.remove("mapbody");
  }

  v() { return this.mode === "galaxy" ? this.gview : this.view; }

  // ---------------------------------------------------------------- camera control
  toManual() {
    if (this.cam !== "manual") this.prevCam = this.cam;
    this.cam = "manual";
    const ret = this.cfg.ret ?? 8;
    this.manualUntil = ret > 0 ? performance.now() + ret * 1000 : Infinity;
    this.lastInteract = performance.now();
    this.saveCam();
  }
  following() { return this.cam === "follow" && !this.viewSector; }
  // a manual camera survives a reload and opens the same in a pop-out window (localStorage x4c.<key>.cam)
  saveCam() {
    if (this._camTimer) return;
    this._camTimer = this.win.setTimeout(() => {
      this._camTimer = null;
      if (this._dead) return;
      try {
        this.win.localStorage.setItem("x4c." + this.settingsKey + ".cam", JSON.stringify({
          cam: this.cam, view: this.view, gview: this.gview, viewSector: this.viewSector, at: Date.now() }));
      } catch (e) { /* private mode */ }
    }, 250);
  }
  restoreCam() {
    let c = null;
    try { c = JSON.parse(this.win.localStorage.getItem("x4c." + this.settingsKey + ".cam") || "null"); } catch (e) { c = null; }
    if (!c || c.cam !== "manual" || (this.cfg.ret ?? 8) !== 0) return false;
    const ok = (v) => v && [v.cx, v.cz, v.scale].every(Number.isFinite) && v.scale > 0;
    if (ok(c.view)) this.view = { cx: c.view.cx, cz: c.view.cz, scale: clampScale(c.view.scale, "sector") };
    if (ok(c.gview)) this.gview = { cx: c.gview.cx, cz: c.gview.cz, scale: clampScale(c.gview.scale, "galaxy") };
    this.cam = "manual"; this.prevCam = "follow"; this.manualUntil = Infinity;
    if (c.viewSector) { this.viewSector = String(c.viewSector); this.watch(this.viewSector); }
    return true;
  }
  auto() {
    this.cam = "follow"; this.manualUntil = 0; this.zoomBias = 1; this.focusObj = null;
    this.viewSector = null; this.watch(null);
    if (this.mode !== "sector") this.setMode("sector");
    this.dirty = true;
    this.saveCam();
  }
  fit() { this.cam = "fit"; this.zoomBias = 1; this.manualUntil = 0; this.lastInteract = performance.now(); this.dirty = true; this.saveCam(); }
  // f > 1 zooms in. Around (sx, sy) in manual mode; auto modes keep their target and change the bias.
  zoom(f, sx, sy) {
    if (!Number.isFinite(f) || f <= 0) return;
    const v = this.v();
    if (this.cam === "manual") {
      const z = zoomAt(v, f, sx ?? this.w / 2, sy ?? this.h / 2, this.w, this.h, this.mode);
      Object.assign(v, z);
      this.toManual();
    } else {
      const base = this.lastBase || v.scale;
      const r = applyBias(base, this.zoomBias * f, this.mode);
      this.zoomBias = r.bias;
      v.scale = clampScale(v.scale * f, this.mode);     // immediate feedback, the camera then settles
    }
    this.lastInteract = performance.now();
    this.dirty = true;
    this.saveCam();
  }
  setMode(m) {
    m = m === "galaxy" ? "galaxy" : "sector";
    this.mode = m;
    this.cfg.mode = m; this.save();
    this.segSector.classList.toggle("on", m === "sector");
    this.segGalaxy.classList.toggle("on", m === "galaxy");
    this.zoomBias = 1;
    this.fitPending = true;
    this.dirty = true;
    this._infoKey = null;
    if (this.w) this.layoutOverlays();
    this.emit("mapmode", m);
  }
  toggleMode() { this.setMode(this.mode === "galaxy" ? "sector" : "galaxy"); }

  showSector(sid) {
    sid = sid === null || sid === undefined ? null : String(sid);
    const ps = this.S.player && this.S.player.sector ? String(this.S.player.sector.id) : null;
    this.viewSector = !sid || sid === ps ? null : sid;
    this.watch(this.viewSector);
    this.setMode("sector");
    this.cam = this.viewSector ? "fit" : "follow";
    this.saveCam();
    this.fitPending = true;
    this.lastInteract = performance.now();
    this.dirty = true;
    this.emit("mapsector", this.currentSid());
  }

  onSelect(sel) {
    this.dirty = true;
    if (!sel) { if (this.cam === "focus") { this.cam = "follow"; this.focusObj = null; this.zoomBias = 1; } return; }
    if (sel.kind === "sector") { if (sel.from !== "galaxy") this.showSector(sel.id); return; }
    if (sel.from === "map") return;          // clicking on the map does not move the map
    const S = this.S;
    const p = S.property && S.property.get(sel.id);
    const sid = sel.sid || (p ? p.s : this.findScanSector(sel.id));
    if (!sid) return;
    const ps = S.player && S.player.sector ? String(S.player.sector.id) : null;
    if (String(sid) !== ps) { this.viewSector = String(sid); this.watch(this.viewSector); } else { this.viewSector = null; this.watch(null); }
    if (this.mode !== "sector") this.setMode("sector");
    this.cam = "focus"; this.focusObj = sel.id; this.manualUntil = 0; this.zoomBias = 1; this.saveCam();
    this.lastInteract = performance.now();
    this.emit("mapsector", String(sid));
  }
  findScanSector(id) {
    for (const [sid, sc] of Object.entries(this.S.scans || {})) if ((sc.objs || sc.items || []).some((o) => o.id === id)) return sid;
    return null;
  }
  centerOn(id) { this.onSelect({ kind: "obj", id, from: "list" }); }

  resize() {
    if (this._dead) return;
    const b = this.body;
    const dpr = this.win.devicePixelRatio || 1;
    const w = b.clientWidth, h = b.clientHeight;
    if (!w || !h) { this.w = 0; this.h = 0; return; }
    this.layoutTools();
    if (w === this.w && h === this.h && this._dpr === dpr) return;
    this.w = w; this.h = h; this._dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + "px"; this.canvas.style.height = h + "px";
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layoutOverlays();
    this.dirty = true;
  }

  toScreen(x, z) { const v = this.v(); return [this.w / 2 + (x - v.cx) * v.scale, this.h / 2 - (z - v.cz) * v.scale]; }
  toWorld(sx, sy) { const v = this.v(); return [v.cx + (sx - this.w / 2) / v.scale, v.cz - (sy - this.h / 2) / v.scale]; }

  // ---------------------------------------------------------------- data for the shown sector
  currentSid() {
    const p = this.S.player;
    return this.viewSector || (p && p.sector ? String(p.sector.id) : null);
  }
  // galaxy geometry (cluster + sector hexagons), cached per live galaxy / static map
  geo() {
    const src = this.S.liveGalaxy, st = this.staticIdx;
    if (this.geoCache.src !== src || this.geoCache.st !== st || !this.geoCache.geo) {
      this.geoCache = { src, st, geo: galaxyGeometry(src, st, DRAW_R) };
    }
    return this.geoCache.geo;
  }
  // The sector record: the galaxy data, or - right after a jump into a sector the galaxy message has
  // not reported yet (the bridge sends it on its slow interval) - what the player message and the
  // scan already tell (name, position estimated from the gates' known destinations). M6.
  sectorRec(sid) {
    if (!sid) return null;
    sid = String(sid);
    const S = this.S;
    const s = S.sectors && S.sectors.get(sid);
    if (s) return s;
    const p = S.player;
    if (!(p && p.sector && String(p.sector.id) === sid)) return null;
    return { id: sid, name: p.sector.name || this.t("map.unknown"), owner: undefined, provisional: true };
  }
  sectorGeo(sid) {
    if (!sid) return null;
    sid = String(sid);
    const g = this.geo().sectors.get(sid);
    if (g) return g;
    if (this._estKey && this._estKey[0] === sid && performance.now() - this._estKey[1] < 1000) return this._est;
    // estimate: each gate with a known destination D points from here towards D
    const geo = this.geo();
    const sc = this.S.scans && this.S.scans[sid];
    const objs = (sc && (sc.objs || sc.items)) || [];
    const gates = objs.filter((o) => (o.c === "gate" || o.c === "highwayentrygate") && o.ds).concat((this.S.gatesBySector && this.S.gatesBySector.get(sid)) || []);
    let sx = 0, sz = 0, n = 0;
    for (const o of gates) {
      const d = geo.sectors.get(String(o.ds));
      const len = Math.hypot(o.x || 0, o.z || 0);
      if (!d || !len) continue;
      sx += d.x - (o.x / len) * HEX * Math.sqrt(3); sz += d.z - (o.z / len) * HEX * Math.sqrt(3); n++;
    }
    let est = null;
    if (n) est = { x: sx / n, z: sz / n, r: HEX * 0.5, cid: null, estimated: true };
    else {
      const pp = this.S.prevPlayer && this.S.prevPlayer.sector ? geo.sectors.get(String(this.S.prevPlayer.sector.id)) : null;
      if (pp) est = { x: pp.x, z: pp.z, r: HEX * 0.5, cid: null, estimated: true, unplaced: true };
    }
    this._estKey = [sid, performance.now()]; this._est = est;
    return est;
  }
  objects() {
    const sid = this.currentSid();
    const sc = sid ? (this.S.scans || {})[sid] : null;
    let objs = sc ? (sc.objs || sc.items || []) : [];
    if (!objs.some((o) => o.c === "gate")) {
      const gs = (this.S.gatesBySector && this.S.gatesBySector.get(String(sid))) || [];
      objs = objs.concat(gs.map((g) => ({ id: g.id, c: g.hw ? "highwayentrygate" : "gate", x: g.x, z: g.z, ds: g.ds, du: g.du, n: g.hw ? this.t("map.highway") : this.t("map.gate") })));
    }
    return { sid, sc, objs };
  }
  colorOf(o) {
    const S = this.S;
    const cur = S.player && S.player.object ? S.player.object.id : null;
    return objColor(o, S.theme, { currentId: cur, factionColors: this.cfg.factioncol, factions: S.factions });
  }
  isLive() { const st = this.S.status; return (this.S.wsOpen === undefined || this.S.wsOpen) && !!st && st.game === "live"; }

  // ---------------------------------------------------------------- animation loop
  frame(t) {
    if (this._dead) return;
    this.raf = this.win.requestAnimationFrame((tt) => this.frame(tt));
    if (!this.w || !this.h) { this.resize(); if (!this.w) return; }
    if (this.root.hidden || this.root.classList.contains("collapsed")) return;
    const anim = this.updateCamera();
    if (!this.dirty && !anim && !this.pulses.size) return;
    this.dirty = false;
    const g = this.ctx2d;
    g.clearRect(0, 0, this.w, this.h);
    if (this.mode === "galaxy") this.drawGalaxy(g, t); else this.drawSector(g, t);
  }

  updateCamera() {
    const now = performance.now();
    if (this.cam === "manual" && now >= this.manualUntil) { this.cam = this.prevCam === "fit" ? "fit" : (this.focusObj ? "focus" : "follow"); this.zoomBias = 1; }
    // the 60 s return from a watched sector applies to the automatic camera modes only - never to manual (M7)
    if (this.viewSector && this.cam !== "focus" && this.cam !== "manual" && now - this.lastInteract > 60000 && this.isLive()) this.auto();
    this.updateFollowUi(now);
    if (this.cam === "manual") return false;
    const target = this.mode === "galaxy" ? this.autoGalaxy() : this.autoSector();
    if (!target) return false;
    const v = this.v();
    const k = this.fitPending ? 1 : 0.16;
    this.fitPending = false;
    const ds = Math.log(target.scale) - Math.log(v.scale);
    const moved = Math.abs(target.cx - v.cx) * v.scale > 0.5 || Math.abs(target.cz - v.cz) * v.scale > 0.5 || Math.abs(ds) > 0.003;
    v.cx += (target.cx - v.cx) * k;
    v.cz += (target.cz - v.cz) * k;
    v.scale = Math.exp(Math.log(v.scale) + ds * k);
    if (moved) this.dirty = true;
    return moved;
  }

  updateFollowUi(now) {
    const S = this.S;
    const T = this.t;
    const p = S.player;
    const who = p && p.object ? (p.object.name || T("map.ship")) : T("map.none");
    let text, cls;
    if (this.cam === "follow" && !this.viewSector) {
      text = this.mode === "galaxy" ? T("map.follow", { name: p && p.sector ? p.sector.name : "" }) :
        T("map.follow", { name: who + (p && p.where ? " · " + this.whereText(p.where) : "") });
      cls = "on";
    } else if (this.cam === "focus") {
      const o = this.objects().objs.find((x) => x.id === this.focusObj) || (S.property && S.property.get(this.focusObj)) || {};
      text = T("map.selected", { name: (o.n || this.focusObj) + (this.viewSector ? " · " + this.sectorName(this.viewSector) : "") });
      cls = "focus";
    } else if (this.cam === "fit") {
      text = this.viewSector ? T("map.overviewOf", { name: this.sectorName(this.viewSector) }) : T("map.overview");
      cls = "focus";
    } else {
      const left = this.manualUntil === Infinity ? null : Math.max(0, Math.ceil((this.manualUntil - now) / 1000));
      text = T("map.manual") + (left !== null ? T("map.manual.in", { n: left }) : T("map.manual.off"));
      cls = "off";
    }
    if (this._fbText !== text) { this.followBadge.textContent = text; this._fbText = text; }
    this.followBadge.className = "followbadge " + cls;
    const following = this.cam === "follow" && !this.viewSector && this.mode === "sector";
    const icon = this.ov && this.ov.back === "icon";
    const bh = following || icon, ih = following || !icon;
    if (this.backBtn.hidden !== bh || this.backIcon.hidden !== ih) { this.backBtn.hidden = bh; this.backIcon.hidden = ih; this.layoutOverlays(); }
    if (this.cam === "manual") this.dirty = true;
  }

  autoSector() {
    const S = this.S;
    const { sid, objs } = this.objects();
    const p = S.player && S.player.object;
    const pts = [];
    let center = null;
    const has = (o) => o && o.x !== null && o.x !== undefined;
    if (this.cam === "fit") {
      for (const o of objs) if (has(o)) pts.push([o.x, o.z]);
      if (!this.viewSector && has(p)) pts.push([p.x, p.z]);
    } else if (this.cam === "focus") {
      const f = objs.find((o) => o.id === this.focusObj && has(o));
      if (f) { center = [f.x, f.z]; pts.push(center); }
      else return null;
    } else if (!this.viewSector && has(p)) {
      center = [p.x, p.z];
      pts.push(center);
      const near = (cls) => {
        let best = null, bd = Infinity;
        for (const o of objs) if (cls(o) && has(o)) {
          const d = Math.hypot(o.x - p.x, o.z - p.z);
          if (d < bd) { bd = d; best = o; }
        }
        return best;
      };
      for (const o of [near((o) => o.c === "gate" || o.c === "highwayentrygate"), near((o) => o.c === "station")]) if (o) pts.push([o.x, o.z]);
      const tg = S.player.target;
      if (tg && has(tg) && tg.sector === sid) pts.push([tg.x, tg.z]);
    } else {
      for (const o of objs) if (has(o) && (o.pl || o.c === "gate" || o.c === "station")) pts.push([o.x, o.z]);
    }
    if (!pts.length) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    let cx, cz, half;
    if (center) {
      [cx, cz] = center;
      half = Math.max(Math.abs(x0 - cx), Math.abs(x1 - cx), Math.abs(z0 - cz), Math.abs(z1 - cz));
      half = this.cam === "focus" ? 15000 : Math.max(8000, Math.min(500000, half * 1.2));
    } else {
      cx = (x0 + x1) / 2; cz = (z0 + z1) / 2;
      half = Math.max(8000, Math.max(x1 - x0, z1 - z0) / 2 * 1.1);
    }
    const base = fitScale(half, this.w, this.h, "sector", 1);
    this.lastBase = base;
    const r = applyBias(base, this.zoomBias, "sector");
    this.zoomBias = r.bias;
    return { cx, cz, scale: r.scale };
  }

  autoGalaxy() {
    const S = this.S;
    const geo = this.geo();
    if (!geo.clusters.size) return null;
    const ps = S.player && S.player.sector ? this.sectorGeo(S.player.sector.id) : null;
    let cx, cz, half;
    if (ps && this.cam !== "fit") {
      cx = ps.x; cz = ps.z; half = HEX * 7;
    } else {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const c of geo.clusters.values()) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); z0 = Math.min(z0, c.z); z1 = Math.max(z1, c.z); }
      cx = (x0 + x1) / 2; cz = (z0 + z1) / 2; half = Math.max(x1 - x0, z1 - z0) / 2 + HEX;
    }
    const base = fitScale(half, this.w, this.h, "galaxy", 1);
    this.lastBase = base;
    const r = applyBias(base, this.zoomBias, "galaxy");
    this.zoomBias = r.bias;
    return { cx, cz, scale: r.scale };
  }

  // ---------------------------------------------------------------- background (game map: deep blue)
  drawBackground(g) {
    const gr = g.createRadialGradient(this.w / 2, this.h / 2, 0, this.w / 2, this.h / 2, Math.hypot(this.w, this.h) / 1.6);
    gr.addColorStop(0, "#0b1a33"); gr.addColorStop(1, "#040a16");
    g.fillStyle = gr; g.fillRect(0, 0, this.w, this.h);
  }

  // ---------------------------------------------------------------- radar coverage
  radarSources(objs, inPlayer) {
    const src = [];
    for (const o of objs) if (o.pl && o.rr > 0 && o.x !== null && o.x !== undefined) src.push({ x: o.x, z: o.z, r: o.rr });
    const p = this.S.player && this.S.player.object;
    if (inPlayer && p && p.rr > 0 && p.x !== undefined && p.x !== null) src.push({ x: p.x, z: p.z, r: p.rr });
    return src;
  }
  drawRadar(g, objs, inPlayer) {
    const src = this.radarSources(objs, inPlayer);
    // "not seen": darker everywhere
    g.fillStyle = "rgba(0,3,10,0.55)";
    g.fillRect(0, 0, this.w, this.h);
    if (!src.length) return 0;
    const cell = radarCell(src);
    // recompute the lit cells only when a source moved by more than a quarter cell
    const key = cell + "|" + src.map((s) => Math.round(s.x / (cell / 4)) + "," + Math.round(s.z / (cell / 4)) + "," + s.r).sort().join(";");
    if (key !== this.radarCache.key) this.radarCache = { key, cells: hexCellsInRange(src, cell), cell };
    const { cells } = this.radarCache;
    const v = this.view;
    const rpx = (cell / Math.sqrt(3)) * v.scale * 1.02;      // pointy-top hex circumradius in px
    const col = holo(this.S.theme, "radarcolor");
    const path = new Path2D();
    const [wx0, wz1] = this.toWorld(-rpx * 2, -rpx * 2), [wx1, wz0] = this.toWorld(this.w + rpx * 2, this.h + rpx * 2);
    let n = 0;
    for (const [cx, cz] of cells.values()) {
      if (cx < wx0 || cx > wx1 || cz < wz0 || cz > wz1) continue;
      const [x, y] = this.toScreen(cx, cz);
      if (rpx < 1.2) { path.rect(x - 1, y - 1, 2, 2); n++; continue; }
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 3 * k + Math.PI / 6;
        const px = x + rpx * Math.cos(a), py = y + rpx * Math.sin(a);
        if (k === 0) path.moveTo(px, py); else path.lineTo(px, py);
      }
      path.closePath();
      n++;
    }
    g.fillStyle = rgb({ r: Math.min(255, col.r + 30), g: Math.min(255, col.g + 50), b: Math.min(255, col.b + 70) }, 0.26);
    g.fill(path);
    if (rpx > 5) { g.strokeStyle = rgb(col, 0.25); g.lineWidth = 1; g.stroke(path); }
    return n;
  }

  // ---------------------------------------------------------------- sector view
  drawSector(g, t) {
    const S = this.S;
    const T = this.t;
    const { sid, sc, objs } = this.objects();
    const sec = this.sectorRec(sid);
    const v = this.view;
    const p = S.player && S.player.object;
    const inPlayer = !this.viewSector;
    const th = S.theme;
    this.setTitle(T("map.title", { name: sec ? sec.name : (S.player && S.player.sector ? S.player.sector.name : T("map.title.sector")) }) +
      (this.viewSector ? T("map.title.watched") : ""));
    this.drawBackground(g);
    if (this.cfg.radar) this.drawRadar(g, objs, inPlayer);
    if (this.cfg.grid) this.drawGrid(g);
    // sector centre (subtle cross, as the game's ecliptic centre)
    const [ox, oy] = this.toScreen(0, 0);
    g.strokeStyle = "rgba(140,190,255,0.35)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(ox - 8, oy); g.lineTo(ox + 8, oy); g.moveTo(ox, oy - 8); g.lineTo(ox, oy + 8); g.stroke();

    const sel = S.selected && S.selected.kind === "obj" ? S.selected.id : null;
    const tg = S.player && S.player.target;
    const now = performance.now();
    const visW = this.w / v.scale;                   // visible width in metres
    const lblMode = this.cfg.labels;
    const nameZoom = visW < 70000, stationZoom = visW < 400000;
    const scale = this.cfg.iconscale || 1;

    // lines below the icons
    if (this.cfg.lines) this.drawLines(g, sid, objs, inPlayer);

    // draw order (M1): misc < NPC ships < own ships < gates < stations; the player marker last
    const sorted = objs.filter((o) => o.x !== null && o.x !== undefined)
      .map((o, i) => [o, drawLayer(o), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
    this.hit = [];
    const labels = [];
    let nNpc = 0, nOwn = 0, nHostile = 0;
    const many = sorted.length > 250;
    for (const o of sorted) {
      if (p && inPlayer && o.id === p.id) continue;
      const ship = isShip(o);
      if (ship && !o.pl && !this.cfg.npc && o.id !== sel) continue;
      const [x, y] = this.toScreen(o.x, o.z);
      if (x < -40 || y < -40 || x > this.w + 40 || y > this.h + 40) continue;
      if (ship) { if (o.pl) nOwn++; else nNpc++; if (o.h) nHostile++; }
      const col = this.colorOf(o);
      const size = iconSize(o, scale);
      const rot = this.cfg.rotate && ship && typeof o.yaw === "number" ? this.heading(o.yaw) : 0;
      drawIcon(g, iconFor(o), x, y, size, col, rot);
      const important = o.id === sel || (tg && tg.id === o.id) || (this.hover && this.hover.id === o.id);
      if (this.cfg.hull && o.hull !== undefined && o.hull !== null && (ship || o.c === "station") && (important || nameZoom || (!many && o.pl))) {
        hullBar(g, x, y - size / 2 - 5, Math.max(14, size * 0.9), o.hull, o.shield, th);
      }
      const pu = this.pulses.get(o.id);
      if (pu) {
        if (pu < now) this.pulses.delete(o.id);
        else { const ph = (now % 1000) / 1000; g.strokeStyle = `rgba(255,70,70,${1 - ph})`; g.lineWidth = 2; g.beginPath(); g.arc(x, y, size / 2 + 4 + ph * 18, 0, Math.PI * 2); g.stroke(); }
      }
      this.hit.push({ x, y, r: size / 2 + 3, o });
      const wantLabel = lblMode === "all" || important ||
        (lblMode === "auto" && (nameZoom || (stationZoom && (o.c === "station" || o.c === "gate" || o.c === "highwayentrygate"))));
      if (o.c === "gate" || o.c === "highwayentrygate") {
        // M8: jump gate / accelerator / superhighway names (= destination sector) at every zoom level
        const dn = o.ds ? this.sectorName(o.ds) : null;
        labels.push({ x, y: y + size / 2 + 12, iy: y, isz: size, gate: true, col, pri: important ? 0 : 0.5,
                      text: dn && dn !== T("map.unknown") && dn !== "?" ? dn : T("map.gate.unknownDest") });
      } else if ((wantLabel && lblMode !== "off") || important) {
        const txt = o.n || this.className(o.c) || "";
        if (txt) labels.push({ x, y: y + size / 2 + 12, text: txt, col, pri: important ? 0 : (o.pl ? 1 : o.c === "station" ? 2 : 3) });
      }
    }
    // labels: important first, no overlaps (like the game, names thin out instead of piling up);
    // gate names are never dropped: they try below / above / right / left, then step downwards
    labels.sort((a, b) => a.pri - b.pri);
    const taken = [];
    const hitsAny = (box) => taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    if (inPlayer && p && p.x !== null && p.x !== undefined) {      // the player's own label (drawn last) is reserved first
      const [px, py] = this.toScreen(p.x, p.z);
      g.font = `13px ${FONT}`;
      const pw = g.measureText(T("map.you", { name: p.name || "" })).width;
      taken.push([px - 18, py - 20, px + 24 + pw, py + 18]);
    }
    g.font = `12px ${FONT}`;
    this.lastLabels = [];
    for (const L of labels) {
      const w = g.measureText(L.text).width;
      const boxAt = (lx, ly) => [lx - 3, ly - 12, lx + w + 3, ly + 4];
      if (L.gate) {
        const h2 = L.isz / 2;
        const cands = [[L.x - w / 2, L.y], [L.x - w / 2, L.iy - h2 - 6], [L.x + h2 + 6, L.iy + 4], [L.x - h2 - 6 - w, L.iy + 4]];
        let pos = cands.find(([lx, ly]) => !hitsAny(boxAt(lx, ly)));
        for (let k = 1; !pos && k <= 6; k++) { const c = [L.x - w / 2, L.y + 16 * k]; if (!hitsAny(boxAt(...c))) pos = c; }
        if (!pos) pos = cands[0];
        const box = boxAt(pos[0], pos[1]);
        taken.push(box);
        g.fillStyle = "rgba(2,6,14,0.62)";
        roundRect(g, box[0], box[1], box[2] - box[0], box[3] - box[1], 3); g.fill();
        text(g, L.text, pos[0], pos[1], rgb(L.col), 12, true);
        this.lastLabels.push({ text: L.text, x: pos[0], y: pos[1], gate: true });
        continue;
      }
      const box = [L.x - w / 2 - 2, L.y - 11, L.x + w / 2 + 2, L.y + 3];
      if (L.pri > 0 && hitsAny(box)) continue;
      taken.push(box);
      text(g, L.text, L.x - w / 2, L.y, rgb(L.col), 12, true);
      this.lastLabels.push({ text: L.text, x: L.x - w / 2, y: L.y, gate: false });
    }
    // player (always on top)
    if (inPlayer && p && p.x !== null && p.x !== undefined) {
      const [px, py] = this.toScreen(p.x, p.z);
      const col = holo(th, "currentplayershipcolor");
      const ph = (performance.now() % 1800) / 1800;
      g.strokeStyle = `rgba(255,255,255,${0.75 - ph * 0.6})`; g.lineWidth = 2;
      g.beginPath(); g.arc(px, py, 17 + ph * 12, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.95)"; g.lineWidth = 1.5; g.beginPath(); g.arc(px, py, 16, 0, Math.PI * 2); g.stroke();
      const mode = S.player.where ? S.player.where.mode : "pilot";
      const pobj = { c: p.class, ic: p.ic, pl: true, id: p.id, p: null };
      if (mode === "station" || mode === "aboard" || mode === "spacesuit") { g.fillStyle = rgb(col); g.beginPath(); g.arc(px, py, 6, 0, Math.PI * 2); g.fill(); }
      else drawIcon(g, iconFor(pobj), px, py, 24 * scale, col, typeof p.yaw === "number" && this.cfg.rotate ? this.heading(p.yaw) : 0);
      if (this.cfg.hull && p.hull !== undefined) hullBar(g, px, py - 24, 26, p.hull, p.shield, th);
      text(g, T("map.you", { name: p.name || "" }), px + 22, py - 6, "#ffffff", 13, true);
      if (S.player.where && S.player.where.mode !== "pilot") text(g, this.whereText(S.player.where), px + 22, py + 10, "#e8eef7", 11, true);
      this.hit.push({ x: px, y: py, r: 16, o: { ...p, c: p.class, n: p.name, pl: true } });
      this.dirty = true;   // pulse animation
    }
    // selection: the game's corner brackets
    if (sel) {
      const h = this.hit.find((q) => q.o.id === sel);
      if (h) brackets(g, h.x, h.y, Math.max(12, h.r + 5), "#ffffff");
    }
    this.drawScale(g);
    if (this.cfg.mini) this.drawMini(g, sid);
    this.drawInfo(sec, sc, nOwn, nNpc, nHostile);
  }

  drawInfo(sec, sc, nOwn, nNpc, nHostile) {
    const T = this.t;
    const res = sec && sec.res ? sec.res.map((r) => r.w).join(", ") : "";
    const pending = sec && sec.provisional;
    const owner = sec && !pending ? this.factionName(sec.owner) : T("map.none");
    const key = [sec && sec.id, sec && sec.name, pending, owner, nOwn, nNpc, nHostile, sc && sc.hidden, res, sc && Math.round(Date.now() / 5000)].join("|");
    if (key === this._infoKey) return;
    this._infoKey = key;
    let counts = T("map.info.counts", { own: nOwn, npc: nNpc });
    if (nHostile) counts += T("map.info.hostile", { n: nHostile });
    if (sc && sc.hidden) counts += T("map.info.hidden", { n: sc.hidden });
    if (this._pill) {              // compact container: one line, the full text as tooltip
      const full = [sec ? sec.name : T("map.none"), pending ? T("map.info.pending") : owner, counts, res ? T("map.info.res", { list: res }) : ""].filter(Boolean).join(" · ");
      this.info.title = full;
      this.info.replaceChildren(this.mk("b", {}, sec ? sec.name : T("map.none")), " ",
        pending ? "" : this.mk("span", { class: "dot", style: { background: factionColor(sec && sec.owner, this.S.factions) } }),
        this.mk("span", { class: "muted" }, " " + (pending ? T("map.info.pending") : owner) + " · " + counts));
      return;
    }
    this.info.title = "";
    this.info.replaceChildren(
      this.mk("div", { class: "mi-title" }, sec ? sec.name : T("map.none"), this.mk("span", { class: "muted" }, sec && sec.cname && sec.cname !== sec.name ? "  " + sec.cname : "")),
      pending ? this.mk("div", { class: "muted" }, T("map.info.pending")) :
        this.mk("div", {}, this.mk("span", { class: "dot", style: { background: factionColor(sec && sec.owner, this.S.factions) } }), " " + owner),
      this.mk("div", { class: "muted" }, counts),
      res ? this.mk("div", { class: "muted" }, T("map.info.res", { list: res })) : "",
      sc ? "" : this.mk("div", { class: "muted" }, T("map.info.noscan")));
  }

  // plotted course, target line, order lines of the selected own ship
  drawLines(g, sid, objs, inPlayer) {
    const S = this.S;
    const T = this.t;
    const p = S.player && S.player.object;
    const th = S.theme;
    const pp = inPlayer && p && p.x !== undefined && p.x !== null ? this.toScreen(p.x, p.z) : null;
    // order queue of the selected own ship (details command, refreshed while selected)
    const sel = S.selected && S.selected.kind === "obj" ? S.selected.id : null;
    const det = sel && S.details ? S.details[sel] : null;
    if (det && det.orders && det.orders.length) {
      const o = objs.find((x) => x.id === sel) || (p && p.id === sel ? p : null);
      if (o && o.x !== undefined && o.x !== null) {
        const col = holo(th, "playercolor");
        let [lx, ly] = this.toScreen(o.x, o.z);
        g.save(); g.setLineDash([6, 4]); g.lineWidth = 1.6;
        det.orders.forEach((ord, i) => {
          if (!ord.pt || ord.pt.s !== String(sid)) return;
          const [x, y] = this.toScreen(ord.pt.x, ord.pt.z);
          g.strokeStyle = rgb(col, 0.85); g.beginPath(); g.moveTo(lx, ly); g.lineTo(x, y); g.stroke();
          g.setLineDash([]); g.fillStyle = rgb(col); g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); g.setLineDash([6, 4]);
          text(g, `${i + 1}. ${ord.n || ord.d || ""}`, x + 7, y - 6, rgb(col), 11, true);
          [lx, ly] = [x, y];
        });
        g.restore();
      }
    }
    if (!pp) return;
    // plotted course (guidance): to the target in this sector, or towards the gate on the route
    const gd = S.player.guidance;
    if (gd && !gd.unknown) {
      const col = holo(th, "missioncolor");
      let to = null, label = gd.n || T("map.route.plotted");
      if (gd.s === String(sid) && gd.x !== undefined && gd.x !== null) to = this.toScreen(gd.x, gd.z);
      else if (gd.s) {
        const path = route(S.links || [], String(sid), String(gd.s));
        if (path && path.length > 1) {
          const gate = objs.find((o) => (o.c === "gate" || o.c === "highwayentrygate") && o.ds === path[1]);
          if (gate) { to = this.toScreen(gate.x, gate.z); label = T("map.route.to", { sector: this.sectorName(gd.s), n: path.length - 1 }); }
        }
      }
      if (to) {
        g.save(); g.strokeStyle = rgb(col, 0.9); g.lineWidth = 2.2; g.setLineDash([10, 6]);
        g.beginPath(); g.moveTo(pp[0], pp[1]); g.lineTo(to[0], to[1]); g.stroke(); g.restore();
        g.strokeStyle = rgb(col); g.lineWidth = 2; g.beginPath(); g.arc(to[0], to[1], 9, 0, Math.PI * 2); g.stroke();
        text(g, label, to[0] + 12, to[1] + 16, rgb(col), 12, true);
      }
    }
    // soft target
    const tg = S.player.target;
    if (tg && tg.x !== undefined && tg.x !== null && tg.sector === sid) {
      const [tx, ty] = this.toScreen(tg.x, tg.z);
      g.save(); g.strokeStyle = "rgba(255,255,255,0.55)"; g.lineWidth = 1.2; g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(pp[0], pp[1]); g.lineTo(tx, ty); g.stroke(); g.restore();
      text(g, this.fmtDist(tg.dist), (pp[0] + tx) / 2 + 6, (pp[1] + ty) / 2 - 6, "rgba(255,255,255,0.85)", 11, true);
    }
  }

  drawGrid(g) {
    const v = this.view;
    let step = GRID_STEPS[GRID_STEPS.length - 1];
    for (const s of GRID_STEPS) if (s * v.scale >= 80) { step = s; break; }
    const [wx0, wz1] = this.toWorld(0, 0), [wx1, wz0] = this.toWorld(this.w, this.h);
    g.strokeStyle = "rgba(110,160,230,0.10)"; g.lineWidth = 1;
    g.beginPath();
    for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) { const [sx] = this.toScreen(x, 0); g.moveTo(Math.round(sx) + 0.5, 0); g.lineTo(Math.round(sx) + 0.5, this.h); }
    for (let z = Math.ceil(wz0 / step) * step; z <= wz1; z += step) { const [, sy] = this.toScreen(0, z); g.moveTo(0, Math.round(sy) + 0.5); g.lineTo(this.w, Math.round(sy) + 0.5); }
    g.stroke();
    this.gridStep = step;
  }

  drawScale(g) {
    const step = this.gridStep || 10000;
    const px = step * this.view.scale;
    const x1 = this.w - 64, x0 = x1 - px, y = this.h - 18;
    g.strokeStyle = "rgba(220,235,255,0.85)"; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x0, y - 5); g.lineTo(x0, y); g.lineTo(x1, y); g.lineTo(x1, y - 5); g.stroke(); g.lineWidth = 1;
    g.font = `11px ${FONT}`;
    const t = this.fmtKm(step);
    text(g, t, x0 + px / 2 - g.measureText(t).width / 2, y - 7, "rgba(220,235,255,0.9)", 11, true);
    this.scaleRect = { l: x0, t: y - 19, r: x1, b: y + 1 };
  }

  // mini galaxy (bottom left): drawn from whatever is known - never absent because a slow channel lags
  drawMini(g, sid) {
    const S = this.S;
    const geo = this.geo();
    const cur = this.sectorRec(sid);
    const cg = this.sectorGeo(sid);
    this.miniDrawn = false;
    const mr = this.miniRect;
    if (!cur || !mr) return;
    const W = mr.r - mr.l, H = mr.b - mr.t, X = mr.l, Y = mr.t;
    g.save();
    roundRect(g, X, Y, W, H, 8);
    g.fillStyle = "rgba(6,12,24,0.86)"; g.fill(); g.strokeStyle = "rgba(120,170,230,0.25)"; g.stroke();
    g.clip();
    const sc = (Math.min(W, H) / 2) / (HEX * 3.2);
    const ox = cg ? cg.x : 0, oz = cg ? cg.z : 0;
    const tx = (x) => X + W / 2 + (x - ox) * sc, ty = (z) => Y + H / 2 - (z - oz) * sc;
    const inView = (x, z, m = 30) => { const a = tx(x), b = ty(z); return a > X - m && a < X + W + m && b > Y - m && b < Y + H + m; };
    for (const c of geo.clusters.values()) {
      if (!inView(c.x, c.z, c.r * sc)) continue;
      g.fillStyle = "rgba(0,0,0,0.6)"; hexPath(g, tx(c.x), ty(c.z), c.r * sc); g.fill();
    }
    for (const l of S.links || []) {
      const a = geo.sectors.get(l.a), b = geo.sectors.get(l.b);
      if (!a || !b) continue;
      if (Math.hypot(a.x - ox, a.z - oz) > HEX * 6 && Math.hypot(b.x - ox, b.z - oz) > HEX * 6) continue;
      g.strokeStyle = l.kind === "hw" ? rgb(holo(S.theme, "superhighwaycolor"), 0.7) : "rgba(255,255,255,0.4)";
      g.beginPath(); g.moveTo(tx(a.x), ty(a.z)); g.lineTo(tx(b.x), ty(b.z)); g.stroke();
    }
    const ps = S.player && S.player.sector ? String(S.player.sector.id) : null;
    for (const [id, gs] of geo.sectors) {
      if (!inView(gs.x, gs.z)) continue;
      const s = S.sectors && S.sectors.get(id);
      const x = tx(gs.x), y = ty(gs.z), r = gs.r * sc * 0.94;
      g.fillStyle = factionColor(s && s.owner, S.factions); g.globalAlpha = 0.35; hexPath(g, x, y, r); g.fill(); g.globalAlpha = 1;
      if (id === String(sid)) { g.strokeStyle = "#ffffff"; g.lineWidth = 2; hexPath(g, x, y, r); g.stroke(); g.lineWidth = 1; }
      if (id === ps) { g.fillStyle = "#ffffff"; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
    }
    if (cg && cg.estimated && !cg.unplaced) {         // a sector the galaxy data has not reported yet (M6)
      const x = tx(cg.x), y = ty(cg.z);
      g.save(); g.setLineDash([3, 3]); g.strokeStyle = "#ffffff"; g.lineWidth = 2; hexPath(g, x, y, cg.r * sc); g.stroke(); g.restore();
      if (String(sid) === ps) { g.fillStyle = "#ffffff"; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
    }
    g.restore();
    text(g, cur.name, X + 8, Y + 15, "rgba(220,232,245,0.9)", 11, true);
    this.miniDrawn = true;
  }

  // ---------------------------------------------------------------- galaxy view
  drawGalaxy(g, t) {
    const S = this.S;
    const T = this.t;
    const geo = this.geo();
    const nsec = geo.sectors.size;
    this.setTitle(nsec ? T("map.title.galaxyCount", { n: nsec }) : T("map.title.galaxy"));
    this.drawBackground(g);
    const v = this.gview;
    const own = new Map(), ownSt = new Map();
    for (const e of (S.property && S.property.values()) || []) {
      if (e.k === "station") ownSt.set(e.s, (ownSt.get(e.s) || 0) + 1); else own.set(e.s, (own.get(e.s) || 0) + 1);
    }
    const sectorOf = (id) => S.sectors && S.sectors.get(id);
    const onScreen = (x, y, r) => !(x < -r || y < -r || x > this.w + r || y > this.h + r);
    // 1. cluster bodies: black (the corners no sector occupies stay black, like the game)
    for (const c of geo.clusters.values()) {
      const [x, y] = this.toScreen(c.x, c.z), r = c.r * v.scale;
      if (!onScreen(x, y, r)) continue;
      g.fillStyle = "rgba(0,0,0,0.88)"; hexPath(g, x, y, r); g.fill();
    }
    // 2. sector hexagons in the owner's colour
    this.ghit = [];
    for (const [id, gs] of geo.sectors) {
      const s = sectorOf(id);
      if (!s) continue;
      const [x, y] = this.toScreen(gs.x, gs.z), r = gs.r * v.scale;
      if (!onScreen(x, y, r)) continue;
      const fc = factionColor(s.owner, S.factions);
      g.fillStyle = fc; g.globalAlpha = 0.24; hexPath(g, x, y, r); g.fill();
      g.globalAlpha = 0.55; g.strokeStyle = fc; g.lineWidth = 1; hexPath(g, x, y, r); g.stroke(); g.globalAlpha = 1;
      this.ghit.push({ x, y, r, s, gx: gs.x, gz: gs.z, wr: gs.r });
    }
    // 3. links: jump gate connections (legend: plain line), superhighways (superhighwaycolor)
    for (const l of S.links || []) {
      const a = geo.sectors.get(l.a), b = geo.sectors.get(l.b);
      if (!a || !b) continue;
      const [x1, y1] = this.toScreen(a.x, a.z), [x2, y2] = this.toScreen(b.x, b.z);
      g.strokeStyle = l.kind === "hw" ? rgb(holo(S.theme, "superhighwaycolor"), 0.85) : "rgba(235,242,255,0.55)";
      g.lineWidth = l.kind === "hw" ? 2.5 : 1.4;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    g.lineWidth = 1;
    for (const st of S.stubs || []) {
      const a = geo.sectors.get(st.s);
      if (!a) continue;
      const d = Math.hypot(st.x, st.z) || 1;
      const ex = a.x + st.x / d * a.r * 1.1, ez = a.z + st.z / d * a.r * 1.1;
      const [x1, y1] = this.toScreen(a.x, a.z), [x2, y2] = this.toScreen(ex, ez);
      g.strokeStyle = "rgba(235,242,255,0.35)"; g.setLineDash([2, 4]);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.setLineDash([]);
      text(g, "?", x2 - 3, y2 + 4, "rgba(235,242,255,0.8)", 13, true);
    }
    // 4. plotted route
    const ps = S.player && S.player.sector ? String(S.player.sector.id) : null;
    const gd = S.player && S.player.guidance;
    if (this.cfg.lines && gd && gd.s && ps) {
      const path = route(S.links || [], ps, String(gd.s));
      if (path && path.length > 1) {
        g.save(); g.strokeStyle = rgb(holo(S.theme, "missioncolor"), 0.95); g.lineWidth = 3.5; g.setLineDash([12, 7]);
        g.beginPath();
        let first = true;
        for (const sid of path) {
          const s = this.sectorGeo(sid);
          if (!s) continue;
          const [x, y] = this.toScreen(s.x, s.z);
          if (first) g.moveTo(x, y); else g.lineTo(x, y);
          first = false;
        }
        g.stroke(); g.restore();
      }
    }
    // 5. system edge: the cluster outline in the owner's colour (majority of its known sectors)
    for (const c of geo.clusters.values()) {
      const [x, y] = this.toScreen(c.x, c.z), r = c.r * v.scale;
      if (!onScreen(x, y, r)) continue;
      const cnt = new Map();
      for (const [id, gs] of geo.sectors) if (gs.cid === c.id) { const s = sectorOf(id); const o = s ? s.owner || "" : ""; cnt.set(o, (cnt.get(o) || 0) + 1); }
      let owner = "", best = -1;
      for (const [o, n] of cnt) if (n > best) { best = n; owner = o; }
      g.strokeStyle = factionColor(owner || null, S.factions); g.lineWidth = 2.2; g.globalAlpha = 0.95;
      hexPath(g, x, y, r); g.stroke(); g.globalAlpha = 1; g.lineWidth = 1;
    }
    // 6. markers and names, all inside their own sector hexagon
    const pc = holo(S.theme, "playercolor");
    for (const h of this.ghit) {
      const { x, y, r, s } = h;
      const spot = sectorMarkerSpots(r);
      const n = own.get(s.id) || 0, ns = ownSt.get(s.id) || 0;
      if ((n || ns) && r > 18) {
        drawIcon(g, "ship_s_fight_01", x + spot.count.x, y + spot.count.y, spot.count.size, pc);
        if (r > 22) text(g, String(n + ns), x + spot.count.textX, y + spot.count.textY, rgb(pc), 11, true);
      }
      if (s.id === ps) {
        const ph = (performance.now() % 2000) / 2000;
        g.strokeStyle = "#ffffff"; g.lineWidth = 2.5; hexPath(g, x, y, r * (0.95 + 0.04 * Math.sin(ph * Math.PI * 2))); g.stroke(); g.lineWidth = 1;
        drawIcon(g, iconFor({ c: S.player.object && S.player.object.class, ic: S.player.object && S.player.object.ic }), x, y, spot.player.size, holo(S.theme, "currentplayershipcolor"));
        this.dirty = true;
      }
      if (this.viewSector === s.id) { g.strokeStyle = "rgba(255,255,255,0.8)"; g.setLineDash([4, 3]); hexPath(g, x, y, r * 0.88); g.stroke(); g.setLineDash([]); }
      const sel = S.selected;
      if (sel && sel.kind === "sector" && sel.id === s.id) { g.strokeStyle = "#ffffff"; g.lineWidth = 2; hexPath(g, x, y, r * 0.9); g.stroke(); g.lineWidth = 1; }
      if (this.cfg.labels !== "off" && r > 20) {
        // the sector's name at the top centre of its hexagon, shrunk to fit the top edge
        let fs = spot.label.fs;
        const maxW = spot.label.maxW;
        g.font = `${fs}px ${FONT}`;
        let tw = g.measureText(s.name).width;
        while (tw > maxW && fs > 9) { fs -= 0.5; g.font = `${fs}px ${FONT}`; tw = g.measureText(s.name).width; }
        let name = s.name;
        if (tw > maxW) { while (name.length > 2 && g.measureText(name + "…").width > maxW) name = name.slice(0, -1); name += "…"; tw = g.measureText(name).width; }
        text(g, name, x - tw / 2, y + spot.label.y, s.id === ps ? "#ffffff" : "rgba(225,234,246,0.92)", fs, true);
      }
    }
    // the player's sector before the galaxy message reports it (M6): estimated, dashed
    if (ps && !geo.sectors.has(ps)) {
      const est = this.sectorGeo(ps);
      if (est && !est.unplaced) {
        const [x, y] = this.toScreen(est.x, est.z), r = est.r * v.scale;
        g.save(); g.setLineDash([5, 4]); g.strokeStyle = "#ffffff"; g.lineWidth = 2; hexPath(g, x, y, r); g.stroke(); g.restore();
        drawIcon(g, iconFor({ c: S.player.object && S.player.object.class, ic: S.player.object && S.player.object.ic }), x, y, Math.max(10, Math.min(20, r * 0.5)), holo(S.theme, "currentplayershipcolor"));
        if (r > 20) { const nm = S.player.sector.name || "?"; g.font = `12px ${FONT}`; text(g, nm, x - g.measureText(nm).width / 2, y - r * 0.866 + 16, "#ffffff", 12, true); }
        this.dirty = true;
      }
    }
    const nGate = (S.links || []).filter((l) => l.kind === "gate").length, nHw = (S.links || []).filter((l) => l.kind === "hw").length;
    const key = ["g", nsec, nGate, nHw, this.t("map.locale")].join("|");
    if (key !== this._infoKey) {
      this._infoKey = key;
      if (this._pill) {
        this.info.title = T("map.galaxy.known");
        this.info.replaceChildren(this.mk("b", {}, T("map.title.galaxy")), this.mk("span", { class: "muted" }, " · " + T("map.galaxy.info", { s: nsec, g: nGate, h: nHw })));
        return;
      }
      this.info.title = "";
      this.info.replaceChildren(this.mk("div", { class: "mi-title" }, T("map.title.galaxy")),
        this.mk("div", {}, T("map.galaxy.info", { s: nsec, g: nGate, h: nHw })),
        this.mk("div", { class: "muted" }, S.liveGalaxy && S.liveGalaxy.length ? T("map.galaxy.known") : T("map.galaxy.none")),
        this.mk("div", { class: "muted" }, T("map.galaxy.dbl")));
    }
  }

  pickSector(sx, sy) {
    const [wx, wz] = this.toWorld(sx, sy);
    const hs = this.ghit || [];
    for (let i = hs.length - 1; i >= 0; i--) if (insideHex(wx, wz, hs[i].gx, hs[i].gz, hs[i].wr)) return hs[i].s;
    return null;
  }

  // topmost drawn object first (the hit list is in drawing order, the player marker last)
  pick(sx, sy) {
    const hs = this.hit || [];
    for (let i = hs.length - 1; i >= 0; i--) {
      const h = hs[i];
      if (Math.hypot(h.x - sx, h.y - sy) < Math.max(10, h.r)) return h.o;
    }
    return null;
  }

  onHover(e) {
    const T = this.t;
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    let o = null, label = "";
    if (this.mode === "galaxy") {
      const s = this.pickSector(sx, sy);
      if (s) { o = { id: "s" + s.id }; label = s.name + " · " + this.factionName(s.owner); }
    } else {
      o = this.pick(sx, sy);
      if (o) label = (o.n || this.className(o.c) || "?") + (o.code ? ` (${o.code})` : "") + (o.pl ? T("map.tip.own") : o.o ? " · " + this.factionName(o.o) : "") +
        (o.hull !== undefined && o.hull !== null ? T("map.tip.hull", { n: this.fmtNum(o.hull) }) : "");
    }
    const id = o ? o.id : null;
    if (id !== (this.hover && this.hover.id)) { this.hover = o; this.dirty = true; }
    this.tip.hidden = !o;
    if (o) { this.tip.textContent = label; this.tip.style.left = (sx + 14) + "px"; this.tip.style.top = (sy + 12) + "px"; }
  }

  click(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (sx < 0 || sy < 0 || sx > this.w || sy > this.h) return;
    this.lastInteract = performance.now();
    if (this.mode === "galaxy") {
      const s = this.pickSector(sx, sy);
      if (s) this.select({ kind: "sector", id: s.id, from: "galaxy" });
      return;
    }
    const best = this.pick(sx, sy);
    if (best) this.select({ kind: "obj", id: best.id, from: "map", obj: best, sid: this.currentSid() });
  }
}

// ---------------------------------------------------------------- drawing helpers
function text(g, s, x, y, color, size = 11, shadow = false) {
  g.font = `${size}px ${FONT}`;
  if (shadow) { g.fillStyle = "rgba(0,0,0,0.85)"; g.fillText(s, x + 1, y + 1); }
  g.fillStyle = color; g.fillText(s, x, y);
}
function hexPath(g, x, y, r) {      // flat-top hex (vanilla cluster grid: q axis along x)
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 3 * i;
    const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function brackets(g, x, y, r, color) {
  const k = r * 0.45;
  g.strokeStyle = color; g.lineWidth = 2;
  g.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    g.moveTo(x + sx * r, y + sy * (r - k)); g.lineTo(x + sx * r, y + sy * r); g.lineTo(x + sx * (r - k), y + sy * r);
  }
  g.stroke(); g.lineWidth = 1;
}
// hull (and shield) bar above the icon, colours of the game's shield/hull bar (Color shieldhullbar_*)
function hullBar(g, x, y, w, hull, shield, theme) {
  const ui = (theme && theme.ui) || {};
  const hc = ui.shieldhullbar_hull ? rgb(ui.shieldhullbar_hull) : "#f2f5f8";
  const sc = ui.shieldhullbar_shield ? rgb(ui.shieldhullbar_shield) : "#3fa0ff";
  const x0 = Math.round(x - w / 2), yy = Math.round(y);
  g.fillStyle = "rgba(0,0,0,0.7)"; g.fillRect(x0 - 1, yy - 1, w + 2, shield !== undefined && shield !== null ? 6 : 4);
  const hp = Math.max(0, Math.min(100, +hull || 0)) / 100;
  g.fillStyle = hp < 0.35 ? "#ff5a4a" : hc; g.fillRect(x0, yy, w * hp, 2);
  if (shield !== undefined && shield !== null) { g.fillStyle = sc; g.fillRect(x0, yy + 3, w * Math.max(0, Math.min(100, +shield)) / 100, 2); }
}
