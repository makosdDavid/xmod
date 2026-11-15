// X4 Companion — shared helpers (no external libraries).
"use strict";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
  }
  return e;
}

const nf0 = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 1 });
export const num = (v, d = 0) => (v === null || v === undefined || Number.isNaN(+v)) ? "–" : (d ? nf1 : nf0).format(+v);

export function money(v, short = false) {
  if (v === null || v === undefined || Number.isNaN(+v)) return "–";
  v = +v;
  if (short) {
    const a = Math.abs(v);
    if (a >= 1e9) return nf1.format(v / 1e9) + " Mrd Cr";
    if (a >= 1e6) return nf1.format(v / 1e6) + " M Cr";
    if (a >= 1e4) return nf0.format(v / 1e3) + " e Cr";
  }
  return nf0.format(v) + " Cr";
}

export function dist(m) {
  if (m === null || m === undefined) return "–";
  return m >= 10000 ? nf1.format(m / 1000) + " km" : nf0.format(m) + " m";
}

export function dur(s) {
  if (s === null || s === undefined || s < 0) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}

// X4 game time (seconds since start) -> "N. nap HH:MM"
export function gameTime(t) {
  if (t === null || t === undefined) return "–";
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60);
  return `${d}. nap ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function ago(gt, now) {
  if (gt === null || gt === undefined || now === null || now === undefined) return "";
  const s = Math.max(0, now - gt);
  if (s < 60) return "most";
  if (s < 3600) return `${Math.floor(s / 60)} perce`;
  if (s < 86400) return `${Math.floor(s / 3600)} órája`;
  return `${Math.floor(s / 86400)} napja`;
}

export const CLASS_HU = {
  ship_xs: "XS", ship_s: "S", ship_m: "M", ship_l: "L", ship_xl: "XL", station: "Állomás", gate: "Kapu",
  highwayentrygate: "Szupersztráda", satellite: "Műhold", navbeacon: "Navigációs jeladó", resourceprobe: "Nyersanyag-szonda",
  lockbox: "Zárt láda", collectablewares: "Áru", collectableammo: "Lőszer", drop: "Rakomány", mine: "Akna",
  lasertower: "Lézertorony", buildstorage: "Építési raktár", crate: "Láda", datavault: "Adattároló", spacesuit: "Űrruha",
};
export const PURPOSE_HU = { trade: "Kereskedő", mine: "Bányász", fight: "Harci", build: "Építő", auxiliary: "Kiegészítő", salvage: "Mentő" };
export const LOGCAT_HU = {
  all: "Összes", alerts: "Riasztások", general: "Általános", missions: "Küldetések", news: "Hírek",
  diplomacy: "Diplomácia", upkeep: "Fenntartás", tips: "Tippek", ticker: "Értesítések", inbox: "Üzenetek",
};

export function relColor(o, factions) {
  if (!o) return "#9aa7b8";
  if (o.pl || o.o === "player") return "#3fe0c5";
  if (o.h) return "#ff4d4d";
  if (o.e) return "#ff9f43";
  const r = o.r ?? (factions && o.o && factions[o.o] ? factions[o.o].rel : null);
  if (r !== null && r !== undefined) {
    if (r >= 20) return "#5fb8ff";
    if (r >= 10) return "#7fc8ff";
    if (r <= -10) return "#ff9f43";
  }
  return "#b9c4d2";
}

export function factionColor(id, factions) {
  const f = factions && factions[id];
  if (f && f.col) return `rgb(${f.col.r},${f.col.g},${f.col.b})`;
  if (!id) return "#55606e";
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h},45%,50%)`;
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function throttle(fn, ms) {
  let last = 0, timer = null;
  return (...a) => {
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); fn(...a); }, ms - (now - last));
  };
}

// per-panel settings in localStorage (key x4c.<panel>)
export function loadSettings(panel, defaults) {
  try {
    const raw = localStorage.getItem("x4c." + panel);
    return Object.assign({}, defaults, raw ? JSON.parse(raw) : {});
  } catch (e) { return Object.assign({}, defaults); }
}
export function saveSettings(panel, obj) {
  try { localStorage.setItem("x4c." + panel, JSON.stringify(obj)); } catch (e) { /* private mode */ }
}

export function bar(pct, cls = "") {
  const p = Math.max(0, Math.min(100, +pct || 0));
  return el("span", { class: "bar " + cls, title: num(p) + " %" }, el("span", { style: { width: p + "%" } }));
}
