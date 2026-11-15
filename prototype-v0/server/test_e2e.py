"""End-to-end test without the game: server.py + sim.py through the real named pipe, checked
over real HTTP and WebSocket.   uv run python test_e2e.py
Uses its own pipe name and port so it never collides with a running server.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent
PY = sys.executable
PORT = 8779
PIPE = "x4webmap_e2e"
BASE = f"http://127.0.0.1:{PORT}"

results: list[tuple[bool, str]] = []
procs: list[subprocess.Popen] = []


def check(ok: bool, what: str) -> None:
    results.append((bool(ok), what))
    print(("PASS " if ok else "FAIL ") + what, flush=True)


def start(args: list[str], name: str) -> subprocess.Popen:
    log = open(ROOT / "logs" / f"e2e_{name}.log", "w", encoding="utf-8")
    p = subprocess.Popen([PY, *args], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    procs.append(p)
    return p


def stop(p: subprocess.Popen) -> None:
    if p.poll() is None:
        p.terminate()          # TerminateProcess: like the game crashing / being killed
        p.wait(10)


def start_server() -> subprocess.Popen:
    return start(["server.py", "--port", str(PORT), "--pipe", PIPE], "server")


def start_sim(*extra: str, name: str = "sim") -> subprocess.Popen:
    return start(["sim.py", "--pipe", PIPE, *extra], name)


async def wait_http(session: aiohttp.ClientSession, timeout: float = 20) -> bool:
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            async with session.get(BASE + "/api/state") as r:
                if r.status == 200:
                    return True
        except aiohttp.ClientError:
            pass
        await asyncio.sleep(0.25)
    return False


async def collect(ws, seconds: float) -> tuple[list[dict], list[dict], list[float]]:
    snaps, stats, lat = [], [], []
    t_end = time.monotonic() + seconds
    while True:
        left = t_end - time.monotonic()
        if left <= 0:
            break
        try:
            m = await ws.receive(timeout=left)
        except asyncio.TimeoutError:
            break
        if m.type != aiohttp.WSMsgType.TEXT:
            break
        d = json.loads(m.data)
        if d["type"] == "snapshot":
            snaps.append(d)
            lat.append(time.time() - d["t"])
        else:
            stats.append(d)
    return snaps, stats, lat


def listening_addresses(port: int) -> list[str]:
    out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True).stdout
    addrs = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0] == "TCP" and parts[3] == "LISTENING" and parts[1].endswith(f":{port}"):
            addrs.append(parts[1])
    return addrs


async def main() -> int:
    (ROOT / "logs").mkdir(exist_ok=True)
    server = start_server()
    async with aiohttp.ClientSession() as s:
        check(await wait_http(s), "server answers /api/state")
        addrs = listening_addresses(PORT)
        check(addrs == [f"127.0.0.1:{PORT}"], f"listens on 127.0.0.1 only: {addrs}")

        async with s.get(BASE + "/") as r:
            body = await r.text()
            check(r.status == 200 and "<canvas" in body and "map.js" in body, "GET / serves index.html")
        async with s.get(BASE + "/map.js") as r:
            js = await r.text()
            check(r.status == 200 and "WebSocket" in js and "javascript" in r.headers.get("Content-Type", ""),
                  "GET /map.js serves the script")
        async with s.get(BASE + "/", headers={"Host": "evil.example:8777"}) as r:
            check(r.status == 403, f"foreign Host header refused ({r.status})")
        try:
            async with s.ws_connect(BASE + "/ws", origin="http://evil.example") as _ws:
                check(False, "cross-origin WebSocket refused")
        except aiohttp.WSServerHandshakeError as e:
            check(e.status == 403, f"cross-origin WebSocket refused ({e.status})")

        # 1) normal stream, SN-like client (message read mode + PIPE_NOWAIT), 4 Hz, 10 ships
        async with s.ws_connect(BASE + "/ws") as ws:
            sim = start_sim("--ships", "10", "--rate", "4")
            snaps, stats, lat = await collect(ws, 6.0)
            n = len(snaps)
            check(n >= 18, f"[stream] {n} snapshots in 6 s over WebSocket (expect ~24 at 4 Hz)")
            seqs = [x["seq"] for x in snaps]
            check(seqs == sorted(seqs) and len(set(seqs)) == len(seqs), "[stream] seq strictly increasing")
            if snaps:
                last = snaps[-1]
                check(last["sector"]["name"] == "Argon Prime", f"[stream] sector name = {last['sector']['name']}")
                own = [x for x in last["ships"] if not x["player"]]
                check(len(own) == 10 and all({"id", "name", "class", "x", "z"} <= set(x) for x in own),
                      f"[stream] 10 own ships with id/name/class/x/z ({len(own)})")
                check(isinstance(last["player"]["yaw"], float), "[stream] player x/z/yaw present")
                xs = {round(x["player"]["x"]) for x in snaps}
                check(len(xs) > 10, f"[stream] player position changes between updates ({len(xs)} distinct x)")
            if lat:
                lat_sorted = sorted(lat)
                p50 = lat_sorted[len(lat) // 2] * 1000
                pmax = lat_sorted[-1] * 1000
                check(pmax < 500, f"[stream] pipe->browser latency p50 {p50:.1f} ms, max {pmax:.1f} ms")
            live = [x for x in stats if x["receiving"]]
            check(bool(live) and live[-1]["pipe_connected"], f"[stream] status says receiving ({len(live)} status msgs)")
            if live:
                print(f"     status: {json.dumps(live[-1])}")
            async with s.get(BASE + "/api/state") as r:
                st = await r.json()
                check(st["snapshot"] is not None and st["status"]["msgs"] >= n,
                      f"[stream] /api/state has the snapshot (msgs={st['status']['msgs']})")

            # 2) game killed (no clean close) -> server notices, page shows stale
            stop(sim)
            await asyncio.sleep(4.0)
            snaps2, stats2, _ = await collect(ws, 1.5)
            check(not snaps2, "[kill] no snapshots after the client died")
            check(bool(stats2) and not stats2[-1]["pipe_connected"] and not stats2[-1]["receiving"],
                  f"[kill] status: pipe disconnected, not receiving (age {stats2[-1]['last_rx_age'] if stats2 else '?'} s)")

            # 3) game restarted, byte-mode client, with junk lines -> resumes, junk ignored
            sim = start_sim("--ships", "5", "--mode", "byte", "--junk")
            snaps3, stats3, _ = await collect(ws, 4.0)
            check(len(snaps3) >= 10, f"[restart] stream resumes after client restart ({len(snaps3)} in 4 s)")
            check(bool(stats3) and stats3[-1]["bad"] > 0, f"[restart] junk lines counted and ignored (bad={stats3[-1]['bad'] if stats3 else '?'})")
            stop(sim)

            # 4) UI-reload pattern: client sends "garbage_collected", new client right after
            sim = start_sim("--seconds", "2", "--gc-on-exit", name="sim_gc")
            sim.wait(15)
            sim = start_sim("--ships", "3")
            snaps4, stats4, _ = await collect(ws, 3.0)
            check(len(snaps4) >= 8 and len(snaps4[-1]["ships"]) == 4,
                  f"[reloadui] new client accepted after garbage_collected ({len(snaps4)} snapshots)")
            async with s.get(BASE + "/api/state") as r:
                st = (await r.json())["status"]
                check(st["pipe_clients"] == 1, f"[reloadui] exactly one live pipe client ({st['pipe_clients']}, connects so far {st['pipe_connects']})")

        # 5) server restart while the client keeps running -> client reconnects by itself
        stop(server)
        await asyncio.sleep(1.5)
        server = start_server()
        check(await wait_http(s), "[server restart] server back")
        async with s.ws_connect(BASE + "/ws") as ws:
            snaps5, _, _ = await collect(ws, 4.0)
            check(len(snaps5) >= 8, f"[server restart] client reconnected, {len(snaps5)} snapshots in 4 s")
        stop(sim)

        # 6) big message: 900 ships (~120 KB > 64 KB read chunk -> ERROR_MORE_DATA path)
        async with s.ws_connect(BASE + "/ws") as ws:
            sim = start_sim("--ships", "900", "--seconds", "3", name="sim_big")
            snaps6, _, _ = await collect(ws, 4.0)
            if snaps6 and len(snaps6[0]["ships"]) != 901:
                snaps6 = snaps6[1:]            # the cached last snapshot sent on WS connect
            sizes = [len(json.dumps(x)) for x in snaps6]
            check(len(snaps6) >= 8 and all(len(x["ships"]) == 901 for x in snaps6),
                  f"[big] {len(snaps6)} intact 901-ship snapshots, ~{max(sizes) if sizes else 0} B each")
            sim.wait(15)

        # 7) a second server on the same pipe must refuse to start
        dup = start(["server.py", "--port", str(PORT + 1), "--pipe", PIPE], "server_dup")
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
