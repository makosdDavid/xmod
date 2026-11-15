"""Browser integration tests of the map module (python tests/test_map_browser.py).

Loads tests/map_harness.html (the real web/map.js with a fake store) in a headless Chromium-based
browser of this machine (own profile under D:\\X4-backups\\work, never visible, no server needed)
and reports the harness checks. Exit 0 = all passed, 2 = no browser found (skipped).
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from cdp import Browser, find_browser  # noqa: E402


async def main() -> int:
    if not find_browser():
        print("SKIP no Chromium-based browser found")
        return 2
    async with Browser(2000, 1200, port=9334, profile="headless-map-tests") as b:
        p = await b.page("about:blank")
        await p.goto((HERE / "map_harness.html").as_uri())
        res = await p.wait_for("window.__results", timeout=60)
        if not res:
            errs = [e for e in p.events if e.get("method") in ("Runtime.exceptionThrown", "Runtime.consoleAPICalled")]
            print("FAIL harness did not finish", errs[:5])
            return 1
    fails = 0
    for r in res:
        print(("PASS " if r["ok"] else "FAIL ") + r["what"])
        fails += 0 if r["ok"] else 1
    print(f"\n{len(res) - fails}/{len(res)} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
