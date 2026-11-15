// Visual verification: headless Brave (own temp profile, never the user's) via puppeteer-core.
// Takes screenshots of views / presets / pop-outs and audits every panel for horizontal scrollbars,
// visible scrollbars and content sticking out of the panel (U7).
//   node scripts/shots.mjs <base-url> <out-dir> [scenario-filter]
// puppeteer-core is NOT a project dependency: run from a folder where it is installed, e.g.
//   NODE_PATH=D:\X4-backups\work\shot-tool\node_modules node scripts\shots.mjs http://127.0.0.1:8791 D:\X4-backups\work\shots
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(process.env.SHOT_TOOL || "D:/X4-backups/work/shot-tool/package.json");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8791";
const OUT = process.argv[3] || "D:/X4-backups/work/shots";
const FILTER = process.argv[4] || "";
const BRAVE = "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
fs.mkdirSync(OUT, { recursive: true });

const audit = () => {
  const out = [];
  for (const sec of document.querySelectorAll("section[data-panel]")) {
    const id = sec.dataset.panel;
    const r = sec.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const issues = [];
    for (const el of sec.querySelectorAll("*")) {
      if (el.closest(".x4map-root")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) issues.push("hscroll:" + (el.className || el.tagName).toString().slice(0, 40));
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1 && el.offsetWidth - el.clientWidth > 2) issues.push("vbar:" + (el.className || el.tagName).toString().slice(0, 40));
      const b = el.getBoundingClientRect();
      if (b.width && b.height && b.right > r.right + 1.5 && !el.closest("[data-radix-popper-content-wrapper]")) {
        // sticks out of the panel and nothing between clips it -> visibly cut by the panel edge
        let p = el.parentElement, clipper = null;
        while (p && p !== sec) { if (getComputedStyle(p).overflowX !== "visible") { clipper = p; break; } p = p.parentElement; }
        const cr = clipper ? clipper.getBoundingClientRect() : r;
        if (b.left < cr.right - 1 && b.right > cr.right + 1.5) issues.push("cut:" + (el.textContent || el.tagName).trim().slice(0, 30));
      }
    }
    // text cut by the panel's own width without an ellipsis
    out.push({ id, w: Math.round(r.width), h: Math.round(r.height), issues: [...new Set(issues)].slice(0, 6) });
  }
  return out;
};

const scenarios = [
  { name: "map-nav-1920", w: 1920, h: 1040, steps: (u) => u.applyPreset("nav") },
  { name: "galaxy-1920", w: 1920, h: 1040, steps: (u) => { u.applyPreset("nav"); u.setView("galaxy"); } },
  { name: "preset-fleet-1920", w: 1920, h: 1040, steps: (u) => u.applyPreset("fleet") },
  { name: "preset-combat-1920", w: 1920, h: 1040, steps: (u) => u.applyPreset("combat") },
  { name: "preset-all-1920", w: 1920, h: 1040, steps: (u) => u.applyPreset("all") },
  { name: "preset-nav-1366", w: 1366, h: 768, steps: (u) => u.applyPreset("nav") },
  { name: "preset-fleet-1366", w: 1366, h: 768, steps: (u) => u.applyPreset("fleet") },
  { name: "preset-combat-1366", w: 1366, h: 768, steps: (u) => u.applyPreset("combat") },
  { name: "preset-all-1366", w: 1366, h: 768, steps: (u) => u.applyPreset("all") },
  { name: "cramped-1366", w: 1366, h: 768, steps: (u) => {
    u.applyPreset("all"); u.togglePanel("diag"); u.togglePanel("hotkeys");
    u.dropPanel("diag", "objects", "bottom"); u.dropPanel("hotkeys", "economy", "right");
  } },
  { name: "maximized-property-1920", w: 1920, h: 1040, steps: (u) => { u.applyPreset("all"); u.toggleMax("property"); } },
  ...["property", "log", "missions", "factions", "economy", "diag", "hotkeys"].map((v) => ({ name: "view-" + v + "-1920", w: 1920, h: 1040, view: v, steps: () => {} })),
  { name: "view-hu-map-1920", w: 1920, h: 1040, lang: "hu", steps: (u) => u.applyPreset("nav") },
  { name: "view-hu-all-1920", w: 1920, h: 1040, lang: "hu", steps: (u) => u.applyPreset("all") },
  { name: "view-hu-property-1366", w: 1366, h: 768, lang: "hu", view: "property", steps: () => {} },
  { name: "narrow-900", w: 900, h: 1000, steps: (u) => u.applyPreset("nav") },
  { name: "popout-map", w: 1280, h: 900, url: "/?panel=map", steps: () => {} },
  { name: "popout-objects-hu", w: 1000, h: 800, url: "/?panel=objects", lang: "hu", steps: () => {} },
  { name: "select-satellite-1920", w: 1920, h: 1040, select: "satellite", steps: (u) => u.applyPreset("nav") },
  { name: "select-ownship-hu-1920", w: 1920, h: 1040, lang: "hu", select: "ownship", steps: (u) => u.applyPreset("nav") },
  { name: "firstrun-hint-hu-1920", w: 1920, h: 1040, lang: "hu", hint: true, steps: (u) => u.applyPreset("nav") },
  { name: "font125-1366", w: 1366, h: 768, font: 125, steps: (u) => u.applyPreset("nav") },
  { name: "sheet-details-1920", w: 1920, h: 1040, select: "ownship", steps: (u) => { u.applyPreset("nav"); u.togglePanel("info"); } },
  { name: "palette-1920", w: 1920, h: 1040, palette: "argon", steps: (u) => u.applyPreset("nav") },
];

const profile = "D:/X4-backups/work/headless-ui";
const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: "new", userDataDir: profile,
  args: ["--no-first-run", "--no-default-browser-check", "--disable-features=Translate", "--hide-scrollbars=false"],
});
const report = [];
try {
  for (const sc of scenarios) {
    if (FILTER && !sc.name.includes(FILTER)) continue;
    const page = await browser.newPage();
    await page.setViewport({ width: sc.w, height: sc.h, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("requestfailed", (r) => errors.push("requestfailed " + r.url()));
    const external = [];
    page.on("request", (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith("data:") && !r.url().startsWith("ws://127.0.0.1")) external.push(r.url()); });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.evaluate((lang, hint, font) => { localStorage.clear(); localStorage.setItem("x4c.lang", lang); if (!hint) localStorage.setItem("x4c.hint.layers", "1"); if (font) localStorage.setItem("x4c.ui", JSON.stringify({ view: "map", font })); }, sc.lang || "en", !!sc.hint, sc.font || 0);
    await page.goto(BASE + (sc.url || "/"), { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 2500));
    await page.evaluate(`(${sc.steps.toString()})(window.__x4ui)`);
    if (sc.view) await page.evaluate((v) => window.__x4ui.setView(v), sc.view);
    if (sc.select) {
      await page.evaluate((kind) => {
        const S = window.__x4c;
        const sid = S.player && S.player.sector && S.player.sector.id;
        const objs = (S.scans[sid] && S.scans[sid].objs) || [];
        const o = kind === "satellite" ? objs.find((x) => x.c === "satellite") : objs.find((x) => x.pl && String(x.c).startsWith("ship"));
        if (o) window.__x4ui.select({ kind: "obj", id: String(o.id), from: "test", obj: o, sid });
      }, sc.select);
    }
    await new Promise((r) => setTimeout(r, 3000));
    if (sc.palette) {
      await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
      await new Promise((r) => setTimeout(r, 300));
      await page.keyboard.type(sc.palette);
      await new Promise((r) => setTimeout(r, 600));
    }
    const file = path.join(OUT, sc.name + ".png");
    await page.screenshot({ path: file });
    const a = await page.evaluate(audit);
    const body = await page.evaluate(() => document.body.innerText);
    const nulls = (body.match(/\bnull\b|\bundefined\b|\bNaN\b/g) || []).length;
    report.push({ name: sc.name, file, errors: errors.slice(0, 5), external, nulls, panels: a });
    console.log(sc.name, "errors:", errors.length, "external:", external.length, "nulls:", nulls, "issues:", a.filter((p) => p.issues.length).map((p) => p.id + "=" + p.issues.join("|")).join(" ; ") || "none");
    await page.close();
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
