# X4 Companion map module – public API (v2)

Files: `web/map.js` (the view), `web/mapstyle.js` (pure look/geometry functions + icon cache),
`web/camera.js` (pure camera math), `web/map-strings.js` (texts). Imported unchanged; they also import
`./util.js` and `./icons.js` (keep them next to the map files or alias them).
This API is **stable**: later versions only add things.

## Mount

```js
import { MapView } from "./map.js";
import { createTranslator } from "./map-strings.js";

const map = new MapView(container, {
  S,                 // required: the state store (see "Data")
  bus,               // required: { on(name, fn), emit(name, data) }; optional off(name, fn)
  t: createTranslator("hu"),   // optional, default English (see "Texts")
  // all optional:
  select(sel) {},    // a map click selected { kind: "obj"|"sector", id, from: "map"|"galaxy", obj?, sid? }
                     //   default: S.selected = sel; bus.emit("select", sel)
  watchSector(sid) {},  // the map shows another sector (sid) or the player's again (null): the shell
                        //   asks the server to scan it ({type:"watch", sid}); default: no-op
  sectorName(id), factionName(id), whereText(where),   // default: built-in, via S + translator
  headingOf(yaw),    // yaw -> screen angle; default: mapstyle.headingFromYaw (verified, see below)
  titleEl,           // element whose textContent gets the title ("Map · <sector>")
  toolsEl,           // element that receives the Sector/Galaxy switch + follow selector
  onTitle(text) {},  // called when the title changes (alternative to titleEl)
  settingsKey: "map" // localStorage key x4c.<settingsKey>
});
```

`container` may be **any element** in any window/document (pop-out windows included):

* Legacy dock module: an element containing `.ptitle`, `.ptools`, `.pbody` – the map uses them.
* Anything else: the map appends its own `.x4map-body` (and, without `toolsEl`, a `.x4map-tools`
  overlay bar) to the container. The container should have a size (e.g. flex: 1 / height: 100%);
  the map sets the inline styles it needs to work without any stylesheet (`position: relative` body,
  absolutely positioned canvas).

Sizing: a `ResizeObserver` on the body; 0×0 (hidden, collapsed, not yet laid out) is fine – the map
waits and draws as soon as the element gets a real size. `map.resize()` forces a re-measure.

## Methods

| Method | |
|---|---|
| `setMode("sector" \| "galaxy")`, `toggleMode()` | view mode (also keys/hotkeys via bus) |
| `mode` (property) | current mode |
| `showSector(sid)` | show that sector (null/player's sector = follow the player) |
| `centerOn(objId)` | select-and-focus an object (sector view) |
| `auto()` | back to following the player ship |
| `fit()` | fit the whole sector / galaxy |
| `zoom(f, sx?, sy?)` | f > 1 zooms in (around screen point in manual mode) |
| `currentSid()` | sector id currently shown |
| `resize()` | re-measure the container |
| `setTranslator(t)` | swap the translator at runtime (null = English); re-renders all texts |
| `setStaticMap(json)` | optional: cluster layout source, the `data/static_map.json` export (or the subset `{clusters:[{macro, sectors:[{macro, x, z}]}]}` of clusters that have ≥1 known sector). Only used to place sectors inside their cluster hexagon independent of discovery; nothing undiscovered is drawn from it |
| `overlayRects()` | `{w, h, rects: {info, layersBtn, layers, legend, legendBtn, miniBtn, zoom, follow, back, mini, scale}}` of the visible overlays (container px) |
| `destroy()` | stops the animation loop, disconnects observers, removes window/bus listeners and all DOM the map added. The instance is dead afterwards |

## Bus events

Consumed (`bus.on`): `player`, `scan`, `galaxy`, `property`, `factions`, `status`, `details`, `icons`
(redraw), `theme` (redraw + legend), `select` (sel), `sectorchange`, `alert` (log items with `ic`),
`hotkey` ({action: view_toggle|zoom_in|zoom_out|zoom_fit}), `auto`, `resize`; also the window event
`x4c-layout`. Emitted (`bus.emit`): `mapmode` (mode), `mapsector` (sid).
If `bus.on` returns a function it is used as the unsubscribe; otherwise `bus.off(name, fn)` if present;
otherwise the handlers become no-ops after `destroy()`.

## Data (`S`)

The map only reads `S`; the shell fills it from the server messages (see `app.js apply()`):

| Field | From message | Shape |
|---|---|---|
| `S.player`, `S.prevPlayer` | `player` | `{sector:{id,name}, object:{id,x,z,yaw,class,ic,rr,hull,shield,name}, target, guidance, where}` |
| `S.liveGalaxy` | `init.galaxy`, `galaxy.clusters` | raw known clusters `[{id,name,macro,x,z,sectors:[{id,name,macro,owner,x,z,res}]}]` |
| `S.sectors`, `S.clusters`, `S.links`, `S.stubs`, `S.gatesBySector` | derived | build them with `galaxyIndex()` from `mapstyle.js` (same as `app.js rebuildGalaxy/rebuildLinks`) |
| `S.scans` | `init.sectors`, `sector` | `{ [sid]: {objs:[…], n, hidden} }` |
| `S.property` | `property` | `Map(id -> entry)` |
| `S.details` | `details` | `{ [id]: {orders:[{pt:{s,x,z}, n, d}]} }` |
| `S.theme` | `theme` | `{holo:{playercolor:{r,g,b},…}, ui:{…}, sim?}` |
| `S.factions` | `factions` | `{ [id]: {n, col:{r,g,b}} }` |
| `S.selected` | shell | `{kind, id}` or null |
| `S.status`, `S.wsOpen` | `status` | `S.status.game === "live"` enables the 60 s auto-return |

```js
import { galaxyIndex } from "./mapstyle.js";
Object.assign(S, galaxyIndex(S.liveGalaxy, S.gates, S.scans, S.hwlinks));  // -> sectors, clusters, links, stubs, gatesBySector, sectorByMacro
bus.emit("galaxy");
```

Icons: call `setIconIndex(names, onLoaded)` from `mapstyle.js` once with the keys of
`GET /icons/index.json` (`onLoaded` → `bus.emit("icons")`); textures load from `/icons/<name>.png`.
Without it the map draws vector fallbacks.

## Texts

`t(key, params)` returns the string; params are `{name}` placeholders. Keys are `map.*`, the full list
with English and Hungarian is `map-strings.js` (`export const STRINGS = { en, hu }`,
`createTranslator(lang)`, `MAP_KEYS`). A custom `t` that returns `undefined`/`null`/the key itself
falls back to English. Number/distance formatting uses `t("map.locale")` (e.g. `en-US`, `hu-HU`).

## Settings (localStorage `x4c.map`, unchanged from v1.1, not migrated)

`labels` auto|all|off, `npc`, `grid`, `mini`, `radar`, `lines`, `hull`, `factioncol`, `rotate`
(default false, layer "Ship heading"), `iconscale`, `mode`, `ret` (ship follow: seconds until the camera
returns to the ship after a manual move, 0 = manual, camera stays put; default 8), `legend`.
A **manual** camera (`ret` 0) is also stored in `x4c.map.cam` and restored by a new instance (reload,
pop-out window).

## Camera rules

The camera only moves on the user's request (pan, zoom, fit, back-to-ship, "show on map", hotkeys) or by
the chosen follow mode. In manual mode nothing moves it: data snapshots, resize, the player's sector
change, static map arrival, view switch, a watched sector's 60 s auto-return are all ignored.

## Layout inside the container (responsive)

`overlayModes(w, h)` (`mapstyle.js`, pure) decides from the container size: `full` (≥1000×600, v1.1 look),
`medium` (≥640×400: one-line info pill, small mini galaxy, legend + back-to-ship as round buttons),
`small` (mini galaxy on demand, 30 px zoom buttons). Layers list / legend / compact mini galaxy are
popovers placed so that no overlay overlaps another or leaves the container; `map.overlayRects()`
returns their rectangles (tests use it).

## Drawing rules (summary)

* Sector view draw order (bottom → top): radar, grid, lines, misc objects, NPC ships, own ships, gates,
  stations, labels, the player marker. Hit-testing walks the same list top → bottom (topmost wins).
* Jump gate / accelerator / superhighway names (= destination sector) are shown at every zoom level
  (also with "Names: never"), with a dark backplate, placed around the icon so they do not stack.
* Abandoned ships (`isOwnerlessShip` in `mapstyle.js`: ship class + owner `ownerless`, not wrecks /
  own / property entries) get a dashed chartreuse ring (`OWNERLESS_COLOR`, slow pulse, still with
  `prefers-reduced-motion`), an "abandoned" badge and an always-shown name; drawn above ordinary ships,
  below gates / stations / the player. Layer `ownerless` (default on); the info box counts them.
* Sector border: a flat-top hexagon in the owner's colour (player: `playercolor`, unowned: grey) with an
  inner glow, black outside. **Approximation** (the UI Lua has no sector extent): centred on the sector
  origin, apothem = everything known (objects, own radar circles) × 1.06, min 60 km
  (`sectorHexApothem`); it only grows, eases in, holds while dragging; "fit" frames it.
* Names (v1.2): always for gates / accelerators / superhighways, abandoned ships and the selected /
  targeted / hovered object (never overlapping each other or route labels: free spot → stepped →
  abbreviated → leader line). "When zoomed in" = density based: own property, mission targets, stations,
  ships, others (nearest to the centre first) get a name where it overlaps no other name or icon.
  "Always" = every object; "never" = only the always-on names.
* v1.2 bridge extras ride along with the player's sector scan as pseudo objects `x4c_sectorinfo`
  (MD `coresize` / `coreposition` / `iscontested`) and `x4c_resarea` (`{w, cell, pts:[x_km, z_km, amount…]}`):
  hosts call `takeSectorExtras(S, scan)` (mapstyle.js) before storing a scan; it fills `S.sectorInfo` /
  `S.resources`. With them the border is the core hexagon (apothem = coresize / 2 around coreposition,
  contested dashed); resource areas are drawn under everything (layer `resources`, default on).
* Ship icons rotate only with the "Ship heading" layer (`headingOf`, default `headingFromYaw`: yaw in
  radians, clockwise from north/+z; verified against live movement, see `tests/test_mapstyle.mjs`).
* Galaxy view: one flat-top hexagon per cluster (radius = the cluster grid edge, 1e7 m) with an
  owner-coloured outline; sectors: 1 → fills it, 2–3 → half-radius hexagons whose outer vertex is a
  cluster vertex (corners nobody occupies stay black), 4–7 → third-radius hex flower. `clusterLayout()`
  assigns the slots from the sectors' real offsets (relative to their centroid), see
  `tests/test_galaxy_layout.mjs`. Without `setStaticMap()` the slots come from the *known* sectors
  only (a lone known sector of a multi-sector cluster then fills the hexagon until its siblings are
  discovered); with it they are independent of discovery.
* A sector the galaxy message has not reported yet (just entered/discovered) is shown at once from
  `S.player.sector` + the scan's gates (position estimated, dashed), refined when the data arrives.

## Pop-out / hosting notes

v1.1 pop-out was blank because `body.single #nav {display:none}` let `#work` auto-place into the 2nd
(`auto`) row of `body {grid-template-rows: auto auto 1fr}`; with only absolutely positioned children it
collapsed to 0 px. A host must give the map container a real height (e.g. flex: 1 / explicit grid row).
The map itself treats width-without-height as "not laid out" and draws as soon as both are > 0.

CSS classes used (cosmetic, all optional): `mapbody mapcanvas dragging mapinfo mi-title layerbox layers
layers-btn chip on maplegend2 lgtitle lgrid lgi swatch radar zoombox zbtn followbadge backbtn maptip
segs seg x4map-body x4map-tools muted dot`.
