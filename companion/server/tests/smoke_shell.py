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
import os
import re
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
from style_checks import color_checks, style_checks  # noqa: E402

PORT, PIPE = int(os.environ.get("X4C_SMOKE_PORT", "8790")), "x4c_smoke"     # override when 8790 is busy
BASE = f"http://127.0.0.1:{PORT}"
EN = json.loads((ROOT / "ui" / "src" / "i18n" / "en.json").read_text(encoding="utf-8"))
results: list[tuple[bool, str]] = []
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")      # check texts may hold map labels ("→")
except (AttributeError, ValueError):
    pass
CASE_FILTER = ""
REPLAY_FROZEN = True
# temporary state / snapshots: X4C_TMP (e.g. a work folder on a data drive), else the system temp dir
TMPDIR = os.environ.get("X4C_TMP") or None
if TMPDIR:
    Path(TMPDIR).mkdir(parents=True, exist_ok=True)


def check(ok, what):
    results.append((bool(ok), what))
    print(("PASS " if ok else "FAIL ") + what, flush=True)


def start_world(dist: Path, state: str, replay: Path | None = None):
    launcher = (f"import sys; sys.path.insert(0, r'{ROOT}'); import server; from pathlib import Path; server.DIST = Path(r'{dist}'); "
                f"sys.argv = ['server.py', '--port', '{PORT}', '--pipe', '{PIPE}', '--host', '127.0.0.1', '--ui', 'dist', '--state-dir', r'{state}', "
                f"'--log-file', 'smoke_server.log']; sys.exit(server.main())")
    logs = ROOT / "logs"
    logs.mkdir(exist_ok=True)
    srv = subprocess.Popen([sys.executable, "-c", launcher], cwd=ROOT, stdout=open(logs / "smoke_server.out", "w"), stderr=subprocess.STDOUT)
    time.sleep(2.5)
    simargs = (["--replay", str(replay)] + (["--replay-frozen"] if REPLAY_FROZEN else [])) if replay else ["--seed", "7", "--player-speed", "300"]
    sim = subprocess.Popen([sys.executable, "sim.py", "--pipe", PIPE, *simargs], cwd=ROOT,
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


async def set_follow(p, val):
    await p.eval(f"(() => {{ const s = {MAP}.selRet; s.value = '{val}'; s.dispatchEvent(new Event('change', {{ bubbles: true }})); return s.value; }})()")


async def handover_matrix(b, sim_world: bool):
    """Sector -> galaxy -> sector by wheel (out far past the threshold, then back in), over sector kinds,
    panel shapes, pointer positions, follow modes, with / without the true sector size."""
    p0 = await fresh(b)
    await b.close_other_pages(p0)                      # the core checks' tabs
    kinds = await p0.eval(f"""(() => {{ const S = {MAP}.S, ps = String(S.player.sector.id);
        const dense = Object.entries(S.scans).filter(([k, v]) => k !== ps && (v.objs || []).length > 10).sort((a, b) => b[1].objs.length - a[1].objs.length)[0];
        const multi = [...S.sectors.values()].find(s => s.multi && s.id !== ps && (!dense || s.id !== dense[0]));
        // the simulator scans only the player's and the watched sector: watch a known one (it is populated on the first watch)
        const watchable = !dense && {'true' if sim_world else 'false'} ? [...S.sectors.values()].find(s => s.id !== ps && !s.multi && (!multi || s.id !== multi.id)) : null;
        return {{ player: ps, dense: dense ? dense[0] : (watchable ? watchable.id : null), multi: multi ? multi.id : null }}; }})()""")
    cases = []
    for panel in ("portrait", "wide"):                 # the player's sector: every combination
        for ptr in ("center", "off"):
            for follow in ("timed", "manual"):
                for truesize in (False, True):
                    cases.append(("player", panel, ptr, follow, truesize))
    for kind in ("dense", "multi"):                    # other sectors: each value at least once
        for panel in ("wide", "portrait"):
            for ptr in ("center", "off"):
                k = len(cases)
                cases.append((kind, panel, ptr, "manual" if k % 2 == 0 else "timed", (k // 2) % 2 == 0))
    for kind, panel, ptr, follow, truesize in cases:
        sid = kinds.get(kind)
        name = f"hand-over {kind} sector, {panel} panel, pointer {ptr}, follow {follow}, true size {'on' if truesize else 'off'}"
        if CASE_FILTER and CASE_FILTER not in name:
            continue
        if not sid:
            check(False, name + ": no such sector in this world")
            continue
        p = await fresh(b, w=1700, h=980)
        if panel == "portrait":
            await p.eval("""(() => { const s = document.querySelector('section[data-panel=map]'); s.style.width = '425px'; s.style.height = '790px'; s.style.flex = 'none'; return true; })()""")
            await asyncio.sleep(0.8)
        await set_follow(p, 0 if follow == "manual" else 8)
        await p.eval(f"""(() => {{ const m = {MAP}, S = m.S, sid = {json.dumps(sid)};
            S.sectorInfo = S.sectorInfo || {{}};
            if ({'true' if truesize else 'false'}) {{ if (!S.sectorInfo[sid]) S.sectorInfo[sid] = {{ core: 300000, cx: 0, cz: 0, contested: false }}; }}
            else delete S.sectorInfo[sid];
            if (sid === String(S.player.sector.id)) m.auto(); else m.showSector(sid); return true; }})()""")
        await asyncio.sleep(1.2)
        if kind == "dense":
            for _ in range(20):
                if (await p.eval(f"(({MAP}.S.scans[{json.dumps(sid)}] || {{}}).objs || []).length") or 0) > 10:
                    break
                await asyncio.sleep(0.3)
        size = await p.eval(f"[{MAP}.w, {MAP}.h]")
        cen = await canvas_center(p)
        r = await p.eval(f"(() => {{ const r = {MAP}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }})()")
        pt = cen if ptr == "center" else [r[0] + r[2] * 0.27, r[1] + r[3] * 0.32]
        start = await p.eval(f"[{MAP}.mode, {MAP}.currentSid()]")
        for _ in range(40):
            await p.wheel(pt[0], pt[1], 240); await asyncio.sleep(0.04)
        await asyncio.sleep(0.3)
        mid = await p.eval(f"[{MAP}.mode, Math.round(({MAP}.ghit || []).length)]")
        for _ in range(60):
            await p.wheel(pt[0], pt[1], -240); await asyncio.sleep(0.04)
        await asyncio.sleep(0.4)
        end = await p.eval(f"[{MAP}.mode, {MAP}.currentSid(), window.__x4ui.getUI().view]")
        ok = start[0] == "sector" and mid[0] == "galaxy" and end[0] == "sector" and end[2] == "map" and (ptr != "center" or end[1] == sid)
        check(ok, f"{name} [{size[0]}x{size[1]}]: {start} -> {mid} -> {end}")
        await b.close_page(p)


SHOTS = Path(os.environ.get("X4C_SHOTS") or r"D:\X4-backups\work\shots")
# the sector view's guidance this frame: drawn (a polyline / marker) when the data has a guidance to show
GD_DRAWN = f"""(() => {{ const m = {MAP}; m.dirty = true; m.frame(performance.now()); const G = m.lastGuidance, gd = m.S.player && m.S.player.gd;
    return [!!(gd && G && (G.runs.length || G.marker)), G ? G.label : null, G ? G.runs.length : 0]; }})()"""
# the player's-sector polyline must be: the player's position this frame, then the route points of this sector in order
GD_SHAPE = f"""(() => {{ const m = {MAP}, S = m.S; m.dirty = true; m.frame(performance.now());
    const gd = S.player.gd, G = m.lastGuidance, ps = String(S.player.sector.id), o = S.player.object;
    if (!gd || !G || !G.world.length) return {{ ok: false, why: 'nothing drawn', gd: !!gd }};
    const exp = [[o.x, o.z]];
    const pts = (gd.r || []).map(q => [String(q.s), q.x, q.z]);
    if (gd.t && gd.t.x !== undefined && gd.t.x !== null) pts.push([String(gd.t.s), gd.t.x, gd.t.z]);
    for (const [s, x, z] of pts) {{ if (s !== ps) break; exp.push([x, z]); }}
    const got = G.world[0];
    const same = got.length === exp.length && got.every((p, i) => Math.abs(p[0] - exp[i][0]) < 1e-6 && Math.abs(p[1] - exp[i][1]) < 1e-6);
    const sp = m.toScreen(o.x, o.z), s0 = G.runs[0][0];
    return {{ ok: same, n: got.length, start: Math.hypot(s0[0] - sp[0], s0[1] - sp[1]) < 0.01,
              color: JSON.stringify(G.color) === JSON.stringify(S.theme && S.theme.holo && S.theme.holo.missioncolor), label: G.label }}; }})()"""


async def guidance_checks(b, p):
    """v1.3 mission guidance against the simulator (sim --guidance route = what the new bridge sends)."""
    SHOTS.mkdir(parents=True, exist_ok=True)
    await p.click(5, 300); await p.key("1"); await asyncio.sleep(0.4)
    await p.eval(f"(() => {{ const m = {MAP}; if (!m.layers.hidden) m.togglePop('layers'); return true; }})()")
    await p.eval(f"(() => {{ const m = {MAP}; m.setMode('sector'); m.auto(); return true; }})()")
    await asyncio.sleep(1.2)
    samples = []
    for _ in range(6):                         # the ship flies on (300 m/s): every sample is one frame
        samples.append(await p.eval(GD_SHAPE))
        await asyncio.sleep(0.4)
    check(all(s.get("ok") for s in samples), f"guidance shape: player -> the route's waypoints of this sector (polyline vertices = route points) in 6 frames ({[s.get('n') for s in samples]})")
    check(all(s.get("start") for s in samples), "guidance starts at the player's drawn position in every sampled frame while the ship moves")
    check(all(s.get("color") for s in samples), "guidance colour = the game's missioncolor of the theme message")
    lab = samples[-1].get("label") or ""
    check(bool(re.search(r"^→ .+ · .+, \d+ jumps?$", lab) or re.search(r" · [\d.,]+ km$", lab)), f"guidance label: '→ next · target, N jumps' or 'objective · N km' ({lab})")
    # screenshots: sector near / far, galaxy
    for name, sc in (("sector_near", 0.004), ("sector_far", 0.0006)):
        await p.eval(f"(() => {{ const m = {MAP}, o = m.S.player.object; m.toManual(); m.manualUntil = Infinity; Object.assign(m.view, {{ cx: o.x, cz: o.z, scale: {sc} }}); m.dirty = true; return true; }})()")
        await asyncio.sleep(0.6)
        await p.screenshot(SHOTS / f"guidance_{name}.png")
    await nav_tab(p, "galaxy"); await asyncio.sleep(1.2)
    st = await p.eval(f"""(() => {{ const m = {MAP}, S = m.S, gd = S.player.gd; m.dirty = true; m.frame(performance.now()); const GG = m.lastGalaxyGuidance;
        if (!gd || !GG) return {{ ok: false }};
        const pts = [[String(S.player.sector.id), S.player.object]].concat((gd.r || []).map(q => [String(q.s), q]));
        if (gd.t && gd.t.x != null) pts.push([String(gd.t.s), gd.t]);
        const exp = pts.filter(([s]) => m.geo().sectors.get(s)).map(([s, q]) => m.toScreen(...m.gateGalaxyPos(s, q)));
        const same = GG.line.length === exp.length && GG.line.every((q, i) => Math.hypot(q[0] - exp[i][0], q[1] - exp[i][1]) < 0.01);
        return {{ ok: same, n: GG.line.length, hops: new Set(pts.map(([s]) => s)).size, target: GG.targetSid === (gd.t ? String(gd.t.s) : null) }}; }})()""")
    check(st.get("ok") and st.get("target") and st.get("n", 0) >= 2, f"galaxy view: guidance polyline through the player and every hop's gate positions, target sector outlined ({st})")
    await p.eval(f"""(() => {{ const m = {MAP}, g = m.sectorGeo(m.S.player.sector.id); m.toManual(); m.manualUntil = Infinity;
        Object.assign(m.gview, {{ cx: g ? g.x : 0, cz: g ? g.z : 0, scale: Math.min(m.w, m.h) / 9e7 }}); m.dirty = true; return true; }})()""")
    await asyncio.sleep(0.6)
    await p.screenshot(SHOTS / "guidance_galaxy.png")
    # guidance ends (a player message without "gd"): gone in the galaxy and the sector view
    await p.eval(f"(() => {{ if (!window.__gdHook) {{ window.__gdHook = true; {MAP}.c.bus.on('player', () => {{ if (window.__noGd) delete {MAP}.S.player.gd; }}); }} window.__noGd = true; return true; }})()")
    await asyncio.sleep(0.8)
    g1 = await p.eval(f"(() => {{ const m = {MAP}; m.dirty = true; m.frame(performance.now()); return [!m.S.player.gd, m.lastGalaxyGuidance]; }})()")
    await nav_tab(p, "map"); await asyncio.sleep(0.8)
    g2 = await p.eval(f"(() => {{ const m = {MAP}; m.dirty = true; m.frame(performance.now()); return [m.lastGuidance, (m.lastMiniGuidance || null)]; }})()")
    check(g1[0] and g1[1] is None and g2[0] is None and g2[1] is None, f"guidance ended -> line, marker, label gone (galaxy, sector, mini) ({g1[1]}, {g2})")
    await p.eval("(() => { window.__noGd = false; return true; })()")
    await asyncio.sleep(0.8)
    # Missions panel: the active mission shows where its target is; "Show on map" centres it
    await p.click(5, 300); await p.key("5"); await asyncio.sleep(1.0)
    row = await p.eval("(() => { const e = document.querySelector('[data-guidance]'); return e ? e.innerText : null; })()")
    ok_click = await p.click_el("document.querySelector('[data-guidance-show]')")
    await asyncio.sleep(1.5)
    st = await p.eval(f"""(() => {{ const m = {MAP}, gd = m.S.player.gd, v = window.__x4ui.getUI().view;
        return [v, m.mode, m.cam, m.focusObj, gd && gd.t ? gd.t.id : null, m.currentSid(), gd && gd.t ? String(gd.t.s) : null]; }})()""")
    check(row and ok_click and st[0] == "map" and st[1] == "sector" and st[2] == "focus" and st[3] == st[4] and st[5] == st[6],
          f"Missions: active mission shows its target ({row!r}); 'Show on map' opens the target's sector focused on it ({st})")
    await p.click(5, 300); await p.key("a"); await asyncio.sleep(0.8)


async def run(dist: Path, replay: bool, suite: str) -> int:
    async with Browser(1700, 1100, port=9336, profile="headless-smoke") as b:
        # the core checks first: in the simulator they need the player near its start (abandoned ships,
        # the start sector's highways); the hand-over matrix does not depend on where the player is
        if suite in ("all", "core") or replay:
            await run_core(b, minimal=replay)
        if suite in ("all", "core", "style") or replay:
            # the game look: computed colours, the bundled font, network, contrast, focus (tests/style_checks.py)
            await style_checks(b, BASE, check, f"{MAP} && {MAP}.w > 0 && {MAP}.S.player && {MAP}.S.liveGalaxy && {MAP}.S.liveGalaxy.length", dist)
            # the game's semantic colours (relation / ownership / mission) on the map and in every list
            await color_checks(b, BASE, check, f"{MAP} && {MAP}.w > 0 && {MAP}.S.player && {MAP}.S.liveGalaxy && {MAP}.S.liveGalaxy.length")
        if suite in ("all", "handover"):
            await handover_matrix(b, not replay)
        return summary()


def summary() -> int:
    failed = [w for ok, w in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


async def run_core(b, minimal: bool) -> int:
    if True:
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
        # ---- every gate pair of the data is drawn as a galaxy connection (live replay: real data shapes)
        await nav_tab(p, "galaxy"); await asyncio.sleep(1.0)
        st = await p.eval(f"""(() => {{ const m = {MAP}, S = m.S, pairs = new Set();
            const add = (a, b) => {{ if (a && b && a !== b && S.sectors.has(String(a)) && S.sectors.has(String(b))) pairs.add([String(a), String(b)].sort().join('|')); }};
            for (const g of S.gates || []) if (!g.hw && g.ds) add(g.s, g.ds);
            for (const [sid, sc] of Object.entries(S.scans || {{}})) for (const o of sc.objs || []) if (o.c === 'gate' && o.ds) add(sid, o.ds);
            return [m.lastGateLinks, pairs.size]; }})()""")
        check(st and st[0] == st[1] and st[1] > 0, f"galaxy: every gate pair between known sectors is drawn as a connection (drawn {st[0]}, pairs {st[1]})")
        await nav_tab(p, "map"); await asyncio.sleep(0.6)
        # ---- v1.3 guidance with whatever the data holds (live replay: today's bridge sends no "gd"): never a stray line
        st = await p.eval(f"""(() => {{ const m = {MAP}, S = m.S; m.dirty = true; m.frame(performance.now());
            const P = S.player || {{}}, gd = P.gd, lg = P.guidance, ps = P.sector ? String(P.sector.id) : null;
            const legacyHere = !gd && lg && !lg.unknown && String(lg.s) === ps;
            const G = m.lastGuidance;
            if (!gd && !legacyHere) return [!G || (!G.runs.length && !G.marker), 'no gd' + (lg ? ' (legacy course in ' + lg.s + ')' : '')];
            return [!!(G && G.runs.length), gd ? 'gd' : 'legacy course here']; }})()""")
        check(st and st[0], f"guidance with the data as it is: drawn only when there is something to draw ({st})")
        if minimal:
            return 0

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
        await set_follow(p, 0)
        c = await canvas_center(p)
        await p.drag(c[0], c[1], c[0] + 180, c[1] + 90)
        await asyncio.sleep(0.4)
        v0 = await p.eval(f"[{MAP}.cam, {MAP}.view.cx, {MAP}.view.cz, {MAP}.view.scale]")
        await asyncio.sleep(4)
        v1 = await p.eval(f"[{MAP}.cam, {MAP}.view.cx, {MAP}.view.cz, {MAP}.view.scale]")
        check(v0[0] == "manual" and v0 == v1, f"follow 'Manual': after a drag the camera stays put for 4 s ({v0[0]})")
        await set_follow(p, 5)
        await p.drag(c[0], c[1], c[0] - 150, c[1] - 60)
        await asyncio.sleep(6.5)
        st = await p.eval(f"""(() => {{ const m = {MAP}, p = m.S.player.object; return [m.cam, Math.round(Math.hypot(m.view.cx - p.x, m.view.cz - p.z))]; }})()""")
        check(st[0] == "follow" and st[1] < 20000, f"follow 'Back to ship after 5 s' returns to the ship ({st})")
        await set_follow(p, 8)

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

        # ---- v1.2: names modes (clicking the Names chip) at three zoom levels
        await p.eval(f"(() => {{ const m = {MAP}; m.setMode('sector'); m.viewSector = null; m.toManual(); m.manualUntil = Infinity; return true; }})()")
        if await p.eval(f"{MAP}.layers.hidden"):
            await p.click_el(f"{MAP}.layersBtn"); await asyncio.sleep(0.3)
        counts = {}
        for want in ("auto", "all", "off"):
            for _ in range(3):
                if await p.eval(f"{MAP}.cfg.labels") == want:
                    break
                await p.click_el(f"{MAP}.lblBtn"); await asyncio.sleep(0.3)
            for zn, sc in (("far", 0.0003), ("mid", 0.002), ("near", 0.03)):
                await p.eval(f"""(() => {{ const m = {MAP}, o = m.S.player.object; Object.assign(m.view, {{ cx: o.x, cz: o.z, scale: {sc} }}); m.dirty = true; return true; }})()""")
                await asyncio.sleep(0.4)
                counts[want + zn] = await p.eval(f"""(() => {{ const m = {MAP}; const L = (m.lastLabels || []);
                    const on = (m.hit || []).filter(h => h.x >= 0 && h.y >= 0 && h.x <= m.w && h.y <= m.h).length;
                    return [L.filter(l => !l.always).length, on]; }})()""")
        stored = await p.eval("JSON.parse(localStorage.getItem('x4c.map')).labels")
        check(all(counts["off" + z][0] == 0 for z in ("far", "mid", "near")) and stored == "off",
              f"names 'never' (chip): no ordinary names at far/mid/near, persisted ({[counts['off' + z] for z in ('far', 'mid', 'near')]})")
        check(all(counts["all" + z][0] >= counts["auto" + z][0] for z in ("far", "mid", "near")) and counts["autonear"][0] > 0 and counts["automid"][0] > 0,
              f"names 'when zoomed in' names objects at mid/near and never more than 'always' ({[counts['auto' + z] for z in ('far', 'mid', 'near')]} vs {[counts['all' + z] for z in ('far', 'mid', 'near')]})")
        await p.click_el(f"{MAP}.lblBtn"); await asyncio.sleep(0.3)     # back to "when zoomed in"

        # ---- v1.2: always-on labels never overlap each other or the route label
        bad = await p.eval(f"""(() => {{ const m = {MAP}, o = m.S.player.object; const out = [];
            for (const sc of [0.0003, 0.0012, 0.004]) {{ Object.assign(m.view, {{ cx: 0, cz: 0, scale: sc }}); m.dirty = true; m.frame(performance.now());
              const L = (m.lastLabels || []).filter(l => l.always).map(l => l.box), R = m._lineBoxes || [];
              for (let i = 0; i < L.length; i++) {{ for (let j = i + 1; j < L.length; j++) {{ const a = L[i], c = L[j]; if (a[0] < c[2] - 0.5 && a[2] > c[0] + 0.5 && a[1] < c[3] - 0.5 && a[3] > c[1] + 0.5) out.push(sc + ' l/l'); }}
                for (const c of R) {{ const a = L[i]; if (a[0] < c[2] - 0.5 && a[2] > c[0] + 0.5 && a[1] < c[3] - 0.5 && a[3] > c[1] + 0.5) out.push(sc + ' l/route'); }} }} }}
            return out; }})()""")
        check(not bad, f"always-on labels (gates, abandoned ships) never overlap each other or the route label ({bad[:3]})")

        # ---- v1.2: resource areas layer (sim = what the new bridge sends) and the true sector size
        await p.eval(f"""(() => {{ const m = {MAP}, o = m.S.player.object; Object.assign(m.view, {{ cx: 0, cz: 0, scale: 0.0012 }}); m.dirty = true; return true; }})()""")
        await asyncio.sleep(0.6)
        r0 = await p.eval(f"{MAP}.lastResources")
        if await p.eval(f"{MAP}.layers.hidden"):
            await p.click_el(f"{MAP}.layersBtn"); await asyncio.sleep(0.3)
        await p.click_el(f"{MAP}.chips.resources"); await asyncio.sleep(0.5)
        r1 = await p.eval(f"[{MAP}.lastResources, JSON.parse(localStorage.getItem('x4c.map')).resources]")
        await p.click_el(f"{MAP}.chips.resources"); await asyncio.sleep(0.5)
        r2 = await p.eval(f"{MAP}.lastResources")
        check(r0 > 0 and r1 == [0, False] and r2 == r0, f"'Resource areas' layer: drawn ({r0} cells), toggle hides them and persists ({r1}), back on ({r2})")
        hx = await p.eval(f"""(() => {{ const m = {MAP}, h = m.lastSectorHex, si = m.S.sectorInfo && m.S.sectorInfo[m.currentSid()];
            return [h.source, Math.round(h.target), si ? Math.round(si.core / 2) : null]; }})()""")
        check(hx[0] == "core" and hx[1] == hx[2], f"sector border from the true sector size when the bridge sends it ({hx})")
        other = await p.eval(f"""(() => {{ const m = {MAP}, ps = m.S.player.sector.id; const s = [...m.S.sectors.keys()].find(k => k !== ps && !(m.S.sectorInfo || {{}})[k]);
            if (!s) return null; m.showSector(s); return s; }})()""")
        await asyncio.sleep(1.2)
        hx2 = await p.eval(f"[{MAP}.lastSectorHex.source, {MAP}.lastSectorHex.sid]")
        check(other and hx2 == ["approx", other], f"... and the approximation for a sector without it ({hx2})")
        await p.click(5, 300); await p.key("a"); await asyncio.sleep(0.5)

        # ---- task E: with ship follow on, the user's zoom-out sticks (no automatic zoom-in), timed return keeps it
        await p.click(5, 300); await p.key("a"); await asyncio.sleep(1.5)
        await set_follow(p, 5)
        c = await canvas_center(p)
        for _ in range(4):                        # in first (well clear of the sector -> galaxy hand-over) ...
            await p.wheel(c[0], c[1], -160); await asyncio.sleep(0.08)
        await asyncio.sleep(1.0)
        z_in = await p.eval(f"{MAP}.view.scale")
        await p.wheel(c[0], c[1], 160)            # ... then one step out: this zoom-out must stick
        await asyncio.sleep(2.0)
        z0 = await p.eval(f"[{MAP}.mode, {MAP}.cam, {MAP}.view.scale]")
        check(z0[2] < z_in * 0.99, f"E: the user's wheel zoom-out with follow on takes effect ({z_in:.3e} -> {z0[2]:.3e}, {z0[:2]})")
        zs = []
        for _ in range(16):                       # 8 s of live sim snapshots (the player flies on)
            await asyncio.sleep(0.5)
            zs.append(await p.eval(f"{MAP}.view.scale"))
        check(z0[0] == "sector" and z0[1] == "follow" and max(zs) <= z0[2] * 1.0001,
              f"E: follow on, after the user zooms out the map never zooms back in by itself ({z0[2]:.3e} -> max {max(zs):.3e})")
        await p.drag(c[0], c[1], c[0] + 120, c[1] + 40); await asyncio.sleep(6.5)
        st = await p.eval(f"""(() => {{ const m = {MAP}, o = m.S.player.object; return [m.cam, m.view.scale, Math.round(Math.hypot(m.view.cx - o.x, m.view.cz - o.z))]; }})()""")
        check(st[0] == "follow" and abs(st[1] - z0[2]) / z0[2] < 1e-6 and st[2] < 20000, f"E: the timed return to the ship recentres without changing the zoom ({st})")
        await set_follow(p, 8)

        # ---- task F: local highways (sim = what the new bridge sends) and abandoned-ship badges never overlap
        hw = await p.eval(f"""(() => {{ const m = {MAP}, S = m.S; const sid = Object.keys(S.highways || {{}}).find(k => (S.highways[k] || []).length);
            if (!sid) return null; if (sid !== String(S.player.sector.id)) m.showSector(sid); else m.auto();
            m.toManual(); m.manualUntil = Infinity; Object.assign(m.view, {{ cx: 0, cz: 0, scale: 0.0015 }}); m.dirty = true; return sid; }})()""")
        await asyncio.sleep(1.0)
        nh = await p.eval(f"{MAP}.lastHighways")
        check(hw and nh >= 2, f"local highways drawn in a sector that has them ({hw}: {nh} lanes)")
        await p.click(5, 300); await p.key("a"); await asyncio.sleep(0.8)
        bad = await p.eval(f"""(() => {{ const m = {MAP}, out = []; for (const sc of [0.0008, 0.002, 0.006]) {{
              Object.assign(m.view, {{ cx: m.S.player.object.x, cz: m.S.player.object.z, scale: sc }}); m.toManual(); m.manualUntil = Infinity; m.dirty = true; m.frame(performance.now());
              const B = (m.lastOwnerless || []).map(q => q.badge).filter(q => q && q[2] - q[0] > 2);
              for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {{ const a = B[i], c = B[j]; if (a[0] < c[2] && a[2] > c[0] && a[1] < c[3] && a[3] > c[1]) out.push(sc); }} }} return out; }})()""")
        check(not bad, f"abandoned-ship badges never overlap each other ({bad})")
        await p.click(5, 300); await p.key("a"); await asyncio.sleep(0.5)

        await guidance_checks(b, p)

        # ---- Layers popover at 80 / 100 / 125 %
        for font in (80, 100, 125):
            q = await fresh(b, font=font, w=1600, h=1100)
            await q.click_el(f"{MAP}.layersBtn"); await asyncio.sleep(0.6)
            st = await q.eval(f"""(() => {{ const m = {MAP}, L = m.layers, C = m.body.getBoundingClientRect(), r = L.getBoundingClientRect();
                return [!L.hidden, r.top >= C.top && r.bottom <= C.bottom + 0.5, L.clientHeight >= L.scrollHeight - 1 || L.clientHeight >= 60, Math.round(r.height)]; }})()""")
            check(st and st[0] and st[1] and st[2] and st[3] > 60, f"Layers popover opens fully at {font} % ({st})")
            st = await q.eval(GD_DRAWN)
            check(st and st[0], f"mission guidance drawn at UI scale {font} % ({st})")

        # ---- pop-out map draws
        q = await fresh(b, url="/?panel=map", w=1200, h=800)
        st = await q.eval(f"[{MAP}.w, {MAP}.h, {MAP}.canvas.width]")
        h = await q.eval(CANVAS_HASH)
        check(st[0] > 500 and st[1] > 300 and h, f"pop-out map draws ({st})")
        st = await q.eval(GD_DRAWN)
        check(st and st[0], f"mission guidance drawn in the pop-out map ({st})")

        # ---- full-screen toggle in the top bar (real click = user gesture); Esc exit updates the icon
        q = await fresh(b)
        await q.eval("(() => { const L = " + json.dumps([EN["top"]["fullscreen"], EN["top"]["fullscreen_exit"]]) + "; window.__fsBtn = () => "
                     "[...document.querySelectorAll('button[aria-pressed]')].find(e => L.includes(e.getAttribute('aria-label'))) || null; return true; })()")
        fs0 = await q.eval("[!!window.__fsBtn(), !!document.fullscreenEnabled]")
        if not fs0[0]:
            check(not fs0[1], f"full-screen button hidden only because the Fullscreen API is unavailable ({fs0})")
        else:
            # a real click first: headless Brave refuses full screen ("not granted"), a visible browser grants it
            await q.eval("(() => { window.__fsLog = []; document.addEventListener('fullscreenchange', () => window.__fsLog.push(!!document.fullscreenElement)); "
                         "const o = Element.prototype.requestFullscreen; Element.prototype.requestFullscreen = function () { const r = o.call(this); "
                         "r.then(() => window.__fsLog.push('granted'), (e) => window.__fsLog.push('refused: ' + e.message)); return r; }; return true; })()")
            await q.click_el("window.__fsBtn()"); await asyncio.sleep(1.0)
            real = await q.eval("[!!document.fullscreenElement, window.__fsLog]")
            if real[0]:
                await q.eval("document.exitFullscreen().then(() => true, () => false)"); await asyncio.sleep(0.8)
            # the toggle logic + icon against an emulated Fullscreen API (what the browser does: the element
            # property + 'fullscreenchange'; Esc = the browser leaves full screen and fires the event)
            await q.eval("""(() => { let fs = null; window.__fsCalls = [];
                Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fs });
                const fire = () => document.dispatchEvent(new Event('fullscreenchange'));
                Element.prototype.requestFullscreen = function () { window.__fsCalls.push('request'); fs = this; fire(); return Promise.resolve(); };
                document.exitFullscreen = function () { window.__fsCalls.push('exit'); fs = null; fire(); return Promise.resolve(); };
                window.__fsEsc = () => { fs = null; fire(); }; return true; })()""")
            BTN = "window.__fsBtn()"
            await q.click_el(BTN); await asyncio.sleep(0.6)
            on = await q.eval(f"[!!document.fullscreenElement, {BTN}.getAttribute('aria-pressed'), {BTN}.getAttribute('aria-label'), window.__fsCalls.slice()]")
            check(on[0] and on[1] == "true" and on[2] == EN["top"]["fullscreen_exit"] and on[3] == ["request"],
                  f"full-screen button: click requests full screen, icon + label switch (real headless request: {real}; emulated: {on})")
            await q.eval("window.__fsEsc()"); await asyncio.sleep(0.6)
            esc = await q.eval(f"[!!document.fullscreenElement, {BTN}.getAttribute('aria-pressed'), {BTN}.getAttribute('aria-label')]")
            check(not esc[0] and esc[1] == "false" and esc[2] == EN["top"]["fullscreen"], f"leaving full screen by Esc (fullscreenchange) switches the icon back ({esc})")
            await q.click_el(BTN); await asyncio.sleep(0.5)
            await q.click_el(BTN); await asyncio.sleep(0.5)
            off2 = await q.eval(f"[!!document.fullscreenElement, {BTN}.getAttribute('aria-pressed'), window.__fsCalls.slice()]")
            check(not off2[0] and off2[1] == "false" and off2[2] == ["request", "request", "exit"], f"full-screen button toggles: second click exits ({off2})")

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

    return 0


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", type=Path, default=None)
    ap.add_argument("--replay", type=Path, default=None, help="live snapshot JSON (GET /api/state) to replay instead of the simulator")
    ap.add_argument("--live", action="store_true", help="take the snapshot from the live server http://127.0.0.1:8788/api/state (GET only) and replay it")
    ap.add_argument("--suite", choices=["all", "core", "handover", "style"], default="all")
    ap.add_argument("--case", default="", help="only hand-over cases whose name contains this")
    ap.add_argument("--replay-live", action="store_true", help="replay: keep re-sending player + scans (a paused game still reports), not frozen")
    a = ap.parse_args()
    global CASE_FILTER, REPLAY_FROZEN
    CASE_FILTER, REPLAY_FROZEN = a.case, not a.replay_live
    if a.live:
        import urllib.request
        snap = urllib.request.urlopen("http://127.0.0.1:8788/api/state", timeout=10).read()
        a.replay = Path(tempfile.mkdtemp(prefix="x4c-replay-", dir=TMPDIR)) / "live_state.json"
        a.replay.write_bytes(snap)
        print("live snapshot:", a.replay, len(snap), "bytes")
    dist = a.dist or (ROOT / "web-dist-candidate" if (ROOT / "web-dist-candidate" / "index.html").is_file() else ROOT / "web-dist")
    if not find_browser():
        print("SKIP no Chromium-based browser")
        return 2
    print("dist:", dist)
    state = tempfile.mkdtemp(prefix="x4c-smoke-", dir=TMPDIR)
    srv, sim = start_world(dist.resolve(), state, a.replay)
    try:
        async with aiohttp.ClientSession() as s:
            for _ in range(60):
                try:
                    async with s.get(BASE + "/api/status") as r:
                        if r.status == 200 and (await r.json()).get("game") in ("live", "paused"):
                            break
                except aiohttp.ClientError:
                    pass
                await asyncio.sleep(0.5)
        await asyncio.sleep(3)
        return await run(dist, bool(a.replay), a.suite)
    finally:
        stop(sim)
        stop(srv)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
