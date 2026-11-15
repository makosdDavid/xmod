// Keyboard / in-game-hotkey list navigation ("lista fel/le + kijelölés"), like the old ListNav:
// every list panel registers its visible row keys; ↑/↓ (or the hotkeys) move a cursor, Enter (or
// "list_select") activates the row. The active list is the focused view's list, else the last list
// the user touched, else the first visible one of objects / property / log / missions.
import { useEffect, useRef, useState } from "react";
import { bus } from "./store";
import type { PanelId } from "./layout";

interface Entry { keys: string[]; activate: (key: string) => void; container: () => HTMLElement | null; visible: () => boolean }
const LISTS = new Map<PanelId, Entry>();
const cursor = new Map<PanelId, string | null>();
let lastList: PanelId = "objects";

export function touchList(id: PanelId) { if (LISTS.has(id)) lastList = id; }

export function activeList(focusedView: PanelId | null): PanelId | null {
  if (focusedView && LISTS.has(focusedView) && LISTS.get(focusedView)!.visible()) return focusedView;
  if (LISTS.has(lastList) && LISTS.get(lastList)!.visible()) return lastList;
  for (const id of ["objects", "property", "log", "missions"] as PanelId[]) if (LISTS.has(id) && LISTS.get(id)!.visible()) return id;
  return null;
}

function scrollTo(id: PanelId, key: string) {
  const c = LISTS.get(id)?.container();
  if (!c) return;
  const row = c.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

export function moveList(id: PanelId, d: number) {
  const e = LISTS.get(id);
  if (!e || !e.keys.length) return;
  const cur = cursor.get(id) ?? null;
  let i = cur === null ? -1 : e.keys.indexOf(cur);
  i = i < 0 ? (d > 0 ? 0 : e.keys.length - 1) : Math.max(0, Math.min(e.keys.length - 1, i + d));
  cursor.set(id, e.keys[i]);
  bus.emit("listnav", id);
  scrollTo(id, e.keys[i]);
}
export function activateList(id: PanelId) {
  const e = LISTS.get(id);
  if (!e) return;
  const cur = cursor.get(id) ?? null;
  if (cur && e.keys.includes(cur)) e.activate(cur);
  else moveList(id, 1);
}

/** register a list; returns the current cursor key (re-renders when it moves) */
export function useListNav(id: PanelId, keys: string[], activate: (key: string) => void,
                           containerRef: React.RefObject<HTMLElement | null>): string | null {
  const [cur, setCur] = useState<string | null>(cursor.get(id) ?? null);
  const act = useRef(activate);
  act.current = activate;
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useEffect(() => {
    const entry: Entry = {
      get keys() { return keysRef.current; },
      activate: (k) => act.current(k),
      container: () => containerRef.current,
      visible: () => !!containerRef.current && containerRef.current.isConnected && containerRef.current.offsetParent !== null,
    };
    LISTS.set(id, entry);
    const off = bus.on("listnav", (lid: PanelId) => { if (lid === id) setCur(cursor.get(id) ?? null); });
    return () => { off(); if (LISTS.get(id) === entry) LISTS.delete(id); };
  }, [id, containerRef]);
  return cur;
}
