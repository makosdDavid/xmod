"""X4 Companion local server (v1).

  game (x4_companion Lua) <--SN named pipe \\\\.\\pipe\\x4companion (duplex)--> this process
  this process <--HTTP / WebSocket on 127.0.0.1:8788--> browser dashboard (web-dist/ = ui/ build, else web/)

Game -> server: one JSON object per line, "type" = hello | player | theme | galaxy | gates | sector |
  property | property_end | logbook | ticker | messages | missions | offers | factions |
  economy | stats | hotkey | details | ack. Big lists arrive in parts (part/last) and are assembled here.
Server -> game: "cmd <seq> <name> [args]\\n" lines (allow-listed here AND in the mod).
Server -> browser: {"type":"init", ...whole state...} on connect, then typed updates. "staticmap" (also
  init.staticmap) = cluster layout positions {clusters:[{macro, sectors:[{macro,x,z}]}]} of clusters with
  at least one known sector only (for MapView.setStaticMap; no names/ids of undiscovered sectors).
Browser -> server: {"type":"control","enabled":bool} | {"type":"cmd","cmd":..,"args":[..],"id":n}
  | {"type":"watch","sid":".."} | {"type":"resync"}.

Binds 127.0.0.1 by default. Requests with a foreign Host header are refused (DNS rebinding), as are
WebSockets with a foreign Origin; commands additionally need an allowed Origin header and the
"vezérlés" switch of that browser tab.
LAN mode (--host 0.0.0.0, or {"host": "0.0.0.0"} in <state-dir>/server.json): an IP-literal Host is also
accepted (a rebinding attack needs a DNS name), so http://<lan-ip>:<port>/ works from other machines.
Peers that are not loopback are view-only: no game control (NEED_CONTROL commands, control switch) and
no saved-layout writes; those stay reserved to this PC (127.0.0.1).
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import ipaddress
import json
import logging
import logging.handlers
import re
import sys
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from pipe import PipeServer, PipeServerError

HOST = "127.0.0.1"              # default bind; LAN: --host 0.0.0.0 or <state-dir>/server.json {"host": ...}
ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"              # v1 shell (plain ES modules); also the source of the map module
DIST = ROOT / "web-dist"        # v2 shell: production build of ui/ (React + shadcn/ui), served when present
DATA = ROOT / "data"
LOGDIR = ROOT / "logs"
STATE = ROOT / "state"          # local, user-owned state (saved layouts); git-ignored
STALE_AFTER = 3.0
MAX_LOG = 3000
MAX_TICKER = 600

# commands the server forwards (the mod has its own allow-list on top: CFG.allow)
CMD_ARGS = {
    "openmap": 1, "select": 1, "target": 1, "guidance": 1, "guidance_end": 0,
    "stop": 1, "flyto": 2, "watch": 1, "resync": 0, "reenable": 0, "details": 1,
}
NEED_CONTROL = {"openmap", "select", "target", "guidance", "guidance_end", "stop", "flyto"}
ID_RE = re.compile(r"^\d{1,20}$")
STATIC_RE = re.compile(r"^[a-zA-Z0-9_\-]+\.(js|css|html|svg|png|ico|json)$")
ASSET_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,120}\.(js|css|svg|png|woff2|woff)$")
ICON_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,80}\.png$")
ICONS = DATA / "icons"          # exported locally by export_icons.py (game data, git-ignored)
CTYPES = {"js": "text/javascript", "css": "text/css", "html": "text/html", "svg": "image/svg+xml",
          "png": "image/png", "ico": "image/x-icon", "json": "application/json",
          "woff2": "font/woff2", "woff": "font/woff"}

# ------------------------------------------------------------------ saved layouts (v2 shell)
LAYOUT_PANELS = {"map", "objects", "info", "property", "log", "missions", "factions", "economy", "diag", "hotkeys"}
LAYOUT_OPT_KEYS = {"objects", "property", "map", "logcat"}
LAYOUT_NAME_RE = re.compile(r"^[\w \-.()]{1,40}$")
LAYOUT_MAX_ITEMS = 30
LAYOUT_MAX_BYTES = 16 * 1024     # one saved layout (tree + options), as JSON (a real one is ~2 KB)
LAYOUT_FILE_MAX = 512 * 1024     # the whole file


class LayoutError(ValueError):
    pass


def _check_tree(n, depth: int, seen: set) -> None:
    if not isinstance(n, dict):
        raise LayoutError("tree node is not an object")
    size = n.get("size")
    if isinstance(size, bool) or not isinstance(size, (int, float)) or not (0 <= size <= 100):
        raise LayoutError("bad size")
    if n.get("t") == "p":
        if n.get("id") not in LAYOUT_PANELS or n["id"] in seen:
            raise LayoutError("bad or duplicate module id")
        seen.add(n["id"])
        if "collapsed" in n and not isinstance(n["collapsed"], bool):
            raise LayoutError("bad collapsed flag")
        if set(n) - {"t", "id", "size", "collapsed"}:
            raise LayoutError("unknown module field")
        return
    if n.get("t") != "s" or depth > 8:
        raise LayoutError("bad node type or too deep")
    if not isinstance(n.get("id"), str) or not (1 <= len(n["id"]) <= 40) or n.get("dir") not in ("row", "col"):
        raise LayoutError("bad split")
    kids = n.get("kids")
    if not isinstance(kids, list) or not (1 <= len(kids) <= 12):
        raise LayoutError("bad split children")
    if set(n) - {"t", "id", "size", "dir", "kids"}:
        raise LayoutError("unknown split field")
    for k in kids:
        _check_tree(k, depth + 1, seen)


def _check_opts(o) -> None:
    if not isinstance(o, dict) or set(o) - LAYOUT_OPT_KEYS:
        raise LayoutError("bad options")
    for k, v in o.items():
        if k == "logcat":
            if not isinstance(v, str) or len(v) > 20:
                raise LayoutError("bad logbook category")
            continue
        if not isinstance(v, dict) or len(v) > 40:
            raise LayoutError("bad module options")
        for kk, vv in v.items():
            if not isinstance(kk, str) or len(kk) > 40:
                raise LayoutError("bad option key")
            if vv is not None and not isinstance(vv, (bool, int, float, str)):
                raise LayoutError("option values must be plain values")
            if isinstance(vv, str) and len(vv) > 200:
                raise LayoutError("option text too long")


def validate_layout(name, body) -> tuple[str, dict]:
    """-> (clean name, clean layout) or LayoutError."""
    if not isinstance(name, str) or not LAYOUT_NAME_RE.match(name.strip()) or not name.strip():
        raise LayoutError("bad name")
    if not isinstance(body, dict) or set(body) - {"tree", "opts"}:
        raise LayoutError("body must be {tree, opts}")
    if len(jdump(body).encode("utf-8")) > LAYOUT_MAX_BYTES:
        raise LayoutError("layout too large")
    tree = body.get("tree")
    if tree is not None:
        _check_tree(tree, 0, set())
    opts = body.get("opts") or {}
    _check_opts(opts)
    return name.strip(), {"tree": tree, "opts": opts, "saved": round(time.time())}


class LayoutStore:
    """Named user layouts in <state>/layouts.json (written atomically)."""

    def __init__(self, state_dir: Path) -> None:
        self.path = state_dir / "layouts.json"
        self.doc = {"v": 1, "default": None, "items": {}}
        self.load()

    def load(self) -> None:
        if not self.path.is_file():
            return
        try:
            if self.path.stat().st_size > LAYOUT_FILE_MAX:
                raise LayoutError("file too large")
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            items = {}
            for n, it in (raw.get("items") or {}).items():
                try:
                    cn, clean = validate_layout(n, {"tree": it.get("tree"), "opts": it.get("opts") or {}})
                    clean["saved"] = it.get("saved") if isinstance(it.get("saved"), (int, float)) else clean["saved"]
                    items[cn] = clean
                except (LayoutError, AttributeError) as e:
                    log.warning("saved layout %.40r dropped: %s", n, e)
            d = raw.get("default")
            self.doc = {"v": 1, "default": d if d in items else None, "items": dict(list(items.items())[:LAYOUT_MAX_ITEMS])}
        except (ValueError, OSError, AttributeError) as e:
            log.error("cannot read %s (%s) - starting with no saved layouts; the file is kept as .bad", self.path, e)
            try:
                self.path.replace(self.path.with_suffix(".json.bad"))
            except OSError:
                pass

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.doc, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    def put(self, name, body) -> dict:
        n, clean = validate_layout(name, body)
        if n not in self.doc["items"] and len(self.doc["items"]) >= LAYOUT_MAX_ITEMS:
            raise LayoutError(f"at most {LAYOUT_MAX_ITEMS} saved layouts")
        self.doc["items"][n] = clean
        self.save()
        return self.doc

    def delete(self, name) -> dict:
        if name not in self.doc["items"]:
            raise KeyError(name)
        del self.doc["items"][name]
        if self.doc["default"] == name:
            self.doc["default"] = None
        self.save()
        return self.doc

    def set_default(self, name) -> dict:
        if name is not None and name not in self.doc["items"]:
            raise LayoutError("no such layout")
        self.doc["default"] = name
        self.save()
        return self.doc

log = logging.getLogger("x4companion")


def jdump(o) -> str:
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)


class Assembler:
    """Collects part/last messages of one list type into a complete list."""

    def __init__(self) -> None:
        self.parts: dict[tuple, list] = {}

    def add(self, key: tuple, msg: dict):
        items = msg.get("items") or []
        if msg.get("part", 0) == 0:
            self.parts[key] = []
        buf = self.parts.setdefault(key, [])
        buf.extend(items)
        if msg.get("last", True):
            return self.parts.pop(key, [])
        return None


class Store:
    """Everything the game told us; all methods run on the asyncio loop."""

    def __init__(self, static_map: dict | None) -> None:
        self.static = static_map
        self.hello: dict | None = None
        self.latest: dict[str, dict] = {}         # player, theme, missions, offers, factions, economy, messages, stats
        self.galaxy: list | None = None
        self.galaxy_gen = None
        self.gates: list = []
        self.sectors: dict[str, dict] = {}       # sid -> {objs, n, hidden, at, player}
        self.property: dict[str, dict] = {}
        self.property_meta: dict = {}
        self.log: collections.deque = collections.deque(maxlen=MAX_LOG)
        self.log_keys: set = set()
        self.ticker: collections.deque = collections.deque(maxlen=MAX_TICKER)
        self.ticker_ids: set = set()
        self.asm = Assembler()
        self.prop_pending: dict[str, dict] = {}

    def hw_links(self) -> list[list[str]]:
        """Superhighway links from the static map export, filtered by what the player knows.

        The static export covers the whole galaxy (incl. undiscovered sectors), so it is never sent
        as such: a link is only revealed when both sector macros are in the live (known-only) galaxy
        and the game reported a known superhighway entry gate in one of the two sectors.
        """
        if not self.static or not self.galaxy:
            return []
        by_macro = {}
        for c in self.galaxy:
            for sec in c.get("sectors") or []:
                if sec.get("macro"):
                    by_macro[str(sec["macro"]).lower()] = str(sec["id"])
        hw_secs = {str(g.get("s")) for g in self.gates if g.get("hw")}
        out = []
        for a, b in self.static.get("highways") or []:
            ia, ib = by_macro.get(a), by_macro.get(b)
            if ia and ib and (ia in hw_secs or ib in hw_secs):
                out.append([ia, ib])
        return out

    def static_layout(self) -> dict:
        """Cluster layout for the map (MapView.setStaticMap): for every cluster with at least one KNOWN
        sector, all of that cluster's sectors as {macro, x, z} - positions only, so the map can place a
        known sector in its correct slot of the cluster hexagon. Nothing else about an undiscovered
        sector (no name, owner, id) leaves the server; clusters without a known sector are not sent."""
        if not self.static or not self.galaxy:
            return {"clusters": []}
        known = {str(c.get("macro") or "").lower() for c in self.galaxy if c.get("sectors")}
        out = []
        for c in self.static.get("clusters") or []:
            m = str(c.get("macro") or "").lower()
            if not m or m not in known:
                continue
            secs = [{"macro": str(s["macro"]).lower(), "x": float(s.get("x") or 0), "z": float(s.get("z") or 0)}
                    for s in c.get("sectors") or [] if isinstance(s, dict) and s.get("macro")]
            if secs:
                out.append({"macro": m, "sectors": secs})
        return {"clusters": out}

    def snapshot(self) -> dict:
        return {
            "type": "init",
            "staticmap": self.static_layout(),
            "hwlinks": self.hw_links(),
            "hello": self.hello,
            "galaxy": self.galaxy,
            "gates": self.gates,
            "sectors": self.sectors,
            "property": list(self.property.values()),
            "property_meta": self.property_meta,
            "log": list(self.log)[-800:],
            "ticker": list(self.ticker)[-200:],
            **{k: v for k, v in self.latest.items()},
        }

    def _log_key(self, e: dict) -> str:
        return f"{e.get('cat')}|{e.get('t')}|{e.get('ti')}|{e.get('tx')}"

    def apply(self, msg: dict) -> list[dict]:
        """Apply one game message; return browser updates to broadcast."""
        t = msg.get("type")
        out: list[dict] = []
        if t == "hello":
            self.hello = {k: msg.get(k) for k in ("mod", "ver", "session", "allow", "hotkeys", "loglib", "timer")}
            self.hello["at"] = time.time()
            out.append({"type": "hello", "hello": self.hello})
        elif t in ("player", "theme", "missions", "offers", "factions", "economy", "messages", "stats"):
            msg["rx"] = time.time()
            self.latest[t] = msg
            out.append(msg)
        elif t == "galaxy":
            items = self.asm.add(("galaxy", msg.get("gen")), msg)
            if items is not None:
                self.galaxy = items
                self.galaxy_gen = msg.get("gen")
                out.append({"type": "galaxy", "clusters": items})
                out.append({"type": "hwlinks", "links": self.hw_links()})
                out.append({"type": "staticmap", **self.static_layout()})
        elif t == "gates":
            items = self.asm.add(("gates",), msg)
            if items is not None:
                self.gates = items
                out.append({"type": "gates", "gates": items})
                out.append({"type": "hwlinks", "links": self.hw_links()})
        elif t == "sector":
            sid = str(msg.get("sid"))
            items = self.asm.add(("sector", sid, msg.get("gen")), msg)
            if items is not None:
                rec = {"sid": sid, "objs": items, "n": msg.get("n"), "hidden": msg.get("hidden"),
                       "skipped": msg.get("skipped"), "full": msg.get("full"), "player": msg.get("player"),
                       "at": time.time()}
                self.sectors[sid] = rec
                # keep at most the player sector + 3 others
                if len(self.sectors) > 4:
                    old = sorted((v["at"], k) for k, v in self.sectors.items())
                    for _, k in old[: len(self.sectors) - 4]:
                        self.sectors.pop(k, None)
                out.append({"type": "sector", **rec})
        elif t == "property":
            upd = {}
            for e in msg.get("items") or []:
                if isinstance(e, dict) and e.get("id"):
                    self.property[str(e["id"])] = e
                    upd[str(e["id"])] = e
            if upd:
                out.append({"type": "property", "upd": list(upd.values()), "del": []})
        elif t == "property_end":
            ids = {str(i) for i in (msg.get("ids") or [])}
            gone = [k for k in self.property if k not in ids]
            for k in gone:
                self.property.pop(k, None)
            self.property_meta = {"ships": msg.get("ships"), "stations": msg.get("stations"), "at": time.time()}
            out.append({"type": "property", "upd": [], "del": gone, "meta": self.property_meta})
        elif t == "logbook":
            new = []
            for e in msg.get("items") or []:
                if not isinstance(e, dict):
                    continue
                k = self._log_key(e)
                if k in self.log_keys:
                    continue
                if len(self.log) == self.log.maxlen:
                    self.log_keys.discard(self._log_key(self.log[0]))
                self.log.append(e)
                self.log_keys.add(k)
                new.append(e)
            if new:
                out.append({"type": "log", "items": new, "initial": bool(msg.get("initial"))})
        elif t == "ticker":
            new = []
            for e in msg.get("items") or []:
                if not isinstance(e, dict) or e.get("id") in self.ticker_ids:
                    continue
                if len(self.ticker) == self.ticker.maxlen:
                    self.ticker_ids.discard(self.ticker[0].get("id"))
                self.ticker.append(e)
                self.ticker_ids.add(e.get("id"))
                new.append(e)
            if new:
                out.append({"type": "ticker", "items": new})
        elif t in ("hotkey", "ack"):
            out.append(msg)
        return out


class Client:
    """One browser tab. Latest-only types are coalesced; event types are queued in order."""

    LATEST = {"player", "stats", "status", "galaxy", "gates", "hwlinks", "staticmap", "missions", "offers", "factions",
              "economy", "messages", "hello", "theme"}

    def __init__(self, ws: web.WebSocketResponse, origin_ok: bool, local: bool = True) -> None:
        self.ws = ws
        self.origin_ok = origin_ok
        self.local = local          # loopback peer (this PC); LAN peers are view-only
        self.control = False
        self.latest: dict[str, str] = {}
        self.sectors: dict[str, str] = {}
        self.queue: collections.deque[str] = collections.deque()
        self.prop_upd: dict[str, dict] = {}
        self.prop_del: set[str] = set()
        self.prop_meta = None
        self.event = asyncio.Event()
        self.cmd_times: collections.deque[float] = collections.deque(maxlen=10)

    def push(self, msg: dict) -> None:
        t = msg.get("type")
        if t in self.LATEST:
            self.latest[t] = jdump(msg)
        elif t == "sector":
            self.sectors[msg["sid"]] = jdump(msg)
        elif t == "property":
            for e in msg.get("upd", []):
                self.prop_upd[str(e["id"])] = e
                self.prop_del.discard(str(e["id"]))
            for k in msg.get("del", []):
                self.prop_upd.pop(k, None)
                self.prop_del.add(k)
            if msg.get("meta"):
                self.prop_meta = msg["meta"]
        else:
            self.queue.append(jdump(msg))
            while len(self.queue) > 500:
                self.queue.popleft()
        self.event.set()

    def push_raw(self, raw: str) -> None:
        self.queue.append(raw)
        self.event.set()

    async def run_sender(self) -> None:
        try:
            while not self.ws.closed:
                await self.event.wait()
                self.event.clear()
                while self.queue:
                    await self.ws.send_str(self.queue.popleft())
                if self.prop_upd or self.prop_del or self.prop_meta:
                    m = {"type": "property", "upd": list(self.prop_upd.values()), "del": list(self.prop_del)}
                    if self.prop_meta:
                        m["meta"] = self.prop_meta
                    self.prop_upd, self.prop_del, self.prop_meta = {}, set(), None
                    await self.ws.send_str(jdump(m))
                for d in (self.sectors, self.latest):
                    while d:
                        _, raw = d.popitem()
                        await self.ws.send_str(raw)
        except (ConnectionError, RuntimeError) as e:
            log.debug("websocket send stopped: %s", e)


class Hub:
    def __init__(self, static_map: dict | None) -> None:
        self.store = Store(static_map)
        self.clients: set[Client] = set()
        self.pipe: PipeServer | None = None
        self.pipe_clients: set[int] = set()
        self.connects = 0
        self.msgs = 0
        self.bad = 0
        self.last_rx: float | None = None
        self.rx_times: collections.deque[float] = collections.deque(maxlen=400)
        self.by_type: collections.Counter = collections.Counter()
        self.cmd_seq = 0
        self.cmd_owner: dict[int, Client] = {}
        self.watch: str | None = None
        self._last_bad_log = 0.0
        self.sector_key = None

    # ------------------------------------------------------------------ pipe side
    def on_pipe_status(self, event: str, cid: int) -> None:
        if event == "connected":
            self.pipe_clients.add(cid)
            self.connects += 1
            log.info("game pipe client #%d connected", cid)
        else:
            self.pipe_clients.discard(cid)
            log.info("game pipe client #%d %s", cid, event)
        self.broadcast_status()

    def on_pipe_line(self, line: str, cid: int) -> None:
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
                raise ValueError("not a typed object")
        except ValueError as e:
            self.bad += 1
            now = time.monotonic()
            if now - self._last_bad_log > 10:
                self._last_bad_log = now
                log.warning("ignored bad pipe message from #%d (%s): %.120r", cid, e, line)
            return
        now = time.monotonic()
        self.msgs += 1
        self.last_rx = now
        self.rx_times.append(now)
        t = msg["type"]
        self.by_type[t] += 1
        if t == "hello":
            log.info("bridge hello: %s v%s session %s, allowed: %s, hotkeys %s",
                     msg.get("mod"), msg.get("ver"), msg.get("session"), msg.get("allow"), msg.get("hotkeys"))
            if self.watch:
                self.send_game("watch", [self.watch])
        elif t == "player":
            sec = (msg.get("sector") or {})
            if sec.get("id") != self.sector_key:
                self.sector_key = sec.get("id")
                log.info("player sector: %s (id %s)", sec.get("name"), sec.get("id"))
        elif t == "details":
            # read-only info-panel data: only to the tab that asked
            owner = self.cmd_owner.get(int(msg.get("seq") or 0))
            if owner is not None:
                owner.push(msg)
            return
        elif t == "ack":
            owner = self.cmd_owner.pop(int(msg.get("seq") or 0), None)
            log.info("ack #%s %s ok=%s %s", msg.get("seq"), msg.get("cmd"), msg.get("ok"), msg.get("msg"))
            msg["mine"] = False
            if owner is not None:
                owner.push(dict(msg, mine=True))
            for c in list(self.clients):
                if c is not owner:
                    c.push(msg)
            return
        for upd in self.store.apply(msg):
            for c in list(self.clients):
                c.push(upd)

    # ------------------------------------------------------------------ commands
    def send_game(self, name: str, args: list[str], owner: Client | None = None) -> tuple[bool, str, int]:
        self.cmd_seq += 1
        seq = self.cmd_seq
        line = " ".join(["cmd", str(seq), name, *args]) + "\n"
        ok = self.pipe is not None and self.pipe.send(line.encode("ascii"))
        if ok and owner is not None:
            self.cmd_owner[seq] = owner
            if len(self.cmd_owner) > 200:
                self.cmd_owner.pop(next(iter(self.cmd_owner)))
        return ok, ("elküldve" if ok else "a játék nincs csatlakozva"), seq

    def handle_browser(self, c: Client, msg: dict) -> None:
        t = msg.get("type")
        if t == "control":
            c.control = bool(msg.get("enabled")) and c.origin_ok and c.local
            # origin_ok=False makes the UI grey out the switch; a LAN tab may never enable control
            c.push({"type": "control", "enabled": c.control, "origin_ok": c.origin_ok and c.local, "local": c.local})
            log.info("browser control %s", "ON" if c.control else "off")
            return
        if t == "watch":
            sid = str(msg.get("sid") or "0")
            if not ID_RE.match(sid):
                return
            self.watch = sid if sid != "0" else None
            self.send_game("watch", [sid])
            return
        if t == "resync":
            self.send_game("resync", [])
            return
        if t != "cmd":
            return
        name = str(msg.get("cmd") or "")
        args = [str(a) for a in (msg.get("args") or [])]
        cid = msg.get("id")

        def reply(ok, text, seq=None):
            c.push({"type": "cmdreply", "id": cid, "seq": seq, "cmd": name, "ok": ok, "msg": text})

        if name not in CMD_ARGS or len(args) != CMD_ARGS[name] or not all(ID_RE.match(a) for a in args):
            reply(False, "érvénytelen parancs")
            return
        if name in NEED_CONTROL:
            if not c.origin_ok:
                reply(False, "a parancsokhoz böngésző-Origin kell")
                return
            if not c.local:
                reply(False, "vezérlés csak erről a gépről (127.0.0.1)")
                return
            if not c.control:
                reply(False, "a vezérlés nincs engedélyezve ezen a lapon")
                return
        now = time.monotonic()
        c.cmd_times.append(now)
        if len(c.cmd_times) >= 10 and now - c.cmd_times[0] < 2.0:
            reply(False, "túl sok parancs, lassíts")
            return
        allow = (self.store.hello or {}).get("allow")
        if name in NEED_CONTROL and isinstance(allow, list) and name not in allow:
            reply(False, "a mod ezt a parancsot nem engedi (CFG.allow)")
            return
        ok, text, seq = self.send_game(name, args, owner=c)
        log.info("command #%d %s %s -> %s", seq, name, " ".join(args), text)
        reply(ok, text, seq)

    # ------------------------------------------------------------------ status
    def game_state(self) -> str:
        age = None if self.last_rx is None else time.monotonic() - self.last_rx
        player = self.store.latest.get("player") or {}
        if not self.pipe_clients:
            return "disconnected" if self.last_rx is None or age > STALE_AFTER else "live"
        if age is None:
            return "connected"
        if age < STALE_AFTER:
            return "paused" if player.get("paused") else "live"
        # pipe still open but silent: X4 lost focus (exclusive fullscreen) or a modal pause
        return "background"

    def status(self) -> dict:
        now = time.monotonic()
        age = None if self.last_rx is None else round(now - self.last_rx, 3)
        rate = 0.0
        recent = [t for t in self.rx_times if now - t < 5]
        if len(recent) >= 2 and recent[-1] > recent[0]:
            rate = round((len(recent) - 1) / (recent[-1] - recent[0]), 2)
        return {
            "type": "status",
            "game": self.game_state(),
            "pipe_connected": bool(self.pipe_clients),
            "pipe_clients": len(self.pipe_clients),
            "pipe_connects": self.connects,
            "last_rx_age": age,
            "rate_hz": rate,
            "msgs": self.msgs,
            "bad": self.bad,
            "by_type": dict(self.by_type),
            "ws_clients": len(self.clients),
            "watch": self.watch,
            "server_time": time.time(),
        }

    def broadcast_status(self) -> None:
        st = self.status()
        for c in list(self.clients):
            c.push(st)


# ------------------------------------------------------------------ HTTP
def pick_web_root(ui: str) -> Path:
    """auto: the v2 build (web-dist) when it exists, else the v1 shell (web)."""
    if ui == "legacy":
        return WEB
    if ui == "dist" or (DIST / "index.html").is_file():
        return DIST
    return WEB


def is_loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def peer_is_local(request: web.Request) -> bool:
    """True when the TCP peer is this PC via loopback (127.0.0.1 / ::1)."""
    try:
        ip = ipaddress.ip_address((request.remote or "").split("%", 1)[0])
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def make_app(hub: Hub, port: int, web_root: Path | None = None, layouts: LayoutStore | None = None,
             lan: bool = False) -> web.Application:
    root = web_root or pick_web_root("auto")
    layouts = layouts or LayoutStore(STATE)
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    allowed_origins = {f"http://{h}" for h in allowed_hosts}
    csp_base = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                f"connect-src 'self' ws://127.0.0.1:{port} ws://localhost:{port}")
    # Framing: the user's own cockpit pages (e.g. the X4Telemetry tablet/phone "map only" overlay on port 8080)
    # may embed the companion - any page served by this same PC, by loopback name or by the IP literal the
    # companion itself was reached with (Host is validated by host_ok before frame_ancestors uses it).
    loopback_frames = "'self' http://127.0.0.1:* http://localhost:*"
    csp = f"{csp_base}; frame-ancestors {loopback_frames}"

    def frame_ancestors(host: str) -> str:
        name = host.rpartition(":")[0]
        try:
            ipaddress.IPv4Address(name)
        except ValueError:
            return f"frame-ancestors {loopback_frames}"
        return f"frame-ancestors {loopback_frames} http://{name}:*"

    def host_ok(host: str) -> bool:
        if host in allowed_hosts:
            return True
        if not lan:
            return False
        # LAN mode: also http://<ip-literal>:<port>/ (an IP literal cannot be a DNS-rebinding name)
        name, sep, p = host.rpartition(":")
        if not sep or p != str(port):
            return False
        try:
            ipaddress.IPv4Address(name)
        except ValueError:
            return False
        return True

    def origin_ok(request: web.Request, origin: str | None) -> bool:
        # our loopback origins, or same-origin with the (already validated) Host of this request
        return origin is not None and (origin in allowed_origins or origin == f"http://{request.host}")

    @web.middleware
    async def guard(request: web.Request, handler):
        if not host_ok(request.host):
            return web.Response(status=403, text="forbidden host")
        resp = await handler(request)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        if request.host in allowed_hosts:
            resp.headers["Content-Security-Policy"] = csp
        else:
            resp.headers["Content-Security-Policy"] = f"{csp_base} ws://{request.host}; {frame_ancestors(request.host)}"
        return resp

    async def index(_r):
        return web.FileResponse(root / "index.html", headers={"Cache-Control": "no-cache", "Content-Type": "text/html"})

    async def static(request: web.Request):
        name = request.match_info["name"]
        if not STATIC_RE.match(name):
            raise web.HTTPNotFound()
        p = root / name
        if not p.is_file():
            raise web.HTTPNotFound()
        ext = name.rsplit(".", 1)[1]
        return web.FileResponse(p, headers={"Cache-Control": "no-cache", "Content-Type": CTYPES[ext]})

    async def asset(request: web.Request):
        # hashed build output of the v2 shell (web-dist/assets): immutable
        name = request.match_info["name"]
        if not ASSET_RE.match(name):
            raise web.HTTPNotFound()
        p = root / "assets" / name
        if not p.is_file():
            raise web.HTTPNotFound()
        ext = name.rsplit(".", 1)[1]
        return web.FileResponse(p, headers={"Cache-Control": "max-age=31536000, immutable", "Content-Type": CTYPES[ext]})

    # ---- saved layouts: GET is free; writes need no Origin (non-browser) or our own Origin,
    #      and only from this PC (a LAN peer can load layouts but not change the file)
    def write_guard(request: web.Request):
        if not peer_is_local(request):
            raise web.HTTPForbidden(text="layouts can only be changed from this PC")
        origin = request.headers.get("Origin")
        if origin is not None and not origin_ok(request, origin):
            raise web.HTTPForbidden(text="forbidden origin")

    async def read_json(request: web.Request):
        raw = await request.read()
        if len(raw) > LAYOUT_MAX_BYTES + 1024:
            raise web.HTTPRequestEntityTooLarge(max_size=LAYOUT_MAX_BYTES, actual_size=len(raw))
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise web.HTTPBadRequest(text="body is not JSON") from None

    async def layouts_get(_r):
        return web.json_response(layouts.doc, dumps=jdump, headers={"Cache-Control": "no-store"})

    async def layouts_put(request: web.Request):
        write_guard(request)
        body = await read_json(request)
        try:
            doc = layouts.put(request.match_info["name"], body)
        except LayoutError as e:
            raise web.HTTPBadRequest(text=str(e)) from None
        log.info("saved layout %r", request.match_info["name"])
        return web.json_response(doc, dumps=jdump)

    async def layouts_delete(request: web.Request):
        write_guard(request)
        try:
            doc = layouts.delete(request.match_info["name"])
        except KeyError:
            raise web.HTTPNotFound(text="no such layout") from None
        return web.json_response(doc, dumps=jdump)

    async def layouts_default(request: web.Request):
        write_guard(request)
        body = await read_json(request)
        if not isinstance(body, dict) or not (body.get("name") is None or isinstance(body.get("name"), str)):
            raise web.HTTPBadRequest(text="body must be {name: string|null}")
        try:
            doc = layouts.set_default(body.get("name"))
        except LayoutError as e:
            raise web.HTTPBadRequest(text=str(e)) from None
        return web.json_response(doc, dumps=jdump)

    async def icon(request: web.Request):
        name = request.match_info["name"]
        if not ICON_RE.match(name):
            raise web.HTTPNotFound()
        p = ICONS / name
        if not p.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(p, headers={"Cache-Control": "max-age=3600", "Content-Type": "image/png"})

    async def icon_index(_r):
        p = ICONS / "index.json"
        if not p.is_file():
            return web.json_response({"count": 0, "icons": {}, "missing_export": True})
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            return web.json_response({"count": 0, "icons": {}, "bad_export": True})
        return web.json_response({"count": d.get("count", 0), "size": d.get("size"), "icons": d.get("icons", {})})

    async def api_state(_r):
        snap = hub.store.snapshot()
        snap["status"] = hub.status()
        return web.json_response(snap, dumps=jdump)

    async def api_status(_r):
        return web.json_response(hub.status())

    async def ws_handler(request: web.Request):
        origin = request.headers.get("Origin")
        if origin is not None and not origin_ok(request, origin):
            return web.Response(status=403, text="forbidden origin")
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024)
        await ws.prepare(request)
        local = peer_is_local(request)
        client = Client(ws, origin_ok=origin_ok(request, origin), local=local)
        hub.clients.add(client)
        log.info("browser connected (%d open)%s", len(hub.clients), "" if local else f" from {request.remote} (view-only)")
        snap = hub.store.snapshot()
        snap["status"] = hub.status()
        client.push_raw(jdump(snap))
        sender = asyncio.create_task(client.run_sender())
        try:
            async for m in ws:
                if m.type == WSMsgType.TEXT:
                    try:
                        msg = json.loads(m.data)
                    except ValueError:
                        continue
                    if isinstance(msg, dict):
                        hub.handle_browser(client, msg)
                elif m.type == WSMsgType.ERROR:
                    break
        finally:
            hub.clients.discard(client)
            sender.cancel()
            log.info("browser disconnected (%d open)", len(hub.clients))
        return ws

    async def no_content(_r):
        return web.Response(status=204)

    app = web.Application(middlewares=[guard], client_max_size=64 * 1024)
    app.router.add_get("/", index)
    app.router.add_get("/index.html", index)
    app.router.add_get("/api/state", api_state)
    app.router.add_get("/api/status", api_status)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/favicon.ico", no_content)
    app.router.add_get("/icons/index.json", icon_index)
    app.router.add_get("/icons/{name}", icon)
    app.router.add_get("/api/layouts", layouts_get)
    app.router.add_put("/api/layouts-default", layouts_default)
    app.router.add_put("/api/layouts/{name}", layouts_put)
    app.router.add_delete("/api/layouts/{name}", layouts_delete)
    app.router.add_get("/assets/{name}", asset)
    app.router.add_get("/{name}", static)
    return app


async def status_ticker(hub: Hub) -> None:
    last = None
    while True:
        await asyncio.sleep(1.0)
        st = hub.game_state()
        if st != last:
            log.info("game state: %s", st)
            last = st
        hub.broadcast_status()


def load_static() -> dict | None:
    p = DATA / "static_map.json"
    if not p.exists():
        log.warning("no %s (run export_static.py) - no superhighway links on the galaxy map", p)
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError as e:
        log.error("bad %s: %s", p, e)
        return None


async def main_async(port: int, pipe_name: str, ui: str = "auto", state_dir: Path = STATE, host: str = HOST) -> None:
    lan = not is_loopback_host(host)
    loop = asyncio.get_running_loop()
    hub = Hub(load_static())
    if not (ICONS / "index.json").is_file():
        log.warning("no %s (run export_icons.py) - the map uses drawn fallback icons", ICONS / "index.json")
    pipe = PipeServer(
        pipe_name,
        on_message=lambda line, cid: loop.call_soon_threadsafe(hub.on_pipe_line, line, cid),
        on_status=lambda ev, cid: loop.call_soon_threadsafe(hub.on_pipe_status, ev, cid),
    )
    hub.pipe = pipe
    pipe.start()
    web_root = pick_web_root(ui)
    log.info("web UI: %s", web_root)
    runner = web.AppRunner(make_app(hub, port, web_root, LayoutStore(state_dir), lan=lan), access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    try:
        await site.start()
    except OSError:
        pipe.stop()
        raise
    if lan:
        log.info("dashboard: http://127.0.0.1:%d and http://<lan-ip>:%d  (bound to %s, LAN peers view-only, "
                 "pipe \\\\.\\pipe\\%s)", port, port, host, pipe_name)
    else:
        log.info("dashboard: http://%s:%d  (bound to %s only, pipe \\\\.\\pipe\\%s)", host, port, host, pipe_name)
    ticker = asyncio.create_task(status_ticker(hub))
    try:
        await asyncio.Event().wait()
    finally:
        ticker.cancel()
        pipe.stop()
        await runner.cleanup()
        log.info("server stopped")


def setup_logging(level: str, logfile: str) -> None:
    LOGDIR.mkdir(exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%H:%M:%S")
    root = logging.getLogger()
    root.setLevel(level)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    fh = logging.handlers.RotatingFileHandler(LOGDIR / logfile, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(sh)
    root.addHandler(fh)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)


def configured_host(state_dir: Path) -> str:
    """Bind host from <state-dir>/server.json {"host": "..."} (user-owned, git-ignored), else 127.0.0.1."""
    p = state_dir / "server.json"
    if p.is_file():
        try:
            h = json.loads(p.read_text(encoding="utf-8")).get("host")
        except (ValueError, AttributeError) as e:
            log.error("bad %s (%s) - binding %s", p, e, HOST)
            return HOST
        if isinstance(h, str) and h.strip():
            return h.strip()
    return HOST


def main() -> int:
    ap = argparse.ArgumentParser(description="X4 Companion local server (127.0.0.1 unless --host / server.json)")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--host", default=None,
                    help="bind address; default: <state-dir>/server.json 'host', else 127.0.0.1. "
                         "0.0.0.0 = LAN too (LAN peers are view-only)")
    ap.add_argument("--pipe", default="x4companion", help="pipe name (\\\\.\\pipe\\<name>)")
    ap.add_argument("--log-level", default="INFO")
    ap.add_argument("--log-file", default="x4companion.log")
    ap.add_argument("--ui", choices=["auto", "dist", "legacy"], default="auto",
                    help="auto: the v2 build (web-dist) if present, else the v1 shell (web); legacy: always web")
    ap.add_argument("--state-dir", default=str(STATE), help="folder for saved layouts (layouts.json)")
    a = ap.parse_args()
    setup_logging(a.log_level.upper(), a.log_file)
    try:
        host = a.host or configured_host(Path(a.state_dir))
        asyncio.run(main_async(a.port, a.pipe, a.ui, Path(a.state_dir), host))
    except PipeServerError as e:
        log.error("%s", e)
        return 2
    except OSError as e:
        log.error("cannot start: %s", e)
        return 2
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
