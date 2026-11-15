"""Saved layouts (server.py LayoutStore / validate_layout): save, load, delete, default, and rejection of
malformed input. Pure unit test, no server process, writes only into a temporary folder.

    uv run --locked python tests\\test_layouts.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

results: list[tuple[bool, str]] = []


def check(ok, what):
    results.append((bool(ok), what))
    print(("PASS " if ok else "FAIL ") + what, flush=True)


def rejects(fn, what):
    try:
        fn()
    except server.LayoutError as e:
        check(True, f"rejects {what} ({e})")
        return
    except Exception as e:  # noqa: BLE001 - any other exception is a bug in the validator
        check(False, f"rejects {what}: wrong exception {type(e).__name__}: {e}")
        return
    check(False, f"rejects {what}: accepted")


TREE = {"t": "s", "id": "s1", "dir": "row", "size": 100, "kids": [
    {"t": "p", "id": "map", "size": 66.7},
    {"t": "s", "id": "s2", "dir": "col", "size": 33.3, "kids": [
        {"t": "p", "id": "objects", "size": 50, "collapsed": True}, {"t": "p", "id": "info", "size": 50}]},
]}
OPTS = {"objects": {"f": "ships", "q": ""}, "map": {"labels": "auto", "rotate": True, "ret": 8}, "logcat": "alerts"}


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        st = server.LayoutStore(d)
        check(st.doc == {"v": 1, "default": None, "items": {}}, "empty store without a file")

        doc = st.put("Harc 2 képernyő", {"tree": TREE, "opts": OPTS})
        check("Harc 2 képernyő" in doc["items"] and doc["items"]["Harc 2 képernyő"]["tree"] == TREE, "save (accented name, tree + options)")
        st.put("Only map", {"tree": {"t": "p", "id": "map", "size": 100}, "opts": {}})
        st.put("Nothing open", {"tree": None, "opts": {}})
        st.set_default("Only map")
        check((d / "layouts.json").is_file(), "written to <state>/layouts.json")

        st2 = server.LayoutStore(d)
        check(st2.doc["items"].keys() == {"Harc 2 képernyő", "Only map", "Nothing open"} and st2.doc["default"] == "Only map",
              "load: a new store reads the same layouts and default")
        check(st2.doc["items"]["Harc 2 képernyő"]["opts"] == OPTS, "load: options survive")

        st2.put("Only map", {"tree": TREE, "opts": {}})
        check(st2.doc["items"]["Only map"]["tree"] == TREE, "overwrite an existing layout")
        st2.delete("Only map")
        check("Only map" not in st2.doc["items"] and st2.doc["default"] is None, "delete (also clears it as default)")
        try:
            st2.delete("Only map")
            check(False, "delete of a missing layout raises KeyError")
        except KeyError:
            check(True, "delete of a missing layout raises KeyError")
        rejects(lambda: st2.set_default("nope"), "default = unknown layout")

        # malformed input
        bad_names = ["", "   ", "a" * 41, "../x", "x/y", "<script>", "a\nb", 5, None]
        for n in bad_names:
            rejects(lambda n=n: server.validate_layout(n, {"tree": None, "opts": {}}), f"name {n!r}")
        rejects(lambda: server.validate_layout("x", "not a dict"), "body that is not an object")
        rejects(lambda: server.validate_layout("x", {"tree": None, "opts": {}, "extra": 1}), "unknown body key")
        rejects(lambda: server.validate_layout("x", {"tree": {"t": "p", "id": "evil", "size": 100}}), "unknown module id")
        rejects(lambda: server.validate_layout("x", {"tree": {"t": "p", "id": "map", "size": 300}}), "size > 100")
        rejects(lambda: server.validate_layout("x", {"tree": {"t": "p", "id": "map", "size": True}}), "boolean size")
        rejects(lambda: server.validate_layout("x", {"tree": {"t": "s", "id": "s", "dir": "row", "size": 100, "kids": [
            {"t": "p", "id": "map", "size": 50}, {"t": "p", "id": "map", "size": 50}]}}), "duplicate module")
        rejects(lambda: server.validate_layout("x", {"tree": {"t": "s", "id": "s", "dir": "diagonal", "size": 100, "kids": [
            {"t": "p", "id": "map", "size": 100}]}}), "bad split direction")
        rejects(lambda: server.validate_layout("x", {"tree": {"t": "s", "id": "s", "dir": "row", "size": 100, "kids": []}}), "empty split")
        deep = {"t": "p", "id": "map", "size": 100}
        for i in range(12):
            deep = {"t": "s", "id": f"s{i}", "dir": "row", "size": 100, "kids": [deep]}
        rejects(lambda: server.validate_layout("x", {"tree": deep}), "too deep tree")
        rejects(lambda: server.validate_layout("x", {"tree": None, "opts": {"evil": {}}}), "unknown option group")
        rejects(lambda: server.validate_layout("x", {"tree": None, "opts": {"map": {"a": {"nested": 1}}}}), "nested option value")
        rejects(lambda: server.validate_layout("x", {"tree": None, "opts": {"map": {"q": "x" * 300}}}), "too long option text")
        rejects(lambda: server.validate_layout("x", {"tree": None, "opts": {g: {f"k{i}": "x" * 190 for i in range(40)} for g in ("map", "objects", "property")}}), "too large layout")
        rejects(lambda: server.validate_layout("x", {"tree": {"t": "p", "id": "map", "size": 100, "onclick": "x"}}), "unknown module field")

        # limits
        st3 = server.LayoutStore(d / "lim")
        for i in range(server.LAYOUT_MAX_ITEMS):
            st3.put(f"L{i}", {"tree": None, "opts": {}})
        rejects(lambda: st3.put("one too many", {"tree": None, "opts": {}}), f"more than {server.LAYOUT_MAX_ITEMS} layouts")
        st3.put("L0", {"tree": None, "opts": {}})
        check(True, "overwriting at the limit is still allowed")

        # damaged files never break the start
        (d / "bad").mkdir()
        (d / "bad" / "layouts.json").write_text("{not json", encoding="utf-8")
        st4 = server.LayoutStore(d / "bad")
        check(st4.doc["items"] == {} and (d / "bad" / "layouts.json.bad").is_file(), "corrupt file: empty start, file kept as .bad")
        (d / "mixed").mkdir()
        (d / "mixed" / "layouts.json").write_text(json.dumps({"v": 1, "default": "evil", "items": {
            "ok": {"tree": TREE, "opts": {}}, "evil": {"tree": {"t": "p", "id": "rm -rf", "size": 1}, "opts": {}}}}), encoding="utf-8")
        st5 = server.LayoutStore(d / "mixed")
        check(list(st5.doc["items"]) == ["ok"] and st5.doc["default"] is None, "an invalid stored layout is dropped, the valid ones kept")

    failed = [w for ok, w in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
