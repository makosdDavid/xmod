// The 17 in-game hotkeys (Native Hotkey API, delivered over the websocket as {type:"hotkey", action})
// and the browser keyboard shortcuts. Ported from web/app.js onHotkey + keydown handler.
import { t } from "@/i18n";
import { alertEntries, markAllRead } from "./logbook";
import { activateList, activeList, moveList } from "./listnav";
import type { PanelId } from "./layout";
import { bus, S, select, toast, type Any } from "./store";
import { getUI, isMapView, setPalette, setView, togglePanel, VIEWS, viewStep, type ViewId } from "./ui";

// ids = x4_companion.lua HOTKEYS; the name is what the game shows in Hotkey Bindings (set by the mod)
export const HOTKEYS: [string, string][] = [
  ["panel_next", "Companion: következő nézet"], ["view_prev", "Companion: előző nézet"],
  ["view_map", "Companion: vissza a térképre"], ["view_toggle", "Companion: galaxis / szektor"],
  ["zoom_in", "Companion: nagyítás"], ["zoom_out", "Companion: kicsinyítés"],
  ["zoom_fit", "Companion: illesztés (minden látsszon)"], ["log_down", "Companion: lista lefelé"],
  ["log_up", "Companion: lista felfelé"], ["list_select", "Companion: kijelölés a listában"],
  ["details", "Companion: részletek nyit / zár"], ["alert_next", "Companion: következő riasztás"],
  ["ship_next", "Companion: következő saját hajó"], ["ship_prev", "Companion: előző saját hajó"],
  ["show_selected", "Companion: játékban kijelölt / célzott objektum"], ["auto", "Companion: vissza a hajómra (automata)"],
  ["ack_alerts", "Companion: riasztások nyugtázása"],
];

/** the Property list's current row order (set by the Property panel); own ships for ship_next/prev */
let propertyIds: string[] = [];
export function setPropertyOrder(ids: string[]) { propertyIds = ids; }
export function shipOrder(): string[] {
  const ids = propertyIds.length ? propertyIds : [...S.property.keys()];
  return ids.filter((id) => (S.property.get(id) || {}).k === "ship");
}

function focusedModule(): PanelId | null {
  const v = getUI().view;
  if (isMapView(v)) return null;
  return v as PanelId;
}
const list = () => activeList(focusedModule());

let alertIdx = -1;
export function onHotkey(m: Any) {
  if (!m.local) toast(t("toast.hotkey", { name: t("hk." + m.action) }), "info", 1600);
  bus.emit("hotkeyraw", m);
  const view = getUI().view;
  const onMap = isMapView(view);
  switch (m.action) {
    case "panel_next": viewStep(1); break;
    case "view_prev": viewStep(-1); break;
    case "view_map": setView("map"); break;
    case "view_toggle": if (!onMap) setView("map"); bus.emit("hotkey", m); break;
    case "zoom_in": case "zoom_out": case "zoom_fit": if (!onMap) setView("map"); bus.emit("hotkey", m); break;
    case "log_down": case "log_up": { const l = list(); if (l) moveList(l, m.action === "log_down" ? 1 : -1); break; }
    case "list_select": { const l = list(); if (l) activateList(l); break; }
    case "details": togglePanel("info"); if (!onMap) setView("map"); break;
    case "alert_next": {
      const al = alertEntries().filter((e) => e.ic);
      if (!al.length) { toast(t("toast.no_alert_obj"), "info", 1500); break; }
      alertIdx = (alertIdx + 1) % al.length;
      const e = al[al.length - 1 - alertIdx];
      setView("map");
      select({ kind: "obj", id: String(e.ic), from: "hotkey" });
      toast(t("toast.alert", { title: e.ti || "" }), "warn", 3000);
      break;
    }
    case "ack_alerts": markAllRead(); break;
    case "auto": select(null); setView("map"); bus.emit("auto"); break;
    case "show_selected":
      if (m.obj) { setView("map"); select({ kind: "obj", id: String(m.obj), from: "hotkey" }); }
      else toast(t("toast.no_ingame_sel"), "info", 1500);
      break;
    case "ship_next": case "ship_prev": {
      const ids = shipOrder();
      if (!ids.length) break;
      const cur = S.selected && S.selected.kind === "obj" ? ids.indexOf(S.selected.id) : -1;
      const d = m.action === "ship_next" ? 1 : -1;
      const i = cur < 0 ? (d > 0 ? 0 : ids.length - 1) : (cur + d + ids.length) % ids.length;
      if (!onMap && view !== "property") setView("map");
      select({ kind: "obj", id: ids[i], from: "hotkey" });
      break;
    }
    default: break;
  }
}

/** browser keyboard; `single` = pop-out window (no view switching) */
export function installKeyboard(single: PanelId | null) {
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault(); setPalette(!getUI().paletteOpen); return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const tg = e.target as HTMLElement | null;
    if (tg && (tg.tagName === "INPUT" || tg.tagName === "SELECT" || tg.tagName === "TEXTAREA" || tg.isContentEditable)) {
      if (e.key === "Escape") tg.blur();
      return;
    }
    // inside an open dialog / menu, Radix handles the keys
    if (tg && tg.closest && tg.closest("[role=dialog],[role=menu],[role=listbox],[role=alertdialog]")) return;
    const v = VIEWS.find((x) => x.key === e.key);
    if (v && !single) { e.preventDefault(); setView(v.id as ViewId); return; }
    const view = getUI().view;
    switch (e.key) {
      case "Escape":
        if (!single && !isMapView(view)) setView("map");
        else if (S.selected) select(null);
        else bus.emit("auto");
        break;
      case "+": case "=": case "Add": bus.emit("hotkey", { action: "zoom_in" }); break;
      case "-": case "_": case "Subtract": bus.emit("hotkey", { action: "zoom_out" }); break;
      case "0": bus.emit("hotkey", { action: "zoom_fit" }); break;
      case "g": bus.emit("hotkey", { action: "view_toggle" }); break;
      case "a": bus.emit("auto"); break;
      case "n": onHotkey({ action: "ship_next", local: true }); break;
      case "N": onHotkey({ action: "ship_prev", local: true }); break;
      case "ArrowDown": { const l = list(); if (l) { e.preventDefault(); moveList(l, 1); } break; }
      case "ArrowUp": { const l = list(); if (l) { e.preventDefault(); moveList(l, -1); } break; }
      case "Enter": { const l = list(); if (l) { e.preventDefault(); activateList(l); } break; }
      case "/": {
        e.preventDefault();
        if (!single) setView("property");
        setTimeout(() => { const s = document.querySelector<HTMLInputElement>('[data-panel="property"] input[type=search]'); if (s) s.focus(); }, 30);
        break;
      }
      case "?": if (!single) setView("hotkeys"); break;
      default: break;
    }
  };
  window.addEventListener("keydown", onKey);
  const off = bus.on("ingamehotkey", onHotkey);
  return () => { window.removeEventListener("keydown", onKey); off(); };
}
