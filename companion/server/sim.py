"""Game simulator for X4 Companion: speaks the exact v2 protocol of dev\\x4_companion\\ui\\x4_companion.lua
over the same named pipe, the way the SN winpipe client does (CreateFile, message read mode +
PIPE_NOWAIT, one WriteFile per message, non-blocking reads of commands, reopen after a failure).

The world is built from data\\static_map.json (the real 9.00 galaxy incl. DLC and installed map
mods): every known sector, gates from the real gate links, superhighway entry gates, NPC stations
and traffic per sector, a few hundred player ships with fleets and orders, logbook/ticker/inbox
traffic with alerts, missions, offers, factions with licences, account history and bridge stats.
The player flies from gate to gate and jumps sectors, so auto-follow and sector changes happen.

  uv run python sim.py                          # forever, default pipe x4companion
  uv run python sim.py --ships 400 --seconds 30 --hotkeys
  uv run python sim.py --pause-at 10 --pause-for 8     # paused:true, then silence (focus lost)
  uv run python sim.py --bad-bytes --junk               # invalid UTF-8, raw ESC, quotes, junk lines
  uv run python sim.py --mode byte --gc-on-exit
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

import pywintypes
import win32file
import win32pipe
import winerror

ROOT = Path(__file__).resolve().parent
MAX_MSG = 48000

FACTIONS = [
    ("argon", "Argon Federation", "ARG", (0, 120, 255), 10), ("antigone", "Antigone Republic", "ANT", (80, 160, 255), 12),
    ("hatikvah", "Hatikvah Free League", "HAT", (0, 200, 180), 5), ("paranid", "Godrealm of the Paranid", "PAR", (160, 60, 220), 2),
    ("holyorder", "Holy Order of the Pontifex", "HOP", (200, 40, 160), -12), ("alliance", "Alliance of the Word", "ALI", (220, 200, 60), 3),
    ("teladi", "Teladi Company", "TEL", (60, 200, 60), 8), ("ministry", "Ministry of Finance", "MIN", (40, 160, 40), 6),
    ("split", "Zyarth Patriarchy", "ZYA", (230, 120, 40), -3), ("freesplit", "Free Families", "FRF", (240, 160, 60), 4),
    ("scaleplate", "Scale Plate Pact", "SCA", (150, 140, 60), -15), ("terran", "Terran Protectorate", "TER", (220, 220, 220), 1),
    ("pioneers", "Segaris Pioneers", "PIO", (120, 200, 255), 7), ("boron", "Queendom of Boron", "BOR", (60, 180, 255), 9),
    ("buccaneers", "Duke's Buccaneers", "BUC", (180, 80, 80), -18), ("loanshark", "Riptide Rakers", "LOA", (200, 100, 60), -4),
    ("xenon", "Xenon", "XEN", (230, 30, 30), -30), ("khaak", "Kha'ak", "KHK", (200, 60, 200), -30),
    ("trinity", "Trinity Sanctum", "TRI", (100, 220, 160), 0),
]
FACTION_IDS = [f[0] for f in FACTIONS]
SHIP_CLASSES = [("ship_s", 0.30), ("ship_m", 0.35), ("ship_l", 0.22), ("ship_xl", 0.08), ("ship_xs", 0.05)]
PURPOSES = ["trade", "mine", "fight", "build", "auxiliary"]
ORDERS = [("TradeRoutine", "Automatikus kereskedés", "Kereskedés"), ("MiningRoutine", "Automatikus bányászat", "Bányászat"),
          ("Patrol", "Járőrözés", "Járőr"), ("Wait", "Várakozás", "Vár"), ("MoveWait", "Repülés és várakozás", "Úton"),
          ("Escort", "Kíséret", "Kísér"), ("DockAndWait", "Dokkolás és várakozás", "Dokkol"),
          ("ProtectStation", "Állomás védelme", "Véd")]
NAMES = ["Hermes", "Nodan", "Minotaur", "Elite", "Mercury", "Courier", "Magnetar", "Sunder", "Behemoth", "Odysseus",
         "Colossus", "Raptor", "Shih", "Kalis", "Heron", "Crane", "Plutus", "Okinawa", "Rattlesnake", "Asgard"]
LOG_TEMPLATES = {
    "general": ["{ship} dokkolt: {station}", "Új hajó leszállítva: {ship}", "Javítás kész: {ship}"],
    "missions": ["Küldetés teljesítve: {mission}", "Küldetés frissítve: {mission}"],
    "news": ["{fac} és {fac2} kapcsolata romlik", "Xenon támadás {sector} közelében"],
    "diplomacy": ["Diplomáciai esemény: {fac} kereskedelmi megállapodás"],
    "alerts": ["{ship} támadás alatt ({sector})", "{ship} megsemmisült ({sector})", "{station} támadás alatt"],
    "upkeep": ["{station}: kevés a pénz a kereskedelemhez", "{ship}: nincs pilóta"],
    "tips": ["Tipp: a térképen jobb gombbal adhatsz parancsot."],
}


class SnLikeClient:
    def __init__(self, name: str, mode: str):
        self.path = "\\\\.\\pipe\\" + name
        self.mode = mode
        self.h = None
        self.ok_writes = 0
        self.failed = 0
        self.reads = 0

    def _open(self) -> None:
        h = win32file.CreateFile(self.path, win32file.GENERIC_READ | win32file.GENERIC_WRITE,
                                 0, None, win32file.OPEN_EXISTING, 0, None)
        if self.mode == "message":
            win32pipe.SetNamedPipeHandleState(h, win32pipe.PIPE_READMODE_MESSAGE | win32pipe.PIPE_NOWAIT, None, None)
        else:
            win32pipe.SetNamedPipeHandleState(h, win32pipe.PIPE_NOWAIT, None, None)
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
            if self.h is not None or self.failed == 0:
                print(f"[sim] pipe unavailable ({e.winerror}: {e.strerror}); retrying", flush=True)
            self.failed += 1
            self.close()
            return False

    def read_all(self) -> list[str]:
        out = []
        if self.h is None:
            return out
        while True:
            try:
                hr, data = win32file.ReadFile(self.h, 65536)
            except pywintypes.error as e:
                if e.winerror in (winerror.ERROR_NO_DATA,):
                    return out
                self.close()
                return out
            self.reads += 1
            out.extend(l for l in bytes(data).decode("utf-8", "replace").splitlines() if l.strip())

    def close(self) -> None:
        if self.h is not None:
            try:
                win32file.CloseHandle(self.h)
            except pywintypes.error:
                pass
            self.h = None


# the game's icon ids (libraries\icons.xml, map legend menu_map.lua:1543-1637) the bridge would report
SHIP_ICONS = {
    ("ship_xs", "fight"): "ship_xs_drone_fight_01", ("ship_xs", "trade"): "ship_xs_drone_trade_01",
    ("ship_xs", "build"): "ship_xs_drone_build_01", ("ship_xs", "mine"): "ship_xs_personalvehicle_01",
    ("ship_s", "fight"): "ship_s_fighter_01", ("ship_s", "trade"): "ship_s_courier_01", ("ship_s", "mine"): "ship_s_miner_01",
    ("ship_s", "build"): "ship_s_scout_01", ("ship_s", "auxiliary"): "ship_s_heavyfighter_01",
    ("ship_m", "fight"): "ship_m_corvette_01", ("ship_m", "trade"): "ship_m_transporter_01", ("ship_m", "mine"): "ship_m_miner_01",
    ("ship_m", "build"): "ship_m_tug_01", ("ship_m", "auxiliary"): "ship_m_frigate_01",
    ("ship_l", "fight"): "ship_l_destroyer_01", ("ship_l", "trade"): "ship_l_freighter_01", ("ship_l", "mine"): "ship_l_miner_01",
    ("ship_l", "build"): "ship_l_scavenger_01", ("ship_l", "auxiliary"): "ship_l_carrier_01",
    ("ship_xl", "fight"): "ship_xl_battleship_01", ("ship_xl", "trade"): "ship_xl_freighter_01", ("ship_xl", "mine"): "ship_xl_carrier_01",
    ("ship_xl", "build"): "ship_xl_builder_01", ("ship_xl", "auxiliary"): "ship_xl_resupplier_01",
}
STATION_ICONS = ["mapob_tradestation", "mapob_shipyard", "mapob_wharf", "mapob_equipmentdock", "mapob_defensestation",
                 "mapob_factory", "mapob_energy", "mapob_food", "mapob_refined", "mapob_hightech", "mapob_piratestation"]
OTHER_ICONS = {"gate": "mapob_jumpgate", "highwayentrygate": "mapob_superhighway", "satellite": "mapob_satellite_01",
               "navbeacon": "mapob_navbeacon", "resourceprobe": "mapob_resourceprobe", "lockbox": "mapob_lockbox",
               "collectablewares": "mapob_collectablewarecontainer", "mine": "mapob_mine"}
# NOT the game's values: the real ones come from GetHoloMapColors() at runtime (helper.lua:13070).
# Rough look-alikes so the simulator shows a coloured map; the dashboard never uses these in the game.
SIM_HOLO = {"playercolor": (0, 255, 162), "friendcolor": (153, 204, 255), "enemycolor": (255, 128, 0),
            "hostilecolor": (255, 32, 32), "missioncolor": (255, 192, 0), "currentplayershipcolor": (255, 255, 255),
            "gatecolor": (255, 255, 255), "highwaygatecolor": (64, 160, 255), "superhighwaycolor": (64, 160, 255),
            "highwaycolor": (90, 140, 200), "radarcolor": (40, 90, 160), "visitorcolor": (200, 120, 255), "missilecolor": (255, 64, 64)}


def jd(o) -> str:
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)


class World:
    def __init__(self, nships: int, seed: int, bad_bytes: bool):
        self.r = random.Random(seed)
        self.bad = bad_bytes
        self.t0 = time.time()
        self.gametime = 123456.0
        static = json.loads((ROOT / "data" / "static_map.json").read_text(encoding="utf-8"))
        r = self.r
        self.next_id = 30000
        self.clusters = []
        self.sectors: dict[str, dict] = {}
        self.by_macro: dict[str, str] = {}
        for c in static["clusters"]:
            cid = self.nid()
            ce = {"id": cid, "name": c["name"], "macro": c["macro"], "x": c["x"], "z": c["z"], "sectors": []}
            for s in c["sectors"]:
                sid = self.nid()
                owner = s.get("owner") or r.choice(FACTION_IDS[:16] + ["xenon", "khaak", "ownerless"])
                se = {"id": sid, "name": s["name"], "macro": s["macro"], "x": s["x"], "z": s["z"],
                      "owner": None if owner == "ownerless" else owner, "cluster": cid,
                      "gx": c["x"] + s["x"], "gz": c["z"] + s["z"]}
                if r.random() < 0.6:
                    se["res"] = [{"w": w, "c": r.randint(10, 100), "m": 100} for w in r.sample(["ore", "silicon", "ice", "hydrogen", "helium", "methane", "nividium", "rawscrap"], r.randint(1, 4))]
                ce["sectors"].append(se)
                self.sectors[sid] = se
                self.by_macro[s["macro"]] = sid
            self.clusters.append(ce)
        # the player's discoveries: BFS over gate links from the start, ~60 % of the galaxy;
        # everything else is undiscovered and must never reach the browser (names carry "SECRET")
        adj: dict[str, set] = {sid: set() for sid in self.sectors}
        for a, b in static["gates"]:
            sa, sb = self.by_macro.get(a), self.by_macro.get(b)
            if sa and sb:
                adj[sa].add(sb); adj[sb].add(sa)
        start = max(adj, key=lambda k: len(adj[k]))
        self.known = {start}
        frontier = [start]
        target = int(len(self.sectors) * 0.6)
        while frontier and len(self.known) < target:
            nxt = []
            for f in frontier:
                for n in sorted(adj[f]):
                    if n not in self.known and len(self.known) < target:
                        self.known.add(n); nxt.append(n)
            frontier = nxt
        for sid, se in self.sectors.items():
            if sid not in self.known:
                se["name"] = "SECRET " + se["name"]
        # gates and highway entry gates as objects in their sectors
        self.gates = []
        self.objects: dict[str, dict[str, dict]] = {sid: {} for sid in self.sectors}
        for kind, links in (("gate", static["gates"]), ("highwayentrygate", static["highways"])):
            for a, b in links:
                sa, sb = self.by_macro.get(a), self.by_macro.get(b)
                if not sa or not sb:
                    continue
                ga = self._gate_obj(sa, sb, kind)
                gb = self._gate_obj(sb, sa, kind)
                ga["d"], gb["d"] = gb["id"], ga["id"]
                self.gates += [ga, gb]
        # NPC stations + player stations
        self.stations = {}
        for sid, s in self.sectors.items():
            for _ in range(r.randint(1, 8) if s["owner"] else r.randint(0, 2)):
                owner = s["owner"] or r.choice(["xenon", "buccaneers", "loanshark"])
                o = self._obj(sid, "station", owner, self._name("st"), r.uniform(-150000, 150000), r.uniform(-150000, 150000))
                o["code"] = self._code()
                o["ic"] = r.choice(STATION_ICONS)
                if sid not in self.known or r.random() < 0.2:
                    o["unknown"] = True
                    o["n"] = "SECRET station " + o["n"]
        sids = sorted(self.known)
        self.home = r.sample(sids, 6)
        for i in range(max(3, nships // 16)):
            sid = r.choice(self.home if r.random() < 0.7 else sids)
            o = self._obj(sid, "station", "player", f"Saját állomás {i + 1} {self._quoted()}", r.uniform(-120000, 120000), r.uniform(-120000, 120000))
            o.update(code=self._code(), money=r.randint(100000, 50000000), mods=r.randint(4, 60), ic=r.choice(STATION_ICONS[:6]), rr=50000,
                     wf=r.randint(0, 900), wfc=r.choice([0, 500, 1000]))
            self.stations[o["id"]] = o
        # player ships
        self.ships = {}
        commanders = []
        for i in range(nships):
            sid = r.choice(self.home if r.random() < 0.6 else sids)
            cls = self._wchoice(SHIP_CLASSES)
            name = f"{r.choice(NAMES)} {i + 1}"
            if self.bad and i % 23 == 0:
                name = f'"{name}" ékezet @@BAD{i % 3}@@'
            o = self._obj(sid, cls, "player", name, r.uniform(-120000, 120000), r.uniform(-120000, 120000))
            od = r.choice(ORDERS)
            pur = r.choice(PURPOSES)
            o.update(code=self._code(), p=pur, ic=SHIP_ICONS.get((cls, pur)), rr=40000 if cls in ("ship_s", "ship_xs") else 50000,
                     hull=r.randint(40, 100), shield=r.randint(0, 100),
                     od=od[0], on=od[1], os=od[2], oq=r.randint(0, 4), mc=f"ship_gen_{cls[5:]}_{r.choice(['trans', 'miner', 'fighter'])}_01_a_macro",
                     vx=r.uniform(-150, 150), vz=r.uniform(-150, 150))
            if cls in ("ship_l", "ship_xl") and r.random() < 0.5:
                commanders.append(o)
                o["fl"] = f"{r.choice(['Alpha', 'Bravo', 'Delta', 'Omega'])} flotta {len(commanders)}"
            elif commanders and r.random() < 0.35:
                o["cmd"] = r.choice(commanders)["id"]
            self.ships[o["id"]] = o
        # NPC traffic is generated per sector when first scanned
        self.npc_done = set()
        self.discover = False
        self.jumped = False
        # player
        start = self.home[0]
        self.player_ship = self._obj(start, "ship_m", "player", "Játékos hajója", 0.0, 0.0)
        self.player_ship.update(code="PLY-001", hull=93.0, shield=100.0, ic="ship_m_corvette_01", rr=40000)
        self.guidance = None
        self.player_sector = start
        self.player_target_gate = None
        self.target = None
        self.money = 41_234_567
        self.missions = self._missions()
        self.offers = self._offers()
        self.factions = self._factions()
        self.logbook: list[dict] = []
        self.ticker: list[dict] = []
        self.inbox: list[dict] = []
        for _ in range(60):
            self._new_log(initial=True)
        for _ in range(12):
            self._new_ticker()
        for _ in range(8):
            self._new_message()

    # ---------------------------------------------------------------- builders
    def nid(self) -> str:
        self.next_id += self.r.randint(1, 9)
        return str(self.next_id)

    def _code(self) -> str:
        r = self.r
        return "".join(r.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(3)) + "-" + str(r.randint(100, 999))

    def _name(self, kind: str) -> str:
        r = self.r
        return r.choice(["Fénylő", "Kristály", "Kelet", "Nyugat", "Ős", "Új"]) + " " + r.choice(["Kereskedőállomás", "Hajógyár", "Védelmi Állomás", "Energiacellák", "Finomító", "Raktár"])

    def _quoted(self) -> str:
        return '"Aurora"' if self.r.random() < 0.3 else ""

    def _wchoice(self, items):
        x = self.r.random()
        acc = 0.0
        for v, w in items:
            acc += w
            if x <= acc:
                return v
        return items[-1][0]

    def _obj(self, sid: str, cls: str, owner: str, name: str, x: float, z: float) -> dict:
        o = {"id": self.nid(), "c": cls, "n": name, "o": owner, "s": sid, "x": x, "y": 0.0, "z": z, "yaw": 0.0}
        self.objects[sid][o["id"]] = o
        return o

    def _gate_obj(self, sid: str, other: str, kind: str) -> dict:
        s, o = self.sectors[sid], self.sectors[other]
        ang = math.atan2(o["gx"] - s["gx"], o["gz"] - s["gz"])
        dist = 180000 if kind == "gate" else 90000
        g = self._obj(sid, kind, "ownerless", "Ugrókapu" if kind == "gate" else "Szupersztráda", dist * math.sin(ang), dist * math.cos(ang))
        g["ic"] = OTHER_ICONS[kind]
        g["ds"] = other
        return g

    def _npc(self, sid: str) -> None:
        if sid in self.npc_done:
            return
        self.npc_done.add(sid)
        r = self.r
        s = self.sectors[sid]
        for _ in range(r.randint(60, 260)):
            owner = s["owner"] if (s["owner"] and r.random() < 0.6) else r.choice(FACTION_IDS)
            cls = self._wchoice(SHIP_CLASSES)
            o = self._obj(sid, cls, owner, f"{r.choice(NAMES)} ({owner})", r.uniform(-200000, 200000), r.uniform(-200000, 200000))
            pur = r.choice(PURPOSES)
            o.update(code=self._code(), p=pur, ic=SHIP_ICONS.get((cls, pur)), hull=r.randint(30, 100), vx=r.uniform(-300, 300), vz=r.uniform(-300, 300))
            if r.random() < 0.02:
                o["mt"] = True
        # abandoned (claimable) ships: owner faction "ownerless", standing still (the real game sends
        # e.g. {"c": "ship_m", "o": "ownerless", "n": "Baku", "ic": "ship_m_transporter_01"})
        for _ in range(r.randint(1, 3)):
            cls = r.choice(["ship_s", "ship_m", "ship_l"])
            pur = r.choice(["fight", "trade", "mine"])
            o = self._obj(sid, cls, "ownerless", r.choice(NAMES), r.uniform(-60000, 60000), r.uniform(-60000, 60000))
            o.update(code=self._code(), p=pur, ic=SHIP_ICONS.get((cls, pur)), hull=r.randint(10, 60), yaw=r.uniform(-3.1, 3.1))
        for _ in range(r.randint(2, 8)):
            cls = r.choice(["satellite", "navbeacon", "resourceprobe", "lockbox", "collectablewares", "mine"])
            own = cls in ("satellite", "resourceprobe", "navbeacon") and r.random() < 0.6
            o = self._obj(sid, cls, "player" if own else "ownerless", "Objektum", r.uniform(-150000, 150000), r.uniform(-150000, 150000))
            o["ic"] = OTHER_ICONS.get(cls)
            if own and cls == "satellite":
                o["rr"] = 30000

    def _missions(self) -> list[dict]:
        r = self.r
        out = []
        for i in range(9):
            sid = r.choice(sorted(self.sectors))
            out.append({"id": self.nid(), "n": r.choice(["Hajó építése", "Áru szállítása", "Járőrözés", "Xenon elleni harc", "Állomás védelme", "Keresés és mentés"]) + f" #{i + 1}",
                        "d": "Részletes küldetésleírás. Szállíts 120 egység Energiacellát a megadott állomásra.",
                        "diff": r.randint(0, 5), "mt": r.choice(["plot", "guild", "fight", "build", "upkeep", "guidance"]),
                        "st": r.choice(["Szállítás", "Harc", "Építés", "Felderítés"]), "fa": r.choice(FACTION_IDS[:10]),
                        "rw": r.randint(50000, 3000000), "rt": "", "dur": r.choice([-1, r.randint(300, 7200)]),
                        "act": True if i == 0 else None, "ab": True,
                        "ob": f"Repülj ide: {self.sectors[sid]['name']}" if sid in self.known else "Repülj egy ismeretlen szektorba",
                        "pn": "Szállított", "pc": r.randint(0, 50), "pm": 120, "acs": sid if sid in self.known else None})
        return out

    def _offers(self) -> list[dict]:
        r = self.r
        return [{"id": self.nid(), "n": r.choice(["Hajószállítás", "Áruszállítás", "Bérgyilkosság", "Javítás", "Felderítés"]) + f" ({i + 1})",
                 "d": "Ajánlat leírása.", "diff": r.randint(0, 5), "mt": r.choice(["fight", "trade", "build"]),
                 "st": "Ajánlat", "fa": r.choice(FACTION_IDS[:12]), "rw": r.randint(20000, 900000), "rt": "",
                 "dur": r.randint(600, 3600), "s": r.choice(sorted(self.known))} for i in range(24)]

    def _factions(self) -> list[dict]:
        out = []
        for fid, name, short, col, rel in FACTIONS:
            rn = "Szövetséges" if rel >= 20 else "Baráti" if rel >= 10 else "Semleges" if rel > -10 else "Ellenséges" if rel > -20 else "Elkeseredett ellenség"
            lic = [{"t": t, "n": n, "has": rel >= mr, "pr": pr, "mr": mr} for t, n, pr, mr in
                   (("generaluseequipment", "Általános felszerelés", 0, 0), ("militaryship", "Katonai hajó", 0, 10),
                    ("capitalship", "Nagyhajó", 2000000, 20), ("police", "Rendőrségi", 0, 20), ("station_gen_basic", "Alap állomás", 0, -5))]
            out.append({"id": fid, "n": name, "sn": short, "rel": rel, "rn": rn, "e": rel <= -10 or None, "h": rel <= -25 or None,
                        "lk": fid in ("xenon", "khaak") or None, "col": {"r": col[0], "g": col[1], "b": col[2]}, "lic": lic})
        return out

    def _fill(self, tpl: str) -> str:
        r = self.r
        ship = r.choice(list(self.ships.values()))["n"] if self.ships else "Hajó"
        st = r.choice(list(self.stations.values()))["n"] if self.stations else "Állomás"
        return tpl.format(ship=ship, station=st, mission=r.choice(self.missions)["n"], fac=r.choice(FACTIONS)[1],
                          fac2=r.choice(FACTIONS)[1], sector=self.sectors[r.choice(sorted(self.known))]["name"])

    def _new_log(self, initial: bool = False, cat: str | None = None) -> dict:
        r = self.r
        cat = cat or r.choice(["general", "general", "missions", "news", "alerts", "upkeep", "tips", "diplomacy"])
        self.gametime += r.uniform(1, 30) if initial else 0
        e = {"cat": cat, "t": round(self.gametime, 2), "ti": self._fill(r.choice(LOG_TEMPLATES[cat])),
             "tx": "Részletek: " + self._fill(r.choice(LOG_TEMPLATES["general"])) if r.random() < 0.6 else "",
             "fa": r.choice(FACTIONS)[1] if r.random() < 0.4 else None,
             "mo": r.choice([None, None, r.randint(-50000, 900000)])}
        if cat == "alerts" and self.ships:
            ship = r.choice(list(self.ships.values()))
            e["ia"] = "showonmap"
            e["ic"] = ship["id"]
            e["hl"] = True
        if not e["tx"]:
            e.pop("tx")
        self.logbook.append(e)
        return e

    def _new_ticker(self) -> dict:
        r = self.r
        e = {"id": self.nid(), "t": round(self.gametime, 2), "cat": r.choice(["trade", "alert", "general"]),
             "ti": self._fill(r.choice(["Kereskedés kész: {ship}", "{ship} támadás alatt", "Új küldetés elérhető"])), "tx": ""}
        self.ticker.append(e)
        return e

    def _new_message(self) -> dict:
        r = self.r
        e = {"id": self.nid(), "cat": r.choice(["highprio", "lowprio"]), "t": round(self.gametime, 2),
             "ti": r.choice(["Üzenet a flottaparancsnoktól", "Ajánlat egy kereskedőtől", "Figyelmeztetés"]),
             "tx": "Az üzenet szövege, akár több mondat is.", "so": r.choice(FACTIONS)[1], "rd": False}
        self.inbox.append(e)
        self.inbox = self.inbox[-40:]
        return e

    # ---------------------------------------------------------------- dynamics
    def step(self, dt: float) -> list[dict]:
        """Advance the world; return 'events' (new log/ticker entries) for chatty logging."""
        r = self.r
        self.gametime += dt
        p = self.player_ship
        sid = self.player_sector
        if self.player_target_gate is None or self.player_target_gate["s"] != sid:
            gs = [g for g in self.objects[sid].values() if g["c"] == "gate" and g["ds"] in self.known]
            if self.discover:   # M6 scenario: fly into undiscovered sectors whenever possible
                new = [g for g in self.objects[sid].values() if g["c"] == "gate" and g["ds"] not in self.known]
                gs = new or gs
            self.player_target_gate = r.choice(gs) if gs else None
        g = self.player_target_gate
        speed = getattr(self, "player_speed", 2500.0)   # fast, so the simulation shows sector changes in a test run
        if g:
            dx, dz = g["x"] - p["x"], g["z"] - p["z"]
            d = math.hypot(dx, dz)
            if d < speed * dt * 1.5:
                dest = self.objects.get(g["ds"], {}).get(g.get("d")) if g.get("d") else None
                self._move_player(g["ds"], dest)
            else:
                p["x"] += dx / d * speed * dt
                p["z"] += dz / d * speed * dt
                p["yaw"] = math.atan2(dx, dz)
                p["speed"] = speed
        for o in self.ships.values():
            if "vx" in o:
                o["x"] += o["vx"] * dt
                o["z"] += o["vz"] * dt
        for oid in list(self.objects[self.player_sector].keys())[:400]:
            o = self.objects[self.player_sector][oid]
            if "vx" in o and o["o"] != "player":
                o["x"] += o["vx"] * dt
                o["z"] += o["vz"] * dt
                o["yaw"] = math.atan2(o["vx"], o["vz"])
        if r.random() < 0.02 * dt * 4:
            s = r.choice(list(self.ships.values()))
            s["hull"] = max(5, s["hull"] - r.randint(5, 30))
        self.money += int(r.uniform(-2000, 9000) * dt)
        return []

    # ---------------------------------------------------------------- v1.3 mission guidance
    # What the bridge sends as "gd" (x4_companion.lua guidanceField): the active mission's target and the
    # route the game's path finder computes (MD get_global_path): per hop the gate in this sector and its exit
    # gate in the next, cut before the first gate into an undiscovered sector. Scenarios (--guidance):
    # route (a station 2+ jumps away), local (a station in the player's sector), position (a zone = a point),
    # inside (a room in a station), unknown (a target in undiscovered space), off (disableguidance), none.
    def _gd_adj(self) -> dict:
        if getattr(self, "_gdadj", None) is None:
            adj: dict[str, list] = {}
            for g in self.gates:
                ex = self.objects.get(g["ds"], {}).get(g.get("d")) if g.get("d") else None
                if ex:
                    adj.setdefault(g["s"], []).append((g, ex))
            self._gdadj = adj
        return self._gdadj

    def gd_path(self, start: str, goal: str) -> list[tuple[dict, dict]] | None:
        adj = self._gd_adj()
        prev = {start: None}
        q = [start]
        while q:
            cur = q.pop(0)
            if cur == goal:
                break
            for g, ex in sorted(adj.get(cur, []), key=lambda e: e[0]["id"]):
                if ex["s"] not in prev:
                    prev[ex["s"]] = (cur, g, ex)
                    q.append(ex["s"])
        if goal not in prev:
            return None
        hops = []
        c = goal
        while prev[c] is not None:
            a, g, ex = prev[c]
            hops.insert(0, (g, ex))
            c = a
        return hops

    def gd_pick(self, scenario: str) -> None:
        """the target of a scenario, chosen once (deterministic per seed)"""
        start = self.player_sector
        if scenario in ("route", "unknown"):
            dist = {start: 0}
            q = [start]
            while q:
                cur = q.pop(0)
                for g, ex in self._gd_adj().get(cur, []):
                    if ex["s"] not in dist:
                        dist[ex["s"]] = dist[cur] + 1
                        q.append(ex["s"])
            want = (lambda s: s in self.known and dist[s] >= 2) if scenario == "route" else (lambda s: s not in self.known and dist[s] >= 1)
            cands = sorted((dist[s], s) for s in dist if want(s))
            for _, sid in cands:
                st = sorted((o for o in self.objects[sid].values() if o["c"] == "station" and (scenario == "unknown" or not o.get("unknown"))),
                            key=lambda o: o["id"])
                if st:
                    self.gd_target = st[0]
                    return
            self.gd_target = None

    def gd_field(self, scenario: str, act: dict | None) -> dict | None:
        if scenario == "none" or not act:
            return None
        gd = {"k": "mission", "mid": act["id"], "n": act["n"], "ob": act.get("ob")}
        if scenario == "off":
            gd["off"] = True
            return gd
        ps = self.player_sector
        here = [o for o in self.objects[ps].values() if o["c"] == "station" and not o.get("unknown")]
        p = self.player_ship
        if scenario in ("local", "inside") and here:
            st = min(here, key=lambda o: math.hypot(o["x"] - p["x"], o["z"] - p["z"]))
            t = {"id": st["id"], "c": "station", "s": ps, "x": round(st["x"]), "z": round(st["z"]), "n": st["n"]}
            if scenario == "inside":
                t = {"id": "9" + st["id"], "c": "room", "s": ps, "x": round(st["x"]), "z": round(st["z"]), "n": "Repair Terminal",
                     "in": {"id": st["id"], "n": st["n"], "c": "station"}}
            gd.update(r=[], t=t)
            return gd
        if scenario == "position":
            gd.update(r=[], t={"id": "8" + ps, "c": "zone", "s": ps, "x": 60000, "z": -40000})
            return gd
        if not hasattr(self, "gd_target"):
            self.gd_pick(scenario)
        tg = self.gd_target
        if tg is None:
            gd["r"] = []
            return gd
        hops = self.gd_path(ps, tg["s"]) or []
        pts, cut = [], False
        for g, ex in hops:
            if ex["s"] not in self.known:
                cut = True        # the gate into undiscovered space is not shown either
                break
            kin, kout = ("g", "g") if g["c"] == "gate" else ("he", "hx")
            pts.append({"s": g["s"], "x": round(g["x"]), "z": round(g["z"]), "id": g["id"], "k": kin})
            pts.append({"s": ex["s"], "x": round(ex["x"]), "z": round(ex["z"]), "id": ex["id"], "k": kout})
        gd["r"] = pts
        if cut or tg["s"] not in self.known:
            gd["th"] = True
            if cut:
                gd["cut"] = True
        else:
            gd["t"] = {"id": tg["id"], "c": "station", "s": tg["s"], "x": round(tg["x"]), "z": round(tg["z"]), "n": tg["n"]}
        return gd

    def _move_player(self, sid: str, dest_gate: dict | None) -> None:
        p = self.player_ship
        self.objects[self.player_sector].pop(p["id"], None)
        self.player_sector = sid
        p["s"] = sid
        if dest_gate:
            p["x"], p["z"] = dest_gate["x"] * 0.97, dest_gate["z"] * 0.97
        else:
            p["x"], p["z"] = 0.0, 0.0
        self.objects[sid][p["id"]] = p
        self.player_target_gate = None
        self.target = None
        if sid not in self.known:      # entering a sector discovers it (the galaxy channel reports it later)
            self.known.add(sid)
            se = self.sectors[sid]
            if se["name"].startswith("SECRET "):
                se["name"] = se["name"][len("SECRET "):]
        self.jumped = True
        print(f"[sim] player jumped to {self.sectors[sid]['name']}", flush=True)


class Bridge:
    """Mimics the Lua scheduler: per-channel intervals, chunking, diffs, resync, commands."""

    INTERVALS = {"player": 0.25, "theme": 30.0, "sector": 1.0, "property": 4.0, "logbook": 2.0, "ticker": 1.0, "messages": 5.0,
                 "missions": 3.0, "offers": 10.0, "factions": 20.0, "economy": 30.0, "stats": 2.0, "galaxy": 60.0}

    def __init__(self, world: World, cli: SnLikeClient, args):
        self.w = world
        self.cli = cli
        self.a = args
        self.session = 0
        self.connected = False
        self.last_hello = -1e9
        self.due = {k: 0.0 for k in self.INTERVALS}
        self.sent_prop: dict[str, str] = {}
        self.sent_log = 0
        self.sent_ticker = 0
        self.gen = 0
        self.watch: str | None = None
        self.n_sector = 0
        self.allow = {"resync", "watch", "reenable", "openmap", "select", "target", "guidance", "guidance_end", "details"}
        if args.allow_orders:
            self.allow |= {"stop", "flyto"}
        self.counts = {}
        self.paused = False
        self.last_hotkey = 0.0
        self.last_junk = 0.0
        self.hotkey_i = 0
        self.cmds = 0
        self.nbytes = 0

    def send(self, obj: dict, raw_items: list[str] | None = None) -> bool:
        obj["v"] = 2
        obj["src"] = "sim"
        if raw_items is None:
            s = jd(obj)
        else:
            head = jd(obj)
            s = head[:-1] + ',"items":[' + ",".join(raw_items) + "]}"
        data = (s + "\n").encode("utf-8")
        if self.a.bad_bytes:
            data = data.replace(b"@@BAD0@@", b"\xc3\x28 invalid utf8").replace(b"@@BAD1@@", b"\xff\xfe\xfd").replace(b"@@BAD2@@", b"\xe2\x82")
        ok = self.cli.write(data)
        if ok:
            self.nbytes += len(data)
            self.counts[obj["type"]] = self.counts.get(obj["type"], 0) + 1
        else:
            if self.connected:
                print("[sim] write failed -> reconnecting, full resync on next hello", flush=True)
            self.connected = False
        return ok

    def chunks(self, mtype: str, items: list[dict], extra: dict) -> None:
        part, buf, size = 0, [], 0
        for it in items:
            js = jd(it)
            if size + len(js) > MAX_MSG - 1000 and buf:
                self.send({"type": mtype, "part": part, "last": False, **extra}, buf)
                part, buf, size = part + 1, [], 0
            buf.append(js)
            size += len(js) + 1
        self.send({"type": mtype, "part": part, "last": True, **extra}, buf)

    def resync(self) -> None:
        for k in self.due:
            self.due[k] = 0.0
        self.sent_prop = {}
        self.sent_log = max(0, len(self.w.logbook) - 40)
        self.sent_ticker = max(0, len(self.w.ticker) - 30)

    # ---------------------------------------------------------------- channels
    def ch_player(self, now):
        w = self.w
        p = w.player_ship
        sec = w.sectors[w.player_sector]
        m = {"type": "player", "t": round(now, 3), "ingame": True, "paused": self.paused, "name": "Kovács Kapitány",
             "faction": "Játékos", "money": w.money, "gametime": round(w.gametime, 1),
             "sector": {"id": sec["id"], "name": sec["name"]},
             "object": {"id": p["id"], "mode": "ship", "x": round(p["x"]), "y": 0, "z": round(p["z"]), "yaw": round(p["yaw"], 4),
                        "name": p["n"], "class": "ship_m", "hull": p["hull"], "shield": p["shield"], "code": p["code"],
                        "maxspeed": 520, "travelspeed": 4100, "speed": round(p.get("speed", 0), 1), "ic": p["ic"], "rr": p["rr"]},
             "nframe": int(now * 60), "nmd": 0, "where": {"mode": "pilot", "name": p["n"]}}
        if w.target and w.target in w.objects[w.player_sector]:
            t = w.objects[w.player_sector][w.target]
            m["target"] = {"id": t["id"], "name": t["n"], "class": t["c"], "hull": t.get("hull"), "owner": t["o"],
                           "dist": round(math.hypot(t["x"] - p["x"], t["z"] - p["z"])), "x": round(t["x"]), "z": round(t["z"]),
                           "sector": w.player_sector}
        if w.guidance:
            g = next((objs[w.guidance] for objs in w.objects.values() if w.guidance in objs), None)
            if g is None or g.get("unknown") or g["s"] not in w.known:
                m["guidance"] = {"unknown": True}
            else:
                m["guidance"] = {"id": g["id"], "s": g["s"], "x": round(g["x"]), "z": round(g["z"]), "n": g["n"]}
        act = next((x for x in w.missions if x.get("act")), None)
        if act:
            m["mission"] = {"id": act["id"], "name": act["n"]}
        gd = w.gd_field(self.a.guidance, act)
        if gd:
            m["gd"] = gd
        if self.watch:
            m["watch"] = self.watch
        self.send(m)

    def ch_theme(self, now):
        self.send({"type": "theme", "sim": True,
                   "holo": {k: {"r": c[0], "g": c[1], "b": c[2], "a": 100} for k, c in SIM_HOLO.items()},
                   "ui": {"text_normal": {"r": 255, "g": 255, "b": 255, "a": 100}, "text_inactive": {"r": 128, "g": 128, "b": 128, "a": 100}}})

    def ch_galaxy(self, now):
        self.gen += 1
        items = []
        known = self.w.known
        for c in self.w.clusters:
            secs = [{k: s.get(k) for k in ("id", "name", "macro", "owner", "x", "z", "res") if s.get(k) is not None}
                    for s in c["sectors"] if s["id"] in known]
            if secs:
                items.append({"id": c["id"], "name": c["name"], "macro": c["macro"], "x": c["x"], "z": c["z"], "sectors": secs})
        self.chunks("galaxy", items, {"gen": self.gen})
        gates = []
        for g in self.w.gates:
            if g["s"] not in known:
                continue
            e = {"id": g["id"], "s": g["s"], "a": True, "x": round(g["x"]), "z": round(g["z"])}
            if g["c"] == "highwayentrygate":
                e["hw"] = True
            if g["ds"] in known:
                e["ds"] = g["ds"]
            else:
                e["du"] = True
            gates.append(e)
        self.chunks("gates", gates, {"n": len(gates)})

    def scan_sector(self, sid: str, is_player: bool):
        w = self.w
        w._npc(sid)
        objs, hidden = [], 0
        p = w.player_ship
        for o in list(w.objects[sid].values())[:700]:
            # visibility like the bridge: own objects, known gates/stations; other ships only near own assets
            vis = o["o"] == "player" or (o["c"] in ("gate", "highwayentrygate", "station") and not o.get("unknown"))
            if o.get("unknown"):
                hidden += 1
                continue
            if not vis and is_player:
                vis = math.hypot(o["x"] - p["x"], o["z"] - p["z"]) < 60000
            if not vis and not is_player:
                vis = self.w.r.random() < 0.3
            if not vis:
                hidden += 1
                continue
            e = {"id": o["id"], "c": o["c"], "n": o["n"], "o": o["o"], "x": round(o["x"]), "y": 0, "z": round(o["z"])}
            if o.get("ic"):
                e["ic"] = o["ic"]
            if o.get("mt"):
                e["mt"] = True
            if o["o"] == "player":
                e["pl"] = True
                if o.get("rr"):
                    e["rr"] = o["rr"]
            if o["o"] in ("xenon", "khaak"):
                e["h"] = True
            elif o["o"] in ("buccaneers", "scaleplate", "holyorder"):
                e["e"] = True
            if o["c"].startswith("ship"):
                e.update(yaw=round(o.get("yaw", 0), 4), p=o.get("p"), hull=o.get("hull"), code=o.get("code"))
            elif o["c"] in ("gate", "highwayentrygate"):
                if o.get("ds") in w.known:
                    e["ds"] = o.get("ds")
                else:
                    e["du"] = True
            elif o["c"] == "station":
                e["code"] = o.get("code")
            e["r"] = next((f[4] for f in FACTIONS if f[0] == o["o"]), 0)
            objs.append(e)
        if is_player:
            objs.extend(self.sector_extras(sid))
        self.n_sector += 1
        self.chunks("sector", objs, {"sid": sid, "gen": self.n_sector, "player": is_player, "n": len(objs) + hidden,
                                     "hidden": hidden, "skipped": 0, "full": False})

    def sector_extras(self, sid: str) -> list[dict]:
        """What the v1.2 bridge appends to the player's sector scan (pseudo objects, see x4_companion.lua
        sectorExtras): the sector's core size / centre / contested state (MD) and the resource areas of
        the wares discovered there (sampled every 10 km). Deterministic per sector, own RNG."""
        se = self.w.sectors[sid]
        rr = random.Random(int(sid) * 7919)
        out = [{"id": "si:" + sid, "c": "x4c_sectorinfo", "core": rr.randint(260, 460) * 1000,
                "cx": rr.randint(-20, 20) * 1000, "cz": rr.randint(-20, 20) * 1000, "contested": rr.random() < 0.15}]
        # a local highway (two lanes) in most sectors, always in the start sector (deterministic tests)
        if rr.random() < 0.6 or sid == self.w.home[0]:
            p0 = (rr.uniform(-150, -60), rr.uniform(-150, 150))
            p2 = (rr.uniform(60, 150), rr.uniform(-150, 150))
            p1 = ((p0[0] + p2[0]) / 2 + rr.uniform(-40, 40), (p0[1] + p2[1]) / 2 + rr.uniform(-60, 60))
            lane = []
            for i in range(21):
                t = i / 20
                lane += [round((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], 2),
                         round((1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1], 2)]
            back = []
            for i in range(len(lane) - 2, -1, -2):
                back += [lane[i], lane[i + 1]]
            out += [{"id": f"hw:{sid}:1", "c": "x4c_highway", "pts": lane}, {"id": f"hw:{sid}:2", "c": "x4c_highway", "pts": back}]
        cell = 10000
        for k, res in enumerate(se.get("res") or []):
            ware = res["w"]
            pts = []
            for _ in range(rr.randint(1, 3)):            # 1-3 blobs per ware
                bx, bz, br = rr.uniform(-150000, 150000), rr.uniform(-150000, 150000), rr.uniform(25000, 60000)
                h = cell * math.sqrt(3) / 2
                for j in range(int(-br / h) - 1, int(br / h) + 2):
                    for i in range(int(-br / cell) - 1, int(br / cell) + 2):
                        x = bx + i * cell + (cell / 2 if j % 2 else 0)
                        z = bz + j * h
                        d = math.hypot(x - bx, z - bz)
                        if d < br:
                            pts += [round(x / 1000, 1), round(z / 1000, 1), max(1, int(res["c"] * (1 - d / br)))]
            out.append({"id": f"res:{sid}:{k + 1}", "c": "x4c_resarea", "w": ware, "cell": cell, "gen": 1, "pts": pts})
        return out

    def ch_sector(self, now):
        self.scan_sector(self.w.player_sector, True)
        if self.watch and self.watch != self.w.player_sector and self.watch in self.w.sectors:
            self.scan_sector(self.watch, False)

    def ch_property(self, now):
        w = self.w
        items, ids = [], []
        for o in list(w.ships.values()) + list(w.stations.values()):
            if o["c"] == "station":
                e = {"id": o["id"], "k": "station", "n": o["n"], "code": o["code"], "c": "station", "s": o["s"], "ic": o.get("ic"),
                     "hull": 100, "money": o["money"], "mods": o["mods"], "wf": o["wf"], "wfc": o["wfc"]}
            else:
                e = {"id": o["id"], "k": "ship", "n": o["n"], "code": o["code"], "c": o["c"], "p": o["p"], "s": o["s"], "ic": o.get("ic"),
                     "hull": o["hull"], "shield": o["shield"], "fl": o.get("fl"), "mc": o["mc"], "od": o["od"],
                     "on": o["on"], "os": o["os"], "oq": o["oq"], "cmd": o.get("cmd")}
            e = {k: v for k, v in e.items() if v is not None}
            js = jd(e)
            ids.append(o["id"])
            if self.sent_prop.get(o["id"]) != js:
                items.append(e)
                self.sent_prop[o["id"]] = js
        self.gen += 1
        if items:
            self.chunks("property", items, {"gen": self.gen})
        self.send({"type": "property_end", "gen": self.gen, "ids": ids, "ships": len(w.ships), "stations": len(w.stations)})

    def ch_logbook(self, now):
        w = self.w
        if w.r.random() < 0.35:
            w._new_log(cat="alerts" if w.r.random() < 0.3 else None)
        new = w.logbook[self.sent_log:]
        self.sent_log = len(w.logbook)
        for cat in {e["cat"] for e in new}:
            items = [{k: v for k, v in e.items() if v is not None} for e in new if e["cat"] == cat]
            self.chunks("logbook", items, {"cat": cat, "total": len(w.logbook)})

    def ch_ticker(self, now):
        w = self.w
        if w.r.random() < 0.3:
            w._new_ticker()
        new = w.ticker[self.sent_ticker:]
        self.sent_ticker = len(w.ticker)
        if new:
            self.send({"type": "ticker", "items": new, "total": len(w.ticker)})

    def ch_messages(self, now):
        w = self.w
        if w.r.random() < 0.1:
            w._new_message()
        unread = {"highprio": sum(1 for m in w.inbox if m["cat"] == "highprio" and not m["rd"]),
                  "lowprio": sum(1 for m in w.inbox if m["cat"] == "lowprio" and not m["rd"])}
        self.send({"type": "messages", "items": w.inbox[-40:], "unread": unread})

    def ch_missions(self, now):
        for m in self.w.missions:
            if m["dur"] and m["dur"] > 0:
                m["dur"] = max(0, m["dur"] - 3)
        self.send({"type": "missions", "items": [{k: v for k, v in m.items() if v is not None} for m in self.w.missions]})

    def ch_offers(self, now):
        self.send({"type": "offers", "items": self.w.offers})

    def ch_factions(self, now):
        self.send({"type": "factions", "items": self.w.factions})

    def ch_economy(self, now):
        r = self.w.r
        top = [{"t": round(self.w.gametime - r.uniform(0, 3600)), "mo": r.choice([-1, 1]) * r.randint(10000, 2000000),
                "ty": r.choice(["Kereskedés", "Javítás", "Hajóvásárlás", "Fizetés"]), "pa": r.choice(list(self.w.ships.values()))["n"],
                "w": "energycells", "wn": "Energiacellák", "am": r.randint(10, 5000)} for _ in range(10)]
        top.sort(key=lambda e: -abs(e["mo"]))
        self.send({"type": "economy", "window": 3600, "gt": round(self.w.gametime), "count": 812,
                   "inc": 18_500_000, "exp": 7_250_000,
                   "bytype": [{"n": "Kereskedés", "mo": 15_200_000}, {"n": "Hajóvásárlás", "mo": -5_100_000},
                              {"n": "Javítás", "mo": -900_000}, {"n": "Küldetés jutalom", "mo": 3_300_000}],
                   "top": top, "partners": [{"n": s["n"] + " (" + s["code"] + ")", "mo": r.randint(100000, 4000000)}
                                            for s in list(self.w.ships.values())[:8]],
                   "money": self.w.money})

    def ch_stats(self, now):
        r = self.w.r
        chs = {k: {"avg": round(r.uniform(0.002, 0.06), 4), "max": round(r.uniform(0.05, 0.5), 3), "pass": round(r.uniform(0.05, 3), 3),
                   "ops": round(r.uniform(0.5, 20), 2), "pops": r.randint(5, 2500),
                   "iv": v, "err": 0, "runs": int(now / v)} for k, v in self.INTERVALS.items()}
        self.send({"type": "stats", "span": 2.0, "frames": 120, "frame": {"avg": round(r.uniform(0.08, 0.3), 4), "max": round(r.uniform(0.4, 0.9), 3)},
                   "ch": chs, "srcoff": [], "srcerr": {}, "pending": 0, "sent": sum(self.counts.values()), "bytes": self.nbytes,
                   "dropped": 0, "wfail": self.cli.failed, "cmds": self.cmds, "gates": "received", "ngates": len(self.w.gates),
                   "gates_md": len(self.w.gates), "gates_rx": len(self.w.gates), "gates_hw": 0,
                   "hk": 17 if self.a.hotkeys else 0, "timer": "qpc", "hires": True, "nframe": int(now * 60), "nmd": 0, "watch": self.watch})

    # ---------------------------------------------------------------- commands
    def handle_cmd(self, line: str) -> None:
        parts = line.split()
        if len(parts) < 3 or parts[0] != "cmd":
            print(f"[sim] ignored pipe line {line[:60]!r}", flush=True)
            return
        seq, name, args = int(parts[1]), parts[2], parts[3:]
        self.cmds += 1
        ok, msg = True, "ok"
        if name not in self.allow:
            ok, msg = False, "a parancs nincs engedélyezve a modban (x4_companion.lua CFG.allow)"
        elif name == "resync":
            self.resync()
            msg = "újraküldés"
        elif name == "watch" and args and args[0] != "0" and args[0] not in self.w.known:
            ok, msg = False, "ismeretlen szektor"
        elif name == "watch":
            self.watch = args[0] if args and args[0] != "0" else None
            self.due["sector"] = 0
            msg = "figyelt szektor beállítva" if self.watch else "figyelt szektor törölve"
        elif name in ("openmap", "select"):
            msg = "térkép megnyitva (szimuláció)"
        elif name == "target":
            self.w.target = args[0]
            msg = "célpont beállítva"
        elif name in ("guidance", "guidance_end"):
            self.w.guidance = args[0] if name == "guidance" else None
            msg = "útvonal beállítva" if name == "guidance" else "útvonal törölve"
        elif name == "details":
            o = None
            for objs in self.w.objects.values():
                if args and args[0] in objs:
                    o = objs[args[0]]
                    break
            if o is None or o.get("unknown") or o["s"] not in self.w.known:
                ok, msg = False, "nem látható objektum"
            else:
                r = self.w.r
                d = {"type": "details", "seq": seq, "id": o["id"], "n": o["n"], "c": o["c"], "o": o["o"],
                     "on": next((f[1] for f in FACTIONS if f[0] == o["o"]), o["o"]), "hull": o.get("hull"),
                     "shield": o.get("shield"), "p": o.get("p"), "code": o.get("code"), "s": o["s"],
                     "pl": True if o["o"] == "player" else None, "ic": o.get("ic"), "rr": o.get("rr")}
                if o["c"].startswith("ship") or o["c"] == "station":
                    own = o["o"] == "player"
                    d["cwl"] = own or r.random() < 0.5
                    d["cam"] = own
                    if d["cwl"]:
                        d["cargo"] = [{"w": w, "n": n, "a": r.randint(10, 9000) if own else None}
                                      for w, n in r.sample([("energycells", "Energiacellák"), ("ore", "Érc"), ("silicon", "Szilícium"),
                                                            ("water", "Víz"), ("foodrations", "Élelmiszer"), ("hullparts", "Hajótest-alkatrészek")], 3)]
                if o.get("od"):
                    d.update(od=o["od"], oname=o["on"], os=o["os"], oq=o.get("oq"))
                    # order queue with map points (bridge: GetOrderParams position/object parameters)
                    orders = []
                    for i in range(max(1, o.get("oq") or 1)):
                        pt = {"s": o["s"], "x": round(o["x"] + r.uniform(-60000, 60000)), "z": round(o["z"] + r.uniform(-60000, 60000))}
                        orders.append({"d": o["od"] if i == 0 else "MoveWait", "n": o["on"] if i == 0 else "Repülés és várakozás",
                                       "st": o["os"] if i == 0 else "", "pt": pt})
                    d["orders"] = orders
                self.send({k: v for k, v in d.items() if v is not None})
                msg = "részletek"
        elif name == "stop":
            s = self.w.ships.get(args[0])
            if s:
                s.update(od="Wait", on="Várakozás", os="Vár", vx=0.0, vz=0.0)
                msg = "parancsok törölve, várakozik"
            else:
                ok, msg = False, "nem saját hajó"
        elif name == "flyto":
            s = self.w.ships.get(args[0])
            if s and args[1] in self.w.sectors:
                s.update(od="MoveWait", on="Repülés és várakozás", os="Úton")
                msg = "repülés a szektorba"
            else:
                ok, msg = False, "érvénytelen hajó vagy szektor"
        self.send({"type": "ack", "seq": seq, "cmd": name, "ok": ok, "msg": msg})

    # ---------------------------------------------------------------- loop
    def tick(self, now: float) -> None:
        if not self.connected:
            if now - self.last_hello >= 2.0:
                self.last_hello = now
                self.session += 1
                if self.send({"type": "hello", "mod": "x4_companion", "ver": "110", "session": self.session,
                              "allow": sorted(self.allow), "hotkeys": 17 if self.a.hotkeys else 0,
                              "loglib": True, "timer": "qpc"}):
                    self.connected = True
                    self.resync()
            return
        for line in self.cli.read_all():
            self.handle_cmd(line)
        if self.w.jumped:
            self.w.jumped = False
            if self.a.galaxy_on_jump:      # what the bridge does since M6: galaxy + sector scan at once
                self.due["galaxy"] = 0.0
                self.due["sector"] = 0.0
        for ch, iv in self.INTERVALS.items():
            if now >= self.due[ch]:
                self.due[ch] = now + iv / self.a.speed
                getattr(self, "ch_" + ch)(now)
                if not self.connected:
                    return
        if self.a.junk and now - self.last_junk > 5.0:
            self.last_junk = now
            self.cli.write(b"this is not json\n")
            self.cli.write(b'{"type":"player","name":"raw\x1b[icon]esc"}\n')   # raw control char: invalid JSON
            self.cli.write(b'[1,2,3]\n')
        if self.a.hotkeys and now - self.last_hotkey > 3.0:
            self.last_hotkey = now
            acts = ["view_toggle", "zoom_in", "ship_next", "panel_next", "log_down", "zoom_out", "show_selected", "auto",
                    "view_map", "zoom_fit", "list_select", "details", "alert_next"]
            act = acts[self.hotkey_i % len(acts)]
            self.hotkey_i += 1
            obj = None
            if act == "show_selected":
                obj = next(iter(self.w.ships))
            self.send({"type": "hotkey", "action": act, "obj": obj, "t": round(now, 3)})


class ReplayBridge(Bridge):
    """--replay FILE: plays a live server snapshot (GET /api/state, read-only) back through the pipe as
    the bridge would send it - the same galaxy, gates, sector scans, property, player, theme... - so the
    browser checks run on real data shapes. No simulation: like a paused game, nothing moves; the
    player / scans are re-sent on their usual intervals (--replay-frozen: player only once)."""

    def __init__(self, snap: dict, cli: SnLikeClient, args):
        self.snap = snap
        self.cli = cli
        self.a = args
        self.connected = False
        self.last_hello = -1e9
        self.session = 0
        self.counts, self.nbytes, self.cmds, self.paused = {}, 0, 0, True
        self.due = {"player": 0.0, "sector": 0.0, "galaxy": 0.0, "slow": 0.0}
        self.gen = 0

    def strip(self, m: dict | None) -> dict | None:
        if not isinstance(m, dict):
            return None
        return {k: v for k, v in m.items() if k not in ("rx", "v", "src")}

    def full(self) -> None:
        s = self.snap
        self.gen += 1
        self.chunks("galaxy", s.get("galaxy") or [], {"gen": self.gen})
        self.chunks("gates", s.get("gates") or [], {"n": len(s.get("gates") or [])})
        for k in ("theme", "factions", "missions", "offers", "economy", "messages"):
            m = self.strip(s.get(k))
            if m:
                self.send(m)
        prop = s.get("property") or []
        self.chunks("property", prop, {"gen": self.gen})
        self.send({"type": "property_end", "gen": self.gen, "ids": [str(e.get("id")) for e in prop],
                   "ships": (s.get("property_meta") or {}).get("ships"), "stations": (s.get("property_meta") or {}).get("stations")})

    def scans(self) -> None:
        for sid, rec in (self.snap.get("sectors") or {}).items():
            self.gen += 1
            self.chunks("sector", rec.get("objs") or [], {"sid": sid, "gen": self.gen, "player": bool(rec.get("player")),
                                                          "n": rec.get("n"), "hidden": rec.get("hidden"), "skipped": rec.get("skipped") or 0,
                                                          "full": bool(rec.get("full"))})

    def tick(self, now: float) -> None:
        if not self.connected:
            if now - self.last_hello >= 2.0:
                self.last_hello = now
                self.session += 1
                h = dict((self.snap.get("hello") or {}), type="hello", session=self.session)
                h.pop("at", None)
                if self.send(h):
                    self.connected = True
                    self.full()
                    self.scans()
            return
        self.cli.read_all()                     # commands are not answered (a paused game)
        if now >= self.due["player"]:
            self.due["player"] = now + (1e9 if self.a.replay_frozen else 0.25)
            p = self.strip(self.snap.get("player"))
            if p:
                p["t"] = round(now, 3)
                self.send(p)
        if now >= self.due["sector"]:
            self.due["sector"] = now + (1e9 if self.a.replay_frozen else 1.0)
            self.scans()
        if now >= self.due["galaxy"]:
            self.due["galaxy"] = now + 60.0
            if self.gen > 2:
                self.full()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pipe", default="x4companion")
    ap.add_argument("--ships", type=int, default=300)
    ap.add_argument("--seconds", type=float, default=0, help="0 = run until Ctrl+C")
    ap.add_argument("--speed", type=float, default=1.0, help="channel rate multiplier")
    ap.add_argument("--mode", choices=["message", "byte"], default="message")
    ap.add_argument("--junk", action="store_true")
    ap.add_argument("--bad-bytes", action="store_true")
    ap.add_argument("--hotkeys", action="store_true")
    ap.add_argument("--allow-orders", action="store_true")
    ap.add_argument("--gc-on-exit", action="store_true")
    ap.add_argument("--pause-at", type=float, default=0)
    ap.add_argument("--pause-for", type=float, default=0)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--discover", action="store_true", help="fly into undiscovered sectors (sector-change / discovery scenario)")
    ap.add_argument("--galaxy-on-jump", action="store_true", help="send galaxy + sector at once on a sector change (bridge since M6)")
    ap.add_argument("--player-speed", type=float, default=2500.0)
    ap.add_argument("--guidance", choices=["route", "local", "position", "inside", "unknown", "off", "none"], default="route",
                    help="v1.3 mission guidance scenario of the active mission (bridge 'gd')")
    ap.add_argument("--replay", type=Path, default=None, help="play a live snapshot (GET /api/state JSON) back instead of simulating")
    ap.add_argument("--replay-frozen", action="store_true", help="replay: send player and scans only once (no new snapshots)")
    a = ap.parse_args()

    if a.replay:
        snap = json.loads(Path(a.replay).read_text(encoding="utf-8"))
        cli = SnLikeClient(a.pipe, a.mode)
        br = ReplayBridge(snap, cli, a)
        t0 = time.monotonic()
        try:
            while a.seconds <= 0 or time.monotonic() - t0 < a.seconds:
                br.tick(time.monotonic() - t0)
                time.sleep(1 / 60)
        except KeyboardInterrupt:
            pass
        cli.close()
        print(f"[sim] replay done: {json.dumps(br.counts)}", flush=True)
        return 0

    world = World(a.ships, a.seed, a.bad_bytes)
    world.discover = a.discover
    world.player_speed = a.player_speed
    cli = SnLikeClient(a.pipe, a.mode)
    br = Bridge(world, cli, a)
    t0 = time.monotonic()
    last = t0
    frame = 1 / 60
    try:
        while a.seconds <= 0 or time.monotonic() - t0 < a.seconds:
            now = time.monotonic()
            el = now - t0
            dt = now - last
            last = now
            if a.pause_at and a.pause_at <= el < a.pause_at + a.pause_for:
                if not br.paused:
                    br.paused = True
                    br.ch_player(el)          # the last message before X4 stops: paused:true
                    print("[sim] paused / focus lost: silence", flush=True)
                time.sleep(0.05)
                continue
            if br.paused:
                br.paused = False
                print("[sim] resumed", flush=True)
            world.step(dt)
            br.tick(el)
            time.sleep(max(0.0, frame - (time.monotonic() - now)))
    except KeyboardInterrupt:
        pass
    if a.gc_on_exit and cli.h is not None:
        cli.write(b"garbage_collected")
    cli.close()
    print(f"[sim] done: {cli.ok_writes} writes ok, {cli.failed} failed, {br.cmds} commands, "
          f"{br.nbytes} bytes, per type {json.dumps(br.counts)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
