// X4 Companion — canvas map: galaxy view (hex clusters, gates, property) and sector view
// (km grid, centre + axes, gates, stations, ships, mini galaxy inset), auto-follow + auto-zoom.
// World coordinates: X4 metres, x = east, z = north (drawn up), height ignored.
"use strict";
import { el, num, dist, loadSettings, saveSettings, relColor, factionColor, CLASS_HU } from "./util.js";

const HEX = 1e7;                 // cluster grid edge length (vanilla menu_mapeditor.lua:163)
const SHIP_R = { ship_xs: 3, ship_s: 4, ship_m: 5, ship_l: 7, ship_xl: 9, spacesuit: 3 };
const GRID_STEPS = [500, 1000, 2000, 5000, 10000, 20000, 25000, 50000, 100000, 200000, 500000, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7];

export class MapView {
  constructor(root, ctx) {
    this.root = root;
    this.c = ctx;
    this.S = ctx.S;
    this.cfg = loadSettings("map", { labels: true, npc: true, grid: true, mini: true, autozoom: true, mode: "sector", own: true, ret: 8 });
    this.view = { cx: 0, cz: 0, scale: 0.002 };
    this.gview = { cx: 0, cz: 0, scale: 2e-6, fitted: false };
    this.viewSector = null;           // null = follow the player's sector
    this.manualUntil = 0;
    this.zoomBias = 1;
    this.lastInteract = 0;
    this.pulses = new Map();          // object id -> until (ms)
    this.dirty = true;
    this.build();
    this.bind();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- DOM
  build() {
    const r = this.root;
    this.title = r.querySelector(".ptitle");
    const tools = r.querySelector(".ptools");
    const mk = (key, label, tip) => {
      const b = el("button", { class: this.cfg[key] ? "on" : "", title: tip, onclick: () => {
        this.cfg[key] = !this.cfg[key]; b.classList.toggle("on", this.cfg[key]); saveSettings("map", this.cfg); this.dirty = true;
      } }, label);
      return b;
    };
    this.btnMode = el("button", { class: "on", title: "Galaxis / szektor nézet (g, játékbeli gyorsgomb)", onclick: () => this.toggleMode() }, "Szektor");
    this.btnAuto = el("button", { class: "on", title: "Követés be/ki (a = vissza a hajódra)", onclick: () => {
      if (this.following()) { this.manualUntil = Infinity; this.dirty = true; } else this.auto();
    } }, "Követés");
    this.selRet = el("select", { title: "Kézi mozgatás után ennyi tétlenség után magától visszaáll a követés", onchange: () => {
      this.cfg.ret = +this.selRet.value; saveSettings("map", this.cfg);
    } }, ...[[5, "vissza 5 mp"], [8, "vissza 8 mp"], [15, "vissza 15 mp"], [30, "vissza 30 mp"], [0, "nem áll vissza"]]
      .map(([v, t]) => el("option", { value: v, selected: (this.cfg.ret ?? 8) === v }, t)));
    tools.prepend(this.btnMode, this.btnAuto, this.selRet, mk("labels", "Nevek", "Feliratok"), mk("npc", "NPC", "Más frakciók hajói"),
                  mk("grid", "Rács", "Távolságrács km-skálával"), mk("mini", "Mini", "Mini galaxisnézet a sarokban"));
    this.canvas = el("canvas", { class: "mapcanvas" });
    this.info = el("div", { class: "mapinfo" });
    this.legend = el("div", { class: "maplegend" },
      el("span", { class: "lg own" }, "saját"), el("span", { class: "lg friend" }, "baráti"), el("span", { class: "lg neutral" }, "semleges"),
      el("span", { class: "lg enemy" }, "ellenséges"), el("span", { class: "lg hostile" }, "támadó"), el("span", { class: "lg gate" }, "kapu"),
      el("span", { class: "lg station" }, "állomás"));
    const body = r.querySelector(".pbody");
    this.followBadge = el("div", { class: "followbadge" });
    this.backBtn = el("button", { class: "backbtn", title: "Vissza a hajómra (a, játékbeli gyorsgomb: automata kijelző)", onclick: () => this.auto() }, "⟲ Vissza a hajómra");
    body.append(this.canvas, this.info, this.legend, this.followBadge, this.backBtn);
    this.ctx2d = this.canvas.getContext("2d");
    this.setMode(this.cfg.mode || "sector");
  }

  bind() {
    const cv = this.canvas;
    let drag = null;
    cv.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; cv.classList.add("dragging"); });
    window.addEventListener("mouseup", (e) => {
      if (drag && !drag.moved) this.click(e);
      drag = null; cv.classList.remove("dragging");
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      drag.x = e.clientX; drag.y = e.clientY;
      const v = this.v();
      v.cx -= dx / v.scale; v.cz += dy / v.scale;
      this.manual();
    });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.following()) {          // zooming while following keeps following (zoom bias)
        this.zoomBias = Math.max(0.05, Math.min(40, this.zoomBias * Math.exp(-e.deltaY * 0.0015)));
        this.dirty = true;
        return;
      }
      const v = this.v();
      const [wx, wz] = this.toWorld(e.offsetX, e.offsetY);
      const f = Math.exp(-e.deltaY * 0.0015);
      v.scale = clampScale(v.scale * f, this.mode);
      const [wx2, wz2] = this.toWorld(e.offsetX, e.offsetY);
      v.cx += wx - wx2; v.cz += wz - wz2;
      this.manual();
    }, { passive: false });
    cv.addEventListener("dblclick", (e) => {
      if (this.mode === "galaxy") {
        const s = this.pickSector(e.offsetX, e.offsetY);
        if (s) { this.showSector(s.id); }
      } else this.auto();
    });
    new ResizeObserver(() => { this.resize(); }).observe(this.root.querySelector(".pbody"));
    const b = this.c.bus;
    for (const ev of ["player", "scan", "galaxy", "property", "factions", "status"]) b.on(ev, () => { this.dirty = true; });
    b.on("hotkey", (m) => {
      if (m.action === "view_toggle") this.toggleMode();
      else if (m.action === "zoom_in") this.zoom(1.6);
      else if (m.action === "zoom_out") this.zoom(1 / 1.6);
    });
    b.on("auto", () => this.auto());
    b.on("select", (sel) => this.onSelect(sel));
    b.on("sectorchange", () => {
      // the player jumped: always go to the new sector and the ship
      this.viewSector = null; this.c.watchSector(null); this.manualUntil = 0; this.zoomBias = 1;
      this.focusObj = null; this.fitPending = true; this.setMode("sector");
    });
    b.on("alert", (items) => {
      const until = performance.now() + 20000;
      for (const e of items) if (e.ic) this.pulses.set(String(e.ic), until);
    });
    b.on("resize", () => this.resize());
  }

  v() { return this.mode === "galaxy" ? this.gview : this.view; }
  manual() {
    const ret = this.cfg.ret ?? 8;
    this.manualUntil = ret > 0 ? performance.now() + ret * 1000 : Infinity;
    this.lastInteract = performance.now();
    this.dirty = true;
  }
  following() { return performance.now() >= this.manualUntil && !this.viewSector; }
  auto() {
    this.manualUntil = 0; this.zoomBias = 1; this.viewSector = null; this.c.watchSector(null);
    this.btnAuto.classList.add("on");
    if (this.mode === "galaxy") this.gview.fitted = false;
    this.dirty = true;
  }
  zoom(f) {
    if (performance.now() < this.manualUntil) { const v = this.v(); v.scale = clampScale(v.scale * f, this.mode); }
    else this.zoomBias = Math.max(0.05, Math.min(40, this.zoomBias * f));
    this.dirty = true;
  }
  setMode(m) {
    this.mode = m;
    this.cfg.mode = m; saveSettings("map", this.cfg);
    this.btnMode.textContent = m === "galaxy" ? "Galaxis" : "Szektor";
    this.btnMode.classList.toggle("on", true);
    this.dirty = true;
  }
  toggleMode() { this.setMode(this.mode === "galaxy" ? "sector" : "galaxy"); }

  showSector(sid) {
    sid = String(sid);
    const ps = this.S.player && this.S.player.sector ? this.S.player.sector.id : null;
    this.viewSector = sid === ps ? null : sid;
    this.c.watchSector(this.viewSector);
    this.setMode("sector");
    this.fitPending = true;
    this.lastInteract = performance.now();
    this.dirty = true;
  }

  onSelect(sel) {
    if (!sel) return;
    if (sel.kind === "sector" && sel.from === "galaxy") return;
    if (sel.kind === "obj") {
      const S = this.S;
      const p = S.property.get(sel.id);
      const sid = p ? p.s : this.findScanSector(sel.id);
      if (sid) {
        const ps = S.player && S.player.sector ? S.player.sector.id : null;
        if (sid !== ps) this.showSector(sid);
        else { this.viewSector = null; this.c.watchSector(null); this.setMode("sector"); }
        this.focusObj = sel.id;
        this.manualUntil = 0;
      }
    } else if (sel.kind === "sector" && sel.from !== "galaxy") {
      this.showSector(sel.id);
    }
  }
  findScanSector(id) {
    for (const [sid, sc] of Object.entries(this.S.scans)) if ((sc.objs || sc.items || []).some((o) => o.id === id)) return sid;
    return null;
  }

  resize() {
    const b = this.root.querySelector(".pbody");
    const dpr = window.devicePixelRatio || 1;
    this.w = b.clientWidth; this.h = b.clientHeight;
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
    // gates from the gate channel if the scan has none (e.g. watched sector before the first scan)
    if (!objs.some((o) => o.c === "gate")) {
      const gs = this.S.gatesBySector.get(String(sid)) || [];
      objs = objs.concat(gs.map((g) => ({ id: g.id, c: "gate", x: g.x, z: g.z, ds: g.ds, n: "Ugrókapu" })));
    }
    // own ships known from the property list but not yet in a scan of a watched sector
    if (this.viewSector && !sc) {
      for (const e of this.S.property.values()) if (e.s === sid) objs.push({ id: e.id, c: e.c, n: e.n, pl: true, x: null, z: null, k: e.k });
    }
    return { sid, sc, objs };
  }

  // ---------------------------------------------------------------- animation loop
  frame(t) {
    requestAnimationFrame((tt) => this.frame(tt));
    if (!this.w) this.resize();
    const anim = this.updateCamera(t);
    if (!this.dirty && !anim && !this.pulses.size && !this.S.selected) return;
    this.dirty = false;
    const g = this.ctx2d;
    g.clearRect(0, 0, this.w, this.h);
    if (this.mode === "galaxy") this.drawGalaxy(g, t); else this.drawSector(g, t);
  }

  updateCamera(t) {
    const now = performance.now();
    if (this.viewSector && now - this.lastInteract > 60000 && document.body.dataset.state === "live") {
      // display mode: after a minute without interaction go back to the player's sector
      this.auto();
    }
    this.updateFollowUi(now);
    if (now < this.manualUntil) return false;
    let target;
    if (this.mode === "galaxy") target = this.autoGalaxy();
    else target = this.autoSector();
    if (!target) return false;
    const v = this.v();
    const k = this.fitPending ? 1 : 0.12;
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
    const follow = now >= this.manualUntil && !this.viewSector;
    const who = p && p.object ? (p.object.name || "hajó") : "–";
    let text, cls;
    if (follow) {
      text = "● KÖVETÉS: " + who + (p && p.where ? " · " + this.c.whereText(p.where) : "");
      cls = "on";
    } else if (this.viewSector) {
      text = "Figyelt szektor: " + this.c.sectorName(this.viewSector) + " – a hajód máshol van";
      cls = "off";
    } else {
      const left = this.manualUntil === Infinity ? null : Math.ceil((this.manualUntil - now) / 1000);
      text = "Kézi nézet" + (left !== null ? ` – követés ${left} mp múlva magától` : " – a követés ki van kapcsolva");
      cls = "off";
    }
    if (this.mode === "galaxy") { text = follow ? "● KÖVETÉS: " + (p && p.sector ? p.sector.name : "") : text; }
    if (this._fbText !== text) { this.followBadge.textContent = text; this._fbText = text; }
    this.followBadge.className = "followbadge " + cls;
    this.backBtn.hidden = follow;
    this.btnAuto.classList.toggle("on", follow);
    if (!follow) this.dirty = true;
  }

  autoSector() {
    const S = this.S;
    const { sid, objs } = this.objects();
    const p = S.player && S.player.object;
    const inPlayerSector = !this.viewSector;
    const pts = [];
    let center;
    if (inPlayerSector && p && p.x !== null && p.x !== undefined) {
      center = [p.x, p.z];
      pts.push(center);
      const near = (cls) => {
        let best = null, bd = Infinity;
        for (const o of objs) if (cls(o) && o.x !== null && o.x !== undefined) {
          const d = Math.hypot(o.x - p.x, o.z - p.z);
          if (d < bd) { bd = d; best = o; }
        }
        return best;
      };
      const gate = near((o) => o.c === "gate" || o.c === "highwayentrygate");
      const st = near((o) => o.c === "station");
      for (const o of [gate, st]) if (o) pts.push([o.x, o.z]);
      if (S.player.target && S.player.target.x !== undefined && S.player.target.sector === sid) pts.push([S.player.target.x, S.player.target.z]);
    } else {
      const focus = this.focusObj && objs.find((o) => o.id === this.focusObj && o.x !== null);
      for (const o of objs) if (o.x !== null && o.x !== undefined && (o.pl || o.c === "gate" || o.c === "station")) pts.push([o.x, o.z]);
      if (focus) { center = [focus.x, focus.z]; pts.length = 0; pts.push(center); for (const o of objs) if (o.c === "gate" && o.x !== null) pts.push([o.x, o.z]); }
    }
    if (!pts.length) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    let cx, cz, hw, hh;
    if (center) {
      cx = center[0]; cz = center[1];
      hw = Math.max(Math.abs(x0 - cx), Math.abs(x1 - cx)); hh = Math.max(Math.abs(z0 - cz), Math.abs(z1 - cz));
    } else {
      cx = (x0 + x1) / 2; cz = (z0 + z1) / 2; hw = (x1 - x0) / 2; hh = (z1 - z0) / 2;
    }
    const half = Math.max(8000, Math.min(500000, Math.max(hw, hh) * 1.25));
    const scale = clampScale((Math.min(this.w, this.h) / 2) / half * this.zoomBias, "sector");
    return { cx, cz, scale };
  }

  autoGalaxy() {
    const S = this.S;
    if (!S.sectors.size) return null;
    const ps = S.player && S.player.sector ? S.sectors.get(S.player.sector.id) : null;
    if (ps) {
      // show the player's sector with a few rings of neighbours
      return { cx: ps.gx, cz: ps.gz, scale: clampScale((Math.min(this.w, this.h) / 2) / (HEX * 7) * this.zoomBias, "galaxy") };
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const s of S.sectors.values()) { x0 = Math.min(x0, s.gx); x1 = Math.max(x1, s.gx); z0 = Math.min(z0, s.gz); z1 = Math.max(z1, s.gz); }
    const half = Math.max(x1 - x0, z1 - z0) / 2 + HEX;
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, scale: (Math.min(this.w, this.h) / 2) / half * this.zoomBias };
  }

  // ---------------------------------------------------------------- sector view
  drawSector(g, t) {
    const S = this.S;
    const { sid, sc, objs } = this.objects();
    const sec = sid ? S.sectors.get(String(sid)) : null;
    const v = this.view;
    const p = S.player && S.player.object;
    const inPlayer = !this.viewSector;
    this.title.textContent = (sec ? sec.name : (S.player && S.player.sector ? S.player.sector.name : "Szektor")) +
      (this.viewSector ? " (figyelt szektor)" : "");
    // background + grid
    g.fillStyle = "#060a11"; g.fillRect(0, 0, this.w, this.h);
    if (this.cfg.grid) this.drawGrid(g);
    // sector centre and axes
    const [ox, oy] = this.toScreen(0, 0);
    g.strokeStyle = "rgba(120,170,220,0.35)"; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(0, oy); g.lineTo(this.w, oy); g.moveTo(ox, 0); g.lineTo(ox, this.h); g.stroke();
    g.strokeStyle = "rgba(160,200,240,0.8)";
    g.beginPath(); g.arc(ox, oy, 6, 0, Math.PI * 2); g.moveTo(ox - 10, oy); g.lineTo(ox + 10, oy); g.moveTo(ox, oy - 10); g.lineTo(ox, oy + 10); g.stroke();
    label(g, "szektor közepe", ox + 9, oy + 14, "rgba(160,200,240,0.8)", 11);
    label(g, "É", ox + 4, 14, "rgba(160,200,240,0.7)", 11); label(g, "K", this.w - 14, oy - 5, "rgba(160,200,240,0.7)", 11);

    const occupied = new Set();
    const canLabel = (x, y) => {
      const k = Math.round(x / 90) + ":" + Math.round(y / 18);
      if (occupied.has(k)) return false;
      occupied.add(k); return true;
    };
    const now = performance.now();
    // draw order: gates, stations, others, own, player
    const order = { gate: 0, highwayentrygate: 0, station: 1 };
    const sorted = objs.filter((o) => o.x !== null && o.x !== undefined).sort((a, b) => (order[a.c] ?? 2) - (order[b.c] ?? 2) || (a.pl ? 1 : 0) - (b.pl ? 1 : 0));
    this.hit = [];
    let nNpc = 0, nOwn = 0, nHostile = 0;
    for (const o of sorted) {
      if (p && inPlayer && o.id === p.id) continue;
      const isShip = o.c && o.c.startsWith("ship");
      if (isShip && !o.pl && !this.cfg.npc) continue;
      const [x, y] = this.toScreen(o.x, o.z);
      if (x < -40 || y < -40 || x > this.w + 40 || y > this.h + 40) continue;
      const col = relColor(o, S.factions);
      if (o.c === "gate" || o.c === "highwayentrygate") {
        const hw = o.c === "highwayentrygate";
        g.fillStyle = hw ? "#58a6ff" : "#ffd54a";
        g.strokeStyle = "#000";
        diamond(g, x, y, hw ? 6 : 9);
        const dn = o.ds ? this.c.sectorName(o.ds) : (o.du ? "?" : "");
        if (this.cfg.labels && canLabel(x, y)) label(g, (hw ? "Sztráda" : "Kapu") + (dn && dn !== "?" ? " → " + dn : ""), x + 11, y + 4, hw ? "#8cc4ff" : "#ffe48a", 12, true);
      } else if (o.c === "station") {
        g.fillStyle = o.pl ? "#3fe0c5" : col;
        g.strokeStyle = "#000";
        g.fillRect(x - 6, y - 6, 12, 12); g.strokeRect(x - 6, y - 6, 12, 12);
        if (this.cfg.labels && (canLabel(x, y) || o.pl)) label(g, o.n || "Állomás", x + 9, y + 4, o.pl ? "#7ff2dd" : "#d7e0ea", 12, true);
      } else if (isShip) {
        if (o.pl) nOwn++; else nNpc++;
        if (o.h) nHostile++;
        const r = SHIP_R[o.c] || 4;
        g.fillStyle = col;
        if (typeof o.yaw === "number") tri(g, x, y, r, this.c.headingOf(o.yaw)); else { g.beginPath(); g.arc(x, y, r * 0.7, 0, Math.PI * 2); g.fill(); }
        if (this.cfg.labels && (o.pl || o.h || r >= 7) && v.scale > 0.0015 && canLabel(x, y)) label(g, o.n || "", x + r + 3, y + 3, o.pl ? "#9ff5e6" : col, 11);
      } else {
        g.fillStyle = o.pl ? "#3fe0c5" : "#8a96a6";
        g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
      }
      const pu = this.pulses.get(o.id);
      if (pu) {
        if (pu < now) this.pulses.delete(o.id);
        else { const ph = (now % 1000) / 1000; g.strokeStyle = `rgba(255,70,70,${1 - ph})`; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 8 + ph * 18, 0, Math.PI * 2); g.stroke(); }
      }
      this.hit.push({ x, y, o });
    }
    // target + player
    const tg = S.player && S.player.target;
    if (inPlayer && p && p.x !== null && p.x !== undefined) {
      const [px, py] = this.toScreen(p.x, p.z);
      if (tg && tg.x !== undefined && tg.x !== null && tg.sector === sid) {
        const [tx, ty] = this.toScreen(tg.x, tg.z);
        g.strokeStyle = "rgba(255,120,80,0.6)"; g.setLineDash([5, 5]); g.beginPath(); g.moveTo(px, py); g.lineTo(tx, ty); g.stroke(); g.setLineDash([]);
        g.strokeStyle = "#ff7a50"; g.lineWidth = 2; g.beginPath(); g.arc(tx, ty, 11, 0, Math.PI * 2); g.stroke(); g.lineWidth = 1;
        label(g, `${tg.name || ""} · ${dist(tg.dist)}`, tx + 14, ty - 8, "#ffb199", 12, true);
      }
      const ph = (performance.now() % 1600) / 1600;
      g.strokeStyle = `rgba(255,236,120,${0.9 - ph * 0.7})`; g.lineWidth = 2;
      g.beginPath(); g.arc(px, py, 16 + ph * 10, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = "#ffe878"; g.lineWidth = 2; g.beginPath(); g.arc(px, py, 15, 0, Math.PI * 2); g.stroke();
      g.fillStyle = "#ffe878"; g.strokeStyle = "#000"; g.lineWidth = 1.5;
      const mode = S.player.where ? S.player.where.mode : "pilot";
      if (mode === "station" || mode === "aboard" || mode === "spacesuit") { g.beginPath(); g.arc(px, py, 6, 0, Math.PI * 2); g.fill(); g.stroke(); }
      else arrow(g, px, py, 12, typeof p.yaw === "number" ? this.c.headingOf(p.yaw) : 0);
      g.lineWidth = 1;
      label(g, "TE · " + (p.name || ""), px + 20, py - 6, "#ffe878", 14, true);
      if (S.player.where && S.player.where.mode !== "pilot") label(g, this.c.whereText(S.player.where), px + 20, py + 10, "#ffe878", 11, true);
      this.dirty = true;   // pulse animation
    }
    // selection ring
    const sel = S.selected;
    if (sel && sel.kind === "obj") {
      const h = this.hit.find((q) => q.o.id === sel.id);
      if (h) { const ph = (now % 1500) / 1500; g.strokeStyle = "#ffffff"; g.lineWidth = 1.5; g.beginPath(); g.arc(h.x, h.y, 12 + 4 * Math.sin(ph * Math.PI * 2), 0, Math.PI * 2); g.stroke(); g.lineWidth = 1; }
    }
    this.drawScale(g);
    if (this.cfg.mini) this.drawMini(g, sid);
    const res = sec && sec.res ? sec.res.map((r) => r.w).join(", ") : "";
    const owner = sec ? this.c.factionName(sec.owner) : "–";
    this.info.textContent = "";
    this.info.append(
      el("div", {}, el("b", {}, sec ? sec.name : "–"), "  ", el("span", { class: "muted" }, sec ? sec.cname || "" : "")),
      el("div", {}, `Tulajdonos: ${owner}`),
      el("div", {}, `Saját: ${nOwn} · más: ${nNpc}` + (nHostile ? ` · támadó: ${nHostile}` : "") + (sc && sc.hidden ? ` · nem látható: ${sc.hidden}` : "")),
      res ? el("div", { class: "muted" }, "Nyersanyag: " + res) : "",
      sc ? el("div", { class: "muted" }, "frissítve " + Math.max(0, Math.round(Date.now() / 1000 - sc.at)) + " mp-e") : el("div", { class: "muted" }, "még nincs szektorkép"),
    );
  }

  drawGrid(g) {
    const v = this.view;
    let step = GRID_STEPS[GRID_STEPS.length - 1];
    for (const s of GRID_STEPS) if (s * v.scale >= 70) { step = s; break; }
    const [wx0, wz1] = this.toWorld(0, 0), [wx1, wz0] = this.toWorld(this.w, this.h);
    g.strokeStyle = "rgba(70,100,140,0.22)"; g.lineWidth = 1;
    g.beginPath();
    for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) { const [sx] = this.toScreen(x, 0); g.moveTo(sx, 0); g.lineTo(sx, this.h); }
    for (let z = Math.ceil(wz0 / step) * step; z <= wz1; z += step) { const [, sy] = this.toScreen(0, z); g.moveTo(0, sy); g.lineTo(this.w, sy); }
    g.stroke();
    g.fillStyle = "rgba(130,160,200,0.55)"; g.font = "10px Segoe UI, sans-serif";
    for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) { if (Math.abs(x) < 1) continue; const [sx] = this.toScreen(x, 0); g.fillText(fmtKm(x), sx + 3, this.h - 6); }
    for (let z = Math.ceil(wz0 / step) * step; z <= wz1; z += step) { if (Math.abs(z) < 1) continue; const [, sy] = this.toScreen(0, z); g.fillText(fmtKm(z), 4, sy - 3); }
    this.gridStep = step;
  }

  drawScale(g) {
    const step = this.gridStep || 10000;
    const px = step * this.view.scale;
    const x1 = this.w - 20, x0 = x1 - px, y = this.h - 26;
    g.strokeStyle = "#cfe3ff"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x0, y - 5); g.lineTo(x0, y); g.lineTo(x1, y); g.lineTo(x1, y - 5); g.stroke(); g.lineWidth = 1;
    label(g, fmtKm(step), x0 + px / 2 - 14, y - 8, "#cfe3ff", 12, true);
  }

  drawMini(g, sid) {
    const S = this.S;
    const cur = sid ? S.sectors.get(String(sid)) : null;
    if (!cur) return;
    const W = 230, H = 170, X = 10, Y = this.h - H - 10;
    g.save();
    g.fillStyle = "rgba(8,14,24,0.88)"; g.strokeStyle = "rgba(90,130,180,0.6)";
    g.fillRect(X, Y, W, H); g.strokeRect(X, Y, W, H);
    g.beginPath(); g.rect(X, Y, W, H); g.clip();
    const sc = (Math.min(W, H) / 2) / (HEX * 3.2);
    const tx = (x) => X + W / 2 + (x - cur.gx) * sc, ty = (z) => Y + H / 2 - (z - cur.gz) * sc;
    g.strokeStyle = "rgba(255,213,74,0.55)";
    for (const l of S.links) {
      const a = S.sectors.get(l.a), b = S.sectors.get(l.b);
      if (!a || !b) continue;
      if (Math.hypot(a.gx - cur.gx, a.gz - cur.gz) > HEX * 6 && Math.hypot(b.gx - cur.gx, b.gz - cur.gz) > HEX * 6) continue;
      g.setLineDash(l.kind === "hw" ? [3, 3] : []);
      g.beginPath(); g.moveTo(tx(a.gx), ty(a.gz)); g.lineTo(tx(b.gx), ty(b.gz)); g.stroke();
    }
    g.setLineDash([]);
    const ps = S.player && S.player.sector ? S.player.sector.id : null;
    for (const s of S.sectors.values()) {
      const x = tx(s.gx), y = ty(s.gz);
      if (x < X - 30 || x > X + W + 30 || y < Y - 30 || y > Y + H + 30) continue;
      g.fillStyle = factionColor(s.owner, S.factions);
      g.globalAlpha = 0.55;
      hexPath(g, x, y, (s.multi ? HEX / 2.4 : HEX * 0.92) * sc); g.fill();
      g.globalAlpha = 1;
      if (s.id === String(sid)) { g.strokeStyle = "#ffffff"; g.lineWidth = 2; hexPath(g, x, y, (s.multi ? HEX / 2.4 : HEX * 0.92) * sc); g.stroke(); g.lineWidth = 1; }
      if (s.id === ps) { g.fillStyle = "#ffffff"; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
      if (Math.abs(x - (X + W / 2)) < 80 && Math.abs(y - (Y + H / 2)) < 60) label(g, s.name, x - 30, y + 14, "rgba(220,230,240,0.85)", 9);
    }
    g.restore();
    label(g, "galaxis", X + 6, Y + 13, "rgba(160,190,220,0.8)", 10);
  }

  // ---------------------------------------------------------------- galaxy view
  drawGalaxy(g, t) {
    const S = this.S;
    this.title.textContent = "Galaxis" + (S.sectors.size ? ` (${S.sectors.size} szektor)` : "");
    g.fillStyle = "#05080e"; g.fillRect(0, 0, this.w, this.h);
    const v = this.gview;
    const own = new Map(), ownSt = new Map();
    for (const e of S.property.values()) {
      if (e.k === "station") ownSt.set(e.s, (ownSt.get(e.s) || 0) + 1); else own.set(e.s, (own.get(e.s) || 0) + 1);
    }
    // cluster outlines
    g.strokeStyle = "rgba(80,110,150,0.35)";
    for (const c of S.clusters.values()) {
      const [x, y] = this.toScreen(c.gx, c.gz);
      if (x < -200 || y < -200 || x > this.w + 200 || y > this.h + 200) continue;
      hexPath(g, x, y, HEX * 0.98 * v.scale); g.stroke();
    }
    // links
    for (const l of S.links) {
      const a = S.sectors.get(l.a), b = S.sectors.get(l.b);
      if (!a || !b) continue;
      const [x1, y1] = this.toScreen(a.gx, a.gz), [x2, y2] = this.toScreen(b.gx, b.gz);
      g.strokeStyle = l.kind === "hw" ? "rgba(88,166,255,0.7)" : "rgba(255,213,74,0.55)";
      g.setLineDash(l.kind === "hw" ? [5, 4] : []);
      g.lineWidth = l.kind === "hw" ? 2 : 1.3;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    g.setLineDash([]); g.lineWidth = 1;
    for (const st of S.stubs || []) {
      const a = S.sectors.get(st.s);
      if (!a) continue;
      const d = Math.hypot(st.x, st.z) || 1;
      const ex = a.gx + st.x / d * HEX * 1.15, ez = a.gz + st.z / d * HEX * 1.15;
      const [x1, y1] = this.toScreen(a.gx, a.gz), [x2, y2] = this.toScreen(ex, ez);
      g.strokeStyle = "rgba(255,213,74,0.45)"; g.setLineDash([2, 4]);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.setLineDash([]);
      label(g, "?", x2 - 3, y2 + 4, "#ffd54a", 13, true);
    }
    const ps = S.player && S.player.sector ? S.player.sector.id : null;
    this.ghit = [];
    const labelOk = v.scale * HEX > 26;
    for (const s of S.sectors.values()) {
      const [x, y] = this.toScreen(s.gx, s.gz);
      const r = (s.multi ? HEX / 2.4 : HEX * 0.92) * v.scale;
      if (x < -r || y < -r || x > this.w + r || y > this.h + r) continue;
      g.fillStyle = factionColor(s.owner, S.factions);
      g.globalAlpha = 0.33; hexPath(g, x, y, r); g.fill(); g.globalAlpha = 1;
      g.strokeStyle = "rgba(160,190,220,0.35)"; hexPath(g, x, y, r); g.stroke();
      this.ghit.push({ x, y, r, s });
      const n = own.get(s.id) || 0, ns = ownSt.get(s.id) || 0;
      if (n || ns) {
        g.fillStyle = "#3fe0c5"; g.beginPath(); g.arc(x + r * 0.45, y - r * 0.45, Math.max(5, Math.min(11, 4 + Math.sqrt(n + ns))), 0, Math.PI * 2); g.fill();
        if (labelOk) label(g, String(n + ns), x + r * 0.45 - 4, y - r * 0.45 + 4, "#002", 10);
        if (ns) { g.fillStyle = "#3fe0c5"; g.fillRect(x - r * 0.55 - 4, y - r * 0.45 - 4, 8, 8); }
      }
      if (s.id === ps) {
        const ph = (performance.now() % 2000) / 2000;
        g.strokeStyle = "#ffffff"; g.lineWidth = 2; hexPath(g, x, y, r * (1 + 0.08 * Math.sin(ph * Math.PI * 2))); g.stroke(); g.lineWidth = 1;
        g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
        this.dirty = true;
      }
      if (this.viewSector === s.id) { g.strokeStyle = "#ffd54a"; g.setLineDash([4, 3]); hexPath(g, x, y, r * 1.06); g.stroke(); g.setLineDash([]); }
      const sel = S.selected;
      if (sel && sel.kind === "sector" && sel.id === s.id) { g.strokeStyle = "#ffffff"; g.setLineDash([2, 2]); hexPath(g, x, y, r * 1.12); g.stroke(); g.setLineDash([]); }
      if (labelOk && this.cfg.labels) {
        const fs = Math.max(9, Math.min(13, r / 5));
        g.font = `${fs}px Segoe UI, sans-serif`;
        const tw = g.measureText(s.name).width;
        label(g, s.name, x - tw / 2, y + r * 0.62, s.id === ps ? "#ffffff" : "rgba(220,230,240,0.85)", fs);
      }
    }
    this.info.textContent = "";
    this.info.append(el("div", {}, el("b", {}, "Galaxis")),
      el("div", {}, `${S.sectors.size} szektor · ${S.links.filter((l) => l.kind === "gate").length} kapu · ${S.links.filter((l) => l.kind === "hw").length} sztráda`),
      el("div", { class: "muted" }, S.liveGalaxy && S.liveGalaxy.length ? "csak a felfedezett szektorok (a játék szerint)" : "még nincs galaxisadat a játéktól"),
      el("div", { class: "muted" }, "dupla katt: szektornézet"));
  }

  pickSector(sx, sy) {
    let best = null, bd = Infinity;
    for (const h of this.ghit || []) {
      const d = Math.hypot(h.x - sx, h.y - sy);
      if (d < h.r && d < bd) { bd = d; best = h.s; }
    }
    return best;
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
    let best = null, bd = 14;
    for (const h of this.hit || []) {
      const d = Math.hypot(h.x - sx, h.y - sy);
      if (d < bd) { bd = d; best = h.o; }
    }
    if (best) this.c.select({ kind: "obj", id: best.id, from: "map", obj: best, sid: this.currentSid() });
    else {
      const p = this.S.player && this.S.player.object;
      if (p) {
        const [px, py] = this.toScreen(p.x, p.z);
        if (Math.hypot(px - sx, py - sy) < 14) this.c.select({ kind: "obj", id: p.id, from: "map", obj: { ...p, c: p.class, pl: true }, sid: this.currentSid() });
      }
    }
  }
}

// ---------------------------------------------------------------- drawing helpers
function clampScale(s, mode) {
  return mode === "galaxy" ? Math.max(1e-8, Math.min(2e-5, s)) : Math.max(2e-5, Math.min(0.5, s));
}
function fmtKm(m) {
  const a = Math.abs(m);
  if (a >= 1000) return (m / 1000).toLocaleString("hu-HU", { maximumFractionDigits: a >= 10000 ? 0 : 1 }) + " km";
  return Math.round(m) + " m";
}
function label(g, text, x, y, color, size = 11, shadow = false) {
  g.font = `${size}px Segoe UI, sans-serif`;
  if (shadow) { g.fillStyle = "rgba(0,0,0,0.75)"; g.fillText(text, x + 1, y + 1); }
  g.fillStyle = color; g.fillText(text, x, y);
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
function diamond(g, x, y, r) {
  g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.fill(); g.stroke();
}
function tri(g, x, y, r, h) {        // h: heading, radians clockwise from north (x = sin h, z = cos h)
  const fx = Math.sin(h), fy = -Math.cos(h);
  const lx = -fy, ly = fx;
  g.beginPath();
  g.moveTo(x + fx * r * 1.4, y + fy * r * 1.4);
  g.lineTo(x - fx * r + lx * r * 0.8, y - fy * r + ly * r * 0.8);
  g.lineTo(x - fx * r - lx * r * 0.8, y - fy * r - ly * r * 0.8);
  g.closePath(); g.fill();
}
function arrow(g, x, y, r, h) {
  const fx = Math.sin(h), fy = -Math.cos(h);
  const lx = -fy, ly = fx;
  g.beginPath();
  g.moveTo(x + fx * r, y + fy * r);
  g.lineTo(x - fx * r * 0.7 + lx * r * 0.7, y - fy * r * 0.7 + ly * r * 0.7);
  g.lineTo(x - fx * r * 0.3, y - fy * r * 0.3);
  g.lineTo(x - fx * r * 0.7 - lx * r * 0.7, y - fy * r * 0.7 - ly * r * 0.7);
  g.closePath(); g.fill(); g.stroke();
}
