// Ad-hoc check of the Layout menu with saved layouts (U8): saves two layouts through the UI's own
// API client path (PUT /api/layouts), reloads, opens the menu, screenshots it, applies one.
import { createRequire } from "node:module";
const require = createRequire(process.env.SHOT_TOOL || "D:/X4-backups/work/shot-tool/package.json");
const puppeteer = require("puppeteer-core");
const BASE = process.argv[2] || "http://127.0.0.1:8791";
const OUT = process.argv[3] || "D:/X4-backups/work/shots";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", headless: "new", userDataDir: "D:/X4-backups/work/headless-ui" });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1040 });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("x4c.hint.layers", "1"); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2500));
  const res = await page.evaluate(async () => {
    window.__x4ui.applyPreset("combat");
    const tree = window.__x4ui.getUI().tree;
    const put = (n, body) => fetch("/api/layouts/" + encodeURIComponent(n), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);
    const a = await put("Harc 2 képernyő", { tree, opts: { logcat: "alerts" } });
    window.__x4ui.applyPreset("all");
    const b = await put("Everything", { tree: window.__x4ui.getUI().tree, opts: {} });
    const c = await fetch("/api/layouts-default", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Harc 2 képernyő" }) }).then((r) => r.status);
    return [a, b, c];
  });
  console.log("PUT statuses", res);
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 3000));
  const preset = await page.evaluate(() => window.__x4ui.getUI().preset);
  console.log("preset after reload (default layout applied on start):", preset);
  const btn = await page.$$("button");
  for (const b of btn) { const tx = await b.evaluate((e) => e.textContent); if (tx && tx.trim() === "Layout") { await b.click(); break; } }
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: OUT + "/layout-menu-1920.png" });
  // clean up the test layouts
  await page.evaluate(async () => {
    for (const n of ["Harc 2 képernyő", "Everything"]) await fetch("/api/layouts/" + encodeURIComponent(n), { method: "DELETE" });
  });
} finally { await browser.close(); }
