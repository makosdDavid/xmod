# X4 Companion – második képernyő X4 9.00-hoz

A játékban futó híd (`dev\x4_companion`) a SirNukes-pipe-on (`\\.\pipe\x4companion`) küldi az adatokat
ennek a helyi szervernek, ami böngészőben mutatja: **http://127.0.0.1:8788** (csak erről a gépről érhető el).

> A port **8788**, nem 8787: a 8787-et ezen a gépen egy másik program (headroom proxy) foglalja.
> Másik port: `run.cmd --port NNNN`.

## Indítás

1. `run.cmd` (dupla katt; ablakban marad, Ctrl+C állítja le; napló: `logs\x4companion.log`).
2. Böngésző a Dellen: `http://127.0.0.1:8788`. Külön ablakok a második monitorra (a panel ⧉ gombja is ezt nyitja):
   `/?panel=map`, `/?panel=property`, `/?panel=log`, `/?panel=missions`, `/?panel=factions`, `/?panel=economy`,
   `/?panel=diag`, `/?panel=player`.
3. Mindegy, mi indul előbb; a mod 2 mp-enként újrapróbál, `/reloadui` és szerver-újraindítás után is visszajön.

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

## Mit tud

- **Felső sáv:** kapitány, kredit, szektor, hajó (burkolat/pajzs, sebesség), hol vagy (pilóta / utas / dokkolva /
  gyalog), célpont távolsággal, aktív küldetés, játékidő, kapcsolat-állapot.
- **Térkép, szektornézet:** km-rács felirattal és léptékkel, szektorközép és tengelyek, kapuk (célszektorral, vagy
  „?”), sztrádák, állomások névvel, a látott hajók relációszínnel, saját hajók, mini-galaxis a sarokban. A te
  jelölőd sárga gyűrűs nyíl „TE” felirattal. Követés alapból; kézi mozgatás után beállítható idő (alap 8 mp) múlva
  magától visszaáll, közben nagy „Vissza a hajómra” gomb.
- **Térkép, galaxisnézet:** a *felfedezett* szektorok hexagonokban, tulajdonos színével, kapuk és sztrádák, saját
  hajók/állomások száma szektoronként, a te szektorod kiemelve, ismeretlen irányok „?”-lel.
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
- A hajó iránya (yaw) előjele még nincs élesben megerősítve: az Állapot fül „yaw-konvenció” sora mozgás közben
  magától dönt.
- `export_static.py` a térképfájlok változásakor (új mod) újrafuttatandó.
