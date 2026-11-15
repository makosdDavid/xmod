// X4 Companion — small dock/grid layout manager (no libraries).
// Modules live on a 12 x 12 grid: drag the header to move (snaps to cells), drag an edge or the
// corner to resize, collapse to the header, double-click the header to maximise, hide with x and
// bring back from the "Modulok" menu. The layout is saved in localStorage (x4c.dock.v2).
"use strict";
import { el } from "./util.js";
import { iconEl } from "./icons.js";

export const COLS = 12, ROWS = 12;
const KEY = "x4c.dock.v2";

export class Dock {
  constructor(root, modules, { presets, defaultPreset, onChange, single } = {}) {
    this.root = root;
    this.modules = modules;               // [{ id, title, icon, mount(modEl) }]
    this.presets = presets;
    this.defaultPreset = defaultPreset;
    this.onChange = onChange || (() => {});
    this.single = single || null;
    this.focused = null;                  // module shown maximised as a "view" (navigation)
    this.els = {};
    this.layout = this.load() || this.preset(defaultPreset);
    this.root.classList.add("dock");
    for (const m of modules) this.build(m);
    this.apply();
    this.mq = window.matchMedia("(max-width: 1100px)");
    const onMq = () => { this.root.classList.toggle("narrow", this.mq.matches); this.apply(); };
    this.mq.addEventListener("change", onMq);
    onMq();
  }

  // ------------------------------------------------------------ persistence / presets
  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!raw || !raw.mods) return null;
      for (const m of this.modules) if (!raw.mods[m.id]) raw.mods[m.id] = { x: 0, y: 0, w: 4, h: 4, hidden: true };
      return raw;
    } catch (e) { return null; }
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.layout)); } catch (e) { /* private mode */ } }
  preset(name) {
    const p = this.presets[name] || this.presets[this.defaultPreset];
    const mods = {};
    for (const m of this.modules) {
      const r = p.mods[m.id];
      mods[m.id] = r ? { x: r[0], y: r[1], w: r[2], h: r[3], hidden: false, collapsed: false } : { x: 0, y: 0, w: 4, h: 4, hidden: true, collapsed: false };
    }
    return { name, mods, z: this.modules.map((m) => m.id) };
  }
  applyPreset(name) { this.layout = this.preset(name); this.focused = null; this.save(); this.apply(); this.onChange(); }
  reset() { this.applyPreset(this.defaultPreset); }

  // ------------------------------------------------------------ DOM
  build(m) {
    const ctl = (name, title, fn) => {
      const b = el("button", { class: "mbtn", title, onclick: (e) => { e.stopPropagation(); fn(); } });
      b.appendChild(iconEl(name, 15));
      return b;
    };
    const head = el("header", { class: "phead" },
      el("span", { class: "micon" }, iconEl(m.icon, 16)),
      el("span", { class: "ptitle" }, m.title),
      el("span", { class: "ptools" }),
      el("span", { class: "mctl" },
        ctl("collapse", "Összecsukás / kinyitás", () => this.toggleCollapse(m.id)),
        ctl("max", "Teljes munkaterület (dupla katt a fejlécen)", () => this.toggleMax(m.id)),
        ctl("popout", "↗ Külön ablakba (csak erre a gombra nyílik új ablak)", () => window.open(`/?panel=${m.id}`, "x4c_" + m.id, "width=1280,height=900")),
        ctl("close", "Elrejtés (a Modulok menüből visszahozható)", () => this.hide(m.id))));
    const body = el("div", { class: "pbody" });
    const mod = el("section", { class: "mod", "data-id": m.id }, head, body);
    for (const d of ["n", "s", "e", "w", "se", "sw", "ne", "nw"]) mod.appendChild(el("div", { class: "rz rz-" + d, "data-dir": d }));
    this.root.appendChild(mod);
    this.els[m.id] = mod;
    head.addEventListener("dblclick", (e) => { if (!e.target.closest("button,input,select")) this.toggleMax(m.id); });
    head.addEventListener("pointerdown", (e) => this.startDrag(e, m.id));
    for (const h of mod.querySelectorAll(".rz")) h.addEventListener("pointerdown", (e) => this.startResize(e, m.id, h.dataset.dir));
    mod.addEventListener("pointerdown", () => this.raise(m.id), true);
    m.mount(mod);
  }

  apply() {
    const narrow = this.root.classList.contains("narrow");
    const z = this.layout.z || [];
    for (const m of this.modules) {
      const e = this.els[m.id];
      const r = this.layout.mods[m.id];
      const focused = this.focused === m.id;
      const visible = this.single ? this.single === m.id : (focused || (!this.focused && !r.hidden));
      e.hidden = !visible;
      e.classList.toggle("max", focused || r.max || this.single === m.id);
      e.classList.toggle("collapsed", !!r.collapsed && !focused && !this.single);
      if (narrow) { e.style.cssText = ""; e.style.order = String(r.y * COLS + r.x); continue; }
      e.style.left = (r.x / COLS * 100) + "%";
      e.style.top = (r.y / ROWS * 100) + "%";
      e.style.width = (r.w / COLS * 100) + "%";
      e.style.height = (r.h / ROWS * 100) + "%";
      e.style.zIndex = String(10 + Math.max(0, z.indexOf(m.id)));
    }
    window.dispatchEvent(new Event("x4c-layout"));
  }

  raise(id) {
    const z = (this.layout.z || []).filter((x) => x !== id);
    z.push(id);
    this.layout.z = z;
    const e = this.els[id];
    if (e) e.style.zIndex = String(10 + z.length);
  }

  // ------------------------------------------------------------ actions
  isVisible(id) { return !this.els[id].hidden; }
  show(id) { const r = this.layout.mods[id]; r.hidden = false; r.collapsed = false; this.raise(id); this.save(); this.apply(); this.onChange(); }
  hide(id) {
    if (this.focused === id) { this.focused = null; }
    this.layout.mods[id].hidden = true; this.layout.mods[id].max = false; this.save(); this.apply(); this.onChange();
  }
  toggle(id) { if (this.layout.mods[id].hidden) this.show(id); else this.hide(id); }
  toggleCollapse(id) {
    const r = this.layout.mods[id];
    if (this.focused === id) return;
    r.collapsed = !r.collapsed; this.save(); this.apply();
  }
  toggleMax(id) {
    if (this.focused === id) { this.focused = null; this.apply(); this.onChange(); return; }
    const r = this.layout.mods[id];
    r.max = !r.max;
    if (r.max) for (const [k, o] of Object.entries(this.layout.mods)) if (k !== id) o.max = false;
    this.raise(id); this.save(); this.apply(); this.onChange();
  }
  focus(id) { this.focused = id; this.raise(id); this.apply(); this.onChange(); }
  unfocus() {
    this.focused = null;
    for (const o of Object.values(this.layout.mods)) o.max = false;
    this.apply(); this.onChange();
  }

  // ------------------------------------------------------------ drag / resize (snap to cells)
  cell() {
    const rect = this.root.getBoundingClientRect();
    return { rect, cw: rect.width / COLS, ch: rect.height / ROWS };
  }
  startDrag(e, id) {
    if (e.button !== 0 || e.target.closest("button,input,select,a") || this.single) return;
    const r = this.layout.mods[id];
    if (this.focused === id || r.max || this.root.classList.contains("narrow")) return;
    const { cw, ch } = this.cell();
    const sx = e.clientX, sy = e.clientY, ox = r.x, oy = r.y;
    const mod = this.els[id];
    mod.classList.add("dragging");
    const move = (ev) => {
      const nx = Math.max(0, Math.min(COLS - r.w, Math.round(ox + (ev.clientX - sx) / cw)));
      const ny = Math.max(0, Math.min(ROWS - (r.collapsed ? 1 : r.h), Math.round(oy + (ev.clientY - sy) / ch)));
      if (nx !== r.x || ny !== r.y) { r.x = nx; r.y = ny; this.apply(); }
    };
    const up = () => {
      mod.classList.remove("dragging");
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      this.save(); this.onChange();
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    e.preventDefault();
  }
  startResize(e, id, dir) {
    if (e.button !== 0 || this.single) return;
    const r = this.layout.mods[id];
    if (this.focused === id || r.max) return;
    const { cw, ch } = this.cell();
    const sx = e.clientX, sy = e.clientY, o = { ...r };
    const mod = this.els[id];
    mod.classList.add("resizing");
    const move = (ev) => {
      const dx = Math.round((ev.clientX - sx) / cw), dy = Math.round((ev.clientY - sy) / ch);
      let { x, y, w, h } = o;
      if (dir.includes("e")) w = Math.max(2, Math.min(COLS - x, o.w + dx));
      if (dir.includes("s")) h = Math.max(2, Math.min(ROWS - y, o.h + dy));
      if (dir.includes("w")) { const nx = Math.max(0, Math.min(o.x + o.w - 2, o.x + dx)); w = o.w + (o.x - nx); x = nx; }
      if (dir.includes("n")) { const ny = Math.max(0, Math.min(o.y + o.h - 2, o.y + dy)); h = o.h + (o.y - ny); y = ny; }
      if (x !== r.x || y !== r.y || w !== r.w || h !== r.h) { Object.assign(r, { x, y, w, h }); this.apply(); }
    };
    const up = () => {
      mod.classList.remove("resizing");
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      this.save(); this.onChange();
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    e.preventDefault(); e.stopPropagation();
  }
}
