# X4 WebMap – élő szektortérkép a második monitoron (1. mérföldkő, „életjel”)

A játék (`dev\x4_webmap` mod) ~4 Hz-cel JSON-sorokat ír a `\\.\pipe\x4webmap` pipe-ba a SirNukes
Mod Support APIs (1.95) pipe-rétegén át. Ez a szerver fogadja, és a böngészőnek továbbítja:
`http://127.0.0.1:8777` (csak helyi gépről érhető el).

## Indítás

1. `run.cmd` (dupla katt). Ablakban marad; leállítás: Ctrl+C. Napló: `logs\x4webmap.log`.
2. A Dellen böngészőben: `http://127.0.0.1:8777`.

Mindegy, hogy a szerver vagy a játék indul előbb: a mod 2 mp-enként újrapróbál, a szerver pedig
a játék újraindítását / UI-újratöltését (`/reloadui`) is kezeli.

**Játék nélkül:** `uv run python sim.py` (második ablakban) ugyanazt a JSON-t küldi ugyanazon a
pipe-on. Automata teszt: `uv run python test_e2e.py` (saját porton és pipe-on fut, 26 ellenőrzés).

## Mod telepítése a játékteszthez

1. `x4validate`: `cd tools\x4validate && uv run x4validate ..\..\dev\x4_webmap`
   (`X4_REFERENCE` = a projekt `reference\` mappája).
2. A `dev\x4_webmap\` mappát másold ide: `extensions\x4_webmap\` (nem Vortex-kezelt mappa lesz).
3. Feltételek: az `sn_mod_support_apis` be van kapcsolva, a Protected UI Mode ki van kapcsolva.
4. Ajánlott: Borderless ablak + indítási paraméterek: `-nocputhrottle -nosoundthrottle`.

`save="0"`: a mod bármikor eltávolítható, a mentésbe nem kerül.

## Mit kell látnod

- Felül a szektor neve, zöld „böngésző ↔ szerver: OK”, „játék: él (4 Hz)”, és egy
  „utolsó frissítés” jelző (ezredmásodpercek; 1,5 mp felett sárga, 5 mp felett piros).
- A térképen a hajód fehér nyílként (a nyíl a haladási irányba mutat), a saját hajóid
  színes pontként, névvel (szín = méretosztály: S kék, M zöld, L sárga, XL narancs).
- Egér: húzás = mozgatás, görgő = nagyítás; `F` = mindet mutat, `P` = követés, `L` = nevek.
- A „forrás” mező: `frame` = a UI képkocka-ciklusa küld, `md` = a tartalék MD-ütem küld.
- A játék chatjében csatlakozáskor egy „Pipe connected in lua” üzenet (az SN írja ki,
  `pipes.lua:388`).

## Nyitott kockázat: fut-e a Lua-ciklus, amikor a böngészőnek van fókusza?

Ha az X4 elveszti a fókuszt, a UI `onUpdate` ciklusa megállhat (az x4-mcp szerzője ezt mérte;
egy másik mérés szerint csak a minimalizálás állítja meg). A mod ezért három ütemforrást használ:

1. saját `SetScript("onUpdate")`,
2. az SN Time API képkocka-visszahívása (ezt az SN a saját 1 ms-os MD-ütemével is hajtja),
3. **tartalék, opcionális:** `dev\x4_webmap\md\x4_webmap_tick.xml` – MD-cue 250 ms-onként.
   Csak akkor küld, ha ~0,5 mp-ig nem ment képkocka-alapú pillanatkép. Ha nem kell, töröld a
   fájlt. (Szünetben az MD áll, ez szándékos.)

Ha a böngészőre kattintva a „forrás” `md`-re vált és a frissítés megy tovább, a tartalék működik.
Ha minden megáll, a játék valószínűleg magát a szimulációt is lassítja/megállítja háttérben:
ellenőrizd a Borderless módot és a `-nocputhrottle` paramétert.

## Nem ellenőrzött (csak a játékban dönthető el)

- A yaw iránya és mértékegysége: radiánnak vettem, irányvektor `(sin yaw, cos yaw)` az x–z
  síkon (a vanilla a `UIPosRot` yaw-t radiánban hasonlítja, `menu_map.lua:19612`). Ha a nyíl
  tükrözve/90°-kal elforgatva áll, a `map.js` két sorát kell javítani.
- `GetContainedObjectsByOwner("player", szektor)`: a vanilla csak konténerrel hívja; ha
  szektorral nem működik, a mod magától a teljes listára + szektorszűrésre vált (`space: "all"`).
- Hogy a valódi SN winpipe DLL pontosan úgy nyitja-e a pipe-ot, ahogy a szimulátor
  (üzenetmód + PIPE_NOWAIT); a szerver bájt- és üzenetmódú klienst is elfogad (tesztelve).
- A játékos pozíciója, ha nem ül hajóban (konténer, illetve maga a karakter).
- A teljesítmény sok száz hajónál (a pillanatkép 400 hajónál / 60 KB-nál le van vágva).
- A Lua szintaxisát nem futtattam (nincs Lua-értelmező a gépen); csak szerkezeti ellenőrzés volt.
