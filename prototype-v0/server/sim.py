"""Game simulator: writes the same JSON snapshots the x4_webmap Lua sends, through the same
named pipe, the way the SN winpipe client does (CreateFile on \\\\.\\pipe\\<name>, handle set
to message read mode + PIPE_NOWAIT, one WriteFile per message, reopen after a failed write).

  uv run sim.py                       # 4 Hz, 8 ships, forever
  uv run sim.py --ships 400 --seconds 10
  uv run sim.py --mode byte           # client without SetNamedPipeHandleState (byte mode)
  uv run sim.py --junk                # also send invalid lines (server must ignore them)
  uv run sim.py --gc-on-exit          # finish with "garbage_collected" like SN on UI reload
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time

import pywintypes
import win32file
import win32pipe

CLASSES = ["ship_s", "ship_m", "ship_l", "ship_xl", "ship_xs"]
SECTORS = [("101", "Argon Prime"), ("202", "The Void")]


class SnLikeClient:
    def __init__(self, name: str, mode: str):
        self.path = "\\\\.\\pipe\\" + name
        self.mode = mode
        self.h = None
        self.ok_writes = 0
        self.failed = 0

    def _open(self) -> None:
        h = win32file.CreateFile(self.path, win32file.GENERIC_READ | win32file.GENERIC_WRITE,
                                 0, None, win32file.OPEN_EXISTING, 0, None)
        if self.mode == "message":
            win32pipe.SetNamedPipeHandleState(
                h, win32pipe.PIPE_READMODE_MESSAGE | win32pipe.PIPE_NOWAIT, None, None)
        self.h = h
        print(f"[sim] connected to {self.path} ({self.mode} mode)", flush=True)

    def write(self, data: bytes) -> bool:
        try:
            if self.h is None:
                self._open()
            _, n = win32file.WriteFile(self.h, data)
            if n != len(data):
                raise pywintypes.error(0, "WriteFile", f"short write {n}/{len(data)}")
            self.ok_writes += 1
            return True
        except pywintypes.error as e:
            if self.failed == 0 or self.h is not None:
                print(f"[sim] pipe unavailable ({e.winerror}: {e.strerror}); retrying", flush=True)
            self.failed += 1
            self.close()
            return False

    def close(self) -> None:
        if self.h is not None:
            try:
                win32file.CloseHandle(self.h)
            except pywintypes.error:
                pass
            self.h = None


def make_snapshot(seq: int, t0: float, ships: list[dict], sector_idx: int) -> dict:
    now = time.time()
    el = now - t0
    th = el * 0.2                                  # player flies a 20 km circle
    r = 20000.0
    px, pz = r * math.cos(th), r * math.sin(th)
    vx, vz = -math.sin(th), math.cos(th)
    yaw = math.atan2(vx, vz)                       # map convention: heading = (sin yaw, cos yaw)
    out = []
    for s in ships:
        s["x"] += s["vx"] * 0.25
        s["z"] += s["vz"] * 0.25
        out.append({"id": s["id"], "name": s["name"], "code": s["code"], "class": s["class"],
                    "x": round(s["x"], 1), "y": 0.0, "z": round(s["z"], 1),
                    "yaw": round(math.atan2(s["vx"], s["vz"]), 4), "player": False})
    out.insert(0, {"id": "9000", "name": "Player Ship", "code": "PLY-001", "class": "ship_m",
                   "x": round(px, 1), "y": 0.0, "z": round(pz, 1), "yaw": round(yaw, 4),
                   "player": True})
    sid, sname = SECTORS[sector_idx % len(SECTORS)]
    return {"v": 1, "type": "snapshot", "seq": seq, "t": round(now, 3), "src": "sim",
            "nframe": seq, "nmd": 0, "paused": False, "space": "sector",
            "sector": {"id": sid, "name": sname},
            "player": {"id": "9000", "name": "Player Ship", "mode": "ship",
                       "x": round(px, 1), "y": 0.0, "z": round(pz, 1), "yaw": round(yaw, 4)},
            "ships": out, "truncated": False}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pipe", default="x4webmap")
    ap.add_argument("--rate", type=float, default=4.0)
    ap.add_argument("--ships", type=int, default=8)
    ap.add_argument("--seconds", type=float, default=0, help="0 = run until Ctrl+C")
    ap.add_argument("--mode", choices=["message", "byte"], default="message")
    ap.add_argument("--junk", action="store_true")
    ap.add_argument("--gc-on-exit", action="store_true")
    ap.add_argument("--switch-sector", type=float, default=0, help="change sector every N s")
    a = ap.parse_args()

    rnd = random.Random(42)
    ships = []
    for i in range(a.ships):
        ang = rnd.uniform(0, 2 * math.pi)
        spd = rnd.uniform(50, 400)
        ships.append({"id": str(10000 + i), "name": f"Own Ship {i + 1}",
                      "code": f"ABC-{i + 1:03d}", "class": CLASSES[i % len(CLASSES)],
                      "x": rnd.uniform(-60000, 60000), "z": rnd.uniform(-60000, 60000),
                      "vx": spd * math.sin(ang), "vz": spd * math.cos(ang)})

    cli = SnLikeClient(a.pipe, a.mode)
    period = 1.0 / a.rate
    t0 = time.time()
    seq = 0
    data = b""
    nxt = time.monotonic()
    try:
        while a.seconds <= 0 or time.time() - t0 < a.seconds:
            seq += 1
            sec_idx = int((time.time() - t0) // a.switch_sector) if a.switch_sector > 0 else 0
            snap = make_snapshot(seq, t0, ships, sec_idx)
            data = (json.dumps(snap, separators=(",", ":")) + "\n").encode("utf-8")
            cli.write(data)
            if a.junk and seq % 5 == 0:
                cli.write(b"this is not json\n")
                cli.write(b'{"type":"other"}\n')
            nxt += period
            time.sleep(max(0.0, nxt - time.monotonic()))
    except KeyboardInterrupt:
        pass
    if a.gc_on_exit and cli.h is not None:
        cli.write(b"garbage_collected")
    cli.close()
    print(f"[sim] done: {cli.ok_writes} writes ok, {cli.failed} failed, last size {len(data)} B",
          flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
