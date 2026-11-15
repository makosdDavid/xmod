"""Static galaxy exporter for X4 Companion (read-only on every source).

The live bridge reads clusters/sectors through the game's Lua API (GetClusters/GetSectors +
GetPositionalOffset), but two things are not exposed there: superhighway connections and a
gate list that does not depend on the optional MD gate enumeration. This script builds them
from the *effective* map files:

  base    <reference>\\maps\\xu_ep2_universe\\{galaxy,clusters}.xml
  DLC     <reference>\\extensions\\ego_dlc_*\\maps\\xu_ep2_universe\\*.xml (diffs and full files)
  mods    <game>\\extensions\\<mod>\\maps\\xu_ep2_universe\\*.xml  (loose files) and the same paths
          inside the mod's ext_*.cat (read only, nothing is unpacked to disk); disabled mods
          (content.xml enabled="0"/"false") are skipped
  names   libraries\\mapdefaults.xml identification name="{page,id}" + t\\0001-l044.xml / 0001.xml
  owners  libraries\\god.xml stations (majority owner per sector) - only used by the simulator

Element-level parsing (not diff application): every <connection> that appears anywhere in a
file is taken, so <diff><add sel=...> wrappers from DLCs/mods are handled the same way as full
files. Output: data\\static_map.json (sector macros are the join key with the live data).

  uv run python export_static.py [--reference DIR] [--game DIR] [--out FILE]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from lxml import etree

ROOT = Path(__file__).resolve().parent
DEFAULT_REF = ROOT.parent.parent / "reference"
DEFAULT_GAME = ROOT.parent.parent
PARSER = etree.XMLParser(recover=True, huge_tree=True, remove_comments=True)


# ---------------------------------------------------------------- sources
class Source:
    """A readable set of game-path files (directory or .cat/.dat pair)."""

    def __init__(self, label: str, root: Path | None = None, cats: list[Path] | None = None):
        self.label = label
        self.root = root
        self.index: dict[str, tuple[Path, int, int]] = {}
        for cat in cats or []:
            self._index_cat(cat)

    def _index_cat(self, cat: Path) -> None:
        dat = cat.with_suffix(".dat")
        if not dat.exists():
            return
        off = 0
        with open(cat, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                parts = line.rstrip("\n").rsplit(" ", 3)
                if len(parts) != 4:
                    continue
                name, size = parts[0], int(parts[1])
                self.index[name.lower()] = (dat, off, size)
                off += size

    def files(self, prefix: str) -> list[tuple[str, bytes]]:
        out = []
        prefix = prefix.lower()
        if self.root is not None:
            base = self.root / Path(prefix)
            if base.is_dir():
                for p in sorted(base.glob("*.xml")):
                    out.append((f"{self.label}:{p.relative_to(self.root)}", p.read_bytes()))
            elif base.with_suffix(".xml").is_file():
                p = base.with_suffix(".xml")
                out.append((f"{self.label}:{p.relative_to(self.root)}", p.read_bytes()))
        for name, (dat, off, size) in sorted(self.index.items()):
            if name.startswith(prefix) and name.endswith(".xml"):
                with open(dat, "rb") as d:
                    d.seek(off)
                    out.append((f"{self.label}:{name}", d.read(size)))
        return out


def mod_enabled(moddir: Path) -> bool:
    cx = moddir / "content.xml"
    if not cx.exists():
        return False
    try:
        root = etree.fromstring(cx.read_bytes(), PARSER)
    except etree.XMLSyntaxError:
        return False
    if root is None:
        return False
    return str(root.get("enabled", "1")).lower() not in ("0", "false")


def collect_sources(ref: Path, game: Path) -> list[Source]:
    srcs = [Source("base", ref)]
    for dlc in sorted((ref / "extensions").glob("ego_dlc_*")):
        srcs.append(Source(dlc.name, dlc))
    ext = game / "extensions"
    if ext.is_dir():
        for mod in sorted(ext.iterdir()):
            if not mod.is_dir() or mod.name.startswith("ego_dlc_") or not mod_enabled(mod):
                continue
            cats = sorted(p for p in mod.glob("ext_*.cat") if not p.name.endswith("_sig.cat"))
            s = Source("mod:" + mod.name, mod, cats)
            srcs.append(s)
    return srcs


def parse(data: bytes):
    try:
        return etree.fromstring(data, PARSER)
    except etree.XMLSyntaxError:
        return None


# ---------------------------------------------------------------- text
class Texts:
    def __init__(self) -> None:
        self.pages: dict[int, dict[int, str]] = defaultdict(dict)

    def load(self, data: bytes) -> None:
        root = parse(data)
        if root is None:
            return
        for page in root.iter("page"):
            try:
                pid = int(page.get("id"))
            except (TypeError, ValueError):
                continue
            for t in page.iter("t"):
                try:
                    tid = int(t.get("id"))
                except (TypeError, ValueError):
                    continue
                self.pages[pid][tid] = t.text or ""

    def resolve(self, s: str | None, depth: int = 0) -> str | None:
        if s is None:
            return None
        if depth > 6:
            return s

        def sub(m):
            p, i = int(m.group(1)), int(m.group(2))
            v = self.pages.get(p, {}).get(i)
            return self.resolve(v, depth + 1) if v is not None else m.group(0)

        s = re.sub(r"\{(\d+),\s*(\d+)\}", sub, s)
        s = re.sub(r"(?<!\\)\([^)]*\)", "", s)        # X4 strips unescaped (comments)
        return s.replace("\\(", "(").replace("\\)", ")").strip()


# ---------------------------------------------------------------- map
def pos_of(conn) -> tuple[float, float]:
    p = conn.find("offset/position")
    if p is None:
        return 0.0, 0.0
    return float(p.get("x", 0) or 0), float(p.get("z", 0) or 0)


def export(ref: Path, game: Path) -> dict:
    srcs = collect_sources(ref, game)
    texts = Texts()
    for s in srcs:
        for name, data in s.files("t/0001-l044") + s.files("t/0001"):
            texts.load(data)

    galaxy_clusters: dict[str, dict] = {}      # cluster connection name -> {macro, x, z, src}
    gate_paths: list[tuple[str, str, str]] = []
    cluster_sectors: dict[str, dict[str, dict]] = defaultdict(dict)   # cluster macro -> conn -> sector
    highways: list[tuple[str, str, str, str]] = []
    used = []

    for s in srcs:
        files = s.files("maps/xu_ep2_universe")
        if files:
            used.append(s.label)
        for name, data in files:
            root = parse(data)
            if root is None:
                continue
            base = os.path.basename(name.split(":", 1)[1]).lower()
            is_galaxy = base.endswith("galaxy.xml")
            for conn in root.iter("connection"):
                ref_ = conn.get("ref")
                if is_galaxy and ref_ == "clusters":
                    m = conn.find("macro")
                    if m is not None and m.get("ref"):
                        x, z = pos_of(conn)
                        galaxy_clusters[conn.get("name")] = {"macro": m.get("ref"), "x": x, "z": z, "src": s.label}
                elif is_galaxy and ref_ == "destination":
                    m = conn.find("macro")
                    if conn.get("path") and m is not None and m.get("path"):
                        gate_paths.append((conn.get("path"), m.get("path"), s.label))
            # cluster macros: sectors and superhighways
            for macro in root.iter("macro"):
                if macro.get("class") != "cluster" or not macro.get("name"):
                    continue
                cname = macro.get("name")
                for conn in macro.iter("connection"):
                    if conn.get("ref") == "sectors":
                        m = conn.find("macro")
                        if m is not None and m.get("ref"):
                            x, z = pos_of(conn)
                            cluster_sectors[cname][conn.get("name")] = {"macro": m.get("ref"), "x": x, "z": z}
                    elif conn.get("ref") == "sechighways":
                        ends = {}
                        for sub in conn.iter("connection"):
                            if sub.get("ref") in ("entrypoint", "exitpoint"):
                                mm = sub.find("macro")
                                if mm is not None and mm.get("path"):
                                    ends[sub.get("ref")] = mm.get("path")
                        if len(ends) == 2:
                            highways.append((cname, ends["entrypoint"], ends["exitpoint"], s.label))
            # DLC/mod diffs adding sectors to an existing cluster: <add sel="//macro[@name='X']/connections">
            for add in root.iter("add"):
                sel = add.get("sel") or ""
                mm = re.search(r"macro\[@name='([^']+)'\]", sel)
                if not mm:
                    continue
                cname = mm.group(1)
                for conn in add.iter("connection"):
                    if conn.get("ref") == "sectors":
                        m = conn.find("macro")
                        if m is not None and m.get("ref"):
                            x, z = pos_of(conn)
                            cluster_sectors[cname][conn.get("name")] = {"macro": m.get("ref"), "x": x, "z": z}

    # names (mapdefaults) and owners (god.xml)
    ident: dict[str, str] = {}
    for s in srcs:
        for name, data in s.files("libraries/mapdefaults"):
            root = parse(data)
            if root is None:
                continue
            for ds in root.iter("dataset"):
                idn = ds.find("properties/identification")
                if ds.get("macro") and idn is not None and idn.get("name"):
                    ident[ds.get("macro").lower()] = idn.get("name")
    owners: dict[str, Counter] = defaultdict(Counter)
    for s in srcs:
        for name, data in s.files("libraries/god"):
            root = parse(data)
            if root is None:
                continue
            for st in root.iter("station"):
                owner = st.get("owner")
                loc = st.find("location")
                if owner and loc is not None and loc.get("class") == "sector" and loc.get("macro"):
                    owners[loc.get("macro").lower()][owner] += 1

    conn_to_cluster = {k: v["macro"] for k, v in galaxy_clusters.items()}

    def sector_from_galaxy_path(path: str) -> str | None:
        parts = [p for p in path.split("/") if p and p != ".."]
        if len(parts) < 2:
            return None
        cmacro = conn_to_cluster.get(parts[0])
        if not cmacro:
            return None
        sec = cluster_sectors.get(cmacro, {}).get(parts[1])
        return sec["macro"] if sec else None

    gates = set()
    for a, b, _ in gate_paths:
        sa, sb = sector_from_galaxy_path(a), sector_from_galaxy_path(b)
        if sa and sb and sa.lower() != sb.lower():
            gates.add(tuple(sorted((sa.lower(), sb.lower()))))
    hw = set()
    for cname, pa, pb, _ in highways:
        def sec_of(path):
            parts = [p for p in path.split("/") if p and p != ".."]
            if not parts:
                return None
            sec = cluster_sectors.get(cname, {}).get(parts[0])
            return sec["macro"] if sec else None
        sa, sb = sec_of(pa), sec_of(pb)
        if sa and sb and sa.lower() != sb.lower():
            hw.add(tuple(sorted((sa.lower(), sb.lower()))))

    clusters = []
    for cconn, c in sorted(galaxy_clusters.items(), key=lambda kv: kv[1]["macro"].lower()):
        secs = []
        for sconn, sdat in sorted(cluster_sectors.get(c["macro"], {}).items()):
            m = sdat["macro"]
            own = owners.get(m.lower())
            secs.append({"macro": m.lower(), "name": texts.resolve(ident.get(m.lower())) or m,
                         "x": sdat["x"], "z": sdat["z"],
                         "owner": own.most_common(1)[0][0] if own else None})
        if not secs:
            continue
        clusters.append({"macro": c["macro"].lower(), "x": c["x"], "z": c["z"], "src": c["src"],
                         "name": texts.resolve(ident.get(c["macro"].lower())) or c["macro"],
                         "sectors": secs})
    return {
        "generated_by": "export_static.py",
        "sources": used,
        "clusters": clusters,
        "gates": sorted(list(g) for g in gates),
        "highways": sorted(list(h) for h in hw),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--reference", type=Path, default=DEFAULT_REF)
    ap.add_argument("--game", type=Path, default=DEFAULT_GAME, help="game root (for extensions\\)")
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "static_map.json")
    a = ap.parse_args()
    if not (a.reference / "maps" / "xu_ep2_universe" / "galaxy.xml").exists():
        print(f"reference not found: {a.reference}", file=sys.stderr)
        return 2
    data = export(a.reference, a.game)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(data, ensure_ascii=False, indent=0), encoding="utf-8")
    ns = sum(len(c["sectors"]) for c in data["clusters"])
    print(f"{len(data['clusters'])} clusters, {ns} sectors, {len(data['gates'])} gate links, "
          f"{len(data['highways'])} highway links from {len(data['sources'])} sources -> {a.out}")
    print("sources:", ", ".join(data["sources"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
