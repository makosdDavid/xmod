// Hosts the framework-free map (web/map.js, API: web/MAP-API.md) for React.
// One MapView per window, created on first use and kept alive: it mounts into a persistent container
// element, its title goes into a persistent title element and its Sector/Galaxy switch + follow
// selector into a persistent tools element. The React map panel only re-parents these three nodes
// into its body / header slots, so re-arranging, maximising, collapsing or switching views never
// re-creates the map (camera, follow mode and listeners survive).
import { MapView } from "@web/map.js";
import i18n, { mapT } from "@/i18n";
import { bus, factionName, S, sectorName, select, watchSector, whereText } from "./store";
import { getUI, isMapView, setView } from "./ui";

interface Parts { container: HTMLElement; title: HTMLElement; tools: HTMLElement }
let parts: Parts | null = null;
let parking: HTMLElement | null = null;
let view: MapView | null = null;
let attached = 0;

let constructing = false;
function newView(p: Parts): MapView {
  constructing = true;
  const nav0 = getUI().view;
  const v = new MapView(p.container, {
    S, bus, t: mapT, select, watchSector, sectorName, factionName, whereText,
    titleEl: p.title, toolsEl: p.tools,
  });
  // cluster layout (known clusters only, positions only) from the server: MAP-API.md setStaticMap
  if (S.staticMap && v.setStaticMap) v.setStaticMap(S.staticMap);
  // navigation is the source of truth for sector / galaxy (the map follows bus "view" itself)
  constructing = false;
  if (nav0 === "galaxy" && v.mode !== "galaxy") v.setMode("galaxy");
  else if (nav0 === "map" && v.mode !== "sector") v.setMode("sector");
  return v;
}
bus.on("staticmap", () => { if (view && view.setStaticMap && S.staticMap) view.setStaticMap(S.staticMap); });
// the map changed its mode itself (header switch, zoom hand-over, "show on map"): keep the navigation in step
bus.on("mapmode", (m: string) => {
  if (constructing) return;
  const nav = getUI().view;
  const want = m === "galaxy" ? "galaxy" : "map";
  if (isMapView(nav) && nav !== want) setView(want);
});

function ensure(): Parts {
  if (parts) return parts;
  parking = document.createElement("div");
  parking.className = "x4map-parking";
  parking.hidden = true;
  document.body.appendChild(parking);
  const container = document.createElement("div");
  container.className = "x4map-root";
  const title = document.createElement("span");
  title.className = "x4map-title";
  const tools = document.createElement("span");
  tools.className = "x4map-toolslot";
  parts = { container, title, tools };
  parking.append(container, title, tools);
  view = newView(parts);
  i18n.on("languageChanged", () => { view && view.setTranslator(mapT); });
  (window as unknown as Record<string, unknown>).__x4map = view;
  return parts;
}

export function getMap(): MapView | null { return view; }

/** sector the map currently shows (falls back to the player's sector when no map is on screen) */
export function mapSid(): string | null {
  if (view && attached > 0) return view.currentSid();
  return S.player && S.player.sector ? String(S.player.sector.id) : null;
}

/** move the map into the given slots; returns the detach function */
export function attachMap(slots: { body: HTMLElement; title: HTMLElement | null; tools: HTMLElement | null }): () => void {
  const p = ensure();
  slots.body.replaceChildren(p.container);
  if (slots.title) slots.title.replaceChildren(p.title);
  if (slots.tools) slots.tools.replaceChildren(p.tools);
  attached++;
  p.container.hidden = false;
  requestAnimationFrame(() => { view && view.resize(); });
  return () => {
    attached = Math.max(0, attached - 1);
    if (attached === 0 && parking) {
      // nothing shows the map: park it hidden (MapView stops drawing while its container is hidden)
      p.container.hidden = true;
      parking.append(p.container, p.title, p.tools);
    }
  };
}

/** a collapsed map panel: the map stops drawing (MapView checks the "collapsed" class) */
export function setMapCollapsed(c: boolean) {
  if (parts) parts.container.classList.toggle("collapsed", c);
}
export function isMapAttached() { return attached > 0; }

/** re-create the map (after its stored settings changed, e.g. a saved layout was applied) */
export function recreateMap() {
  if (!view || !parts) return;
  view.destroy();
  parts.container.replaceChildren();
  parts.title.replaceChildren();
  parts.tools.replaceChildren();
  view = newView(parts);
  if (attached > 0) requestAnimationFrame(() => { view && view.resize(); });
}
