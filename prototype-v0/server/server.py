"""X4 WebMap local server.

  game (x4_webmap Lua) --SN named pipe \\\\.\\pipe\\x4webmap--> this process
  this process --HTTP / WebSocket on 127.0.0.1:8777--> browser (web/index.html)

Routes:  /            web/index.html
         /map.js      web/map.js
         /api/state   latest snapshot + link status (JSON)
         /ws          WebSocket: {"type":"snapshot",...} as they arrive, {"type":"status",...} 1/s

Binds 127.0.0.1 only (not configurable on purpose). Requests whose Host header is not
127.0.0.1/localhost:<port> are refused (DNS-rebinding guard), as are cross-origin WebSockets.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import logging.handlers
import sys
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from pipe import PipeServer, PipeServerError

HOST = "127.0.0.1"
ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
LOGDIR = ROOT / "logs"
STALE_AFTER = 3.0        # seconds without a snapshot -> "no data"

log = logging.getLogger("x4webmap")


class Hub:
    """Latest state + fan-out. All methods run on the asyncio loop."""

    def __init__(self) -> None:
        self.latest: dict | None = None
        self.latest_raw: str | None = None
        self.last_rx: float | None = None        # time.monotonic() of last good snapshot
        self.msgs = 0
        self.bad = 0
        self.connects = 0
        self.pipe_clients: set[int] = set()
        self.clients: set["Client"] = set()
        self.rx_times: list[float] = []
        self.sector_key = None
        self._last_bad_log = 0.0

    # -- pipe side ------------------------------------------------------------------
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
            if not isinstance(msg, dict) or msg.get("type") != "snapshot":
                raise ValueError("not a snapshot object")
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
        cutoff = now - 5
        while self.rx_times and self.rx_times[0] < cutoff:
            self.rx_times.pop(0)
        self.latest = msg
        self.latest_raw = json.dumps(msg, separators=(",", ":"), ensure_ascii=False)
        sector = msg.get("sector") or {}
        key = sector.get("id")
        if key != self.sector_key:
            self.sector_key = key
            log.info("sector: %s (id %s), %d own ships", sector.get("name"), key, len(msg.get("ships") or []))
        if self.msgs == 1:
            log.info("first snapshot received (src=%s)", msg.get("src"))
        for c in list(self.clients):
            c.push_snapshot(self.latest_raw)

    # -- status ---------------------------------------------------------------------
    def status(self) -> dict:
        now = time.monotonic()
        age = None if self.last_rx is None else round(now - self.last_rx, 3)
        rate = 0.0
        if len(self.rx_times) >= 2:
            span = self.rx_times[-1] - self.rx_times[0]
            if span > 0:
                rate = round((len(self.rx_times) - 1) / span, 2)
        return {
            "type": "status",
            "pipe_connected": bool(self.pipe_clients),
            "pipe_clients": len(self.pipe_clients),
            "pipe_connects": self.connects,
            "receiving": age is not None and age < STALE_AFTER,
            "last_rx_age": age,
            "rate_hz": rate,
            "msgs": self.msgs,
            "bad": self.bad,
            "ws_clients": len(self.clients),
        }

    def broadcast_status(self) -> None:
        raw = json.dumps(self.status(), separators=(",", ":"))
        for c in list(self.clients):
            c.push_status(raw)


class Client:
    """One browser. Keeps only the newest snapshot pending, so a slow tab never backs up."""

    def __init__(self, ws: web.WebSocketResponse) -> None:
        self.ws = ws
        self.snapshot: str | None = None
        self.status: str | None = None
        self.event = asyncio.Event()

    def push_snapshot(self, raw: str) -> None:
        self.snapshot = raw
        self.event.set()

    def push_status(self, raw: str) -> None:
        self.status = raw
        self.event.set()

    async def run_sender(self) -> None:
        try:
            while not self.ws.closed:
                await self.event.wait()
                self.event.clear()
                for attr in ("status", "snapshot"):
                    raw = getattr(self, attr)
                    if raw is not None:
                        setattr(self, attr, None)
                        await self.ws.send_str(raw)
        except (ConnectionError, RuntimeError) as e:   # tab closed mid-send
            log.debug("websocket send stopped: %s", e)


# -- HTTP -------------------------------------------------------------------------------
def make_app(hub: Hub, port: int) -> web.Application:
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    allowed_origins = {f"http://{h}" for h in allowed_hosts}

    @web.middleware
    async def guard(request: web.Request, handler):
        if request.host not in allowed_hosts:
            return web.Response(status=403, text="forbidden host")
        return await handler(request)

    async def index(_r):
        return web.FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})

    async def mapjs(_r):
        return web.FileResponse(WEB / "map.js", headers={"Cache-Control": "no-cache",
                                                         "Content-Type": "text/javascript"})

    async def api_state(_r):
        return web.json_response({"status": hub.status(), "snapshot": hub.latest})

    async def ws_handler(request: web.Request):
        origin = request.headers.get("Origin")
        if origin is not None and origin not in allowed_origins:
            return web.Response(status=403, text="forbidden origin")
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        client = Client(ws)
        hub.clients.add(client)
        log.info("browser connected (%d open)", len(hub.clients))
        client.push_status(json.dumps(hub.status(), separators=(",", ":")))
        if hub.latest_raw:
            client.push_snapshot(hub.latest_raw)
        sender = asyncio.create_task(client.run_sender())
        try:
            async for m in ws:                       # browser -> server: ignored for now
                if m.type == WSMsgType.ERROR:
                    break
        finally:
            hub.clients.discard(client)
            sender.cancel()
            log.info("browser disconnected (%d open)", len(hub.clients))
        return ws

    async def no_content(_r):
        return web.Response(status=204)

    app = web.Application(middlewares=[guard])
    app.router.add_get("/", index)
    app.router.add_get("/index.html", index)
    app.router.add_get("/map.js", mapjs)
    app.router.add_get("/api/state", api_state)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/favicon.ico", no_content)
    return app


async def status_ticker(hub: Hub) -> None:
    was_receiving = False
    while True:
        await asyncio.sleep(1.0)
        st = hub.status()
        if was_receiving and not st["receiving"]:
            log.warning("no snapshot for %.1f s (game paused in a menu, alt-tabbed, or gone?)",
                        st["last_rx_age"] or 0)
        was_receiving = st["receiving"]
        hub.broadcast_status()


async def main_async(port: int, pipe_name: str) -> None:
    loop = asyncio.get_running_loop()
    hub = Hub()
    pipe = PipeServer(
        pipe_name,
        on_message=lambda line, cid: loop.call_soon_threadsafe(hub.on_pipe_line, line, cid),
        on_status=lambda ev, cid: loop.call_soon_threadsafe(hub.on_pipe_status, ev, cid),
    )
    pipe.start()
    runner = web.AppRunner(make_app(hub, port), access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, HOST, port)
    await site.start()
    log.info("web UI: http://%s:%d  (bound to %s only)", HOST, port, HOST)
    ticker = asyncio.create_task(status_ticker(hub))
    try:
        await asyncio.Event().wait()
    finally:
        ticker.cancel()
        pipe.stop()
        await runner.cleanup()
        log.info("server stopped")


def setup_logging(level: str) -> None:
    LOGDIR.mkdir(exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%H:%M:%S")
    root = logging.getLogger()
    root.setLevel(level)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    fh = logging.handlers.RotatingFileHandler(LOGDIR / "x4webmap.log", maxBytes=1_000_000,
                                              backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(sh)
    root.addHandler(fh)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)


def main() -> int:
    ap = argparse.ArgumentParser(description="X4 WebMap local server (127.0.0.1 only)")
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--pipe", default="x4webmap", help="pipe name (\\\\.\\pipe\\<name>)")
    ap.add_argument("--log-level", default="INFO")
    a = ap.parse_args()
    setup_logging(a.log_level.upper())
    try:
        asyncio.run(main_async(a.port, a.pipe))
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
