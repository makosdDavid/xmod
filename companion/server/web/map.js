// X4 Companion — canvas map, modelled on the game's own map (M):
//   sector view: the game's icons (exported from the user's catalogs, see export_icons.py) tinted with
//   the game map's colours (GetHoloMapColors via the bridge), constant icon size at every zoom, hull
//   bar above the icon, names only when zoomed in / selected / hovered, own radar coverage lit on a
//   dark "not seen" background with a hex-stepped edge, plotted course, target line and the order
//   lines of a selected own ship.
//   galaxy view: sector hexes in the owner's faction colour, gate / superhighway connections, the
//   plotted route, where your ships and stations are.
// Camera modes: follow (your ship, default) | focus (a selected object) | fit (whole sector / galaxy)
// | manual (after dragging; returns to follow after the configured idle time).
// World coordinates: X4 metres, x = east, z = north (drawn up), height ignored.
"use strict";
import { el, num, dist, loadSettings, saveSettings, factionColor, CLASS_HU } from "./util.js";
import { clampScale, wheelFactor, applyBias, zoomAt, fitScale, pinchFactor } from "./camera.js";
import { iconEl } from "./icons.js";
import { objColor, holo, rgb, iconFor, iconSize, isShip, drawIcon, hexCellsInRange, radarCell, route } from "./mapstyle.js";

const HEX = 1e7;                 // cluster grid edge length (vanilla menu_mapeditor.lua:163)
const GRID_STEPS = [500, 1000, 2000, 5000, 10000, 20000, 25000, 50000, 100000, 200000, 500000, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7];
const FONT = '"Segoe UI", "Inter", system-ui, sans-serif';

export class MapView {
  constructor(root, ctx) {
    this.root = root;
    this.c = ctx;
    this.S = ctx.S;
    this.cfg = loadSettings("map", { labels: "auto", npc: true, grid: true, mini: true, radar: true, lines: true, hull: true,
                                      factioncol: false, rotate: false, iconscale: 1, mode: "sector", ret: 8, legend: false });
    if (typeof this.cfg.labels === "boolean") this.cfg.labels = this.cfg.labels ? "auto" : "off";
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
    this.build();
    this.bind();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- DOM
  build() {
    const r = this.root;
    this.title = r.querySelector(".ptitle");
    const tools = r.querySelector(".ptools");
    this.segSector = el("button", { class: "seg on", title: "Szektornézet (1)", onclick: () => this.setMode("sector") }, "Szektor");
    this.segGalaxy = el("button", { class: "seg", title: "Galaxisnézet (2)", onclick: () => this.setMode("galaxy") }, "Galaxis");
    this.selRet = el("select", { class: "small", title: "Kézi mozgatás után ennyi idő múlva tér vissza a követés", onchange: () => {
      this.cfg.ret = +this.selRet.value; saveSettings("map", this.cfg);
    } }, ...[[5, "követés 5 mp után"], [8, "követés 8 mp után"], [15, "követés 15 mp után"], [30, "követés 30 mp után"], [0, "követés kézzel"]]
      .map(([v, t]) => el("option", { value: v, selected: (this.cfg.ret ?? 8) === v }, t)));
    if (tools) tools.prepend(el("span", { class: "segs" }, this.segSector, this.segGalaxy), this.selRet);

    this.canvas = el("canvas", { class: "mapcanvas", tabindex: "-1", "aria-label": "Térkép" });
    this.info = el("div", { class: "mapinfo" });
    const zbtn = (icon, title, fn, cls = "") => { const b = el("button", { class: "zbtn " + cls, title, "aria-label": title, onclick: fn }); b.appendChild(iconEl(icon, 18)); return b; };
    this.zoomBox = el("div", { class: "zoombox" },
      zbtn("plus", "Nagyítás (+ / görgő / játékbeli gyorsgomb)", () => this.zoom(1.5)),
      zbtn("minus", "Kicsinyítés (− / görgő / játékbeli gyorsgomb)", () => this.zoom(1 / 1.5)),
      zbtn("fit", "Illesztés: minden látsszon (0)", () => this.fit()));
    const chip = (key, label, title) => {
      const b = el("button", { class: "chip" + (this.cfg[key] ? " on" : ""), title, onclick: () => {
        this.cfg[key] = !this.cfg[key]; b.classList.toggle("on", !!this.cfg[key]); saveSettings("map", this.cfg); this.dirty = true;
        if (key === "legend") this.renderLegend();
      } }, label);
      return b;
    };
    const LBL = { auto: "Nevek: nagyításkor", all: "Nevek: mind", off: "Nevek: ki" };
    this.lblBtn = el("button", { class: "chip", title: "Nevek: mint a játékban csak közelről / kijelölve; mindig; soha", onclick: () => {
      this.cfg.labels = { auto: "all", all: "off", off: "auto" }[this.cfg.labels] || "auto";
      this.lblBtn.textContent = LBL[this.cfg.labels]; saveSettings("map", this.cfg); this.dirty = true;
    } }, LBL[this.cfg.labels] || LBL.auto);
    this.layersBtn = el("button", { class: "chip layers-btn", title: "Térképrétegek és beállítások", onclick: () => {
      this.layers.hidden = !this.layers.hidden; this.layersBtn.classList.toggle("on", !this.layers.hidden);
    } }, "Rétegek ▾");
    this.layers = el("div", { class: "layers", hidden: true },
      chip("radar", "Radar", "A saját radarok által látott terület világos, a többi sötét (mint a játék térképén)"),
      chip("lines", "Útvonalak", "Kijelölt útvonal, célpont, a kijelölt saját hajó parancsai"),
      chip("npc", "Más hajók", "Nem saját hajók megjelenítése"),
      chip("hull", "Burkolat", "Burkolatsáv az ikon fölött"),
      chip("factioncol", "Frakciószínek", "A játék „frakciószínek” térképszűrője: semleges objektumok a frakció színében"),
      chip("rotate", "Irány", "Hajóikonok elforgatása a haladási irányba (a játék térképén nem forognak)"),
      chip("grid", "Rács", "km-rács"), chip("mini", "Mini galaxis", "Kis galaxistérkép a sarokban"),
      this.lblBtn, chip("legend", "Jelmagyarázat", "A játék térképének jelmagyarázata"));
    this.legendBox = el("div", { class: "maplegend2", hidden: true });
    this.followBadge = el("div", { class: "followbadge" });
    this.backBtn = el("button", { class: "backbtn", title: "Vissza a hajómra (a, Esc, játékbeli gyorsgomb)", onclick: () => this.auto() });
    this.backBtn.append(iconEl("ship", 18), el("span", {}, "Vissza a hajómra"));
    this.tip = el("div", { class: "maptip", hidden: true });
    const body = r.querySelector(".pbody");
    body.classList.add("mapbody");
    body.append(this.canvas, this.info, el("div", { class: "layerbox" }, this.layersBtn, this.layers), this.legendBox, this.zoomBox, this.followBadge, this.backBtn, this.tip);
    this.ctx2d = this.canvas.getContext("2d");
    this.setMode(this.cfg.mode || "sector");
    this.renderLegend();
  }

  renderLegend() {
    this.legendBox.hidden = !this.cfg.legend;
    if (!this.cfg.legend) return;
    const th = this.S.theme;
    const rows = [
      ["ship_s_fight_01", "playercolor", "Saját"], ["ship_s_fight_01", "friendcolor", "Semleges"],
      ["ship_s_fight_01", "enemycolor", "Ellenséges"], ["ship_s_fight_01", "hostilecolor", "Támadó"],
      ["ship_s_fight_01", "missioncolor", "Küldetés célpontja"], ["mapob_jumpgate", "gatecolor", "Ugrókapu"],
      ["mapob_superhighway", "highwaygatecolor", "Szupersztráda-kapu"], ["mapob_shipyard", "friendcolor", "Hajógyár"],
      ["mapob_tradestation", "friendcolor", "Kereskedőállomás"], ["mapob_satellite_01", "playercolor", "Műhold"],
    ];
    const box = el("div", { class: "lgrid" });
    for (const [ic, ck, label] of rows) {
      const cv = el("canvas", { width: 22, height: 22 });
      drawIcon(cv.getContext("2d"), ic, 11, 11, 20, holo(th, ck));
      box.append(el("span", { class: "lgi" }, cv, el("span", {}, label)));
    }
    box.append(el("span", { class: "lgi" }, el("span", { class: "swatch radar" }), el("span", {}, "Radar által látott")));
    this.legendBox.replaceChildren(el("div", { class: "lgtitle" }, "Jelmagyarázat" + (th && !th.sim ? " (a játék színei)" : " (közelítő színek – a játék még nem küldte)")), box);
  }

  bind() {
    const cv = this.canvas;
    const pointers = new Map();
    let drag = null, pinch = null;
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
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
      this.zoom(wheelFactor(e.deltaY, e.deltaMode), e.offsetX, e.offsetY);
    }, { passive: false });
    cv.addEventListener("dblclick", (e) => {
      if (this.mode === "galaxy") {
        const s = this.pickSector(e.offsetX, e.offsetY);
        if (s) this.showSector(s.id);
      } else this.auto();
    });
    new ResizeObserver(() => this.resize()).observe(this.root.querySelector(".pbody"));
    window.addEventListener("x4c-layout", () => setTimeout(() => this.resize(), 0));
    const b = this.c.bus;
    for (const ev of ["player", "scan", "galaxy", "property", "factions", "status", "details", "icons"]) b.on(ev, () => { this.dirty = true; });
    b.on("theme", () => { this.dirty = true; this.renderLegend(); });
    b.on("icons", () => this.renderLegend());
    b.on("hotkey", (m) => {
      if (m.action === "view_toggle") this.toggleMode();
      else if (m.action === "zoom_in") this.zoom(1.6);
      else if (m.action === "zoom_out") this.zoom(1 / 1.6);
      else if (m.action === "zoom_fit") this.fit();
    });
    b.on("auto", () => this.auto());
    b.on("select", (sel) => this.onSelect(sel));
    b.on("sectorchange", () => {
      // the player jumped: always go to the new sector and the ship
      this.viewSector = null; this.c.watchSector(null); this.cam = "follow"; this.zoomBias = 1;
      this.focusObj = null; this.fitPending = true;
      if (this.mode === "galaxy") this.dirty = true;   // the galaxy view stays, it follows the new sector
      else this.setMode("sector");
    });
    b.on("alert", (items) => {
      const until = performance.now() + 20000;
      for (const e of items) if (e.ic) this.pulses.set(String(e.ic), until);
    });
    b.on("resize", () => this.resize());
  }

  v() { return this.mode === "galaxy" ? this.gview : this.view; }

  // ---------------------------------------------------------------- camera control
  toManual() {
    if (this.cam !== "manual") this.prevCam = this.cam;
    this.cam = "manual";
    const ret = this.cfg.ret ?? 8;
    this.manualUntil = ret > 0 ? performance.now() + ret * 1000 : Infinity;
    this.lastInteract = performance.now();
  }
  following() { return this.cam === "follow" && !this.viewSector; }
  auto() {
    this.cam = "follow"; this.manualUntil = 0; this.zoomBias = 1; this.focusObj = null;
    this.viewSector = null; this.c.watchSector(null);
    if (this.mode !== "sector") this.setMode("sector");
    this.dirty = true;
  }
  fit() { this.cam = "fit"; this.zoomBias = 1; this.manualUntil = 0; this.lastInteract = performance.now(); this.dirty = true; }
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
  }
  setMode(m) {
    this.mode = m;
    this.cfg.mode = m; saveSettings("map", this.cfg);
    this.segSector.classList.toggle("on", m === "sector");
    this.segGalaxy.classList.toggle("on", m === "galaxy");
    this.zoomBias = 1;
    this.fitPending = true;
    this.dirty = true;
    this.c.bus.emit("mapmode", m);
  }
  toggleMode() { this.setMode(this.mode === "galaxy" ? "sector" : "galaxy"); }

  showSector(sid) {
    sid = String(sid);
    const ps = this.S.player && this.S.player.sector ? this.S.player.sector.id : null;
    this.viewSector = sid === ps ? null : sid;
    this.c.watchSector(this.viewSector);
    this.setMode("sector");
    this.cam = this.viewSector ? "fit" : "follow";
    this.fitPending = true;
    this.lastInteract = performance.now();
    this.dirty = true;
    this.c.bus.emit("mapsector", this.currentSid());
  }

  onSelect(sel) {
    this.dirty = true;
    if (!sel) { if (this.cam === "focus") { this.cam = "follow"; this.focusObj = null; this.zoomBias = 1; } return; }
    if (sel.kind === "sector") { if (sel.from !== "galaxy") this.showSector(sel.id); return; }
    if (sel.from === "map") return;          // clicking on the map does not move the map
    const S = this.S;
    const p = S.property.get(sel.id);
    const sid = sel.sid || (p ? p.s : this.findScanSector(sel.id));
    if (!sid) return;
    const ps = S.player && S.player.sector ? S.player.sector.id : null;
    if (sid !== ps) { this.viewSector = sid; this.c.watchSector(sid); } else { this.viewSector = null; this.c.watchSector(null); }
    if (this.mode !== "sector") this.setMode("sector");
    this.cam = "focus"; this.focusObj = sel.id; this.manualUntil = 0; this.zoomBias = 1;
    this.lastInteract = performance.now();
    this.c.bus.emit("mapsector", sid);
  }
  findScanSector(id) {
    for (const [sid, sc] of Object.entries(this.S.scans)) if ((sc.objs || sc.items || []).some((o) => o.id === id)) return sid;
    return null;
  }
  centerOn(id) { this.onSelect({ kind: "obj", id, from: "list" }); }

  resize() {
    const b = this.root.querySelector(".pbody");
    const dpr = window.devicePixelRatio || 1;
    this.w = b.clientWidth; this.h = b.clientHeight;
    if (!this.w || !this.h) return;
    this.canvas.width = Math.max(1, Math.round(this.w * dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * dpr));
    this.canvas.style.width = this.w + "px"; this.canvas.style.height = this.h + "px";
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  toScreen(x, z) { const v = this.v(); return [this.w / 2 + (x - v.cx) * v.scale, this.h / 2 - (z - v.cz) * v.scale]; }
  toWorld(sx, sy) { const v = this.v(); return [v.cx + (sx - this.w / 2) / v.scale, v.cz - (sy - this.h / 2) / v.scale]; }

  // ---------------------------------------------------------------- data for the shown sector
  currentSid() {
    const p = this.S.player;
    return this.viewSector || (p && p.sector ? p.sector.id : null);
  }
  objects() {
    const sid = this.currentSid();
    const sc = sid ? this.S.scans[sid] : null;
    let objs = sc ? (sc.objs || sc.items || []) : [];
    if (!objs.some((o) => o.c === "gate")) {
      const gs = this.S.gatesBySector.get(String(sid)) || [];
      objs = objs.concat(gs.map((g) => ({ id: g.id, c: g.hw ? "highwayentrygate" : "gate", x: g.x, z: g.z, ds: g.ds, du: g.du, n: g.hw ? "Szupersztráda" : "Ugrókapu" })));
    }
    return { sid, sc, objs };
  }
  colorOf(o) {
    const S = this.S;
    const cur = S.player && S.player.object ? S.player.object.id : null;
    return objColor(o, S.theme, { currentId: cur, factionColors: this.cfg.factioncol, factions: S.factions });
  }

  // ---------------------------------------------------------------- animation loop
  frame(t) {
    requestAnimationFrame((tt) => this.frame(tt));
    if (!this.w) { this.resize(); if (!this.w) return; }
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
    if (this.viewSector && this.cam !== "focus" && now - this.lastInteract > 60000 && document.body.dataset.state === "live") this.auto();
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
    const p = S.player;
    const who = p && p.object ? (p.object.name || "hajó") : "–";
    let text, cls;
    if (this.cam === "follow" && !this.viewSector) {
      text = this.mode === "galaxy" ? "Követés: " + (p && p.sector ? p.sector.name : "") :
        "Követés: " + who + (p && p.where ? " · " + this.c.whereText(p.where) : "");
      cls = "on";
    } else if (this.cam === "focus") {
      const o = this.objects().objs.find((x) => x.id === this.focusObj) || S.property.get(this.focusObj) || {};
      text = "Kijelölve: " + (o.n || this.focusObj) + (this.viewSector ? " · " + this.c.sectorName(this.viewSector) : "");
      cls = "focus";
    } else if (this.cam === "fit") {
      text = "Áttekintés" + (this.viewSector ? ": " + this.c.sectorName(this.viewSector) : "");
      cls = "focus";
    } else {
      const left = this.manualUntil === Infinity ? null : Math.max(0, Math.ceil((this.manualUntil - now) / 1000));
      text = "Kézi nézet" + (left !== null ? ` · követés ${left} mp múlva` : " · követés kikapcsolva");
      cls = "off";
    }
    if (this._fbText !== text) { this.followBadge.textContent = text; this._fbText = text; }
    this.followBadge.className = "followbadge " + cls;
    const following = this.cam === "follow" && !this.viewSector && this.mode === "sector";
    this.backBtn.hidden = following;
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
    if (!S.sectors.size) return null;
    const ps = S.player && S.player.sector ? S.sectors.get(S.player.sector.id) : null;
    let cx, cz, half;
    if (ps && this.cam !== "fit") {
      cx = ps.gx; cz = ps.gz; half = HEX * 7;
    } else {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const s of S.sectors.values()) { x0 = Math.min(x0, s.gx); x1 = Math.max(x1, s.gx); z0 = Math.min(z0, s.gz); z1 = Math.max(z1, s.gz); }
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
    const { sid, sc, objs } = this.objects();
    const sec = sid ? S.sectors.get(String(sid)) : null;
    const v = this.view;
    const p = S.player && S.player.object;
    const inPlayer = !this.viewSector;
    const th = S.theme;
    this.title.textContent = "Térkép · " + (sec ? sec.name : (S.player && S.player.sector ? S.player.sector.name : "Szektor")) +
      (this.viewSector ? " (figyelt szektor)" : "");
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

    const order = { gate: 0, highwayentrygate: 0, station: 1 };
    const sorted = objs.filter((o) => o.x !== null && o.x !== undefined)
      .sort((a, b) => (order[a.c] ?? 2) - (order[b.c] ?? 2) || (a.pl ? 1 : 0) - (b.pl ? 1 : 0));
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
      const rot = this.cfg.rotate && ship && typeof o.yaw === "number" ? this.c.headingOf(o.yaw) : 0;
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
      if (wantLabel && lblMode !== "off" || important) {
        let text = o.n || CLASS_HU[o.c] || "";
        if ((o.c === "gate" || o.c === "highwayentrygate")) text = (o.c === "gate" ? "Ugrókapu" : "Szupersztráda") + " → " + (o.ds ? this.c.sectorName(o.ds) : "?");
        if (text) labels.push({ x, y: y + size / 2 + 12, text, col, pri: important ? 0 : (o.pl ? 1 : o.c === "station" || o.c === "gate" ? 2 : 3) });
      }
    }
    // labels: important first, no overlaps (like the game, names thin out instead of piling up)
    labels.sort((a, b) => a.pri - b.pri);
    const taken = [];
    g.font = `12px ${FONT}`;
    for (const L of labels) {
      const w = g.measureText(L.text).width;
      const box = [L.x - w / 2 - 2, L.y - 11, L.x + w / 2 + 2, L.y + 3];
      if (L.pri > 0 && taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      taken.push(box);
      text(g, L.text, L.x - w / 2, L.y, rgb(L.col), 12, true);
    }
    // player
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
      else drawIcon(g, iconFor(pobj), px, py, 24 * scale, col, typeof p.yaw === "number" && this.cfg.rotate ? this.c.headingOf(p.yaw) : 0);
      if (this.cfg.hull && p.hull !== undefined) hullBar(g, px, py - 24, 26, p.hull, p.shield, th);
      text(g, "TE · " + (p.name || ""), px + 22, py - 6, "#ffffff", 13, true);
      if (S.player.where && S.player.where.mode !== "pilot") text(g, this.c.whereText(S.player.where), px + 22, py + 10, "#e8eef7", 11, true);
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
    const res = sec && sec.res ? sec.res.map((r) => r.w).join(", ") : "";
    const owner = sec ? this.c.factionName(sec.owner) : "–";
    const key = [sec && sec.id, owner, nOwn, nNpc, nHostile, sc && sc.hidden, res, sc && Math.round(Date.now() / 5000)].join("|");
    if (key === this._infoKey) return;
    this._infoKey = key;
    this.info.replaceChildren(
      el("div", { class: "mi-title" }, sec ? sec.name : "–", el("span", { class: "muted" }, sec && sec.cname && sec.cname !== sec.name ? "  " + sec.cname : "")),
      el("div", {}, el("span", { class: "dot", style: { background: factionColor(sec && sec.owner, this.S.factions) } }), " " + owner),
      el("div", { class: "muted" }, `saját ${nOwn} · más ${nNpc}` + (nHostile ? ` · támadó ${nHostile}` : "") + (sc && sc.hidden ? ` · nem látható ${sc.hidden}` : "")),
      res ? el("div", { class: "muted" }, "Nyersanyag: " + res) : "",
      sc ? "" : el("div", { class: "muted" }, "még nincs szektorkép"));
  }

  // plotted course, target line, order lines of the selected own ship
  drawLines(g, sid, objs, inPlayer) {
    const S = this.S;
    const p = S.player && S.player.object;
    const th = S.theme;
    const pp = inPlayer && p && p.x !== undefined && p.x !== null ? this.toScreen(p.x, p.z) : null;
    // order queue of the selected own ship (details command, refreshed while selected)
    const sel = S.selected && S.selected.kind === "obj" ? S.selected.id : null;
    const det = sel ? S.details[sel] : null;
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
      let to = null, label = gd.n || "Kijelölt útvonal";
      if (gd.s === String(sid) && gd.x !== undefined && gd.x !== null) to = this.toScreen(gd.x, gd.z);
      else if (gd.s) {
        const path = route(S.links, String(sid), String(gd.s));
        if (path && path.length > 1) {
          const gate = objs.find((o) => (o.c === "gate" || o.c === "highwayentrygate") && o.ds === path[1]);
          if (gate) { to = this.toScreen(gate.x, gate.z); label = "Útvonal → " + this.c.sectorName(gd.s) + ` (${path.length - 1} ugrás)`; }
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
      text(g, dist(tg.dist), (pp[0] + tx) / 2 + 6, (pp[1] + ty) / 2 - 6, "rgba(255,255,255,0.85)", 11, true);
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
    const t = fmtKm(step);
    text(g, t, x0 + px / 2 - g.measureText(t).width / 2, y - 7, "rgba(220,235,255,0.9)", 11, true);
  }

  drawMini(g, sid) {
    const S = this.S;
    const cur = sid ? S.sectors.get(String(sid)) : null;
    if (!cur) return;
    const W = 210, H = 150, X = 12, Y = this.h - H - 12;
    g.save();
    roundRect(g, X, Y, W, H, 8);
    g.fillStyle = "rgba(6,12,24,0.86)"; g.fill(); g.strokeStyle = "rgba(120,170,230,0.25)"; g.stroke();
    g.clip();
    const sc = (Math.min(W, H) / 2) / (HEX * 3.2);
    const tx = (x) => X + W / 2 + (x - cur.gx) * sc, ty = (z) => Y + H / 2 - (z - cur.gz) * sc;
    for (const l of S.links) {
      const a = S.sectors.get(l.a), b = S.sectors.get(l.b);
      if (!a || !b) continue;
      if (Math.hypot(a.gx - cur.gx, a.gz - cur.gz) > HEX * 6 && Math.hypot(b.gx - cur.gx, b.gz - cur.gz) > HEX * 6) continue;
      g.strokeStyle = l.kind === "hw" ? rgb(holo(S.theme, "superhighwaycolor"), 0.7) : "rgba(255,255,255,0.4)";
      g.beginPath(); g.moveTo(tx(a.gx), ty(a.gz)); g.lineTo(tx(b.gx), ty(b.gz)); g.stroke();
    }
    const ps = S.player && S.player.sector ? S.player.sector.id : null;
    for (const s of S.sectors.values()) {
      const x = tx(s.gx), y = ty(s.gz);
      if (x < X - 30 || x > X + W + 30 || y < Y - 30 || y > Y + H + 30) continue;
      const r = (s.multi ? HEX / 2.4 : HEX * 0.92) * sc;
      g.fillStyle = factionColor(s.owner, S.factions); g.globalAlpha = 0.35; hexPath(g, x, y, r); g.fill(); g.globalAlpha = 1;
      if (s.id === String(sid)) { g.strokeStyle = "#ffffff"; g.lineWidth = 2; hexPath(g, x, y, r); g.stroke(); g.lineWidth = 1; }
      if (s.id === ps) { g.fillStyle = "#ffffff"; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
    }
    g.restore();
    text(g, cur.name, X + 8, Y + 15, "rgba(220,232,245,0.9)", 11, true);
  }

  // ---------------------------------------------------------------- galaxy view
  drawGalaxy(g, t) {
    const S = this.S;
    this.title.textContent = "Galaxis" + (S.sectors.size ? ` · ${S.sectors.size} felfedezett szektor` : "");
    this.drawBackground(g);
    const v = this.gview;
    const own = new Map(), ownSt = new Map();
    for (const e of S.property.values()) {
      if (e.k === "station") ownSt.set(e.s, (ownSt.get(e.s) || 0) + 1); else own.set(e.s, (own.get(e.s) || 0) + 1);
    }
    // links: jump gate connections (legend: plain line), superhighways (superhighwaycolor)
    for (const l of S.links) {
      const a = S.sectors.get(l.a), b = S.sectors.get(l.b);
      if (!a || !b) continue;
      const [x1, y1] = this.toScreen(a.gx, a.gz), [x2, y2] = this.toScreen(b.gx, b.gz);
      g.strokeStyle = l.kind === "hw" ? rgb(holo(S.theme, "superhighwaycolor"), 0.85) : "rgba(235,242,255,0.55)";
      g.lineWidth = l.kind === "hw" ? 2.5 : 1.4;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    g.lineWidth = 1;
    for (const st of S.stubs || []) {
      const a = S.sectors.get(st.s);
      if (!a) continue;
      const d = Math.hypot(st.x, st.z) || 1;
      const ex = a.gx + st.x / d * HEX * 1.15, ez = a.gz + st.z / d * HEX * 1.15;
      const [x1, y1] = this.toScreen(a.gx, a.gz), [x2, y2] = this.toScreen(ex, ez);
      g.strokeStyle = "rgba(235,242,255,0.35)"; g.setLineDash([2, 4]);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.setLineDash([]);
      text(g, "?", x2 - 3, y2 + 4, "rgba(235,242,255,0.8)", 13, true);
    }
    // plotted route
    const ps = S.player && S.player.sector ? S.player.sector.id : null;
    const gd = S.player && S.player.guidance;
    if (this.cfg.lines && gd && gd.s && ps) {
      const path = route(S.links, ps, String(gd.s));
      if (path && path.length > 1) {
        g.save(); g.strokeStyle = rgb(holo(S.theme, "missioncolor"), 0.95); g.lineWidth = 3.5; g.setLineDash([12, 7]);
        g.beginPath();
        path.forEach((sid, i) => { const s = S.sectors.get(sid); const [x, y] = this.toScreen(s.gx, s.gz); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.stroke(); g.restore();
      }
    }
    this.ghit = [];
    const labelOk = v.scale * HEX > 26;
    for (const s of S.sectors.values()) {
      const [x, y] = this.toScreen(s.gx, s.gz);
      const r = (s.multi ? HEX / 2.4 : HEX * 0.92) * v.scale;
      if (x < -r || y < -r || x > this.w + r || y > this.h + r) continue;
      const fc = factionColor(s.owner, S.factions);
      g.fillStyle = fc; g.globalAlpha = 0.22; hexPath(g, x, y, r); g.fill();
      g.globalAlpha = 0.75; g.strokeStyle = fc; g.lineWidth = 1.5; hexPath(g, x, y, r * 0.97); g.stroke(); g.globalAlpha = 1; g.lineWidth = 1;
      this.ghit.push({ x, y, r, s });
      const n = own.get(s.id) || 0, ns = ownSt.get(s.id) || 0;
      if ((n || ns) && r > 10) {
        const pc = holo(S.theme, "playercolor");
        drawIcon(g, "ship_s_fight_01", x + r * 0.42, y - r * 0.42, Math.max(10, Math.min(18, r / 3)), pc);
        if (labelOk) text(g, String(n + ns), x + r * 0.42 + 9, y - r * 0.42 + 4, rgb(pc), 11, true);
      }
      if (s.id === ps) {
        const ph = (performance.now() % 2000) / 2000;
        g.strokeStyle = "#ffffff"; g.lineWidth = 2.5; hexPath(g, x, y, r * (1 + 0.06 * Math.sin(ph * Math.PI * 2))); g.stroke(); g.lineWidth = 1;
        drawIcon(g, iconFor({ c: S.player.object && S.player.object.class, ic: S.player.object && S.player.object.ic }), x, y, 20, holo(S.theme, "currentplayershipcolor"));
        this.dirty = true;
      }
      if (this.viewSector === s.id) { g.strokeStyle = "rgba(255,255,255,0.8)"; g.setLineDash([4, 3]); hexPath(g, x, y, r * 1.06); g.stroke(); g.setLineDash([]); }
      const sel = S.selected;
      if (sel && sel.kind === "sector" && sel.id === s.id) brackets(g, x, y, r * 0.9, "#ffffff");
      if (labelOk && this.cfg.labels !== "off") {
        const fs = Math.max(10, Math.min(14, r / 5));
        g.font = `${fs}px ${FONT}`;
        const tw = g.measureText(s.name).width;
        text(g, s.name, x - tw / 2, y + r * 0.62, s.id === ps ? "#ffffff" : "rgba(225,234,246,0.9)", fs, true);
      }
    }
    const key = ["g", S.sectors.size, S.links.length].join("|");
    if (key !== this._infoKey) {
      this._infoKey = key;
      this.info.replaceChildren(el("div", { class: "mi-title" }, "Galaxis"),
        el("div", {}, `${S.sectors.size} szektor · ${S.links.filter((l) => l.kind === "gate").length} kapu · ${S.links.filter((l) => l.kind === "hw").length} sztráda`),
        el("div", { class: "muted" }, S.liveGalaxy && S.liveGalaxy.length ? "csak a felfedezett szektorok (a játék szerint)" : "még nincs galaxisadat a játéktól"),
        el("div", { class: "muted" }, "dupla katt: szektornézet"));
    }
  }

  pickSector(sx, sy) {
    let best = null, bd = Infinity;
    for (const h of this.ghit || []) {
      const d = Math.hypot(h.x - sx, h.y - sy);
      if (d < h.r && d < bd) { bd = d; best = h.s; }
    }
    return best;
  }

  pick(sx, sy) {
    let best = null, bd = Infinity;
    for (const h of this.hit || []) {
      const d = Math.hypot(h.x - sx, h.y - sy);
      if (d < Math.max(10, h.r) && d < bd) { bd = d; best = h.o; }
    }
    return best;
  }

  onHover(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    let o = null, label = "";
    if (this.mode === "galaxy") {
      const s = this.pickSector(sx, sy);
      if (s) { o = { id: "s" + s.id }; label = s.name + " · " + this.c.factionName(s.owner); }
    } else {
      o = this.pick(sx, sy);
      if (o) label = (o.n || CLASS_HU[o.c] || "?") + (o.code ? ` (${o.code})` : "") + (o.pl ? " · saját" : o.o ? " · " + this.c.factionName(o.o) : "") +
        (o.hull !== undefined && o.hull !== null ? ` · burkolat ${num(o.hull)}%` : "");
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
      if (s) this.c.select({ kind: "sector", id: s.id, from: "galaxy" });
      return;
    }
    const best = this.pick(sx, sy);
    if (best) this.c.select({ kind: "obj", id: best.id, from: "map", obj: best, sid: this.currentSid() });
  }
}

// ---------------------------------------------------------------- drawing helpers
function fmtKm(m) {
  const a = Math.abs(m);
  if (a >= 1000) return (m / 1000).toLocaleString("hu-HU", { maximumFractionDigits: a >= 10000 ? 0 : 1 }) + " km";
  return Math.round(m) + " m";
}
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
