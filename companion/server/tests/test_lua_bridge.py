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
    for name in ("x4companion.mdTick", "x4companion.gate", "HotkeyApi.Register_Request"):
        check(ev[name] is not None, f"RegisterEvent {name}")
    check(len(list(M.debug.values())) == 0, f"no DebugError lines at start with Lua Log API present ({list(M.debug.values())})")
    check(any("loaded" in s for s in M.info.values()), "start line written through UIInfo")

    # hotkeys: the API raises Register_Request after a load
    ev["HotkeyApi.Register_Request"]("HotkeyApi.Register_Request", None)
    regs = list(rt.globals().HotkeyApi.registered.values())
    check(len(regs) == 11 and all(r.area == "map;pilot;fps" and r.actionLua is not None for r in regs),
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
    gates = [g for m in msgs if m["type"] == "gates" for g in m["items"]]
    check(len(gates) == 14 and sum(1 for g in gates if g.get("ds")) >= 12, f"gates via MD round trip: {len(gates)} known ({sum(1 for g in gates if g.get('ds'))} with known destination)")
    ug = [g for g in gates if g["id"] == str(int(M.W.unknowngate))]
    check(ug and ug[0].get("du") and "ds" not in ug[0], "gate into an undiscovered sector: destination sent only as '?' (du), no id")
    check(any(g.get("hw") for g in gates), "superhighway entry gates from MD are sent with hw flag")
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

    # watched sector is scanned
    for _ in range(240):
        M.frame(1 / 60)
    sids = {json.loads(s)["sid"] for s in M.out.values() if '"type":"sector"' in s}
    check("503" in sids, f"watched sector scanned too ({sorted(sids)})")

    # hotkey press -> message for the browser
    n1 = len(M.out)
    regs[4].actionLua(rt.table_from({"id": "x4companion_ship_next", "object": rt.eval(f"ConvertStringToLuaID('{S1}')")}))
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

    failed = [w for ok, w in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
