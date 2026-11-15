"""Release-gate smoke suite: the REAL shell build in headless Chromium, driven by real input events
(mouse clicks / drags / wheel, keyboard) against the simulator.

  uv run --locked python tests/smoke_shell.py [--dist DIR]     (default: web-dist-candidate, else web-dist)

Starts its own server on 127.0.0.1:8790 (pipe x4c_smoke, its own state dir) serving DIR, and the
simulator; stops exactly those two processes at the end. Exit 0 = every check passed.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import aiohttp

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from cdp import Browser, find_browser  # noqa: E402

PORT, PIPE = 8790, "x4c_smoke"
BASE = f"http://127.0.0.1:{PORT}"
EN = json.loads((ROOT / "ui" / "src" / "i18n" / "en.json").read_text(encoding="utf-8"))
results: list[tuple[bool, str]] = []


def check(ok, what):
    results.append((bool(ok), what))
    print(("PASS " if ok else "FAIL ") + what, flush=True)


def start_world(dist: Path, state: str):
    launcher = (f"import sys; sys.path.insert(0, r'{ROOT}'); import server; from pathlib import Path; server.DIST = Path(r'{dist}'); "
                f"sys.argv = ['server.py', '--port', '{PORT}', '--pipe', '{PIPE}', '--ui', 'dist', '--state-dir', r'{state}', "
                f"'--log-file', 'smoke_server.log']; sys.exit(server.main())")
    logs = ROOT / "logs"
    logs.mkdir(exist_ok=True)
    srv = subprocess.Popen([sys.executable, "-c", launcher], cwd=ROOT, stdout=open(logs / "smoke_server.out", "w"), stderr=subprocess.STDOUT)
    time.sleep(2.5)
    sim = subprocess.Popen([sys.executable, "sim.py", "--pipe", PIPE, "--seed", "7", "--player-speed", "300"], cwd=ROOT,
                           stdout=open(logs / "smoke_sim.out", "w"), stderr=subprocess.STDOUT)
    return srv, sim


def stop(p):
    if p and p.poll() is None:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)


MAP = "window.__x4map"
CANVAS_HASH = r"""(() => { const c = window.__x4map.canvas, g = c.getContext('2d'); const w = c.width, h = c.height; let s = 0;
  const d = g.getImageData(0, 0, w, h).data; for (let i = 0; i < d.length; i += 4 * 97) s = (s * 31 + d[i] + 3 * d[i + 1] + 7 * d[i + 2]) % 1000000007; return s; })()"""


async def fresh(b, lang="en", font=100, url="/", w=1600, h=1000, extra="") -> "Page":
    p = await b.page("about:blank", w, h)
    await p.goto(BASE + "/")
    await asyncio.sleep(0.8)
    await p.eval(f"localStorage.clear(); localStorage.setItem('x4c.lang', '{lang}'); localStorage.setItem('x4c.ui', JSON.stringify({{view: 'map', font: {font}}})); {extra} true")
    await p.goto(BASE + url)
    await p.wait_for(f"{MAP} && {MAP}.w > 0 && {MAP}.S.player && {MAP}.S.liveGalaxy && {MAP}.S.liveGalaxy.length", 25)
    await asyncio.sleep(1.5)
    return p


async def nav_tab(p, view_id):
    label = EN["views"][view_id]
    return await p.click_el(f"[...document.querySelectorAll('nav [role=tab]')].find(e => e.textContent.includes({json.dumps(label)}))")


async def canvas_center(p):
    return await p.center_of(f"{MAP}.canvas")


async def run(dist: Path) -> int:
    async with Browser(1700, 1100, port=9336, profile="headless-smoke") as b:
        p = await fresh(b)

        # ---- navigation views 1..8 (keyboard) show their panels
        await p.click(5, 300)            # focus the page (not an input)
        for i, vid in enumerate(["map", "galaxy", "property", "log", "missions", "factions", "economy", "diag"], start=1):
            await p.key(str(i))
            await asyncio.sleep(0.6)
            ok = await p.eval(f"""(() => {{ const v = window.__x4ui.getUI().view; const want = {json.dumps(vid)};
              if (v !== want) return 'view ' + v;
              if (want === 'map' || want === 'galaxy') return !!document.querySelector('section[data-panel=map]') && window.__x4map.w > 0;
              const s = document.querySelector('main'); return s && s.innerText.trim().length > 20; }})()""")
            check(ok is True, f"nav key {i} -> view '{vid}' shows its content ({ok})")
        await p.key("1"); await asyncio.sleep(0.5)

        # ---- sector <-> galaxy via the navigation (click + hotkey)
        await nav_tab(p, "galaxy"); await asyncio.sleep(0.8)
        st = await p.eval(f"[{MAP}.mode, {MAP}.segGalaxy.classList.contains('on')]")
        check(st == ["galaxy", True], f"nav click 'Galaxy' -> map in galaxy mode, switch shows it ({st})")
        await nav_tab(p, "map"); await asyncio.sleep(0.8)
        st = await p.eval(f"[{MAP}.mode, {MAP}.segSector.classList.contains('on')]")
        check(st == ["sector", True], f"nav click 'Map' -> sector mode ({st})")
        await p.click(5, 300); await p.key("2"); await asyncio.sleep(0.8)
        check(await p.eval(f"{MAP}.mode") == "galaxy", "hotkey 2 -> galaxy mode")
        await p.key("1"); await asyncio.sleep(0.8)
        check(await p.eval(f"{MAP}.mode") == "sector", "hotkey 1 -> sector mode")

        # ---- via the map's own switch; the navigation follows
        await p.click_el(f"{MAP}.segGalaxy"); await asyncio.sleep(0.8)
        st = await p.eval(f"[{MAP}.mode, window.__x4ui.getUI().view]")
        check(st == ["galaxy", "galaxy"], f"map switch 'Galaxy' -> galaxy mode, navigation follows ({st})")
        await p.click_el(f"{MAP}.segSector"); await asyncio.sleep(0.8)
        st = await p.eval(f"[{MAP}.mode, window.__x4ui.getUI().view]")
        check(st == ["sector", "map"], f"map switch 'Sector' -> sector mode, navigation follows ({st})")

        # ---- wheel zoom-out continues into the galaxy, zoom-in enters a sector
        c = await canvas_center(p)
        sid0 = await p.eval(f"{MAP}.currentSid()")
        for _ in range(80):
            await p.wheel(c[0], c[1], 240)
            await asyncio.sleep(0.03)
            if await p.eval(f"{MAP}.mode") == "galaxy":
                break
        await asyncio.sleep(0.6)
        st = await p.eval(f"[{MAP}.mode, window.__x4ui.getUI().view]")
        went_out = st == ["galaxy", "galaxy"]
        check(went_out, f"wheel zoom-out in the sector view continues into the galaxy ({st})")
        for _ in range(6):                      # keep zooming out: more of the galaxy comes into view
            await p.wheel(c[0], c[1], 240)
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.6)
        gl = await p.eval(f"({MAP}.ghit || []).length")
        check((gl or 0) > 3, f"... and the neighbouring sectors are drawn ({gl} sector hexagons on screen)")
        for _ in range(80):
            await p.wheel(c[0], c[1], -240)
            await asyncio.sleep(0.03)
            if await p.eval(f"{MAP}.mode") == "sector":
                break
        await asyncio.sleep(0.6)
        st = await p.eval(f"[{MAP}.mode, window.__x4ui.getUI().view, {MAP}.currentSid()]")
        check(went_out and st and st[0] == "sector" and st[1] == "map" and st[2], f"wheel zoom-in on a sector in the galaxy enters it ({st}, started in {sid0})")

        # ---- double-click a sector in the galaxy opens it
        await nav_tab(p, "galaxy"); await asyncio.sleep(1.0)
        tgt = await p.eval(f"""(() => {{ const m = {MAP}, r = m.canvas.getBoundingClientRect();
            const h = (m.ghit || []).find(q => q.x > 60 && q.y > 60 && q.x < m.w - 60 && q.y < m.h - 60 && q.r > 8);
            return h ? [r.left + h.x, r.top + h.y, h.s.id] : null; }})()""")
        if tgt:
            await p.click(tgt[0], tgt[1], 2)
            await asyncio.sleep(0.8)
            st = await p.eval(f"[{MAP}.mode, {MAP}.currentSid()]")
            check(st == ["sector", tgt[2]], f"double-click a sector in the galaxy opens it ({st} vs {tgt[2]})")
        else:
            check(False, "double-click a sector: no sector hexagon on screen")
        await p.key("Escape"); await asyncio.sleep(0.3)
        await p.click(5, 300); await p.key("a"); await asyncio.sleep(0.8)

        # ---- follow modes: manual stays put, timed returns to the ship
        async def set_follow(val):
            await p.eval(f"(() => {{ const s = {MAP}.selRet; s.focus(); return true; }})()")
            await p.eval(f"(() => {{ const s = {MAP}.selRet; s.value = '{val}'; s.dispatchEvent(new Event('change', {{ bubbles: true }})); return s.value; }})()")
        await set_follow(0)
        c = await canvas_center(p)
        await p.drag(c[0], c[1], c[0] + 180, c[1] + 90)
        await asyncio.sleep(0.4)
        v0 = await p.eval(f"[{MAP}.cam, {MAP}.view.cx, {MAP}.view.cz, {MAP}.view.scale]")
        await asyncio.sleep(4)
        v1 = await p.eval(f"[{MAP}.cam, {MAP}.view.cx, {MAP}.view.cz, {MAP}.view.scale]")
        check(v0[0] == "manual" and v0 == v1, f"follow 'Manual': after a drag the camera stays put for 4 s ({v0[0]})")
        await set_follow(5)
        await p.drag(c[0], c[1], c[0] - 150, c[1] - 60)
        await asyncio.sleep(6.5)
        st = await p.eval(f"""(() => {{ const m = {MAP}, p = m.S.player.object; return [m.cam, Math.round(Math.hypot(m.view.cx - p.x, m.view.cz - p.z))]; }})()""")
        check(st[0] == "follow" and st[1] < 20000, f"follow 'Back to ship after 5 s' returns to the ship ({st})")
        await set_follow(8)

        # ---- layer toggles: drawing changes and the setting persists
        await p.eval(f"(() => {{ const m = {MAP}, o = m.S.player.object; m.toManual(); m.manualUntil = Infinity; Object.assign(m.view, {{ cx: o.x, cz: o.z, scale: 0.004 }}); m.dirty = true; return true; }})()")
        await asyncio.sleep(0.5)
        await p.click_el(f"{MAP}.layersBtn"); await asyncio.sleep(0.4)
        changed_need = {"radar", "grid", "mini", "npc", "legend", "lines", "ownerless", "rotate", "hull"}
        for key in ["radar", "lines", "npc", "ownerless", "hull", "factioncol", "rotate", "grid", "mini", "legend"]:
            if await p.eval(f"{MAP}.layers.hidden"):
                await p.click_el(f"{MAP}.layersBtn"); await asyncio.sleep(0.3)
            h0 = await p.eval(CANVAS_HASH); lg0 = await p.eval(f"{MAP}.legendBox.hidden")
            before = await p.eval(f"!!{MAP}.cfg[{json.dumps(key)}]")
            ok_click = await p.click_el(f"{MAP}.chips[{json.dumps(key)}]")
            await asyncio.sleep(0.5)
            h1 = await p.eval(CANVAS_HASH); lg1 = await p.eval(f"{MAP}.legendBox.hidden")
            after = await p.eval(f"!!{MAP}.cfg[{json.dumps(key)}]")
            stored = await p.eval(f"!!JSON.parse(localStorage.getItem('x4c.map') || '{{}}')[{json.dumps(key)}]")
            drew = h0 != h1 or lg0 != lg1
            check(ok_click and after != before and stored == after and (drew or key not in changed_need),
                  f"layer '{key}': toggles ({before}->{after}), persists, drawing {'changed' if drew else 'unchanged'}")
            await p.click_el(f"{MAP}.chips[{json.dumps(key)}]"); await asyncio.sleep(0.3)
        lab = await p.click_el(f"{MAP}.lblBtn"); await asyncio.sleep(0.3)
        check(lab and await p.eval(f"JSON.parse(localStorage.getItem('x4c.map')).labels") == "all", "names layer cycles and persists")
        await p.click_el(f"{MAP}.lblBtn"); await p.click_el(f"{MAP}.lblBtn")

        # ---- gate names and the ownerless marker
        await p.eval(f"(() => {{ const m = {MAP}; m.setMode('sector'); m.toManual(); m.manualUntil = Infinity; Object.assign(m.view, {{ cx: 0, cz: 0, scale: 0.0012 }}); m.dirty = true; return true; }})()")
        await asyncio.sleep(0.6)
        gates = await p.eval(f"({MAP}.lastLabels || []).filter(l => l.gate).length")
        check((gates or 0) > 0, f"gate names visible in the sector view ({gates})")
        ab = await p.eval(f"""(() => {{ const m = {MAP}; const sc = m.S.scans[m.currentSid()]; const o = (sc && sc.objs || []).find(x => x.o === 'ownerless' && /^ship_/.test(x.c));
            if (!o) return null; Object.assign(m.view, {{ cx: o.x, cz: o.z, scale: 0.01 }}); m.dirty = true; return o.n; }})()""")
        await asyncio.sleep(0.6)
        mk = await p.eval(f"({MAP}.lastOwnerless || []).length")
        check(ab and mk, f"ownerless marker drawn on the abandoned ship ({ab}, {mk})")

        # ---- Layers popover at 80 / 100 / 125 %
        for font in (80, 100, 125):
            q = await fresh(b, font=font, w=1600, h=1100)
            await q.click_el(f"{MAP}.layersBtn"); await asyncio.sleep(0.6)
            st = await q.eval(f"""(() => {{ const m = {MAP}, L = m.layers, C = m.body.getBoundingClientRect(), r = L.getBoundingClientRect();
                return [!L.hidden, r.top >= C.top && r.bottom <= C.bottom + 0.5, L.clientHeight >= L.scrollHeight - 1 || L.clientHeight >= 60, Math.round(r.height)]; }})()""")
            check(st and st[0] and st[1] and st[2] and st[3] > 60, f"Layers popover opens fully at {font} % ({st})")

        # ---- pop-out map draws
        q = await fresh(b, url="/?panel=map", w=1200, h=800)
        st = await q.eval(f"[{MAP}.w, {MAP}.h, {MAP}.canvas.width]")
        h = await q.eval(CANVAS_HASH)
        check(st[0] > 500 and st[1] > 300 and h, f"pop-out map draws ({st})")

        # ---- language switch (real clicks on the language select)
        q = await fresh(b)
        await q.click_el("document.querySelector('[aria-label=\"Language\"]')"); await asyncio.sleep(0.5)
        await q.click_el("[...document.querySelectorAll('[role=option]')].find(e => e.textContent.includes('Magyar'))"); await asyncio.sleep(0.8)
        st = await q.eval(f"[document.querySelector('nav [role=tab]').textContent, {MAP}.segSector.textContent]")
        check(st and "Térkép" in st[0] and "Szektor" in st[1], f"language switch to Hungarian (nav + map) ({st})")

        # ---- panel maximize / restore (double-click the header) and layout preset switch
        q = await fresh(b)
        n0 = await q.eval("document.querySelectorAll('section[data-panel]').length")
        hdr = "document.querySelector('section[data-panel=map] header')"
        c = await q.eval(f"(() => {{ const r = {hdr}.getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]; }})()")
        await q.click(c[0], c[1], 2); await asyncio.sleep(0.8)
        n1 = await q.eval("[...document.querySelectorAll('section[data-panel]')].filter(s => s.getBoundingClientRect().width > 0).length")
        c = await q.eval(f"(() => {{ const r = {hdr}.getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]; }})()")
        await q.click(c[0], c[1], 2); await asyncio.sleep(0.8)
        n2 = await q.eval("[...document.querySelectorAll('section[data-panel]')].filter(s => s.getBoundingClientRect().width > 0).length")
        check(n0 > 1 and n1 == 1 and n2 == n0 and await q.eval(f"{MAP}.w > 0"), f"panel maximize / restore by double-click ({n0} -> {n1} -> {n2})")
        await q.click_el(f"[...document.querySelectorAll('nav button')].find(e => e.textContent.trim() === {json.dumps(EN['nav']['layout'])})"); await asyncio.sleep(0.5)
        await q.click_el(f"[...document.querySelectorAll('[role=menuitem]')].find(e => e.textContent.includes({json.dumps(EN['layout']['fleet'])}))"); await asyncio.sleep(1.0)
        st = await q.eval("[window.__x4ui.getUI().preset, !!document.querySelector('section[data-panel=property]'), window.__x4map.w > 0]")
        check(st and st[0] == "fleet" and st[1] and st[2], f"layout preset switch to Fleet ({st})")

    failed = [w for ok, w in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", type=Path, default=None)
    a = ap.parse_args()
    dist = a.dist or (ROOT / "web-dist-candidate" if (ROOT / "web-dist-candidate" / "index.html").is_file() else ROOT / "web-dist")
    if not find_browser():
        print("SKIP no Chromium-based browser")
        return 2
    print("dist:", dist)
    state = tempfile.mkdtemp(prefix="x4c-smoke-")
    srv, sim = start_world(dist.resolve(), state)
    try:
        async with aiohttp.ClientSession() as s:
            for _ in range(60):
                try:
                    async with s.get(BASE + "/api/status") as r:
                        if r.status == 200 and (await r.json()).get("game") == "live":
                            break
                except aiohttp.ClientError:
                    pass
                await asyncio.sleep(0.5)
        await asyncio.sleep(3)
        return await run(dist)
    finally:
        stop(sim)
        stop(srv)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
