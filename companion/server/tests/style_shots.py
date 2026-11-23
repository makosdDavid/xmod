"""Screenshots of the game-look shell for review (not a pass/fail gate).

  uv run --locked python tests/style_shots.py --dist DIR [--replay snapshot.json | --live] [--out DIR]

Starts its own server + simulator (or a frozen replay of a live snapshot) exactly like smoke_shell.py
(X4C_SMOKE_PORT, own state dir), drives a headless browser (own profile under D:\\X4-backups\\work) and
writes style_*.png: every layout preset at 1920x1040 and 1366x768, both languages, UI scale 80 / 125 %,
a narrow window, a narrow pop-out panel, the Layers popover, the command palette, menus and dialogs,
the focused list views. Stops only the processes it started.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import smoke_shell as sm  # noqa: E402
from cdp import Browser  # noqa: E402

EN = sm.EN
PREFIX = "style"
MAP = sm.MAP


async def shoot(p, out: Path, name: str):
    await asyncio.sleep(0.4)
    await p.screenshot(out / f"{PREFIX}_{name}.png")
    print("shot", name, flush=True)


async def main_async(out: Path) -> int:
    async with Browser(1920, 1040, port=9338, profile="headless-style-shots") as b:
        for w, h in ((1920, 1040), (1366, 768)):
            for preset in ("nav", "fleet", "combat", "all"):
                p = await sm.fresh(b, w=w, h=h)
                await p.eval(f"window.__x4ui.applyPreset({json.dumps(preset)}); true")
                await asyncio.sleep(1.6)
                if preset == "nav":   # a selected object: the selected-row look + details
                    await p.click_el("document.querySelector('section[data-panel=objects] [data-key]')")
                    await asyncio.sleep(0.8)
                await shoot(p, out, f"{preset}_{w}x{h}")
                await b.close_page(p)
        # languages and UI scale
        for lang, font in (("hu", 100), ("en", 80), ("en", 125), ("hu", 125)):
            p = await sm.fresh(b, lang=lang, font=font, w=1920, h=1040)
            await p.click_el("document.querySelector('section[data-panel=objects] [data-key]')")
            await asyncio.sleep(0.8)
            await shoot(p, out, f"nav_{lang}_scale{font}")
            await b.close_page(p)
        # narrow window (stacked modules) and a narrow pop-out panel
        p = await sm.fresh(b, w=1000, h=900)
        await shoot(p, out, "narrow_window_1000x900")
        await b.close_page(p)
        for panel in ("objects", "property", "log"):
            p = await b.page("about:blank", 420, 860)
            await p.goto(sm.BASE + f"/?panel={panel}")
            await asyncio.sleep(3.0)
            await shoot(p, out, f"narrow_popout_{panel}_420x860")
            await b.close_page(p)
        # Layers popover + legend
        p = await sm.fresh(b, w=1600, h=1000)
        await p.click_el(f"{MAP}.layersBtn"); await asyncio.sleep(0.6)
        await shoot(p, out, "layers_popover")
        await p.click_el(f"{MAP}.chips.legend"); await asyncio.sleep(0.6)
        await shoot(p, out, "layers_legend")
        await p.click_el(f"{MAP}.chips.legend"); await asyncio.sleep(0.3)
        await b.close_page(p)
        # command palette (Ctrl+K) with a query
        p = await sm.fresh(b, w=1600, h=1000)
        await p.click(5, 300)
        await p.key("k", mods=2); await asyncio.sleep(0.6)
        await p.call("Input.insertText", {"text": "a"}); await asyncio.sleep(0.8)
        await shoot(p, out, "command_palette")
        await b.close_page(p)
        # menus and dialogs
        p = await sm.fresh(b, w=1600, h=1000)
        await p.click_el(f"[...document.querySelectorAll('nav button')].find(e => e.textContent.trim() === {json.dumps(EN['nav']['layout'])})"); await asyncio.sleep(0.6)
        await shoot(p, out, "menu_layout")
        await p.click_el(f"[...document.querySelectorAll('[role=menuitem]')].find(e => e.textContent.includes({json.dumps(EN['saved']['save_as'])}))"); await asyncio.sleep(0.8)
        await p.call("Input.insertText", {"text": "My layout"}); await asyncio.sleep(0.3)
        await shoot(p, out, "dialog_save_layout")
        await p.key("Escape"); await asyncio.sleep(0.5)
        await p.click_el(f"[...document.querySelectorAll('button')].find(e => e.textContent.includes({json.dumps(EN['control']['button'])}))"); await asyncio.sleep(0.6)
        await shoot(p, out, "menu_game_commands")
        await p.click_el("document.querySelector('#ctl-switch')"); await asyncio.sleep(0.8)
        await shoot(p, out, "dialog_confirm_control")
        await p.key("Escape"); await asyncio.sleep(0.4)
        await p.key("Escape"); await asyncio.sleep(0.4)        # the menu behind the dialog
        # tooltip on a header button
        c = await p.center_of("document.querySelector('section[data-panel=objects] header button')")
        if c:
            await p.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": c[0], "y": c[1]}); await asyncio.sleep(1.0)
            await shoot(p, out, "tooltip")
        await b.close_page(p)
        # focused views (tables, section headers, filter toggles)
        for i, vid in ((3, "property"), (4, "log"), (5, "missions"), (6, "factions"), (7, "economy"), (8, "diag")):
            p = await sm.fresh(b, w=1600, h=1000)
            await p.click(5, 300); await p.key(str(i)); await asyncio.sleep(1.2)
            await shoot(p, out, f"view_{vid}")
            await b.close_page(p)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", type=Path, required=True)
    ap.add_argument("--replay", type=Path, default=None)
    ap.add_argument("--live", action="store_true", help="replay a GET /api/state snapshot of the live server on 8788 (read-only)")
    ap.add_argument("--prefix", default="style", help="file name prefix (style_*.png)")
    ap.add_argument("--out", type=Path, default=Path(os.environ.get("X4C_SHOTS") or r"D:\X4-backups\work\shots"))
    a = ap.parse_args()
    global PREFIX
    PREFIX = a.prefix
    a.out.mkdir(parents=True, exist_ok=True)
    if a.live:
        snap = urllib.request.urlopen("http://127.0.0.1:8788/api/state", timeout=10).read()
        a.replay = Path(tempfile.mkdtemp(prefix="x4c-shots-", dir=sm.TMPDIR)) / "live_state.json"
        a.replay.write_bytes(snap)
    state = tempfile.mkdtemp(prefix="x4c-shots-", dir=sm.TMPDIR)
    srv, sim = sm.start_world(a.dist.resolve(), state, a.replay)
    try:
        import time
        time.sleep(4)
        return asyncio.run(main_async(a.out))
    finally:
        sm.stop(sim)
        sm.stop(srv)


if __name__ == "__main__":
    sys.exit(main())
