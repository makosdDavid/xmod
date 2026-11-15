# x4span presetek — a config.xml szükséges változásai

A fájl: `D:\X4-userdata\6144\config.xml`. **Az x4span ezt nem módosítja**, csak olvassa. A módosítást te végzed,
**a játék bezárt állapotában** (a játék kilépéskor visszaírja a configot). Előtte készíts másolatot:
`copy D:\X4-userdata\6144\config.xml D:\X4-userdata\6144\config.xml.before-x4span`

Kiinduló állapot (2026-11-14-én olvasva):

```xml
<fullscreen>true</fullscreen>
<borderless>false</borderless>
<fov>1.3333</fov>            <!-- 1.3333 × 90 = 120° -->
<res_width>3440</res_width>
<res_height>1440</res_height>
<!-- menuwidthscale: nincs a fájlban (alapérték) -->
```

Jelentések (a 9.00 `gameoptions.lua` alapján): `fullscreen=true` → Fullscreen; `fullscreen=false, borderless=false` →
Windowed; `fullscreen=false, borderless=true` → Borderless Window (ott a felbontás nem választható). A FOV fok = `fov × 90`,
a csúszka 60–120°. A `menuwidthscale` a menük szélessége a képernyőszélesség arányában (0,10–1,00; a menük középre
kerülnek). Ezeket a kulcsneveket az `X4.exe` szövegei is tartalmazzák.

Minden kiterjesztett presethez **Windowed** mód kell: így a játék a `res_width × res_height` méretű ablakot és
swapchaint hozza létre, az x4span pedig ugyanakkora kliensterületet ad neki (nincs átméretezés). Hogy a 9.00 elfogad-e
monitornál nagyobb `res_width`-et ablakos módban: **nem ellenőrzött** — ez a tesztprotokoll 1. kérdése.

---

## single-uw (alap, A/B összehasonlításhoz)

```diff
-<fullscreen>true</fullscreen>
+<fullscreen>false</fullscreen>
 <borderless>false</borderless>
 <res_width>3440</res_width>
 <res_height>1440</res_height>
```
Ezután: `.\x4span.ps1 -Preset single-uw`. (Ugyanezt adja a játék saját Borderless módja is: `borderless=true`.)

## k1-uw-left — ultrawide középen, Dell bal periféria (átrendezés nélkül)

```diff
-<fullscreen>true</fullscreen>
+<fullscreen>false</fullscreen>
 <borderless>false</borderless>
-<fov>1.3333</fov>
+<fov>0.8333</fov>           <!-- 75°; próbáld 0.6667-tel (60°) is -->
-<res_width>3440</res_width>
+<res_width>7280</res_width>
 <res_height>1440</res_height>
+<menuwidthscale>0.47</menuwidthscale>   <!-- 0.47 × 7280 = 3422 px: a menük az ultrawide-on maradnak -->
```
Ablak: x=−1920, y=0, 7280×1440. A jobb oldali 1920 px a képernyőn kívül van (oda eső jelölők, nyilak nem látszanak).

## k2-triple — Dell | ultrawide | laptop (Windows-átrendezés után)

Előfeltétel (te csinálod): Gépház → Kijelző → a laptop-panelt húzd az ultrawide JOBB oldalára, a Dellt hagyd balra;
mindkettőt függőlegesen középre (Y = 180 az ultrawide tetejéhez képest). Ellenőrzés: `.\x4span.ps1 -Preset k2-triple -WhatIf`
(„dy=0", és nincs „!" sor a Y-eltérésről).

```diff
-<fullscreen>true</fullscreen>
+<fullscreen>false</fullscreen>
 <borderless>false</borderless>
-<fov>1.3333</fov>
+<fov>0.6667</fov>           <!-- 60°: ennél a síkvetítés 514 mm szemtávolságra helyes -->
-<res_width>3440</res_width>
+<res_width>7280</res_width>
 <res_height>1440</res_height>
+<menuwidthscale>0.47</menuwidthscale>
-<dlssmode>quality</dlssmode>
+<dlssmode>performance</dlssmode>      <!-- belső render 3640×720 = 2,6 MP, ma 2,2 MP -->
```

## k3-triple-1080 — mint K2, de az ultrawide 2560×1080-on

Előfeltétel (te csinálod): NVIDIA Vezérlőpult → Felbontás módosítása → Testreszabás → egyedi felbontás 2560×1080 @ 100 Hz
az ultrawide-ra; Asztal méretének és helyzetének módosítása → Méretezés: **Képarány**, végrehajtás: **GPU**. Utána a
Windows-elrendezés mint K2-nél (most mindhárom 1080 soros, Y = 0).

```diff
-<fullscreen>true</fullscreen>
+<fullscreen>false</fullscreen>
 <borderless>false</borderless>
-<fov>1.3333</fov>
+<fov>0.6667</fov>
-<res_width>3440</res_width>
-<res_height>1440</res_height>
+<res_width>6400</res_width>
+<res_height>1080</res_height>
+<menuwidthscale>0.40</menuwidthscale>   <!-- 0.40 × 6400 = 2560 px -->
 <dlssmode>quality</dlssmode>            <!-- belső 4267×720 = 3,1 MP; ha kevés: balanced (2,3 MP) -->
```
Visszaállítás: NVIDIA Vezérlőpultban az ultrawide vissza 3440×1440 @ 100 Hz-re.

## k4-surround — NVIDIA Surround (ha egyáltalán felkínálja)

```diff
 <fullscreen>true</fullscreen>       <!-- exkluzív teljes képernyő a Surround-kijelzőn -->
-<res_width>3440</res_width>
-<res_height>1440</res_height>
+<res_width>5760</res_width>          <!-- vagy a kerettel korrigált érték, amit a Surround felkínál -->
+<res_height>1080</res_height>
-<fov>1.3333</fov>
+<fov>0.6667</fov>
+<menuwidthscale>0.34</menuwidthscale>  <!-- 1920/5760 -->
```
Ablakkezelés nem kell (`-Preset k4-surround` csak ellenőrzi, hogy van-e ≥5000 px széles kijelző).

## k6-virtual — virtuális széles monitor + kompozitor (fejlesztési út)

```diff
-<fullscreen>true</fullscreen>
+<fullscreen>false</fullscreen>
+<borderless>true</borderless>        <!-- Borderless a virtuális monitoron (Screen = a virtuális kijelző) -->
-<fov>1.3333</fov>
+<fov>0.6667</fov>
+<confinemouse>true</confinemouse>    <!-- az egér ne hagyja el a láthatatlan virtuális monitort -->
```

## custom — saját téglalap

`.\x4span.ps1 -Preset custom -Area "x,y,w,h"`; a `res_width/res_height` legyen `w`/`h`. Ha a téglalap nagyobb a virtuális
asztalnál (most 7280×1440), az x4span `WS_POPUP` stílust is ad, mert nélküle a Windows 7300×1460-ra vágja (mérve).

## Visszaállítás (mindegyiknél)

1. `.\x4span.ps1 -Restore` (amíg a játék fut), vagy egyszerűen lépj ki a játékból.
2. `copy D:\X4-userdata\6144\config.xml.before-x4span D:\X4-userdata\6144\config.xml` (a játék bezárt állapotában).
3. Ha átrendezted: Windows Kijelző → laptop | Dell | ultrawide, Y = 126; NVIDIA egyedi felbontás törlése.
