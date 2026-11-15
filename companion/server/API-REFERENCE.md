# X4 Companion – API-referencia (9.00)

Minden játékfüggvény, amit a híd (`dev\x4_companion\ui\x4_companion.lua`) hív, a 9.00 vanilla UI-Lua-ban
deklarálva vagy használva van. Forrás: a `08.cat`-ból kicsomagolt `D:\X4-backups\work\multimon\vanilla\ui\`
(rövidítve `ui\`). Két oszlop: hol van az FFI-deklaráció (cdef), és hol hívja a vanilla ugyanígy (használat).
A „menus” környezetben fut, mint az `ego_detailmonitor` menük – a `core\lua` (külön környezet) függvényeire
nem építünk, kivéve ahol jelölve van (opcionális, pcall + kikapcsolható forrás).

Minden hívás az `S(név, fn, …)` burkolón megy át: pcall, forrásonkénti hibaszámláló, 8 egymás utáni vagy
400 összes hiba után a forrás kikapcsol (a „stats” üzenetben látszik, az Állapot fülön is).

## FFI (C.*)

| Függvény | cdef | vanilla használat | csatorna |
|---|---|---|---|
| `GetPlayerID` | menu_docked.lua:104 | menu_playerinfo.lua:703 | player, economy |
| `GetPlayerOccupiedShipID` | menu_crafting.lua:25 | chatwindow.lua:487 | player |
| `GetPlayerControlledShipID` | menu_map.lua:777 | menu_map.lua:4362 | player (pilóta?) |
| `GetContextByClass` | menu_docked.lua:78 | menu_docked.lua:295, menu_map.lua:5561 | mind |
| `GetObjectPositionInSector` (`UIPosRot`) | helper.lua:366 | menu_map.lua:28819, menu_interactmenu.lua:1069 | player, sector, gates |
| `GetComponentName` / `GetComponentClass` | helper.lua:315 / menu_map.lua:587 | menu_diplomacy.lua:736 / menu_map.lua:13191 | mind |
| `IsComponentClass` | menu_docked.lua:123 | menu_map.lua:4839 | parancsok |
| `IsGamePaused` | helptext.lua:9 | helptext.lua:553 | player |
| `GetPlayerName` / `GetPlayerFactionName` | menu_playerinfo.lua:238 / :233 | menu_playerinfo.lua:3838 / :3839 | player |
| `GetCurrentGameTime` | menu_crafting.lua:22 | menu_crafting.lua:116, helper.lua:10611 | player, economy |
| `GetSofttarget2` | menu_docked.lua:110 | menu_docked.lua:1231, menu_map.lua:29439 | player (célpont) |
| `GetDefensibleSpeeds` | menu_map.lua:615 | menu_map.lua:13832 | player (max sebesség) |
| `GetDistanceBetween` | menu_interactmenu.lua:189 | menu_interactmenu.lua:5073 | player (célpont távolság) |
| `GetActiveMissionID` | menu_map.lua:553 | menu_map.lua:3750 | player |
| `GetPositionalOffset` | menu_mapeditor.lua:91 | menu_mapeditor.lua:731, :759-760 | galaxy (klaszter/szektor eltolás) |
| `GetNumDiscoveredSectorResources` / `GetDiscoveredSectorResources` (`WareYield`) | menu_encyclopedia.lua:111 / :100 | menu_map.lua:20891-20893 | galaxy (csak felfedezett nyersanyag) |
| `IsKnownToPlayer` | menu_diplomacy.lua:176 | menu_diplomacy.lua:1922, menu_encyclopedia.lua:833 | galaxy, gates, sector, watch |
| `IsInfoUnlockedForPlayer` | menu_map.lua:855 | menu_map.lua:14907, :13714 | nevek („?” ha nincs feloldva) |
| `GetNumAllFactionShips` / `GetAllFactionShips` | menu_playerinfo.lua:205 / :185 | menu_playerinfo.lua:3737 | property |
| `GetNumAllFactionStations` / `GetAllFactionStations` | menu_playerinfo.lua:206 / :186 | menu_playerinfo.lua:3784 | property |
| `GetNumOrders` / `GetOrders` (`Order`) | menu_map.lua:715 / :747 | menu_docked.lua:353-355 | property |
| `GetOrderQueueCurrentIdx` | menu_map.lua:745 | menu_map.lua:4780 | property |
| `GetDefaultOrder` | menu_map.lua:607 | menu_docked.lua:1013 | property |
| `GetOrderDefinition` (`OrderDefinition`) | menu_map.lua:739 | menu_map.lua:8615 | property (parancs neve) |
| `GetNumStationModules` | helper.lua:359 | menu_map.lua:8862 | property |
| `GetWorkForceInfo` (`WorkForceInfo`) | menu_map.lua:824 | menu_map.lua:14818, menu_encyclopedia.lua:2734 | property |
| `GetNumTickerCache` / `GetTickerCache` (`TickerCacheEntry`) | menu_playerinfo.lua:220 / :248 | menu_playerinfo.lua:2828-2880 | ticker |
| `GetNumMessages` / `GetMessages` (`MessageInfo`) | menu_playerinfo.lua:213 / :203 | menu_playerinfo.lua:3066, :3033 | messages |
| `GetNumCurrentMissionOffers` / `GetCurrentMissionOffers` | menu_map.lua:693 / :604 | menu_map.lua:18539 | offers |
| `GetUIRelationName` (`RelationRangeInfo`) | menu_diplomacy.lua:169 | menu_diplomacy.lua:1264 | factions |
| `GetNumTransactionLog` / `GetTransactionLog` (`TransactionLogEntry`) | helper.lua:361 / :384 | helper.lua:10615-10618 (játékos: menu_playerinfo.lua:1583) | economy |
| `SetSofttarget` | menu_map.lua:983 | menu_map.lua:5567; mycu_map_hotkeys map_hotkeys.lua:159 | parancs `target` |
| `SetGuidance` / `EndGuidance` | menu_map.lua:937 / :544 | menu_playerinfo.lua:864-868 (naplóbejegyzés „útvonal”), menu_map.lua:4364 / :29547 | parancs `guidance`, `guidance_end` |
| `SetFocusMapComponent` | menu_map.lua:933 | menu_map.lua:2727 | parancs `openmap` (ha a térkép nyitva) |
| `IsOrderSelectableFor` | menu_map.lua:862 | menu_map.lua:3450 | parancs `flyto` |
| `RemoveOrder`, `ResetOrderLoop`, `CreateOrder`, `EnablePlannedDefaultOrder` | menu_map.lua:893 / :901 / :537 / :543 | menu_map.lua:2865, :2929-2933; menu_interactmenu.lua:883-915 | parancs `stop` |
| `QueryPerformanceCounter/Frequency` | – (Windows kernel32, nem játékfüggvény) | – | költségmérés |

A struktúrák a vanilla deklaráció szó szerinti másolatai; a híd csak akkor deklarál egy típust, ha
`ffi.typeof` szerint még nincs (a vanilla menük előbb töltődnek be, így ez a gyakorlatban nem fut le).

## Lua globálisok

| Függvény | vanilla használat | megjegyzés |
|---|---|---|
| `GetComponentData(obj, …)` | menu_map.lua:8230 és sok más | tulajdonságok: lásd lent |
| `GetContainedObjectsByOwner(faction, sector)` | menu_map.lua:8225 (tér nélkül), menu_platformundock.lua:121 (térrel) | **a v0 éles teszt igazolta szektorral** |
| `GetClusters(true)` + `GetSectors(c)` | menu_map.lua:29492-29496 (`prepareKnownSectors`) | csak ismert klaszterek |
| `GetPlayerMoney()` | menu_diplomacy.lua:2572 | |
| `GetLibrary("factions")`, `GetFactionData`, `GetOwnLicences`, `HasLicence`, `GetUIRelation` | menu_diplomacy.lua:1188, 1198, 1200, 1780, 1264 | |
| `GetNumLogbook(cat)` / `GetLogbook(start, n, cat)` | menu_playerinfo.lua:2830 / 2909, menu_map.lua:16803-16808 | kategóriák: menu_playerinfo.lua:380-391 |
| `GetNumMissions`, `GetMissionDetails(i)`, `GetMissionObjective(i)`, `GetActiveMission()` | menu_map.lua:18856, 18679, 18686, 18698 | |
| `GetMissionOfferDetails(luaid)` | menu_map.lua:18512 | |
| `GetCommander(obj)` | menu_map.lua:8272, menu_docked.lua:1001 | |
| `GetWareData(ware, "name")` | helper.lua:10641 | |
| `CanViewLiveData(obj)` | menu_map.lua:6210, 6232 | élő adat látható-e (radar/műhold) |
| `IsValidComponent`, `ConvertIDTo64Bit`, `ConvertStringTo64Bit`, `ConvertStringToLuaID` | menu_map.lua:4357; menu_diplomacy.lua:1648; chatwindow.lua:6, 344 | |
| `OpenMenu("MapMenu", {0, 0, true, obj})` | menu_playerinfo.lua:856 (Helper-rel), chatwindow.lua:344 (közvetlenül); paraméterek: menu_map.lua:29435-29438 | `Menus` lista: menu_map.lua:1903 |
| `CreateOrder(ship, "MoveWait", {destination={sector,{x,y,z}}}, false, false, false)` | menu_map.lua:3467 | |
| `AddUITriggeredEvent("x4companion", "gates")` | menu_diplomacy.lua:381 | MD kapulekérdezés |
| `RegisterEvent`, `SetScript("onUpdate")`, `GetCurRealTime`, `DebugError` | chatwindow.lua:32, debug.lua:14, menu_ship_configuration.lua:9924 | |
| `GetPlayerSpeed()` | **core** környezet: `crosshair handling.lua:3358` | opcionális: ha a menus környezetben nincs, a böngésző a pozícióváltozásból számol |

`GetComponentData` tulajdonságok (mind előfordul a vanilla menükben): `name idcode hullpercent shieldpercent owner
uirelation isenemy ishostile isplayerowned isknown isradarvisible isinliveview iswreck primarypurpose macro fleetname
isdocked isdocking destination isactive money assignedpilot` (pl. menu_map.lua:7399, 7553, 13826, 14889, 14893;
menu_interactmenu.lua:5686; menu_docked.lua:349).

## Ismertség (mit láthat a böngésző)

A döntés a hídban születik, a pipe-ra csak az kerül ki, amit a játék térképe is megmutatna:

| Mi | Szabály | Forrás |
|---|---|---|
| Szektor | `GetClusters(true)`/`GetSectors` **és** `C.IsKnownToPlayer(sector)` | menu_map.lua:29492; menu_diplomacy.lua:1922 |
| Szektor/klaszter neve, tulajdonosa | csak ha `C.IsInfoUnlockedForPlayer(x, "name")`, különben „?” | menu_map.lua:14907; helper.lua:13033-13036 |
| Kapu, sztrádabejárat | a szektora ismert, és `isknown` + `isradarvisible`; a cél csak ha a célszektor ismert, különben `du` („?”) | menu_map.lua:7553-7562 |
| Állomás | `isknown` és `isradarvisible` | menu_map.lua:7553-7562 (a térkép objektumszűrője) |
| Hajó és egyéb (műhold, láda, akna…) | `isknown ~= false`, `isradarvisible ~= false` **és** `CanViewLiveData(obj)` (tartalék: `isinliveview`) | menu_map.lua:6210, 6232; menu_interactmenu.lua:5686 |
| Saját objektum | mindig | – |
| Figyelt szektor | csak ismert szektor (különben a parancs elutasítva) | – |
| Statikus térképexport | a szerver geometriát soha nem küld belőle; sztrádát csak két *ismert* szektor között, ha a játék ismert sztrádabejáratot jelentett | server.py `Store.hw_links` |

A játék saját holotérképe natívan dönt (`GetMapRenderedComponents`, menu_map.lua:7414 – holomap nélkül nem
használható), ezért ez közelítés: a szabályok a vanilla menük *saját* szűrői, nem a renderelő belseje.

## SN 1.95 és Native Hotkey API

| Hívás | Forrás |
|---|---|
| `require("extensions.sn_mod_support_apis.ui.named_pipes.Pipes")` | pipes.lua:857 |
| `Pipes.Schedule_Write(pipe, cb, msg)` / `Pipes.Schedule_Read(pipe, cb, true)` | pipes.lua:161 / :127 |
| írási újrapróbálás hibája (sikeres újraírás is ERROR) | pipes.lua:814-840 |
| `garbage_collected` UI-újratöltéskor | pipes.lua:267 |
| `require("extensions.sn_mod_support_apis.ui.time.Interface").Register_NewFrame_Callback` | time\interface.lua:516 |
| `RegisterEvent("HotkeyApi.Register_Request")` + `HotkeyApi.RegisterAction{id, area="map;pilot;fps", name, actionLua}` | hotkey_api.lua:589-617 (extensions\hotkey_api ext_01.cat, 8.00.09) |
| `UIInfo` / `UIWarning` / `UIError` (opcionális) | lua_log_api README „optional dependency”; extensions\lua_log_api |

## MD

| Elem | Forrás |
|---|---|
| `find_gate … space="player.galaxy" active="true" multiple="true"` | md\lib_generic.xml:1173, md\scenario_tutorials.xml:4520 |
| `find_highway_entry_gate superhighwaygate="true" space=…` | md\lib_generic.xml:1174 |
| `raise_lua_event name=… param="$komponens"` | md\cover.xml:397 |
| `event_ui_triggered screen=… control=…` | md\rml_buildstation.xml:823; KNOWLEDGEBASE „event_ui_triggered round-trip” |
| ütem: `cue instantiate="true" checkinterval="250ms"` | SN md\time_api.xml (MD_New_Frame) |
