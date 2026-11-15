"""Minimal headless-Chromium (Brave/Chrome/Edge) driver over the DevTools protocol, for the map tests.

Starts its own browser process with its own profile under D:\\X4-backups\\work (never the user's
profile, never visible), talks CDP over a websocket (aiohttp), and kills only the process tree it
started. Used by tests/test_map_browser.py and for screenshots.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import aiohttp

CANDIDATES = [
    r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]
WORK = Path(os.environ.get("X4C_BROWSER_WORK", r"D:\X4-backups\work"))


def find_browser() -> str | None:
    for c in CANDIDATES:
        if Path(c).is_file():
            return c
    return None


class Page:
    def __init__(self, ws, session):
        self.ws = ws
        self.s = session
        self.n = 0
        self.events: list[dict] = []

    async def call(self, method: str, params: dict | None = None, timeout: float = 30):
        self.n += 1
        mid = self.n
        await self.ws.send_str(json.dumps({"id": mid, "method": method, "params": params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            m = await asyncio.wait_for(self.ws.receive(), timeout=max(0.1, end - time.time()))
            if m.type != aiohttp.WSMsgType.TEXT:
                raise RuntimeError(f"cdp socket closed: {m.type}")
            d = json.loads(m.data)
            if d.get("id") == mid:
                if "error" in d:
                    raise RuntimeError(f"{method}: {d['error']}")
                return d.get("result", {})
            self.events.append(d)
        raise TimeoutError(method)

    async def eval(self, expr: str, timeout: float = 30):
        r = await self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, timeout)
        if r.get("exceptionDetails"):
            raise RuntimeError("js: " + json.dumps(r["exceptionDetails"])[:800])
        return r.get("result", {}).get("value")

    async def wait_for(self, expr: str, timeout: float = 15, every: float = 0.2):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                last = await self.eval(expr)
                if last:
                    return last
            except RuntimeError:
                pass
            await asyncio.sleep(every)
        return last

    async def screenshot(self, path: str | Path):
        r = await self.call("Page.captureScreenshot", {"format": "png"})
        Path(path).write_bytes(base64.b64decode(r["data"]))

    async def goto(self, url: str):
        await self.call("Page.navigate", {"url": url})


class Browser:
    def __init__(self, width: int = 1600, height: int = 1000, port: int = 9333, profile: str = "headless-cdp"):
        self.exe = find_browser()
        self.w, self.h, self.port = width, height, port
        self.profile = WORK / profile
        self.proc: subprocess.Popen | None = None
        self.http: aiohttp.ClientSession | None = None

    async def __aenter__(self):
        if not self.exe:
            raise RuntimeError("no Chromium-based browser found")
        self.profile.mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen([self.exe, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                                      "--disable-extensions", "--mute-audio", f"--user-data-dir={self.profile}",
                                      f"--remote-debugging-port={self.port}", "--remote-allow-origins=*",
                                      "--allow-file-access-from-files", f"--window-size={self.w},{self.h}", "about:blank"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.http = aiohttp.ClientSession()
        for _ in range(100):
            try:
                async with self.http.get(f"http://127.0.0.1:{self.port}/json/version") as r:
                    if r.status == 200:
                        return self
            except aiohttp.ClientError:
                pass
            await asyncio.sleep(0.1)
        raise RuntimeError("browser did not open its debugging port")

    async def page(self, url: str = "about:blank", width: int | None = None, height: int | None = None) -> Page:
        async with self.http.put(f"http://127.0.0.1:{self.port}/json/new?{url}") as r:
            info = await r.json()
        ws = await self.http.ws_connect(info["webSocketDebuggerUrl"], max_msg_size=0)
        p = Page(ws, self.http)
        await p.call("Page.enable")
        await p.call("Runtime.enable")
        await p.call("Emulation.setDeviceMetricsOverride", {"width": width or self.w, "height": height or self.h,
                                                           "deviceScaleFactor": 1, "mobile": False})
        return p

    async def __aexit__(self, *exc):
        if self.http:
            await self.http.close()
        if self.proc and self.proc.poll() is None:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)], capture_output=True)
        return False
