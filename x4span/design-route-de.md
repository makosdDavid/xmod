# Terv: „egyszer renderel, monitoronként torzít" (d út), tartalékként virtuális kijelző (e út)

Dátum: 2026-11-14. Kód nincs; ez az 1 oldalas műszaki terv. A számok a `x4span.ps1 -WhatIf` mért monitoradataiból
(EDID: ultrawide 797×334 mm, Dell 598×336 mm, laptop 344×194 mm) és saját számításból jönnek.

## Mit old meg, amit egy sima nagy ablak nem

Egy ablakban a játék egyetlen síkvetítést rajzol, egyetlen képpont-léptékkel. Ezért (1) a Dellen minden 1,344×
nagyobb, a laptopon 0,773× kisebb; (2) a keretek mögött eltűnik egy sáv, a keresztező vonalak elcsúsznak; (3) befelé
fordított szélső monitoron a kép a szélek felé nyúltnak látszik. A torzító réteg a kész képkockát monitoronként
újramintavételezi: léptékkiegyenlítés, keretkompenzáció, és a befelé fordított szárnyakra pontos perspektíva-javítás.
Ez utóbbi egzakt, mert a játék képe tűlyukkamera-vetítés: bármely más síkra (a szárnyra) egy homográfia vetíti át,
ugyanabból a szempontból nézve.

## Komponensek

1. **Ablak** — az x4span `k2-triple` presete (7280×1440, Windowed). Ez már kész.
2. **Torzító shader, 1. változat: ReShade-effekt** (`x4span_warp.fx`, HLSL-szerű ReShade FX). A ReShade a Vulkan
   prezentáláskor fut, a teljes képre (HUD-dal együtt). Pixelenként: kimeneti pixel → melyik monitor → a monitor síkján
   lévő 3D pont (mm, szög, távolság paraméterekből) → forráspixel = f·(x/z, y/z) + közép → bilineáris/bikubikus minta.
   Paraméterek: monitor-téglalapok (az x4span kiírja), mm-méretek, keretszélesség, szárnyszög, szemtávolság, a játék FOV-ja.
3. **2. változat: saját implicit Vulkan-layer** (C++, `vkQueuePresentKHR` + `vkGetPhysicalDeviceSurfaceCapabilitiesKHR`
   elfogása). Többlete: nagyobb felületméretet jelent a játéknak (pl. 8602×1440), saját képekbe rajzoltat, és ezt torzítja
   a valódi 7280×1440-es swapchainbe — így az ultrawide natív élességű marad. Kiindulópont: a Vulkan-Loader layer-minta
   és az OBS `vulkan-capture.c` (GPL-2.0) prezentációs horga.
4. **(e) tartalék: virtuális kijelző + kompozitor** — IddCx virtuális monitor (pl. VirtualDrivers/Virtual-Display-Driver,
   MIT, aláírt) tetszőleges szélességgel; a játék natívan Borderless módban fut rajta; egy saját D3D11 alkalmazás DXGI
   Desktop Duplicationnel olvassa, ugyanazzal a torzítással rajzolja a három valódi monitorra kiterjedő ablakába.

## Számok (Dell | ultrawide | laptop, 7280 px forrás)

| | ReShade (1.) | Saját layer (2.) | Virtuális kijelző (e) |
|---|---|---|---|
| Renderelt képpont | 10,5 MP (2,12×) | 12,4 MP (8602×1440, 2,51×) | ~12,4 MP |
| Ultrawide élessége | 2911 forrás-px 3440-re nagyítva (1,18×) | natív | natív |
| Dell / laptop | 2184→1920 (0,88×) / 1257→1920 (1,53×) | 2581→1920 / 1485→1920 | ugyanaz |
| Kihasználatlan forrás | 927 px a jobb szélen (a laptop kisebb) | ~0 | ~0 |
| Többlet-késleltetés | ~0 (egy teljes képernyős shader-menet) | ~0 | +1–2 képkocka (becslés) |
| Munka (becslés) | 1–3 nap | 1–3 hét | 2–4 hét |

A ReShade-változatban az aszimmetria (bal szárny 598 mm, jobb 344 mm) miatt a bal oldal szabja meg a léptéket:
3,65 forrás-px/mm.

## Kockázatok

- **Egér:** a játék a forráskoordinátában gondolkodik. Ha a kurzort a játék maga rajzolja a képbe, a torzítás vele
  együtt mozgatja, és a kattintás helyes. Ha a Windows hardveres kurzora látszik, a szárnyakon elcsúszik. Hogy az X4
  melyiket használja: **nem ellenőrzött**. A menük a középen maradnak (`menuwidthscale 0.47`), ott a torzítás közel 1:1.
- **ReShade + X4 Vulkan:** az előző tanulmány szerint a 6.7.1 utáni verziók elsötétítik a képet. A Streamline/DLSS
  és az FSR képkocka-generálás melletti viselkedés **nem ellenőrzött**; a 3070 Ti DLSS-FG-t nem tud, FSR-FG mellett a
  generált képkockák is átmennek-e a shaderen: **nem ellenőrzött**.
- **Erős szárnyszögnél** a külső szél felé eső irányokhoz nagyon széles forráskép kell (tan-növekedés), ezért a
  szárnyszög és a FOV kölcsönösen korlátozza egymást. Ezt a paraméterező kiírja.
- **(e):** illesztőprogram-telepítés (a te döntésed); a játék egy láthatatlan monitoron fut (`confinemouse=true`
  kell); a virtuális kijelzőt a VDD-ben az NVIDIA GPU-hoz kell rendelni, különben adapterek közötti másolás lesz.
- Az egész csak akkor ér valamit, ha a protokoll 1–5. lépése (az X4 elfogadja-e a 7280×1440-es ablakot) sikeres.
