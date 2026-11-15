// X4 Companion — list panels: property, logbook/notifications, missions, factions, economy, diagnostics,
// and the details drawer. Each panel keeps its own settings in localStorage (x4c.<panel>).
"use strict";
import { $, el, num, money, dist, dur, gameTime, ago, bar, throttle, loadSettings, saveSettings,
         CLASS_HU, PURPOSE_HU, LOGCAT_HU, relColor, factionColor } from "./util.js";

let CTX = null;      // property context (for shipOrder)
let LOG = null;      // log panel instance

// ================================================================ property
const PROP_COLS = [
  ["n", "Név"], ["code", "Azon."], ["c", "Oszt."], ["p", "Szerep"], ["s", "Szektor"], ["hull", "Burk."],
  ["shield", "Pajzs"], ["on", "Parancs"], ["fl", "Flotta / parancsnok"],
];
const FILTERS = [["all", "Mind"], ["ship", "Hajók"], ["station", "Állomások"], ["ship_s", "S"], ["ship_m", "M"], ["ship_l", "L"],
                 ["ship_xl", "XL"], ["trade", "Keresk."], ["mine", "Bány."], ["fight", "Harci"], ["damaged", "Sérült"], ["here", "Itt"]];

export function mountProperty(root, ctx) {
  CTX = ctx;
  const { S, bus, select, sectorName } = ctx;
  const cfg = loadSettings("property", { sort: "n", dir: 1, filter: "all", q: "", tree: false });
  const body = root.querySelector(".pbody");
  const tools = root.querySelector(".ptools");
  const search = el("input", { type: "search", placeholder: "Keresés ( / )", value: cfg.q, title: "Név, azonosító, szektor, parancs" });
  const treeBtn = el("button", { class: cfg.tree ? "on" : "", title: "Flottafa: alárendeltek a parancsnokuk alatt" }, "Fa");
  tools.prepend(search, treeBtn);
  const chips = el("div", { class: "chips" });
  for (const [k, label] of FILTERS) {
    chips.appendChild(el("button", { class: cfg.filter === k ? "on" : "", "data-f": k, onclick: () => {
      cfg.filter = k; save(); for (const b of chips.children) b.classList.toggle("on", b.dataset.f === k); render();
    } }, label));
  }
  const summary = el("div", { class: "psummary" });
  const table = el("table", { class: "grid" });
  const thead = el("thead");
  const tr = el("tr");
  for (const [k, label] of PROP_COLS) {
    tr.appendChild(el("th", { "data-k": k, onclick: () => { if (cfg.sort === k) cfg.dir = -cfg.dir; else { cfg.sort = k; cfg.dir = 1; } save(); render(); } }, label));
  }
  thead.appendChild(tr);
  const tbody = el("tbody");
  table.append(thead, tbody);
  const scroller = el("div", { class: "scroll" }, table);
  body.append(chips, summary, scroller);
  function save() { cfg.q = search.value; saveSettings("property", cfg); }
  search.addEventListener("input", throttle(() => { save(); render(); }, 150));
  treeBtn.addEventListener("click", () => { cfg.tree = !cfg.tree; treeBtn.classList.toggle("on", cfg.tree); save(); render(); });

  ctx.rows = [];
  function matches(e, q, here) {
    const f = cfg.filter;
    if (f === "ship" && e.k !== "ship") return false;
    if (f === "station" && e.k !== "station") return false;
    if (f.startsWith("ship_") && e.c !== f) return false;
    if (["trade", "mine", "fight"].includes(f) && e.p !== f) return false;
    if (f === "damaged" && !((e.hull ?? 100) < 70)) return false;
    if (f === "here" && e.s !== here) return false;
    if (!q) return true;
    const hay = `${e.n || ""} ${e.code || ""} ${sectorName(e.s)} ${e.on || ""} ${e.fl || ""} ${CLASS_HU[e.c] || e.c || ""}`.toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }
  function val(e, k) {
    if (k === "s") return sectorName(e.s);
    if (k === "c") return ({ ship_xs: 0, ship_s: 1, ship_m: 2, ship_l: 3, ship_xl: 4, station: 5 })[e.c] ?? 9;
    if (k === "fl") return e.fl || (e.cmd ? (S.property.get(e.cmd) || {}).n || "" : "");
    return e[k] ?? "";
  }
  function render() {
    const q = search.value.trim().toLowerCase();
    const here = S.player && S.player.sector ? S.player.sector.id : null;
    let list = [...S.property.values()].filter((e) => matches(e, q, here));
    const k = cfg.sort, d = cfg.dir;
    list.sort((a, b) => {
      const va = val(a, k), vb = val(b, k);
      return (typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "hu")) * d;
    });
    if (cfg.tree && !q) {
      const byCmd = new Map();
      const ids = new Set(list.map((e) => e.id));
      for (const e of list) if (e.cmd && ids.has(e.cmd)) { if (!byCmd.has(e.cmd)) byCmd.set(e.cmd, []); byCmd.get(e.cmd).push(e); }
      const out = [];
      const walk = (e, depth) => { e._depth = depth; out.push(e); for (const c of byCmd.get(e.id) || []) if (depth < 6) walk(c, depth + 1); };
      for (const e of list) if (!(e.cmd && ids.has(e.cmd))) walk(e, 0);
      list = out;
    } else for (const e of list) e._depth = 0;
    ctx.rows = list.map((e) => e.id);
    for (const th of thead.querySelectorAll("th")) th.classList.toggle("sorted", th.dataset.k === k);
    const frag = document.createDocumentFragment();
    const selId = S.selected && S.selected.kind === "obj" ? S.selected.id : null;
    for (const e of list.slice(0, 1500)) {
      const r = el("tr", { "data-id": e.id, class: (e.id === selId ? "sel " : "") + ((e.hull ?? 100) < 40 ? "dmg" : ""), onclick: () => select({ kind: "obj", id: e.id, from: "property" }) },
        el("td", { class: "name", style: { paddingLeft: (6 + e._depth * 14) + "px" } }, e._depth ? "└ " : "", e.k === "station" ? "▣ " : "", e.n || "–"),
        el("td", { class: "mono" }, e.code || ""),
        el("td", {}, CLASS_HU[e.c] || e.c || ""),
        el("td", {}, PURPOSE_HU[e.p] || e.p || (e.k === "station" ? (e.mods ? e.mods + " modul" : "") : "")),
        el("td", { class: e.s === here ? "here" : "" }, sectorName(e.s)),
        el("td", {}, bar(e.hull, "hull")),
        el("td", {}, e.k === "ship" ? bar(e.shield, "shield") : (e.money !== undefined ? money(e.money, true) : "")),
        el("td", { title: e.od || "" }, e.k === "ship" ? (e.on || "–") + (e.odf ? " (alap)" : "") : (e.wfc ? `munkaerő ${num(e.wf)}/${num(e.wfc)}` : "")),
        el("td", {}, e.fl || (e.cmd ? "↑ " + ((S.property.get(e.cmd) || {}).n || "?") : "")));
      frag.appendChild(r);
    }
    tbody.replaceChildren(frag);
    const ships = [...S.property.values()].filter((e) => e.k === "ship").length;
    const stations = S.property.size - ships;
    const shown = list.length;
    summary.textContent = `${ships} hajó · ${stations} állomás` + (shown !== S.property.size ? ` · szűrve: ${shown}` : "") +
      (S.propertyMeta && S.propertyMeta.at ? "" : " · várakozás a játékra…");
  }
  const r = throttle(render, 700);
  bus.on("property", r);
  bus.on("galaxy", r);
  bus.on("select", () => {
    r();
    const id = S.selected && S.selected.kind === "obj" ? S.selected.id : null;
    if (id) setTimeout(() => { const row = tbody.querySelector(`tr[data-id="${id}"]`); if (row) row.scrollIntoView({ block: "nearest" }); }, 750);
  });
  render();
}

export function shipOrder() {
  if (!CTX) return [];
  const rows = CTX.rows && CTX.rows.length ? CTX.rows : [...CTX.S.property.keys()];
  return rows.filter((id) => (CTX.S.property.get(id) || {}).k === "ship");
}

// ================================================================ logbook / notifications
const LOG_TABS = ["all", "alerts", "general", "missions", "news", "diplomacy", "upkeep", "tips", "ticker", "inbox"];

export function mountLog(root, ctx) {
  const { S, bus, select } = ctx;
  const cfg = loadSettings("log", { cat: "all", read: {} });
  root.classList.add("logpanel");
  const tabs = el("div", { class: "chips logtabs" });
  const list = el("div", { class: "scroll loglist" });
  const tools = el("div", { class: "logtools" },
    el("button", { onclick: () => markAllRead(), title: "Minden olvasott (játékbeli gyorsgomb: riasztások nyugtázása)" }, "Mind olvasott"));
  root.append(tabs, tools, list);
  const counts = {};
  const btns = {};
  for (const k of LOG_TABS) {
    btns[k] = el("button", { "data-c": k, onclick: () => setCat(k) }, LOGCAT_HU[k], el("span", { class: "badge" }));
    tabs.appendChild(btns[k]);
  }
  function key(e) { return `${e.cat}|${e.t}|${e.ti}`; }
  function readT(cat) { return cfg.read[cat] ?? -1; }
  function entries(cat) {
    if (cat === "ticker") return S.ticker.map((e) => ({ ...e, cat: "ticker" }));
    if (cat === "inbox") return (S.messages && S.messages.items || []).map((e) => ({ ...e, cat: "inbox", _unread: !e.rd }));
    return cat === "all" ? S.log : S.log.filter((e) => e.cat === cat);
  }
  function unread(cat) {
    if (cat === "inbox") return S.messages && S.messages.unread ? (S.messages.unread.highprio || 0) + (S.messages.unread.lowprio || 0) : 0;
    const list = entries(cat);
    const t = readT(cat === "all" ? "all" : cat);
    let n = 0;
    for (let i = list.length - 1; i >= 0 && n < 99; i--) { if ((list[i].t ?? 0) > t) n++; else break; }
    return n;
  }
  function setCat(c) {
    cfg.cat = c; saveSettings("log", cfg);
    for (const [k, b] of Object.entries(btns)) b.classList.toggle("on", k === c);
    render(true);
  }
  function render(scrollTop) {
    const cat = cfg.cat;
    const all = entries(cat);
    const t = readT(cat);
    const frag = document.createDocumentFragment();
    const now = S.player ? S.player.gametime : null;
    for (let i = all.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
      const e = all[i];
      const isNew = cat === "inbox" ? e._unread : (e.t ?? 0) > t;
      const div = el("div", { class: "logentry cat-" + e.cat + (isNew ? " unread" : "") + (e.hl ? " hl" : "") },
        el("div", { class: "lhead" }, el("span", { class: "lcat" }, LOGCAT_HU[e.cat] || e.cat || ""), el("span", { class: "ltitle" }, e.ti || ""),
           el("span", { class: "ltime", title: gameTime(e.t) }, ago(e.t, now))),
        e.tx ? el("div", { class: "ltext" }, e.tx) : null,
        (e.en || e.fa || e.so || e.mo) ? el("div", { class: "lmeta" }, [e.en, e.fa, e.so].filter(Boolean).join(" · "),
          e.mo ? el("span", { class: e.mo >= 0 ? "pos" : "neg" }, (e.mo > 0 ? " +" : " ") + money(e.mo)) : null) : null);
      if (e.ic) {
        div.classList.add("clickable");
        div.title = "Megjelenítés a térképen";
        div.addEventListener("click", () => select({ kind: "obj", id: e.ic, from: "log" }));
      }
      frag.appendChild(div);
    }
    list.replaceChildren(frag);
    if (scrollTop) list.scrollTop = 0;
    for (const k of LOG_TABS) {
      const n = unread(k);
      counts[k] = n;
      btns[k].querySelector(".badge").textContent = n ? (n >= 99 ? "99+" : String(n)) : "";
      btns[k].classList.toggle("has", n > 0);
      btns[k].classList.toggle("on", k === cfg.cat);
    }
    btns.alerts.classList.toggle("alert", counts.alerts > 0);
  }
  LOG = {
    markAllRead() {
      const latest = S.log.length ? S.log[S.log.length - 1].t : 0;
      const lt = S.ticker.length ? S.ticker[S.ticker.length - 1].t : 0;
      for (const k of LOG_TABS) cfg.read[k] = k === "ticker" ? lt : latest;
      saveSettings("log", cfg); render();
    },
    focus(cat) { setCat(cat); list.closest(".tabpanel")?.classList.add("flash"); setTimeout(() => list.closest(".tabpanel")?.classList.remove("flash"), 3000); },
    scroll(d) { list.scrollBy({ top: d * 120, behavior: "smooth" }); },
  };
  const r = throttle(() => render(false), 400);
  bus.on("log", r); bus.on("ticker", r); bus.on("messages", r); bus.on("player", throttle(() => render(false), 15000));
  bus.on("hotkey", (m) => { if (m.action === "log_down") LOG.scroll(3); else if (m.action === "log_up") LOG.scroll(-3); });
  setCat(cfg.cat);
}
export function markAllRead() { if (LOG) LOG.markAllRead(); }
export function focusLogCategory(cat) { if (LOG) LOG.focus(cat); }

// ================================================================ missions
export function mountMissions(root, ctx) {
  const { S, bus, select, sectorName, factionName, command } = ctx;
  const body = el("div", { class: "scroll" });
  root.append(body);
  function render() {
    const frag = document.createDocumentFragment();
    frag.appendChild(el("h3", {}, `Elfogadott küldetések (${S.missions.length})`));
    const ms = [...S.missions].sort((a, b) => (b.act ? 1 : 0) - (a.act ? 1 : 0));
    for (const m of ms) {
      frag.appendChild(el("div", { class: "mission" + (m.act ? " active" : "") },
        el("div", { class: "mhead" }, m.act ? el("span", { class: "pill ok" }, "aktív") : null, el("b", {}, m.n || "–"),
          el("span", { class: "muted" }, ` ${m.st || m.mt || ""} · ${factionName(m.fa)}`)),
        m.ob ? el("div", { class: "mobj" }, "▸ " + m.ob + (m.pm ? ` (${m.pn || ""} ${num(m.pc)}/${num(m.pm)})` : "")) : null,
        el("div", { class: "mmeta" }, `Jutalom: ${m.rw ? money(m.rw) : (m.rt || "–")}`, m.dur && m.dur > 0 ? ` · hátralévő idő: ${dur(m.dur)}` : "",
          m.acs ? el("a", { href: "#", onclick: (ev) => { ev.preventDefault(); select({ kind: "sector", id: m.acs, from: "missions" }); } }, " · " + sectorName(m.acs)) : null,
          m.ac ? el("button", { class: "ctl", title: "Útvonal a küldetés célpontjához (vezérlés)", onclick: () => command("guidance", m.ac) }, "Útvonal") : null),
        m.d ? el("div", { class: "mdesc muted" }, m.d) : null));
    }
    frag.appendChild(el("h3", {}, `Ajánlatok (${S.offers.length})`));
    const tbl = el("table", { class: "grid small" }, el("thead", {}, el("tr", {}, el("th", {}, "Ajánlat"), el("th", {}, "Frakció"), el("th", {}, "Jutalom"), el("th", {}, "Szektor"), el("th", {}, "Lejár"))));
    const tb = el("tbody");
    for (const o of [...S.offers].sort((a, b) => (b.rw || 0) - (a.rw || 0))) {
      tb.appendChild(el("tr", { onclick: () => o.s && select({ kind: "sector", id: o.s, from: "offers" }) },
        el("td", {}, o.n || "–"), el("td", {}, factionName(o.fa)), el("td", { class: "num" }, o.rw ? money(o.rw, true) : (o.rt || "")),
        el("td", {}, sectorName(o.s)), el("td", {}, o.dur > 0 ? dur(o.dur) : "")));
    }
    tbl.appendChild(tb);
    frag.appendChild(tbl);
    body.replaceChildren(frag);
  }
  bus.on("missions", throttle(render, 500));
  bus.on("galaxy", throttle(render, 2000));
  render();
}

// ================================================================ factions
export function mountFactions(root, ctx) {
  const { S, bus } = ctx;
  const body = el("div", { class: "scroll" });
  root.append(body);
  function render() {
    const list = [...S.factionList].sort((a, b) => (b.rel ?? 0) - (a.rel ?? 0));
    const tbl = el("table", { class: "grid" }, el("thead", {}, el("tr", {}, el("th", {}, "Frakció"), el("th", {}, "Kapcsolat"), el("th", {}, ""), el("th", {}, "Engedélyek"))));
    const tb = el("tbody");
    for (const f of list) {
      const rel = f.rel ?? 0;
      const pct = ((rel + 30) / 60) * 100;
      const cls = f.h ? "hostile" : f.e ? "enemy" : rel >= 10 ? "friend" : "";
      tb.appendChild(el("tr", {},
        el("td", {}, el("span", { class: "dot", style: { background: factionColor(f.id, S.factions) } }), " ", f.n || f.id, f.sn ? el("span", { class: "muted" }, ` [${f.sn}]`) : null, f.lk ? el("span", { class: "muted", title: "rögzített kapcsolat" }, " 🔒") : null),
        el("td", { class: "num " + cls }, (rel > 0 ? "+" : "") + num(rel), " ", el("span", { class: "muted" }, f.rn || "")),
        el("td", {}, el("span", { class: "relbar" }, el("span", { class: cls, style: { left: Math.min(pct, 50) + "%", width: Math.abs(pct - 50) + "%" } }))),
        el("td", { class: "lics" }, (f.lic || []).map((l) => el("span", { class: "lic " + (l.has ? "has" : "no"), title: (l.has ? "megvan" : "nincs") + (l.pr ? " · ár: " + money(l.pr) : "") + (l.mr !== undefined ? " · min. kapcsolat: " + l.mr : "") }, l.n || l.t)))));
    }
    tbl.appendChild(tb);
    body.replaceChildren(list.length ? tbl : el("div", { class: "muted pad" }, "Még nincs frakcióadat (20 mp-enként frissül)."));
  }
  bus.on("factions", render);
  render();
}

// ================================================================ economy
export function mountEconomy(root, ctx) {
  const { S, bus } = ctx;
  const body = el("div", { class: "scroll pad" });
  root.append(body);
  function render() {
    const e = S.economy;
    if (!e) { body.replaceChildren(el("div", { class: "muted" }, "Még nincs számlaadat (30 mp-enként frissül).")); return; }
    const maxAbs = Math.max(1, ...(e.bytype || []).map((b) => Math.abs(b.mo)));
    body.replaceChildren(
      el("div", { class: "kpis" },
        kpi("Egyenleg", money(S.player ? S.player.money : e.money)),
        kpi("Bevétel (1 óra)", money(e.inc), "pos"), kpi("Kiadás (1 óra)", money(e.exp), "neg"),
        kpi("Nettó", money((e.inc || 0) - (e.exp || 0)), (e.inc - e.exp) >= 0 ? "pos" : "neg"), kpi("Tranzakciók", num(e.count))),
      el("h3", {}, "Típus szerint"),
      el("div", { class: "hbars" }, (e.bytype || []).map((b) => el("div", { class: "hbar" }, el("span", { class: "hl" }, b.n),
        el("span", { class: "ht" }, el("span", { class: b.mo >= 0 ? "pos" : "neg", style: { width: (Math.abs(b.mo) / maxAbs * 100) + "%" } })),
        el("span", { class: "hv " + (b.mo >= 0 ? "pos" : "neg") }, money(b.mo, true))))),
      el("h3", {}, "Legnagyobb tételek"),
      el("table", { class: "grid small" }, el("thead", {}, el("tr", {}, el("th", {}, "Idő"), el("th", {}, "Típus"), el("th", {}, "Partner"), el("th", {}, "Áru"), el("th", {}, "Összeg"))),
        el("tbody", {}, (e.top || []).map((t) => el("tr", {}, el("td", {}, ago(t.t, e.gt)), el("td", {}, t.ty || ""), el("td", {}, t.pa || ""),
          el("td", {}, t.wn ? `${t.wn} ×${num(t.am)}` : ""), el("td", { class: "num " + (t.mo >= 0 ? "pos" : "neg") }, money(t.mo)))))),
      el("h3", {}, "Legjobb kereskedők (saját hajók, nettó)"),
      el("table", { class: "grid small" }, el("tbody", {}, (e.partners || []).map((p) => el("tr", {}, el("td", {}, p.n), el("td", { class: "num " + (p.mo >= 0 ? "pos" : "neg") }, money(p.mo)))))));
  }
  function kpi(label, value, cls = "") { return el("div", { class: "kpi" }, el("div", { class: "kl" }, label), el("div", { class: "kv " + cls }, value)); }
  bus.on("economy", render);
  bus.on("player", throttle(render, 5000));
  render();
}

// ================================================================ diagnostics
export function mountDiag(root, ctx) {
  const { S, bus, yawConvention, send } = ctx;
  const body = el("div", { class: "scroll pad" });
  root.append(body);
  function render() {
    const st = S.status || {};
    const h = S.hello || {};
    const s = S.stats;
    const rows = [
      ["Játék állapota", st.game || "–"], ["Pipe", st.pipe_connected ? `csatlakozva (${st.pipe_connects} kapcsolódás)` : "nincs"],
      ["Üzenetek", `${num(st.msgs)} (${num(st.rate_hz, 1)} /s), hibás: ${num(st.bad)}`], ["Utolsó adat", st.last_rx_age === null || st.last_rx_age === undefined ? "–" : num(st.last_rx_age, 1) + " mp"],
      ["Híd", h.mod ? `${h.mod} v${h.ver} · munkamenet ${h.session} · időzítő ${h.timer}` : "–"],
      ["Engedélyezett parancsok", (h.allow || []).join(", ") || "–"],
      ["Gyorsgombok (Native Hotkey API)", s ? `${s.hk} regisztrálva` : (h.hotkeys ?? "–")], ["Lua Log API", h.loglib ? "van" : "nincs"],
      ["Kapuk (MD)", s ? `${s.gates} · ${num(s.ngates)} kapu` : "–"], ["Tick", s ? `frame ${num(s.nframe)} · md ${num(s.nmd)}` : "–"],
      ["Yaw-konvenció", `${yawConvention()} (szavazat a/b/c: ${S.yaw.a}/${S.yaw.b}/${S.yaw.c})`],
      ["Híd költsége / képkocka", s ? `átlag ${num(s.frame.avg, 1) === "0" ? s.frame.avg : s.frame.avg} ms · max ${s.frame.max} ms` : "–"],
      ["Küldve", s ? `${num(s.sent)} üzenet · ${num(s.bytes / 1024)} KB · eldobva ${num(s.dropped)} · írási hiba ${num(s.wfail)}` : "–"],
      ["Kikapcsolt források", s && s.srcoff && s.srcoff.length ? s.srcoff.join(", ") : "nincs"],
    ];
    const t = el("table", { class: "grid small kv" }, el("tbody", {}, rows.map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, String(v))))));
    const ch = s ? el("table", { class: "grid small" },
      el("thead", {}, el("tr", {}, ["Csatorna", "átlag ms/kocka", "max ms", "menet ms", "intervallum s", "futás", "hiba"].map((x) => el("th", {}, x)))),
      el("tbody", {}, Object.entries(s.ch).sort().map(([k, c]) => el("tr", { class: c.off ? "dmg" : "" },
        el("td", {}, k + (c.off ? " (KI)" : "")), el("td", { class: "num" }, String(c.avg)), el("td", { class: "num" }, String(c.max)),
        el("td", { class: "num" }, String(c.pass)), el("td", { class: "num" }, String(c.iv)), el("td", { class: "num" }, num(c.runs)),
        el("td", { class: "num", title: c.le || "" }, num(c.err)))))) : el("div", { class: "muted" }, "Még nincs statisztika a hídtól.");
    body.replaceChildren(t, el("h3", {}, "Csatornák (a híd méri, QPC)"), ch,
      el("div", { class: "pad" }, el("button", { onclick: () => send({ type: "resync" }), title: "A híd mindent újraküld" }, "Teljes újraküldés")));
  }
  bus.on("stats", throttle(render, 1000)); bus.on("status", throttle(render, 1000)); bus.on("hello", render);
  render();
}

// ================================================================ details drawer
export function mountDrawer(root, ctx) {
  const { S, bus, select, sectorName, factionName, command } = ctx;
  const body = el("div", { class: "dbody" });
  root.append(el("button", { class: "dclose", title: "Bezárás (Esc)", onclick: () => select(null) }, "×"), body);
  let current = null;
  function findObj(sel) {
    const p = S.property.get(sel.id);
    if (p) return { src: "property", o: p, sid: p.s };
    for (const [sid, sc] of Object.entries(S.scans)) {
      const o = (sc.objs || sc.items || []).find((x) => x.id === sel.id);
      if (o) return { src: "scan", o, sid };
    }
    if (sel.obj) return { src: "map", o: sel.obj, sid: sel.sid };
    return null;
  }
  function btn(label, cmd, args, tip, allowKey) {
    const allowed = !S.hello || !S.hello.allow || S.hello.allow.includes(allowKey || cmd);
    return el("button", { class: "ctl" + (allowed ? "" : " disabled"), title: allowed ? tip : tip + " – a modban kikapcsolva (CFG.allow)", disabled: !allowed || undefined,
                          onclick: () => command(cmd, ...args) }, label);
  }
  function render() {
    const sel = S.selected;
    root.classList.toggle("open", !!sel);
    if (!sel) { body.replaceChildren(); return; }
    if (sel.kind === "sector") {
      const s = S.sectors.get(String(sel.id));
      const own = [...S.property.values()].filter((e) => e.s === String(sel.id));
      body.replaceChildren(
        el("h2", {}, s ? s.name : "Szektor"),
        el("div", { class: "muted" }, s ? (s.cname || "") : ""),
        kv([["Tulajdonos", factionName(s && s.owner)], ["Saját hajók", own.filter((e) => e.k === "ship").length], ["Saját állomások", own.filter((e) => e.k === "station").length],
            ["Nyersanyagok", s && s.res ? s.res.map((r) => `${r.w} ${r.m ? Math.round(r.c / r.m * 100) + "%" : ""}`).join(", ") : "–"],
            ["Kapcsolatok", S.links.filter((l) => l.a === String(sel.id) || l.b === String(sel.id)).map((l) => sectorName(l.a === String(sel.id) ? l.b : l.a) + (l.kind === "hw" ? " (sztráda)" : "")).join(", ") || "–"]]),
        el("div", { class: "dbtns" },
          el("button", { onclick: () => select({ kind: "sector", id: sel.id, from: "drawer" }), title: "Szektornézet ezen a szektoron (figyelt szektor)" }, "Szektornézet"),
          btn("Megnyitás a játék térképén", "openmap", [sel.id], "A játék saját térképe erre a szektorra fókuszálva")),
        own.length ? el("h3", {}, "Saját objektumok itt") : null,
        own.length ? el("div", { class: "dlist" }, own.slice(0, 80).map((e) => el("a", { href: "#", onclick: (ev) => { ev.preventDefault(); select({ kind: "obj", id: e.id, from: "drawer" }); } }, (e.k === "station" ? "▣ " : "") + (e.n || e.id)))) : null);
      return;
    }
    const f = findObj(sel);
    if (!f) { body.replaceChildren(el("h2", {}, "Objektum"), el("div", { class: "muted" }, "Nincs adat erről az objektumról (" + sel.id + ").")); return; }
    const o = f.o;
    const subs = [...S.property.values()].filter((e) => e.cmd === o.id);
    const isShip = (o.c || o.class || "").startsWith("ship");
    const p = S.player && S.player.object;
    const d = p && f.sid === (S.player.sector || {}).id && o.x !== undefined && o.x !== null ? Math.hypot(o.x - p.x, o.z - p.z) : null;
    const rows = [
      ["Osztály", CLASS_HU[o.c || o.class] || o.c || o.class || "–"], ["Azonosító", o.code || "–"], ["Szektor", sectorName(f.sid)],
      ["Tulajdonos", o.pl || o.k ? "saját" : factionName(o.o)], o.r !== undefined ? ["Kapcsolat", (o.r > 0 ? "+" : "") + o.r] : null,
      o.hull !== undefined ? ["Burkolat", num(o.hull) + " %"] : null, o.shield !== undefined ? ["Pajzs", num(o.shield) + " %"] : null,
      o.p ? ["Szerep", PURPOSE_HU[o.p] || o.p] : null, o.on ? ["Parancs", `${o.on}${o.os ? " · " + o.os : ""}${o.oq ? ` (sor: ${o.oq})` : ""}${o.odf ? " (alapparancs)" : ""}`] : null,
      o.fl ? ["Flotta", o.fl] : null, o.cmd ? ["Parancsnok", (S.property.get(o.cmd) || {}).n || o.cmd] : null,
      o.k === "station" ? ["Modulok", num(o.mods)] : null, o.k === "station" && o.money !== undefined ? ["Számla", money(o.money)] : null,
      o.k === "station" && o.wfc ? ["Munkaerő", `${num(o.wf)} / ${num(o.wfc)}`] : null, d !== null ? ["Távolság tőled", dist(d)] : null,
      o.ds ? ["Cél", sectorName(o.ds)] : null, o.mc ? ["Makró", o.mc] : null,
    ].filter(Boolean);
    body.replaceChildren(
      el("h2", { style: { color: relColor(o, S.factions) } }, o.n || o.name || "Objektum"),
      kv(rows),
      el("div", { class: "dbtns" },
        btn("Megnyitás a játék térképén", "openmap", [o.id], "A játék saját térképe erre az objektumra fókuszálva, kijelölve"),
        btn("Célpont", "target", [o.id], "Célpontnak jelöli a játékban"),
        btn("Útvonal ide", "guidance", [o.id], "Útvonal (guidance) erre az objektumra"),
        isShip && (o.k === "ship" || o.pl) ? btn("Állj (parancsok törlése)", "stop", [o.id], "A vanilla „Összes parancs törlése” útja") : null,
        isShip && (o.k === "ship" || o.pl) && S.player && S.player.sector && f.sid !== S.player.sector.id ? btn("Repülj a szektorodba", "flyto", [o.id, S.player.sector.id], "MoveWait parancs a játékos szektorába") : null),
      subs.length ? el("h3", {}, `Alárendeltek (${subs.length})`) : null,
      subs.length ? el("div", { class: "dlist" }, subs.map((e) => el("a", { href: "#", onclick: (ev) => { ev.preventDefault(); select({ kind: "obj", id: e.id, from: "drawer" }); } }, e.n || e.id))) : null,
      el("div", { class: "muted small" }, "A parancsgombokhoz a felső sávban kapcsold be a vezérlést."));
  }
  function kv(rows) { return el("table", { class: "kv" }, el("tbody", {}, rows.map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, String(v)))))); }
  bus.on("select", (s) => { current = s; render(); });
  const r = throttle(() => { if (current) render(); }, 1000);
  bus.on("property", r); bus.on("scan", r); bus.on("hello", r);
}
