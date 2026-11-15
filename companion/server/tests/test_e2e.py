"""End-to-end test without the game: server.py + sim.py through the real duplex named pipe, checked
over real HTTP and WebSocket, plus the offline Lua bridge test and a syntax check of the web JS.

    uv run --group test python tests\\test_e2e.py

Uses its own pipe names (x4companion_e2e, x4companion_e2e_legacy) and ports (8791/8792/8793), and a
temporary --state-dir for saved layouts, so it never touches a running server, the real state\ folder,
the v0 pipe/port or the game.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
PORT = int(os.environ.get("X4C_E2E_PORT", "8791"))      # override when 8791 is busy (parallel work)
PIPE = os.environ.get("X4C_E2E_PIPE", "x4companion_e2e")
BASE = f"http://127.0.0.1:{PORT}"
ORIGIN = f"http://127.0.0.1:{PORT}"

results: list[tuple[bool, str]] = []
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass
procs: list[subprocess.Popen] = []


def check(ok, what):
    results.append((bool(ok), what))
    print(("PASS " if ok else "FAIL ") + what, flush=True)


def start(args, name):
    log = open(ROOT / "logs" / f"e2e_{name}.log", "w", encoding="utf-8")
    p = subprocess.Popen([PY, *args], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    procs.append(p)
    return p


def stop(p):
    if p.poll() is None:
        p.terminate()
        p.wait(10)


STATE_DIR = tempfile.mkdtemp(prefix="x4c_e2e_state_")    # saved layouts of the test servers (never the real state/)
DIST = ROOT / "web-dist"


def start_server(port=PORT, name="server", pipe=PIPE, *extra):
    return start(["server.py", "--port", str(port), "--pipe", pipe, "--log-file", f"e2e_{name}_file.log",
                  "--state-dir", STATE_DIR, *extra], name)


def start_sim(*extra, name="sim"):
    return start(["sim.py", "--pipe", PIPE, *extra], name)


async def wait_http(s, timeout=20):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            async with s.get(BASE + "/api/status") as r:
                if r.status == 200:
                    return True
        except aiohttp.ClientError:
            pass
        await asyncio.sleep(0.25)
    return False


ALLRAW: list[str] = []      # every text the browser ever received (discovery leak check)


class WS:
    def __init__(self, ws):
        self.ws = ws
        self.msgs: list[dict] = []

    async def pump(self, seconds, until=None):
        t_end = time.monotonic() + seconds
        while time.monotonic() < t_end:
            try:
                m = await self.ws.receive(timeout=max(0.05, t_end - time.monotonic()))
            except asyncio.TimeoutError:
                break
            if m.type != aiohttp.WSMsgType.TEXT:
                break
            ALLRAW.append(m.data)
            d = json.loads(m.data)
            self.msgs.append(d)
            if until and until(d):
                return d
        return None

    def of(self, t):
        return [m for m in self.msgs if m.get("type") == t]

    async def send(self, obj):
        await self.ws.send_str(json.dumps(obj))


def listening(port):
    out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True).stdout
    return [l.split()[1] for l in out.splitlines() if len(l.split()) >= 4 and l.split()[3] == "LISTENING" and l.split()[1].endswith(f":{port}")]


CANVAS_PROBE = """(() => {
  const c = document.querySelector('.x4map-root canvas');
  if (!c || !c.width || !c.height || c.clientHeight < 50) return null;
  const g = c.getContext('2d'); const seen = new Set();
  for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
    const d = g.getImageData(Math.floor(c.width * i / 12), Math.floor(c.height * j / 12), 1, 1).data;
    seen.add(d[0] + ',' + d[1] + ',' + d[2]);
  }
  return { w: c.clientWidth, h: c.clientHeight, colours: seen.size,
           bad: (document.body.innerText.match(/\\bnull\\b|\\bundefined\\b|\\bNaN\\b/g) || []).length };
})()"""


async def ui_browser_checks():
    """v2 shell in a real headless browser (own profile): main window and the map pop-out route
    get a canvas with a real size that draws, and no null/undefined/NaN text anywhere."""
    sys.path.insert(0, str(ROOT / "tests"))
    from cdp import Browser, find_browser
    if not find_browser():
        check(True, "[ui] no Chromium-based browser here - browser checks skipped")
        return
    async with Browser(1920, 1040, port=9336, profile="headless-e2e-ui") as b:
        for url, w, h, name in ((BASE + "/", 1920, 1040, "main window"), (BASE + "/?panel=map", 1280, 900, "pop-out /?panel=map")):
            p = await b.page("about:blank", w, h)
            await p.goto(url)
            got = await p.wait_for(CANVAS_PROBE + " && " + CANVAS_PROBE + ".colours > 3 ? " + CANVAS_PROBE + " : null", timeout=20)
            shot = ROOT / "logs" / f"e2e_ui_{'popout_map' if 'panel' in url else 'main'}.png"
            try:
                await p.screenshot(shot)
            except (RuntimeError, TimeoutError):
                pass
            check(bool(got) and got["w"] > 300 and got["h"] > 300 and got["colours"] > 3,
                  f"[ui] {name}: map canvas {got and got['w']}x{got and got['h']} px draws ({got and got['colours']} colours), screenshot {shot.name}")
            check(bool(got) and got["bad"] == 0, f"[ui] {name}: no null/undefined/NaN text on the page ({got and got['bad']})")


async def main() -> int:
    (ROOT / "logs").mkdir(exist_ok=True)

    # 0) offline parts: Lua bridge under LuaJIT, JS syntax
    r = subprocess.run([PY, str(ROOT / "tests" / "test_lua_bridge.py")], capture_output=True, text=True, encoding="utf-8", errors="replace")
    last = [l for l in r.stdout.splitlines() if "checks passed" in l]
    check(r.returncode == 0, f"Lua bridge offline test (LuaJIT 2.1 + mock game): {last[-1] if last else r.stdout[-300:]}")
    node = shutil.which("node")
    if node:
        bad = []
        with tempfile.TemporaryDirectory() as td:
            for f in (ROOT / "web").glob("*.js"):
                tgt = Path(td) / (f.stem + ".mjs")
                tgt.write_bytes(f.read_bytes())
                if subprocess.run([node, "--check", str(tgt)], capture_output=True).returncode != 0:
                    bad.append(f.name)
        check(not bad, f"web JS modules parse (node --check): {bad or 'all ok'}")
        for t in ("test_camera.mjs", "test_mapstyle.mjs", "test_galaxy_layout.mjs"):
            r = subprocess.run([node, str(ROOT / "tests" / t)], capture_output=True, text=True, encoding="utf-8", errors="replace")
            last = [l for l in r.stdout.splitlines() if "checks passed" in l]
            check(r.returncode == 0, f"browser logic {t}: {last[-1] if last else r.stdout[-300:]}")
        # v2 shell unit tests (formatters, info panel model, layout tree, en/hu token parity)
        vitest = ROOT / "ui" / "node_modules" / "vitest" / "vitest.mjs"
        if vitest.is_file():
            r = subprocess.run([node, str(vitest), "run"], cwd=ROOT / "ui", capture_output=True, text=True, encoding="utf-8", errors="replace")
            tl = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("Tests")]
            check(r.returncode == 0, f"v2 shell unit tests (vitest): {tl[-1] if tl else r.stdout[-300:]}")
    r = subprocess.run([PY, str(ROOT / "tests" / "test_layouts.py")], capture_output=True, text=True, encoding="utf-8", errors="replace")
    last = [l for l in r.stdout.splitlines() if "checks passed" in l]
    check(r.returncode == 0, f"saved layouts store (save/load/delete/malformed): {last[-1] if last else r.stdout[-300:]}")

    server = start_server()
    async with aiohttp.ClientSession() as s:
        check(await wait_http(s), "server answers")
        check(listening(PORT) == [f"127.0.0.1:{PORT}"], f"listens on 127.0.0.1 only: {listening(PORT)}")
        v2 = (DIST / "index.html").is_file()
        async with s.get(BASE + "/") as r:
            body = await r.text()
            if v2:
                check(r.status == 200 and 'type="module"' in body and "/assets/" in body and 'id="root"' in body, "GET / serves the v2 dashboard (web-dist)")
            else:
                check(r.status == 200 and 'type="module"' in body and "app.js" in body, "GET / serves the dashboard")
            check("default-src 'self'" in r.headers.get("Content-Security-Policy", "") and r.headers.get("X-Content-Type-Options") == "nosniff",
                  "CSP (no external sources) + nosniff headers")
        if v2:
            assets = re.findall(r'(?:src|href)="(/assets/[^"]+)"', body)
            check(assets and not re.search(r'(?:src|href)="(?:https?:)?//', body), f"index references only local /assets ({len(assets)})")
            for a in assets:
                async with s.get(BASE + a) as r:
                    data = await r.read()
                    ct = r.headers.get("Content-Type", "")
                    ok = r.status == 200 and ("javascript" in ct if a.endswith(".js") else "text/css" in ct if a.endswith(".css") else True)
                    check(ok and "immutable" in r.headers.get("Cache-Control", ""), f"GET {a} ({ct}, {len(data) // 1024} KB, immutable)")
                    if a.endswith(".js"):
                        check(b"fonts.googleapis" not in data and b"cdn.jsdelivr" not in data and b"unpkg.com" not in data,
                              f"{a}: no CDN / external font URL in the bundle")
            for path in ("/assets/..%2f..%2fserver.py", "/assets/x.py", "/assets/index.html"):
                async with s.get(BASE + path) as r:
                    check(r.status in (403, 404), f"asset route refuses {path} ({r.status})")
        else:
            for f, ct in (("app.js", "text/javascript"), ("map.js", "text/javascript"), ("panels.js", "text/javascript"), ("util.js", "text/javascript"),
                          ("mapstyle.js", "text/javascript"), ("dock.js", "text/javascript"), ("camera.js", "text/javascript"), ("icons.js", "text/javascript"),
                          ("style.css", "text/css")):
                async with s.get(BASE + "/" + f) as r:
                    check(r.status == 200 and ct in r.headers.get("Content-Type", ""), f"GET /{f} ({r.headers.get('Content-Type')})")

        # saved layouts API (v2): save / list / default / delete, malformed input refused
        tree = {"t": "s", "id": "s1", "dir": "row", "size": 100, "kids": [{"t": "p", "id": "map", "size": 70}, {"t": "p", "id": "info", "size": 30}]}
        hdr = {"Origin": ORIGIN}
        async with s.get(BASE + "/api/layouts") as r:
            check(r.status == 200 and (await r.json())["items"] == {}, "GET /api/layouts: empty at start")
        async with s.put(BASE + "/api/layouts/Harc%202", json={"tree": tree, "opts": {"map": {"rotate": True}, "logcat": "alerts"}}, headers=hdr) as r:
            d = await r.json() if r.status == 200 else {}
            check(r.status == 200 and d.get("items", {}).get("Harc 2", {}).get("tree") == tree, f"PUT /api/layouts/<name> saves ({r.status})")
        async with s.put(BASE + "/api/layouts-default", json={"name": "Harc 2"}, headers=hdr) as r:
            check(r.status == 200 and (await r.json())["default"] == "Harc 2", "PUT /api/layouts-default sets the start layout")
        async with s.put(BASE + "/api/layouts/Temp", json={"tree": None, "opts": {}}, headers=hdr) as r:
            check(r.status == 200, "PUT a second layout")
        async with s.delete(BASE + "/api/layouts/Temp", headers=hdr) as r:
            check(r.status == 200 and "Temp" not in (await r.json())["items"], "DELETE /api/layouts/<name>")
        async with s.delete(BASE + "/api/layouts/Temp", headers=hdr) as r:
            check(r.status == 404, f"DELETE of a missing layout -> 404 ({r.status})")
        big = {g: {f"k{i}": "x" * 190 for i in range(40)} for g in ("map", "objects", "property")}
        for what, url, kw in (("a bad name", "/api/layouts/..%2f..%2fx", dict(json={"tree": None})),
                              ("an unknown module", "/api/layouts/x", dict(json={"tree": {"t": "p", "id": "evil", "size": 100}})),
                              ("an unknown body key", "/api/layouts/x", dict(json={"tree": None, "script": 1})),
                              ("a non-JSON body", "/api/layouts/x", dict(data=b"{nope")),
                              ("a too large layout", "/api/layouts/x", dict(json={"tree": None, "opts": big})),
                              ("an unknown default", "/api/layouts-default", dict(json={"name": "nope"}))):
            async with s.put(BASE + url, headers=hdr, **kw) as r:
                check(r.status in (400, 404, 413), f"layouts API refuses {what} ({r.status})")
        async with s.put(BASE + "/api/layouts/x", json={"tree": None}, headers={"Origin": "http://evil.example"}) as r:
            check(r.status == 403, f"layouts API refuses a foreign Origin ({r.status})")
        check((Path(STATE_DIR) / "layouts.json").is_file(), "layouts stored in <state-dir>/layouts.json")

        # the v1 shell stays reachable with --ui legacy (fallback)
        if v2:
            leg = start_server(PORT + 2, "server_legacy", PIPE + "_legacy", "--ui", "legacy")
            lbase = f"http://127.0.0.1:{PORT + 2}"
            ok = False
            for _ in range(60):
                try:
                    async with s.get(lbase + "/") as r:
                        ok = r.status == 200 and "app.js" in await r.text()
                        break
                except aiohttp.ClientError:
                    await asyncio.sleep(0.25)
            check(ok, "--ui legacy serves the v1 shell (web/)")
            stop(leg)
        for path in ("/..%2fserver.py", "/server.py", "/%2e%2e/pipe.py", "/web/../server.py"):
            async with s.get(BASE + path) as r:
                check(r.status in (403, 404), f"no file outside web/ via {path} ({r.status})")
        async with s.get(BASE + "/icons/index.json") as r:
            idx = await r.json()
            check(r.status == 200 and "icons" in idx, f"GET /icons/index.json ({idx.get('count')} exported icons{', export missing' if idx.get('missing_export') else ''})")
        if idx.get("icons"):
            name = "ship_s_fight_01" if "ship_s_fight_01" in idx["icons"] else next(iter(idx["icons"]))
            async with s.get(BASE + f"/icons/{name}.png") as r:
                body = await r.read()
                check(r.status == 200 and r.headers.get("Content-Type") == "image/png" and body[1:4] == b"PNG", f"GET /icons/{name}.png serves the exported game icon")
        for path in ("/icons/..%2f..%2fserver.py", "/icons/index.py", "/icons/x.png.json"):
            async with s.get(BASE + path) as r:
                check(r.status in (403, 404), f"icon route refuses {path} ({r.status})")
        async with s.get(BASE + "/", headers={"Host": "evil.example:8791"}) as r:
            check(r.status == 403, f"foreign Host refused ({r.status})")
        try:
            async with s.ws_connect(BASE + "/ws", origin="http://evil.example"):
                check(False, "foreign Origin WebSocket refused")
        except aiohttp.WSServerHandshakeError as e:
            check(e.status == 403, f"foreign Origin WebSocket refused ({e.status})")
        async with s.get(BASE + "/?panel=map") as r:
            check(r.status == 200, "pop-out URL /?panel=map served")

        # 1) full stream from the simulator (300 ships, hotkeys, bad bytes, junk lines)
        async with s.ws_connect(BASE + "/ws", origin=ORIGIN) as raw:
            ws = WS(raw)
            init = await ws.pump(3, until=lambda d: d["type"] == "init")
            check(init and "static" not in init and not init.get("galaxy"), "[discovery] init carries no static map geometry (nothing before the game reports what is known)")
            sim = start_sim("--ships", "300", "--hotkeys", "--bad-bytes", "--junk", "--speed", "3")
            await ws.pump(14)
            types = {m["type"] for m in ws.msgs}
            for t in ("hello", "player", "theme", "galaxy", "gates", "sector", "property", "log", "ticker", "messages", "missions", "offers",
                      "factions", "economy", "stats", "status", "hotkey"):
                check(t in types, f"[stream] browser receives '{t}' ({len(ws.of(t))})")
            pl = ws.of("player")
            check(len(pl) >= 25, f"[stream] player updates: {len(pl)} in 14 s (coalesced latest-only)")
            st = ws.of("status")[-1]
            check(st["game"] == "live" and st["pipe_connected"], f"[stream] status live: {st['game']}, {st['rate_hz']} msg/s")
            check(st["bad"] > 0 and st["pipe_connects"] == 1, f"[robust] junk + raw ESC lines ignored without dropping the pipe (bad={st['bad']}, connects={st['pipe_connects']})")
            gal = ws.of("galaxy")[-1]["clusters"]
            nsec = sum(len(c["sectors"]) for c in gal)
            static_n = sum(len(c["sectors"]) for c in json.loads((ROOT / "data" / "static_map.json").read_text(encoding="utf-8"))["clusters"])
            check(60 < nsec < static_n, f"[discovery] galaxy: {len(gal)} clusters / {nsec} discovered sectors (of {static_n} in the files)")
            gl = ws.of("gates")[-1]["gates"]
            check(len(gl) > 50 and any(g.get("du") for g in gl), f"[galaxy] {len(gl)} known gates, {sum(1 for g in gl if g.get('du'))} lead to '?' (undiscovered)")
            known_ids = {x["id"] for c in gal for x in c["sectors"]}
            check(all(g["s"] in known_ids and (not g.get("ds") or g["ds"] in known_ids) for g in gl), "[discovery] every gate endpoint is a discovered sector")
            hwl = ws.of("hwlinks")
            check(hwl and hwl[-1]["links"] and all(a in known_ids and b in known_ids for a, b in hwl[-1]["links"]),
                  f"[discovery] superhighways from the static export only between discovered sectors ({len(hwl[-1]['links']) if hwl else 0})")
            # cluster layout for the map (MapView.setStaticMap): known clusters only, {macro, x, z} only
            smsg = ws.of("staticmap")
            known_cl = {str(c.get("macro") or "").lower() for c in gal}
            known_sec_macros = {str(x.get("macro") or "").lower() for c in gal for x in c["sectors"]}
            if smsg:
                cls = smsg[-1]["clusters"]
                secs = [x for c in cls for x in c["sectors"]]
                check(cls and all(c["macro"] in known_cl and set(c) == {"macro", "sectors"} for c in cls),
                      f"[discovery] staticmap: {len(cls)} clusters, all with a known sector (of {len(known_cl)} known clusters)")
                check(secs and all(set(x) == {"macro", "x", "z"} for x in secs),
                      f"[discovery] staticmap sectors carry macro + position only ({len(secs)} sectors, "
                      f"{sum(1 for x in secs if x['macro'] not in known_sec_macros)} not yet discovered)")
                static_cl = {str(c["macro"]).lower() for c in json.loads((ROOT / "data" / "static_map.json").read_text(encoding="utf-8"))["clusters"]}
                check(len(cls) < len(static_cl), f"[discovery] staticmap never sends the whole export ({len(cls)} of {len(static_cl)} clusters)")
            else:
                check(False, "[map] staticmap message reaches the browser")
            if (DIST / "index.html").is_file():
                await ui_browser_checks()
            prop = {}
            for m in ws.of("property"):
                for e in m["upd"]:
                    prop[e["id"]] = e
                for k in m["del"]:
                    prop.pop(k, None)
            ships = [e for e in prop.values() if e["k"] == "ship"]
            check(len(ships) == 300 and len(prop) > 300, f"[property] {len(ships)} ships + {len(prop) - len(ships)} stations")
            names = [e["n"] for e in prop.values()]
            check(any("�" in n for n in names) and any('"' in n for n in names), "[robust] invalid UTF-8 replaced (U+FFFD), quotes in names survive")
            sc = ws.of("sector")[-1]
            check(sc["player"] and len(sc["objs"]) > 20, f"[sector] player sector scan with {len(sc['objs'])} visible objects (hidden {sc['hidden']})")
            logs = [e for m in ws.of("log") for e in m["items"]]
            check(len(logs) >= 40 and {e["cat"] for e in logs} >= {"general", "alerts"}, f"[log] {len(logs)} logbook entries, categories {sorted({e['cat'] for e in logs})}")
            check(len(ws.of("missions")[-1]["items"]) >= 5 and len(ws.of("offers")[-1]["items"]) >= 10, "[missions] accepted + offers")
            check(len(ws.of("factions")[-1]["items"]) >= 15, "[factions] relations + licences")
            check(ws.of("economy")[-1]["inc"] > 0, "[economy] summary")
            th = ws.of("theme")[-1]
            check(th.get("holo", {}).get("playercolor") and th["holo"].get("friendcolor"), "[map] theme (map colours) reaches the browser")
            check(any(o.get("ic") for o in sc["objs"]) and any(o.get("rr") for o in sc["objs"] if o.get("pl")),
                  "[map] sector objects carry the game icon id and own radar ranges")
            hk = ws.of("hotkey")
            check(hk and hk[0].get("action"), f"[hotkeys] in-game hotkey events reach the browser ({[h['action'] for h in hk][:4]})")

            # 1b) details (read-only, no control switch): own ship with order points
            own = next(o for o in sc["objs"] if o.get("pl") and o["c"].startswith("ship") and o["id"] in prop)
            await ws.send({"type": "cmd", "cmd": "details", "args": [own["id"]], "id": 90})
            det = await ws.pump(4, until=lambda d: d["type"] == "details" and d.get("id") == own["id"])
            check(det and det.get("orders") and det["orders"][0].get("pt") and det.get("ic"),
                  f"[details] info panel data + order queue points without the control switch ({len(det.get('orders') or []) if det else 0} orders)")

            # 2) commands
            await ws.send({"type": "cmd", "cmd": "openmap", "args": [ships[0]["id"]], "id": 1})
            rep = await ws.pump(3, until=lambda d: d["type"] == "cmdreply" and d.get("id") == 1)
            check(rep and not rep["ok"] and "vezérlés" in rep["msg"], f"[cmd] refused while the tab's control switch is off: {rep and rep['msg']}")
            await ws.send({"type": "control", "enabled": True})
            await ws.pump(1, until=lambda d: d["type"] == "control")
            await ws.send({"type": "cmd", "cmd": "openmap", "args": [ships[0]["id"]], "id": 2})
            ack = await ws.pump(4, until=lambda d: d["type"] == "ack" and d.get("cmd") == "openmap")
            check(ack and ack["ok"] and ack.get("mine"), f"[cmd] openmap -> pipe -> game -> ack routed back to the sender: {ack and ack['msg']}")
            await ws.send({"type": "cmd", "cmd": "target", "args": [sc["objs"][0]["id"]], "id": 3})
            ack = await ws.pump(4, until=lambda d: d["type"] == "ack" and d.get("cmd") == "target")
            check(ack and ack["ok"], "[cmd] target ack")
            await ws.send({"type": "cmd", "cmd": "stop", "args": [ships[0]["id"]], "id": 4})
            rep = await ws.pump(3, until=lambda d: d["type"] == "cmdreply" and d.get("id") == 4)
            check(rep and not rep["ok"] and "CFG.allow" in rep["msg"], f"[cmd] stop refused: not in the mod's allow-list ({rep and rep['msg']})")
            await ws.send({"type": "cmd", "cmd": "openmap", "args": ["12; rm -rf"], "id": 5})
            rep = await ws.pump(3, until=lambda d: d["type"] == "cmdreply" and d.get("id") == 5)
            check(rep and not rep["ok"], "[cmd] non-numeric argument refused")
            await ws.send({"type": "cmd", "cmd": "selfdestruct", "args": [], "id": 6})
            rep = await ws.pump(3, until=lambda d: d["type"] == "cmdreply" and d.get("id") == 6)
            check(rep and not rep["ok"], "[cmd] unknown command refused by the server")
            # watching an undiscovered sector is refused (sim mirrors the bridge rule)
            sys.path.insert(0, str(ROOT))
            import sim as simmod
            world = simmod.World(300, 42, True)
            unknown = sorted(set(world.sectors) - world.known)
            await ws.send({"type": "watch", "sid": unknown[0]})
            a = await ws.pump(4, until=lambda d: d["type"] == "ack" and d.get("cmd") == "watch")
            check(a and not a["ok"], f"[discovery] watch of an undiscovered sector refused ({a and a['msg']})")
            # watch another sector (read-only, no control needed)
            other = next(sid for c in gal for sid in [x["id"] for x in c["sectors"]] if sid != sc["sid"])
            await ws.send({"type": "watch", "sid": other})
            got = await ws.pump(6, until=lambda d: d["type"] == "sector" and d["sid"] == other)
            check(got and not got["player"], f"[watch] watched sector {other} scanned and streamed")

        # a client without Origin (not a browser) can read but cannot enable control
        async with s.ws_connect(BASE + "/ws") as raw:
            ws2 = WS(raw)
            await ws2.pump(1)
            await ws2.send({"type": "control", "enabled": True})
            c = await ws2.pump(2, until=lambda d: d["type"] == "control")
            check(c and not c["enabled"], "[security] no Origin header -> control cannot be enabled")
        stop(sim)

        # 3) pause / focus loss: last message paused:true, then silence with the pipe still open
        async with s.ws_connect(BASE + "/ws", origin=ORIGIN) as raw:
            ws = WS(raw)
            sim = start_sim("--ships", "50", "--pause-at", "4", "--pause-for", "9", name="sim_pause")
            seen = []
            t_end = time.monotonic() + 18
            while time.monotonic() < t_end:
                await ws.pump(0.5)
                st = ws.of("status")
                if st and (not seen or seen[-1] != st[-1]["game"]):
                    seen.append(st[-1]["game"])
            check("paused" in seen and "background" in seen and seen[-1] == "live" and "disconnected" not in seen[seen.index("paused"):],
                  f"[pause] states: {' -> '.join(seen)} (background is not disconnected)")
            stop(sim)
            await asyncio.sleep(4.5)
            await ws.pump(1.5)
            check(ws.of("status")[-1]["game"] == "disconnected", f"[kill] game killed -> {ws.of('status')[-1]['game']}")

            # 4) UI reload pattern + byte-mode client
            sim = start_sim("--ships", "20", "--seconds", "3", "--gc-on-exit", name="sim_gc")
            sim.wait(30)
            await ws.pump(0.5)                       # drain what the GC client sent
            ws.msgs.clear()
            sim = start_sim("--ships", "20", "--mode", "byte", name="sim_byte")
            got = await ws.pump(10, until=lambda d: d["type"] == "galaxy")
            clients = 0
            for _ in range(20):
                async with s.get(BASE + "/api/status") as r:
                    clients = (await r.json())["pipe_clients"]
                if clients == 1:
                    break
                await asyncio.sleep(0.25)
            check(got and clients == 1, f"[reloadui] new byte-mode client after garbage_collected, full resync ({clients} live client)")

        # 5) server restart while the game keeps running
        stop(server)
        await asyncio.sleep(1.5)
        server = start_server(name="server2")
        check(await wait_http(s), "[server restart] back")
        async with s.get(BASE + "/api/layouts") as r:
            d = await r.json()
            check("Harc 2" in d["items"] and d["default"] == "Harc 2", "[server restart] saved layouts and the start layout survive")
        async with s.ws_connect(BASE + "/ws", origin=ORIGIN) as raw:
            ws = WS(raw)
            got = await ws.pump(10, until=lambda d: d["type"] == "galaxy")
            check(got is not None and ws.of("player"), "[server restart] game reconnects by itself and resends everything")
        stop(sim)

        # 6) big empire: 900 ships -> chunked property messages, all arrive
        async with s.ws_connect(BASE + "/ws", origin=ORIGIN) as raw:
            ws = WS(raw)
            sim = start_sim("--ships", "900", "--seconds", "10", name="sim_big")
            await ws.pump(11)
            prop = {}
            for m in ws.of("property"):
                for e in m["upd"]:
                    prop[e["id"]] = e
            n = sum(1 for e in prop.values() if e["k"] == "ship")
            check(n == 900, f"[big] {n}/900 ships delivered in chunks < 48 KB")
            sim.wait(20)

        # 7) /api/state snapshot
        async with s.get(BASE + "/api/state") as r:
            snap = await r.json()
            check(snap["type"] == "init" and len(snap["property"]) >= 900 and snap["galaxy"], f"/api/state snapshot ({len(snap['property'])} property entries)")

        # 7b) nothing undiscovered ever reached a browser
        async with s.get(BASE + "/api/state") as r:
            ALLRAW.append(await r.text())
        blob = "\n".join(ALLRAW)
        leaked_ids = [u for u in unknown if f'"{u}"' in blob]
        check("SECRET" not in blob and not leaked_ids,
              f"[discovery] no undiscovered sector/station name or id in {len(ALLRAW)} browser messages ({blob.count('SECRET')} names, {len(leaked_ids)} ids)")

        # 8) a second server on the same pipe must refuse to start
        dup = start(["server.py", "--port", str(PORT + 1), "--pipe", PIPE, "--log-file", "e2e_dup_file.log"], "server_dup")
        rc = dup.wait(20)
        check(rc == 2, f"second server on the same pipe exits with error (rc={rc})")

    for p in procs:
        stop(p)
    alive = [p.pid for p in procs if p.poll() is None]
    check(not alive, f"all test processes stopped {alive}")
    failed = [w for ok, w in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        rc = asyncio.run(main())
    finally:
        for p in procs:
            if p.poll() is None:
                p.kill()
    sys.exit(rc)
