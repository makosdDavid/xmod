"""Map icon exporter for X4 Companion (read-only on every source, writes only data\\icons\\).

The game map draws every object with an icon from libraries\\icons.xml (the bridge sends the id the
game itself reports: GetComponentData(obj, "icon"), vanilla menu_map.lua:20051; the map legend
menu_map.lua:1533-1637 lists the per-type icons). This script exports exactly those textures from
the user's OWN game installation, so the dashboard can draw the same icons:

  icon -> texture  libraries\\icons.xml of base game, DLCs (reference\\extensions\\ego_dlc_*) and enabled
                   mods (loose files or inside the mod's ext_*.cat), later sources override earlier
  texture bytes    <game>\\01.cat .. 09.cat + extensions\\ego_dlc_*\\ext_*.cat + enabled mods' ext_*.cat
                   and loose files. Catalog index (.cat) = text lines "path size timestamp md5", the
                   .dat is the concatenated data. Textures are stored as .gz (gzip-wrapped DDS) or .dds.
  decode           Pillow's DDS decoder (DXT1/3/5, BC4-7, uncompressed RGBA) -> RGBA PNG, 64 x 64

Exported: every icon named ship_*, mapob_*, maplegend_*, plus the order icons the map uses on order
lines (order_*). Output: data\\icons\\<name>.png and data\\icons\\index.json. Game data - the folder is
git-ignored and must never be committed or redistributed.

  uv run --with pillow==11.3.0 python export_icons.py [--game DIR] [--reference DIR] [--size 64]
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import sys
import time
from pathlib import Path

from lxml import etree

ROOT = Path(__file__).resolve().parent
DEFAULT_REF = ROOT.parent.parent / "reference"
DEFAULT_GAME = ROOT.parent.parent
OUT = ROOT / "data" / "icons"
PARSER = etree.XMLParser(recover=True, huge_tree=True, remove_comments=True)
PREFIXES = ("ship_", "mapob_", "maplegend_", "order_")


class Catalogs:
    """game path (lower case, forward slashes) -> (file, offset, size); later catalogs override."""

    def __init__(self) -> None:
        self.index: dict[str, tuple[Path, int, int]] = {}
        self.loose: dict[str, Path] = {}
        self.ncat = 0

    def add_cat(self, cat: Path, prefix: str = "") -> None:
        dat = cat.with_suffix(".dat")
        if not dat.exists():
            return
        self.ncat += 1
        off = 0
        with open(cat, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                parts = line.rstrip("\r\n").rsplit(" ", 3)
                if len(parts) != 4:
                    continue
                try:
                    size = int(parts[1])
                except ValueError:
                    continue
                key = parts[0].lower().replace("\\", "/")
                self.index[key] = (dat, off, size)
                if prefix:   # an extension's own files are also addressed as extensions\<id>\<path>
                    self.index[prefix + key] = (dat, off, size)
                off += size

    def add_loose(self, root: Path, sub: str, prefix: str = "") -> None:
        base = root / sub
        if not base.is_dir():
            return
        for p in base.rglob("*"):
            if p.is_file():
                rel = p.relative_to(root).as_posix().lower()
                for k in ((rel, prefix + rel) if prefix else (rel,)):
                    self.loose[k] = p
                    self.index.pop(k, None)

    def read(self, path: str) -> bytes | None:
        path = path.lower().replace("\\", "/")
        if path in self.loose:
            return self.loose[path].read_bytes()
        e = self.index.get(path)
        if e is None:
            return None
        dat, off, size = e
        with open(dat, "rb") as d:
            d.seek(off)
            return d.read(size)


def mod_enabled(moddir: Path) -> bool:
    cx = moddir / "content.xml"
    if not cx.exists():
        return False
    try:
        root = etree.fromstring(cx.read_bytes(), PARSER)
    except etree.XMLSyntaxError:
        return False
    return root is not None and str(root.get("enabled", "1")).lower() not in ("0", "false")


def ext_cats(d: Path) -> list[Path]:
    return sorted(p for p in [*d.glob("ext_*.cat"), *d.glob("subst_*.cat")] if not p.name.endswith("_sig.cat"))


def icon_defs(data: bytes, out: dict[str, str]) -> int:
    root = None
    try:
        root = etree.fromstring(data, PARSER)
    except etree.XMLSyntaxError:
        return 0
    n = 0
    if root is None:
        return 0
    for e in root.iter("icon"):
        name, tex = e.get("name"), e.get("texture")
        if name and tex and "*" not in name and name.startswith(PREFIXES):
            out[name] = tex
            n += 1
    return n


def candidates(tex: str) -> list[str]:
    t = tex.replace("\\", "/").lower()
    stem = t.rsplit(".", 1)[0] if "." in t.rsplit("/", 1)[-1] else t
    return [stem + ".gz", stem + ".dds", t]


def decode(raw: bytes, size: int):
    from PIL import Image
    data = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    im = Image.open(io.BytesIO(data))
    im.load()
    im = im.convert("RGBA")
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    return im


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--game", default=str(DEFAULT_GAME), help="X4 game folder (01.cat ..)")
    ap.add_argument("--reference", default=str(DEFAULT_REF), help="unpacked reference (libraries\\icons.xml)")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--size", type=int, default=64)
    a = ap.parse_args()
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Pillow missing: run with  uv run --with pillow==11.3.0 python export_icons.py", file=sys.stderr)
        return 2
    t0 = time.monotonic()
    game, ref, out = Path(a.game), Path(a.reference), Path(a.out)

    cats = Catalogs()
    for i in range(1, 10):
        c = game / f"{i:02d}.cat"
        if c.exists():
            cats.add_cat(c)
    if not cats.ncat:
        print(f"no game catalogs (01.cat ..) in {game}", file=sys.stderr)
        return 2
    defs: dict[str, str] = {}
    sources = []
    p = ref / "libraries" / "icons.xml"
    raw = p.read_bytes() if p.exists() else cats.read("libraries/icons.xml")
    if raw is None:
        print("libraries/icons.xml not found (reference or catalogs)", file=sys.stderr)
        return 2
    sources.append(("base", icon_defs(raw, defs)))
    ext = game / "extensions"
    dlcs = sorted(d for d in ext.glob("ego_dlc_*") if d.is_dir()) if ext.is_dir() else []
    mods = sorted(d for d in ext.iterdir() if d.is_dir() and not d.name.startswith("ego_dlc_") and mod_enabled(d)) if ext.is_dir() else []
    for d in dlcs + mods:
        local = Catalogs()
        pre = f"extensions/{d.name.lower()}/"
        for c in ext_cats(d):
            cats.add_cat(c, pre)
            local.add_cat(c)
        cats.add_loose(d, "assets/textures/ui", pre)
        local.add_loose(d, "libraries")
        rp = ref / "extensions" / d.name / "libraries" / "icons.xml"
        data = rp.read_bytes() if rp.exists() else local.read("libraries/icons.xml")
        if data:
            sources.append((d.name, icon_defs(data, defs)))

    out.mkdir(parents=True, exist_ok=True)
    index, failed, missing = {}, {}, []
    for name, tex in sorted(defs.items()):
        raw = None
        for c in candidates(tex):
            raw = cats.read(c)
            if raw is not None:
                break
        if raw is None:
            missing.append(name)
            continue
        try:
            im = decode(raw, a.size)
        except Exception as e:      # noqa: BLE001 - any undecodable texture is reported, not fatal
            failed[name] = f"{type(e).__name__}: {e}"
            continue
        im.save(out / f"{name}.png", optimize=True)
        index[name] = {"w": a.size, "h": a.size}
    meta = {"generated": time.strftime("%Y-%m-%d %H:%M:%S"), "size": a.size, "count": len(index),
            "sources": sources, "missing": missing, "failed": failed, "icons": index}
    (out / "index.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    dt = time.monotonic() - t0
    print(f"exported {len(index)} icons to {out} in {dt:.1f} s "
          f"({len(defs)} defined, {len(missing)} textures not found, {len(failed)} not decodable)")
    for n, why in list(failed.items())[:10]:
        print(f"  not decodable: {n}: {why}")
    return 0 if index else 1


if __name__ == "__main__":
    sys.exit(main())
