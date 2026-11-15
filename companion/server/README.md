# X4 Companion – második képernyő X4 9.00-hoz

A játékban futó híd (`dev\x4_companion`) a SirNukes-pipe-on (`\\.\pipe\x4companion`) küldi az adatokat
ennek a helyi szervernek, ami böngészőben mutatja: **http://127.0.0.1:8788** (csak erről a gépről érhető el).

> A port **8788**, nem 8787: a 8787-et ezen a gépen egy másik program (headroom proxy) foglalja.
> Másik port: `run.cmd --port NNNN`.

## Indítás

1. `run.cmd` (dupla katt; ablakban marad, Ctrl+C állítja le; napló: `logs\x4companion.log`).
2. Böngésző a Dellen: `http://127.0.0.1:8788`. Új ablak **csak** a modulfejléc „↗ Külön ablakba” gombjára nyílik
   (`/?panel=map|objects|info|property|log|missions|factions|economy|diag|hotkeys`).
3. **Egyszer, és minden játék-/modfrissítés után:** a térképikonok exportja a saját játékodból
   (`uv run --with pillow==11.3.0 python export_icons.py`, ~4 mp, ~280 ikon a `data\icons\` mappába – játékadat,
   git-ignored, nem terjeszthető). Nélküle rajzolt helyettesítő ikonok látszanak.
4. Mindegy, mi indul előbb; a mod 2 mp-enként újrapróbál, `/reloadui` és szerver-újraindítás után is visszajön.

Játék nélkül: `sim.cmd` (a szimulátor ugyanazt küldi, mint a mod). Tesztek: `test.cmd`.

## Telepítés (a mod)

1. Ellenőrzés: `cd tools\x4validate` → `uv run x4validate --reference "…\reference" ..\..\dev\x4_companion`.
2. Másold a `dev\x4_companion\` mappát ide: `extensions\x4_companion\`. A v0 (`x4_webmap`) mellette maradhat
   (külön pipe és port).
3. Kell: `sn_mod_support_apis` bekapcsolva, **Protected UI Mode kikapcsolva**. Opcionális, de ajánlott: Native
   Hotkey API (gyorsgombok), Lua Log API (a mod információs sorai ne `=ERROR=`-ként jelenjenek meg).
4. `save="0"`: bármikor eltávolítható, a mentésbe nem kerül. Az `md\x4_companion_tick.xml` (tartalék ütem) és az
   `md\x4_companion_gates.xml` (kapuk) törölhető, ha gondot okoz.

## Ajánlott beállítás: kattintás nélkül, a játékból

- **Fő út:** a böngészőt nem kell érinteni. Kijelző-üzemmód („Auto”): a térkép követi a hajódat, magától nagyít
  úgy, hogy a hajó és a legközelebbi kapu/állomás látsszon, szektorváltáskor ugrik, riasztáskor a napló villan és a
  felső sávban piros felirat jelenik meg (hang nincs).
- **Játékbeli gyorsgombok** (Native Hotkey API): Beállítások → *Hotkey Management* → *Hotkey Bindings*, a
  „Companion: …” sorokhoz rendelj gombot: következő panel, galaxis/szektor nézet, nagyítás, kicsinyítés, következő
  / előző saját hajó, napló le/fel, kijelölt/célzott objektum mutatása, vissza az automata kijelzőre, riasztások
  nyugtázása. Térképen, pilótaként és gyalog is működnek.
- **Ha egérrel is akarod:** a játékban *Borderless Window*, és a profil `config.xml`-jében `confinemouse=false`;
  így az egér egyszerűen áthúzható a Dellre. Exkluzív teljes képernyőn a játék fókuszvesztéskor megáll – ezt a
  felület „játék háttérben” állapotként jelzi (szürke, utolsó ismert adatok), nem kapcsolatvesztésként.
  Indítási paraméter ajánlás: `-nocputhrottle -nosoundthrottle`.

## Kezelés (v1.1)

- **Navigáció** (felső sor, mindig látszik): Térkép (1) · Galaxis (2) · Tulajdon (3) · Napló (4) · Küldetések (5) ·
  Frakciók (6) · Gazdaság (7) · Állapot (8). Esc = vissza a térképre (a térképen: kijelölés törlése, majd vissza a
  hajódra). Az aktív nézet kiemelt; a „Vissza a térképre” gomb minden más nézetben ott van.
- **Modulok** (a Térkép nézet munkaterülete): fejléc húzása = mozgatás rácsra illesztve, szél/sarok húzása =
  átméretezés, ⌃ = összecsukás, dupla katt a fejlécen = teljes méret, × = elrejtés; „Modulok ▾” menü:
  megjelenítés/elrejtés; „Elrendezés ▾”: Navigáció, Flotta, Harc, Minden, Alaphelyzet. A böngésző megjegyzi.
- **Térkép:** görgő / csippentés / + − / gombok = nagyítás mindkét irányba; 0 = illesztés; a = vissza a hajómra.
  „Rétegek ▾”: Radar, Útvonalak, Más hajók, Burkolat, Frakciószínek, Irány, Rács, Mini galaxis, Nevek, Jelmagyarázat.
- **Gyorsgombok nézet** (? gomb a felső sávban): a 17 játékbeli gyorsgomb leírása és hogy hol kell bekötni.

## Mit tud

- **Felső sáv:** kapitány, kredit, szektor, hajó (burkolat/pajzs, sebesség), hol vagy (pilóta / utas / dokkolva /
  gyalog), célpont távolsággal, aktív küldetés, játékidő, kapcsolat-állapot.
- **Térkép, szektornézet (a játék térképe szerint):** a játék saját ikonjai (hajó méret+szerep, állomástípus, kapu,
  gyorsító, sztráda, műhold, szonda, jeladó, akna, lézertorony, láda, roncs), a játék térképszínei
  (`GetHoloMapColors`: saját / semleges / ellenséges / támadó / küldetés / kapu), állandó ikonméret, burkolatsáv az
  ikon fölött, nevek csak közelről vagy kijelölve, a saját radarok által látott terület világos hex-lépcsős folt a
  sötét háttéren, kijelölt útvonal, célpontvonal, a kijelölt saját hajó parancsainak útja. A te jelölőd fehér
  gyűrűs „TE”. Követés alapból; kézi mozgatás után beállítható idő (alap 8 mp) múlva
  magától visszaáll, közben nagy „Vissza a hajómra” gomb.
- **Térkép, galaxisnézet:** a *felfedezett* szektorok hexagonokban, tulajdonos színével, kapuk és sztrádák, saját
  hajók/állomások száma szektoronként, a te szektorod kiemelve, ismeretlen irányok „?”-lel, a kijelölt útvonal.
- **Objektumok + Info:** a játék térképmenüjének objektumlistája (szűrők, távolság), kattintásra a térkép odaugrik és
  az Info megmutatja: tulajdonos, burkolat/pajzs, parancs és parancssor, rakomány (ha a játékban is látható).
- **Tulajdon:** minden saját hajó és állomás – rendezés, szűrők (osztály, szerep, sérült, itt), keresés (`/`),
  flottafa. Kattintás → részletek (parancs, parancsnok, alárendeltek, számla, modulok, munkaerő).
- **Napló:** a játék kategóriái (általános, küldetések, hírek, diplomácia, riasztások, fenntartás, tippek) +
  értesítések (ticker) + üzenetek; olvasatlan-számlálók, villogó riasztás.
- **Küldetések, frakciók (kapcsolat, engedélyek), gazdaság (utolsó óra bevétel/kiadás, legnagyobb tételek), Állapot**
  (a híd mért költsége csatornánként, hibák, kikapcsolt források).
- **Parancsok** (a felső sávban „Vezérlés engedélyezése” + a mod engedélyezőlistája): a játék térképének megnyitása
  az objektumra/szektorra, célpont, útvonal. Az „Állj” és „Repülj ide” alapból **ki van kapcsolva** a modban
  (`CFG.allow` a `x4_companion.lua` elején).

**Csak a felfedezett dolgok jutnak ki a játékból** – a híd szűr, nem a böngésző (részletek: `API-REFERENCE.md`).

## Ismert korlátok

- Az ismertségi szabály a vanilla menük saját szűrőit követi (`IsKnownToPlayer`, `isknown`, `CanViewLiveData`);
  a holotérkép natív renderelőjével nem garantáltan azonos (első játékteszt dönti el).
- Nincs: zónák/régiók (erőforrásmezők) alakja – csak a felfedezett nyersanyagok listája; a játék holotérképének
  képe; hang.
- Sztrádák: a statikus térképfájlokból (`export_static.py`), csak két ismert szektor között és csak ha a játék
  ismert sztrádabejáratot jelent.
- A felfedezett-hex adat nem érhető el a UI-Luából: a radarfolt a saját objektumok radar-hatótávjából számolt
  közelítés. Hajóikonok alapból nem forognak (Rétegek → Irány).
- A hajó iránya (yaw) előjele még nincs élesben megerősítve: az Állapot fül „yaw-konvenció” sora mozgás közben
  magától dönt.
- `export_static.py` a térképfájlok változásakor (új mod) újrafuttatandó.
