"""Runs the real bridge Lua (dev\\x4_companion\\ui\\x4_companion.lua) under LuaJIT 2.1 (lupa) against
tests\\mock_game.lua and checks its behaviour. This proves the Lua parses and runs, that every
message is valid JSON (also with invalid UTF-8 / ESC codes / quotes in game strings), that the
channels time-slice, that failing game functions are contained and switched off, that commands
and hotkeys round-trip, and it measures the bridge's own per-frame cost (mock engine calls are
almost free, so this is the Lua overhead only - real engine call costs are measured in-game by the
"stats" channel).

    uv run --group test python tests\\test_lua_bridge.py
"""
from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

import lupa.luajit21 as lupa

ROOT = Path(__file__).resolve().parent
BRIDGE = ROOT.parent.parent.parent / "dev" / "x4_companion" / "ui" / "x4_companion.lua"

results: list[tuple[bool, str]] = []
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


def check(ok, what):
    results.append((bool(ok), what))
    print(("PASS " if ok else "FAIL ") + what, flush=True)


def guidance_checks(src: str) -> None:
    """v1.3 mission guidance: the target from GetMissionIDObjectiveTarget (mock), the route from the MD round trip
    (mock of md\\x4_companion_guidance.xml), the discovery rule, disableguidance, plotted course, no mission."""
    rt = lupa.LuaRuntime(unpack_returned_tuples=True)
    rt.execute((ROOT / "mock_game.lua").read_text(encoding="utf-8"))
    rt.execute(src)
    M, T = rt.globals().MOCK, rt.globals().__X4COMPANION_TEST
    G = M.gdt
    gates = [int(g) for g in M.W.gates.values()]     # [unknown a (501), b (520), a1 (501), b1 (502), a2 (502), b2 (503), ...]
    vis = int(rt.eval("""(function() for id, o in pairs(MOCK.W.objs) do
        if o.class == "station" and o.sector == 501 and o.owner == "argon" and o.isknown ~= false and o.name:sub(1, 6) == "argon " then return id end
      end end)()"""))
    secret_st = int(M.secretstation)
    host = M.W.objs[int(G.host)]
    lt = rt.table_from

    def run(sec=1.0):
        n = len(M.out)
        for _ in range(int(sec * 60)):
            M.frame(1 / 60)
        new = [json.loads(s) for s in list(M.out.values())[n:]]
        pls = [m for m in new if m["type"] == "player"]
        return (pls[-1] if pls else {}), new, "\n".join(list(M.out.values())[n:])

    run(4.0)                                         # the missions channel has run once (mission type / objective)
    M.objtargets = lt([vis]); M.gdpath = lt([])
    pl, _, _ = run()
    gd = pl.get("gd") or {}
    t = gd.get("t") or {}
    check(gd.get("k") == "mission" and gd.get("mid") == "60001" and gd.get("ob") == "Objective 1" and gd.get("n") == "Mission 1"
          and t.get("id") == str(vis) and t.get("s") == "501" and t.get("x") is not None and gd.get("r") == [] and int(M.gd_value) == vis,
          f"guidance, component target in the player's sector: target id/sector/position, empty route, MD got the target ({gd})")

    req0 = int(M.gd_req)
    M.objtargets = lt([G.station503])
    M.gdpath = lt([G.zone, gates[2], gates[3], gates[4], gates[5], G.station503])
    pl, _, _ = run()
    gd = pl.get("gd") or {}
    r = gd.get("r") or []
    check([p["s"] for p in r] == ["501", "502", "502", "503"] and [p["id"] for p in r] == [str(g) for g in gates[2:6]]
          and all(p.get("x") is not None and p.get("k") == "g" for p in r) and (gd.get("t") or {}).get("s") == "503"
          and int(M.gd_req) > req0,
          f"guidance, cross-sector route: gate / exit gate per hop in order (zones and the target itself left out), re-asked on the target change ({r})")

    M.objtargets = lt([G.zone]); M.gdpath = lt([G.zone])
    pl, _, _ = run()
    t = (pl.get("gd") or {}).get("t") or {}
    check(t.get("c") == "zone" and t.get("x") == 70000 and t.get("z") == -30000 and "n" not in t,
          f"guidance, position target (zone): position, no name ({t})")

    M.objtargets = lt([G.room]); M.gdpath = lt([])
    pl, _, _ = run()
    t = (pl.get("gd") or {}).get("t") or {}
    check(t.get("c") == "room" and (t.get("in") or {}).get("id") == str(int(G.host)) and t.get("x") == host["x"] and t.get("z") == host["z"],
          f"guidance, target inside a station (room): drawn at the station, 'in' names it ({t})")

    M.objtargets = lt([int(M.secret2)]); M.gdpath = lt([gates[0], gates[1], int(M.secret2)])
    pl, new, txt = run()
    gd = pl.get("gd") or {}
    check(gd.get("th") and gd.get("cut") and gd.get("r") == [] and "t" not in gd and "SECRET" not in txt and '"520"' not in txt,
          f"guidance into an undiscovered sector: no target, the route stops before the unknown gate, nothing leaked ({gd})")

    M.objtargets = lt([secret_st]); M.gdpath = lt([])
    pl, new, txt = run()
    t = (pl.get("gd") or {}).get("t") or {}
    check(t.get("x") is not None and t.get("nk") and "n" not in t and "SECRET" not in txt,
          f"guidance to an undiscovered object in a known sector: shown (position) like the game, without its name ({t})")

    M.objtargets = lt([]); M.gdpath = lt([]); M.gdwp = gates[2]
    pl, _, _ = run()
    gd = pl.get("gd") or {}
    check([p["id"] for p in gd.get("r") or []] == [str(gates[2])] and "t" not in gd,
          f"guidance without a UI target: the game's own next hop (activemissionwaypoint) as the route ({gd.get('r')})")
    M.gdwp = None

    M.objtargets = lt([vis]); M.gdpath = lt([])
    run(0.5)
    req1 = int(M.gd_req)
    M.ob1 = "Hack: Repair Terminal"
    pl, _, _ = run(4.0)
    check((pl.get("gd") or {}).get("ob") == "Hack: Repair Terminal" and int(M.gd_req) > req1,
          f"objective change of the active mission -> new objective text and route asked again ({int(M.gd_req) - req1} requests)")

    M.dg1 = True
    pl, _, _ = run(4.0)
    gd = pl.get("gd") or {}
    check(gd.get("off") and "r" not in gd and "t" not in gd, f"mission with disableguidance: guidance off, nothing to draw ({gd})")
    M.dg1 = False

    M.mt1 = "guidance"; M.guidancetarget = vis; M.objtargets = lt([])
    pl, _, _ = run(4.0)
    gd = pl.get("gd") or {}
    check(gd.get("k") == "course" and (gd.get("t") or {}).get("id") == str(vis), f"plotted course: kind 'course', target = guidance component ({gd})")
    M.mt1 = None; M.guidancetarget = None

    M.am = 60002; M.objbase = 0; M.objtargets = lt([G.station503, G.zone])
    pl, _, _ = run()
    gd = pl.get("gd") or {}
    check(T.GD.base == 0 and gd.get("tn") == 2 and (gd.get("t") or {}).get("id") == str(int(G.station503)),
          f"objective target index base probed per mission (0-based here), several targets counted ({T.GD.base}, {gd.get('tn')})")

    c0 = int(M.calls["GetMissionIDObjectiveTarget"] or 0)
    run(10.0)
    calls = int(M.calls["GetMissionIDObjectiveTarget"] or 0) - c0
    st = [json.loads(s) for s in M.out.values() if '"type":"stats"' in s][-1]
    check(calls <= 11 * 3 and st.get("gd", {}).get("rx", 0) > 0 and st["ch"]["player"]["err"] == 0,
          f"guidance cost: {calls} objective-target calls in 10 s (probe 1/s), stats gd={st.get('gd')}")

    M.am = 0
    n = len(M.out)
    M.frame(1 / 60)
    for _ in range(20):
        M.frame(1 / 60)
    pls = [json.loads(s) for s in list(M.out.values())[n:] if '"type":"player"' in s]
    check(pls and "gd" not in pls[0], f"no active mission (guidance ended): 'gd' gone with the next player message ({len(pls)} msgs)")


def main() -> int:
    rt = lupa.LuaRuntime(unpack_returned_tuples=True)
    rt.execute((ROOT / "mock_game.lua").read_text(encoding="utf-8"))
    src = BRIDGE.read_bytes().decode("utf-8")
    t_load = time.perf_counter()
    rt.execute(src)
    load_ms = (time.perf_counter() - t_load) * 1000
    M = rt.globals().MOCK
    T = rt.globals().__X4COMPANION_TEST
    check(T is not None, f"bridge Lua loads and initialises under LuaJIT 2.1 ({load_ms:.1f} ms)")
    check(M.onupdate is not None and M.snframe is not None, "both frame tick sources registered (SetScript onUpdate + SN Time)")
    ev = M.events
    for name in ("x4companion.mdTick", "x4companion.gates", "HotkeyApi.Register_Request"):
        check(ev[name] is not None, f"RegisterEvent {name}")
    check(len(list(M.debug.values())) == 0, f"no DebugError lines at start with Lua Log API present ({list(M.debug.values())})")
    check(any("loaded" in s for s in M.info.values()), "start line written through UIInfo")

    # hotkeys: the API raises Register_Request after a load
    ev["HotkeyApi.Register_Request"]("HotkeyApi.Register_Request", None)
    regs = list(rt.globals().HotkeyApi.registered.values())
    check(len(regs) == 17 and all(r.area == "map;pilot;fps" and r.actionLua is not None for r in regs),
          f"{len(regs)} hotkeys registered with the Native Hotkey API (area map;pilot;fps)")

    # run 60 s of frames at 60 fps
    frame_ms = []
    for i in range(3600):
        t0 = time.perf_counter()
        M.frame(1 / 60)
        frame_ms.append((time.perf_counter() - t0) * 1000)
    out = [s for s in M.out.values()]
    msgs, bad = [], 0
    for s in out:
        b = s.encode("utf-8", "surrogateescape") if isinstance(s, str) else bytes(s)
        try:
            msgs.append(json.loads(b.decode("utf-8")))
        except (ValueError, UnicodeDecodeError) as e:
            bad += 1
            print("  bad message:", e, b[:200])
    check(bad == 0 and len(msgs) > 100, f"{len(msgs)} messages, all valid UTF-8 JSON ({bad} bad)")
    check(all(len(s.encode("utf-8", "surrogateescape")) < 64000 for s in out),
          f"every pipe message < 64 KB (max {max(len(s.encode('utf-8', 'surrogateescape')) for s in out)} B)")
    types = {}
    for m in msgs:
        types[m["type"]] = types.get(m["type"], 0) + 1
    print("     message types:", json.dumps(types))
    for t in ("hello", "player", "galaxy", "gates", "sector", "property", "property_end", "logbook", "ticker",
              "messages", "missions", "offers", "factions", "economy", "stats"):
        check(types.get(t, 0) > 0, f"channel '{t}' produced messages ({types.get(t, 0)})")
    check(225 <= types.get("player", 0) <= 245, f"player channel ~4 Hz ({types.get('player', 0)} in 60 s)")

    # content checks
    pl = [m for m in msgs if m["type"] == "player"][-1]
    check(pl["sector"]["id"] == "501" and pl["object"]["id"] == "2001" and pl["money"] == 12345678 and pl["object"]["hull"] == 90,
          "player: sector, ship, credits, hull")
    gal = [c for m in msgs if m["type"] == "galaxy" for c in m["items"]]
    names = [s["name"] for c in gal for s in c["sectors"]]
    check(len(gal) >= 10 and len(names) == 19, f"galaxy: {len(gal)} clusters / {len(names)} sectors")
    badname = [n for n in names if n.startswith("Bad")]
    check(badname and "�" not in badname[0] and "\x1b" not in badname[0] and '"q"' in badname[0],
          f"invalid UTF-8 / ESC codes cleaned, quotes kept: {badname[:1]!r}")
    gates = [m for m in msgs if m["type"] == "gates"][-1]["items"]          # the latest complete list (v1.2 refreshes it more often)
    check(len(gates) == 14 and sum(1 for g in gates if g.get("ds")) >= 12, f"gates via MD round trip: {len(gates)} known ({sum(1 for g in gates if g.get('ds'))} with known destination)")
    ug = [g for g in gates if g["id"] == str(int(M.W.unknowngate))]
    check(ug and ug[0].get("du") and "ds" not in ug[0], "gate into an undiscovered sector: destination sent only as '?' (du), no id")
    check(any(g.get("hw") for g in gates), "superhighway entry gates from MD are sent with hw flag")
    bb = M.bb[M.W.player]
    check(bb is not None and bb["$x4companion_gates"] is None and bb["$x4companion_hwgates"] is None,
          "gate lists read from the player's blackboard and cleared (SetNPCBlackboard nil); a duplicate event kept the list")
    st0 = [m for m in msgs if m["type"] == "stats"][-1]
    check(st0.get("gates_md") == 14 and st0.get("gates_rx") == 14 and st0.get("gates_hw") == 1,
          f"stats: MD gate count vs received ({st0.get('gates_md')}/{st0.get('gates_rx')}, hw {st0.get('gates_hw')})")
    th = [m for m in msgs if m["type"] == "theme"]
    check(th and th[-1]["holo"].get("playercolor") == {"r": 80, "g": 192, "b": 108, "a": 100} and th[-1]["holo"].get("hostilecolor")
          and th[-1]["ui"].get("text_normal"), f"theme: 22 holomap colours by name (GetHoloMapColors order) + UI colours ({len(th)} msgs)")
    check(len(th) == 1, "theme sent once (only on change / resync)")
    sec = [m for m in msgs if m["type"] == "sector"]
    objs = [o for m in sec if m["last"] or True for o in m["items"]]
    check(sec and any(m["last"] for m in sec), f"sector scans complete ({sum(1 for m in sec if m['last'])} full scans)")
    lastscan = []
    for m in reversed(sec):
        lastscan = m["items"] + lastscan
        if m["part"] == 0:
            break
    hostile = [o for o in lastscan if o.get("h")]
    check(len(lastscan) > 50 and hostile, f"sector view: {len(lastscan)} visible objects in the last scan, {len(hostile)} hostile")
    ships_ic = [o for o in lastscan if o["c"].startswith("ship")]
    check(ships_ic and all(o.get("ic") == o["c"] + "_trade_01" for o in ships_ic)
          and all(o.get("ic") == "mapob_tradestation" for o in lastscan if o["c"] == "station"),
          "game icon id 'ic' on every ship and station (GetComponentData 'icon')")
    sats = [o for o in lastscan if o["c"] == "satellite"]
    beacons = [o for o in lastscan if o["c"] == "navbeacon"]
    check(len(sats) == 3 and all(o.get("ic") == "mapob_satellite_01" and o.get("rr") == 30000 and o.get("pl") for o in sats),
          "own satellites: icon + radar range (maxradarrange) sent")
    check(beacons and all("ic" not in o for o in beacons),
          f"a class whose 'icon' query fails is left without icon (browser fallback), beacons still listed ({len(beacons)})")
    check(all("rr" not in o for o in lastscan if not o.get("pl")), "radar range only for own objects")
    check(any(o.get("mt") for o in lastscan), "mission-target flag 'mt' sent")
    srcerr = [m for m in msgs if m["type"] == "stats"][-1]["srcerr"]
    check("s.ship" not in srcerr and "s.code" not in srcerr, f"icon folded into the class calls without errors ({srcerr})")
    prop = {e["id"]: e for m in msgs if m["type"] == "property" for e in m["items"]}
    pend = [m for m in msgs if m["type"] == "property_end"]
    check(len(prop) == 342 and pend and len(pend[-1]["ids"]) == 342, f"property: {len(prop)} entries, property_end lists {len(pend[-1]['ids']) if pend else 0}")
    firstpass = [m for m in msgs if m["type"] == "property" and m["gen"] == 1]
    laterpass = [m for m in msgs if m["type"] == "property" and m["gen"] > 2]
    check(sum(len(m["items"]) for m in laterpass) == 0, "property diff: unchanged entries are not resent")
    ship = next(e for e in prop.values() if e["k"] == "ship" and e.get("on"))
    check(ship.get("on", "").startswith("Order ") and ship.get("s"), f"ship has order name and sector ({ship.get('on')})")
    st = next(e for e in prop.values() if e["k"] == "station")
    check(st.get("mods") == 12 and st.get("wf") is None, "station: modules counted; failing GetWorkForceInfo left out")
    logs = [e for m in msgs if m["type"] == "logbook" for e in m["items"]]
    cats = {e["cat"] for e in logs}
    check(len(cats) == 7 and len(logs) == 7 * 40, f"logbook: {len(logs)} initial entries in {len(cats)} categories")
    alerts = [e for e in logs if e["cat"] == "alerts"]
    check(alerts and alerts[0].get("ia") == "showonmap" and alerts[0].get("ic"), "alert entries carry the interaction target")
    tk = [e for m in msgs if m["type"] == "ticker" for e in m["items"]]
    check(len(tk) == 30, f"ticker: {len(tk)} entries, no duplicates across 60 polls")
    mi = [m for m in msgs if m["type"] == "missions"][-1]["items"]
    check(len(mi) == 6 and mi[0].get("act") and mi[0].get("ob") == "Objective 1", "missions: 6 with objective, active flagged")
    of = [m for m in msgs if m["type"] == "offers"][-1]["items"]
    check(len(of) == 14, f"offers: {len(of)}")
    fa = [m for m in msgs if m["type"] == "factions"][-1]["items"]
    bf = [f for f in fa if f["id"] == "badfaction"]
    check(len(fa) == 5 and all(f.get("lic") for f in fa) and bf and "sn" not in bf[0] and not any(f["id"] == "player" for f in fa),
          f"factions: {len(fa)} with licences (failing GetFactionData contained, player skipped)")
    eco = [m for m in msgs if m["type"] == "economy"][-1]
    check(eco["count"] == 850 and eco["inc"] > 0 and eco["exp"] > 0 and len(eco["top"]) == 10, "economy summary + top 10")

    # discovery: nothing undiscovered may ever leave the bridge
    alltext = "\n".join(s for s in out)
    check("SECRET" not in alltext and '"520"' not in alltext,
          f"undiscovered sector / unknown station / ship outside radar never sent ({alltext.count('SECRET')} leaks)")
    secnames = [x for m in msgs if m["type"] == "galaxy" for c in m["items"] for x in c["sectors"]]
    check(len(secnames) == 19, f"galaxy contains only the 19 known sectors ({len(secnames)})")
    wl = [m for m in msgs if m["type"] == "player"][-1].get("where", {})
    check(wl.get("mode") == "pilot" and wl.get("name") == "Player Ship", f"player location: {wl}")

    # error containment
    srcoff = [m for m in msgs if m["type"] == "stats"][-1]["srcoff"]
    check("pr.workforce" in srcoff, f"a source failing every call is switched off ({srcoff})")
    errs = [s for s in M.info.values() if s.startswith("E ")]
    check(len(errs) <= 6, f"real errors are rate-limited ({len(errs)} UIError lines in 60 s)")
    check(len(list(M.debug.values())) == 0, "no DebugError at all while the Lua Log API exists")

    # cost of the bridge's own Lua
    stats = [m for m in msgs if m["type"] == "stats"]
    lua_avg = statistics.mean(m["frame"]["avg"] for m in stats[1:])
    lua_max = max(m["frame"]["max"] for m in stats[1:])
    py_avg = statistics.mean(frame_ms)
    check(lua_avg < 0.5, f"bridge Lua cost per frame (QPC, mock engine): avg {lua_avg:.3f} ms, max {lua_max:.3f} ms "
                         f"(harness incl. Python call overhead avg {py_avg:.3f} ms)")
    print("     per channel avg/max ms:", {k: (v["avg"], v["max"]) for k, v in stats[-1]["ch"].items()})
    check(stats[-1]["timer"] == "qpc", "QueryPerformanceCounter timer active")

    # commands
    S1, S2 = str(M.W.playerships[1]), str(M.W.playerships[2])
    n0 = len(M.out)
    M.readcb(f"cmd 5 openmap {S1}\ncmd 6 target {S2}\ncmd 7 stop {S1}\ncmd 8 guidance {S2}\ncmd 9 watch 503\ncmd 10 bogus 1\ngarbage line")
    M.frame(1 / 60)
    acks = [json.loads(s) for s in list(M.out.values())[n0:] if '"ack"' in s]
    byseq = {a["seq"]: a for a in acks}
    check(byseq.get(5, {}).get("ok") and f"MapMenu:{S1}" in list(M.opened.values()), "openmap -> OpenMenu(\"MapMenu\", {0,0,true,obj})")
    check(byseq.get(6, {}).get("ok") and int(S2) in list(M.targets.values()), "target -> SetSofttarget")
    check(byseq.get(7) and not byseq[7]["ok"] and "CFG.allow" in byseq[7]["msg"], "stop refused by the mod allow-list (default off)")
    check(byseq.get(8, {}).get("ok") and int(S2) in list(M.guidance.values()), "guidance -> SetGuidance")
    check(byseq.get(9, {}).get("ok") and T.W.watch == 503, "watch sets the watched sector")
    check(byseq.get(10) and not byseq[10]["ok"], "unknown command refused")
    M.readcb("cmd 31 watch 520")
    M.frame(1 / 60)
    a31 = [json.loads(s) for s in list(M.out.values())[n0:] if '"seq":31' in s]
    check(a31 and not a31[0]["ok"], "watching an undiscovered sector is refused by the bridge")
    T.CFG.allow.stop = True
    T.CFG.allow.flyto = True
    M.mapmenu.shown = True
    M.mapmenu.holomap = 77
    M.readcb(f"cmd 11 stop {S1}\ncmd 12 flyto {S1} 503\ncmd 13 openmap {S2}\ncmd 14 flyto {S1} {S2}")
    M.frame(1 / 60)
    acks = {a["seq"]: a for a in (json.loads(s) for s in list(M.out.values())[n0:] if '"ack"' in s)}
    orders = list(M.orders.values())
    check(acks.get(11, {}).get("ok") and any(o.startswith("remove:") for o in orders), f"stop (when allowed) uses RemoveOrder loop: {orders[:3]}")
    check(acks.get(12, {}).get("ok") and "lua:MoveWait:503" in orders, "flyto (when allowed) -> CreateOrder MoveWait {sector,{0,0,0}}")
    check(acks.get(13, {}).get("ok") and f"focus:{S2}" in list(M.opened.values()), "openmap with the map open -> SetFocusMapComponent")
    check(acks.get(14) and not acks[14]["ok"], "flyto to a non-sector refused")

    # details (info panel): own ship with cargo; object outside radar refused, nothing sent about it
    n4 = len(M.out)
    M.readcb(f"cmd 40 details {S1}\ncmd 41 details {int(M.W.secretship)}")
    M.frame(1 / 60)
    new = [json.loads(s) for s in list(M.out.values())[n4:]]
    det = [m for m in new if m["type"] == "details"]
    a41 = [m for m in new if m["type"] == "ack" and m["seq"] == 41]
    check(det and det[0]["id"] == S1 and det[0].get("cargo") and det[0]["cargo"][0].get("a") and det[0].get("oname"),
          f"details: own ship with cargo amounts and order ({det[0].get('cargo') if det else None})")
    check(len(det) == 1 and a41 and not a41[0]["ok"] and "SECRET" not in json.dumps(new), "details of an object outside radar refused, nothing leaked")

    # details: order queue points (order lines) - a position in a known sector is sent, an object
    # target outside radar is not
    S3 = next(str(int(s)) for s in M.W.playerships.values() if int(s) % 3 == 2)
    n5 = len(M.out)
    M.readcb(f"cmd 42 details {S3}")
    M.frame(1 / 60)
    det3 = [json.loads(s) for s in list(M.out.values())[n5:] if '"details"' in s]
    od = det3[0].get("orders") if det3 else None
    check(od and len(od) == 2 and od[0].get("pt") == {"s": "501", "x": 1000, "z": 2000} and "pt" not in od[1]
          and det3[0].get("rr") == 40000 and det3[0].get("ic"),
          f"details: order queue with map points, hidden target point withheld ({od})")

    # plotted course: visible target -> position; hidden ship -> no position/name; unknown sector -> no id
    vis_station = next(int(k) for k, o in M.W.objs.items() if o["class"] == "station" and o["sector"] == 501 and o["owner"] == "argon" and o["isknown"] is not False)
    secret2 = int(M.secret2)
    def guidance_for(target):
        M.guidancetarget = target
        n = len(M.out)
        for _ in range(30):
            M.frame(1 / 60)
        pls = [json.loads(s) for s in list(M.out.values())[n:] if '"type":"player"' in s]
        return pls[-1].get("guidance") if pls else None
    g1 = guidance_for(vis_station)
    check(g1 and g1.get("id") == str(vis_station) and g1.get("x") is not None and g1.get("s") == "501", f"guidance to a visible station: {g1}")
    g2 = guidance_for(int(M.W.secretship))
    check(g2 and "x" not in g2 and "n" not in g2, f"guidance to a ship outside radar: no position/name ({g2})")
    g3 = guidance_for(secret2)
    check(g3 == {"unknown": True}, f"guidance into an undiscovered sector: only 'unknown' ({g3})")
    M.guidancetarget = None
    plo = [json.loads(s) for s in M.out.values() if '"type":"player"' in s][-1]["object"]
    check(plo.get("ic") == "ship_m_trade_01" and plo.get("rr") == 40000, f"player object: icon + radar range ({plo.get('ic')}, {plo.get('rr')})")

    # watched sector is scanned
    for _ in range(240):
        M.frame(1 / 60)
    sids = {json.loads(s)["sid"] for s in M.out.values() if '"type":"sector"' in s}
    check("503" in sids, f"watched sector scanned too ({sorted(sids)})")

    # hotkey press -> message for the browser
    n1 = len(M.out)
    next(r for r in regs if r.id == "x4companion_ship_next").actionLua(rt.table_from({"id": "x4companion_ship_next", "object": rt.eval(f"ConvertStringToLuaID('{S1}')")}))
    hk = [json.loads(s) for s in list(M.out.values())[n1:] if '"hotkey"' in s]
    check(hk and hk[0]["action"] == "ship_next" and hk[0]["obj"] == S1, f"hotkey press sent to the server: {hk[:1]}")

    # pipe failure -> reconnect with hello and full resync
    M.write_fail = True
    for _ in range(30):
        M.frame(1 / 60)
    check(not T.W.connected, "write ERROR -> disconnected")
    M.write_fail = False
    n2 = len(M.out)
    for _ in range(300):
        M.frame(1 / 60)
    after = [json.loads(s)["type"] for s in list(M.out.values())[n2:]]
    check(after and after[0] == "hello" and "galaxy" in after and "logbook" in after,
          f"reconnect: hello first, then a full resync ({after[:4]}...)")

    # MD tick drives the scheduler when frames stop
    n3 = len(M.out)
    for _ in range(40):
        M.now = M.now + 0.25
        ev["x4companion.mdTick"]("x4companion.mdTick", None)
    mdp = [json.loads(s) for s in list(M.out.values())[n3:] if '"type":"player"' in s]
    check(mdp and all(m["src"] == "md" for m in mdp), f"MD fallback tick keeps the stream alive without frames ({len(mdp)} player msgs, src=md)")

    # channel error containment: a channel whose step raises is switched off, the others continue
    rt.execute("GetNumMissions = function() error('mock: missions broken') end")
    for _ in range(60 * 60):
        M.frame(1 / 60)
    st = json.loads([s for s in M.out.values() if '"type":"stats"' in s][-1])
    check(st["ch"]["missions"]["err"] == 0 and "mi.num" in st["srcoff"], "a failing Lua global is contained at source level (mi.num off)")
    check(st["ch"]["player"]["runs"] > 0 and not st["ch"]["player"].get("off"), "other channels keep running")

    alltext = "\n".join(s for s in M.out.values())
    check("SECRET" not in alltext, f"no undiscovered/hidden name leaked over the whole run ({alltext.count('SECRET')})")

    # without any high-resolution clock (the real game in v1.0): cost counted in engine calls,
    # frame budget and throttle still work
    rt2 = lupa.LuaRuntime(unpack_returned_tuples=True)
    rt2.execute((ROOT / "mock_game.lua").read_text(encoding="utf-8"))
    rt2.execute("__X4COMPANION_TEST_NOQPC = true")
    rt2.execute(src)
    M2 = rt2.globals().MOCK
    for _ in range(60 * 20):
        M2.frame(1 / 60)
    sts2 = [json.loads(s) for s in M2.out.values() if '"type":"stats"' in s]
    st2 = max(sts2[-5:], key=lambda m: m["ch"]["sector"]["ops"])
    hello2 = [json.loads(s) for s in M2.out.values() if '"type":"hello"' in s][-1]
    check(st2["timer"] == "frame" and hello2["timer"] == "frame" and st2["hires"] is False,
          f"no QPC/os.clock: timer reported as 'frame' (hello + stats)")
    check(st2["ch"]["sector"]["ops"] > 0 and st2["ch"]["sector"]["pops"] > 0 and st2["frame"]["ops"] > 0,
          f"cost measured in engine calls instead: sector {st2['ch']['sector']['ops']} ops/frame, pass {st2['ch']['sector']['pops']} ops")
    check(st2["frame"]["ops"] < 400, f"ops frame budget keeps the bridge time-sliced ({st2['frame']['ops']} avg ops/frame)")

    # v1.2 (M6): a sector change pushes the galaxy (incl. a sector discovered just now) and the new
    # sector's scan at once, instead of up to 60 s later on the galaxy channel's interval
    rt3 = lupa.LuaRuntime(unpack_returned_tuples=True)
    rt3.execute((ROOT / "mock_game.lua").read_text(encoding="utf-8"))
    rt3.execute(src)
    M3, T3 = rt3.globals().MOCK, rt3.globals().__X4COMPANION_TEST
    check(T3.CFG.allow.stop is False and T3.CFG.allow.flyto is False, "CFG.allow: stop=false, flyto=false (unchanged default)")
    def galaxy_msgs(start=0):
        return [json.loads(s) for s in list(M3.out.values())[start:] if '"type":"galaxy"' in s]
    for _ in range(80 * 60):                      # two galaxy passes, then 5 s after the last one
        M3.frame(1 / 60)
        if len({m["gen"] for m in galaxy_msgs()}) >= 2:
            break
    for _ in range(5 * 60):
        M3.frame(1 / 60)
    n6 = len(M3.out)
    for _ in range(2 * 60):                       # control: no sector change -> no galaxy message for a while
        M3.frame(1 / 60)
    check(not galaxy_msgs(n6), "control: without a sector change the galaxy channel stays on its 60 s interval")
    M3.W.objs[520].known = True                   # the player flies into a sector discovered right now
    M3.W.objs[520].name = "New Sector"
    M3.W.objs[M3.W.player].sector = 520
    M3.W.objs[M3.W.ship].sector = 520
    n7 = len(M3.out)
    frames = 0
    got_gal = got_scan = None
    while frames < 60 and (got_gal is None or got_scan is None):
        M3.frame(1 / 60)
        frames += 1
        new = [json.loads(s) for s in list(M3.out.values())[n7:]]
        if got_gal is None and any(any(str(x.get("id")) == "520" for c in m.get("items", []) for x in c.get("sectors", []))
                                   for m in new if m["type"] == "galaxy" and m.get("last")):
            got_gal = frames
        if got_scan is None and any(m["type"] == "sector" and m.get("sid") == "520" for m in new):
            got_scan = frames
    pl3 = [json.loads(s) for s in list(M3.out.values())[n7:] if '"type":"player"' in s]
    check(pl3 and pl3[0]["sector"]["id"] == "520", "player message reports the new sector")
    check(got_gal is not None and got_gal <= 30, f"sector change -> galaxy with the newly discovered sector within {got_gal} frames (was: next 60 s pass)")
    check(got_scan is not None and got_scan <= 30, f"sector change -> scan of the new sector within {got_scan} frames")

    # v1.2: the new sector's real core size (MD -> blackboard) and its resource areas (sliced sampling)
    calls0 = int(M3.mineable_calls)
    frames, res_msgs, si_msgs, max_step_calls, prev = 0, [], [], 0, calls0
    # (the server forwards only known message types: both ride along with the sector scan as pseudo objects)
    while frames < 900 and not any(m.get("w") for m in res_msgs):
        M3.frame(1 / 60)
        frames += 1
        c = int(M3.mineable_calls)
        max_step_calls, prev = max(max_step_calls, c - prev), c
        new = [json.loads(s) for s in list(M3.out.values())[n7:]]
        scans = [m for m in new if m["type"] == "sector" and m.get("sid") == "520"]
        res_msgs = [o for m in scans for o in m["items"] if o.get("c") == "x4c_resarea"]
        si_msgs = [o for m in scans for o in m["items"] if o.get("c") == "x4c_sectorinfo"]
    si = si_msgs
    check(si and si[0].get("core") == 400000 and si[0].get("cx") == 10000 and si[0].get("cz") == -5000 and si[0].get("contested") is True,
          f"sector change -> sectorinfo from MD in the scan: core size, core centre, contested ({si[:1]})")
    latest = {}
    for m in res_msgs:
        latest[m["id"]] = m
    wares = sorted({m.get("w") for m in latest.values() if m.get("w")})
    items = [m["pts"][i:i + 3] for m in latest.values() for i in range(0, len(m.get("pts") or []), 3)]
    check(items and set(wares) <= {"ore", "silicon"} and "ore" in wares and all(len(it) == 3 and it[2] > 0 for it in items),
          f"resource areas of the new sector: {len(items)} cells of {wares} within {frames} frames (undiscovered nividium withheld)")
    check(max_step_calls <= 160, f"resource sampling is sliced: at most {max_step_calls} engine calls per frame (budget 160)")
    hw = [o for m in (json.loads(s) for s in list(M3.out.values())[n7:]) if m["type"] == "sector" and m.get("sid") == "520"
          for o in m["items"] if o.get("c") == "x4c_highway"]
    pts = hw[0]["pts"] if hw else []
    check(hw and abs(pts[0] - 100) < 0.01 and abs(pts[1]) < 0.01 and abs(pts[-2] - 160) < 0.01 and abs(pts[-1] - 30) < 0.01 and len(pts) == 22,
          f"local highway: spline sampled (11 points, zone offset applied, entry gate at the start) {pts[:4]}...{pts[-2:]}")
    gates_after = [i for i, s in enumerate(list(M3.out.values())[n7:]) if '"type":"gates"' in s]
    check(gates_after and gates_after[0] < 400, f"sector change -> the gate list is re-collected and sent at once (message #{gates_after[:1]} after the change)")
    # a gate discovered while staying in the sector: MD event -> list re-collected within frames
    for _ in range(3 * 60):
        M3.frame(1 / 60)
    n9 = len(M3.out)
    M3.events["x4companion.gatesdirty"]("x4companion.gatesdirty", None)
    frames_to = None
    for f in range(1, 120):
        M3.frame(1 / 60)
        if any('"type":"gates"' in s for s in list(M3.out.values())[n9:]):
            frames_to = f
            break
    check(frames_to is not None and frames_to <= 30, f"gate discovered (MD event) -> gate list re-sent within {frames_to} frames (was: up to 300 s)")
    other = [(m.get("sid"), o["id"]) for m in (json.loads(s) for s in M3.out.values()) if m["type"] == "sector"
             for o in m["items"] if str(o.get("c", "")).startswith("x4c_") and (not m.get("player") or o["id"].split(":")[1] != m.get("sid"))]
    check(not other, f"resource areas / sector info only in the scan of the player's own sector ({other[:2]})")
    n8 = len(M3.out)
    for _ in range(10 * 60):
        M3.frame(1 / 60)
    later = [s for s in list(M3.out.values())[n8:] if '"x4c_resarea"' in s]
    check(len(later) >= 1 and int(M3.mineable_calls) == c,
          f"no further sampling while the player stays (refresh every 10 min); cached areas re-sent with every 10th scan ({len(later)} in 10 s)")

    guidance_checks(src)

    failed = [w for ok, w in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
