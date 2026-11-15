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

    # ---- real input events (what a user does), not JS-dispatched DOM events
    async def click(self, x: float, y: float, count: int = 1):
        await self.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
        for c in range(1, count + 1):
            await self.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": c})
            await self.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": c})

    async def drag(self, x0: float, y0: float, x1: float, y1: float, steps: int = 8):
        await self.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0, "y": y0})
        await self.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "clickCount": 1})
        for i in range(1, steps + 1):
            await self.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0 + (x1 - x0) * i / steps,
                                                         "y": y0 + (y1 - y0) * i / steps, "button": "left", "buttons": 1})
        await self.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x1, "y": y1, "button": "left", "clickCount": 1})

    async def wheel(self, x: float, y: float, dy: float):
        await self.call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": dy})

    async def key(self, key: str, code: str | None = None, vk: int | None = None, mods: int = 0):
        text = key if len(key) == 1 else ""
        code = code or (("Digit" + key) if key.isdigit() else ("Key" + key.upper()) if len(key) == 1 and key.isalpha() else key)
        vk = vk or (ord(key.upper()) if len(key) == 1 else 0)
        base = {"key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": mods}
        await self.call("Input.dispatchKeyEvent", {"type": "keyDown", "text": text if not mods else "", **base})
        await self.call("Input.dispatchKeyEvent", {"type": "keyUp", **base})

    async def center_of(self, js_element: str):
        """viewport centre of the element the JS expression returns (None if missing / invisible)"""
        return await self.eval(f"""(() => {{ const e = {js_element}; if (!e) return null; const r = e.getBoundingClientRect();
            if (!r.width || !r.height) return null; return [r.left + r.width / 2, r.top + r.height / 2]; }})()""")

    async def click_el(self, js_element: str, count: int = 1) -> bool:
        c = await self.center_of(js_element)
        if not c:
            return False
        await self.click(c[0], c[1], count)
        return True


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
        p.tid = info.get("id")
        await p.call("Page.enable")
        await p.call("Runtime.enable")
        await p.call("Emulation.setDeviceMetricsOverride", {"width": width or self.w, "height": height or self.h,
                                                           "deviceScaleFactor": 1, "mobile": False})
        return p

    async def close_page(self, p: Page) -> None:
        """close a tab opened with page() (long suites: dozens of live tabs exhaust the headless browser)"""
        try:
            await p.ws.close()
            if getattr(p, "tid", None):
                async with self.http.get(f"http://127.0.0.1:{self.port}/json/close/{p.tid}") as r:
                    await r.read()
        except (aiohttp.ClientError, RuntimeError):
            pass

    async def close_other_pages(self, keep: Page) -> None:
        """close every tab except `keep` (pages from page() other than it become unusable)"""
        try:
            async with self.http.get(f"http://127.0.0.1:{self.port}/json/list") as r:
                tabs = await r.json()
            for t in tabs:
                if t.get("type") == "page" and t.get("id") != getattr(keep, "tid", None):
                    async with self.http.get(f"http://127.0.0.1:{self.port}/json/close/{t['id']}") as r:
                        await r.read()
        except aiohttp.ClientError:
            pass

    async def __aexit__(self, *exc):
        if self.http:
            await self.http.close()
        if self.proc and self.proc.poll() is None:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)], capture_output=True)
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
            # the child processes hold the profile a moment longer; a browser started on the same profile
            # meanwhile would hand over to the dying one (single instance per profile) and lose its socket
            time.sleep(2.0)
        return False
