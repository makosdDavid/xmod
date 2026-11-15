# x4span — az X4 ablak kifeszítése több monitorra

Egy PowerShell-szkript, ami a futó X4 ablakát keret nélkülire állítja, és a választott monitorokra feszíti
(pozíció + méret), majd vissza tudja állítani. Csak dokumentált Win32 hívásokat használ. Kijelző-, NVIDIA- és
játékbeállítást **nem** változtat; a `config.xml`-t csak olvassa. A szükséges config-változásokat a `presets.md` írja le.

## Futtatás

PowerShell (Windows PowerShell 5.1 elég), ebben a mappában:

```powershell
powershell -ExecutionPolicy Bypass -File .\x4span.ps1 -List                 # monitorok + presetek
powershell -ExecutionPolicy Bypass -File .\x4span.ps1 -Preset k2-triple -WhatIf
powershell -ExecutionPolicy Bypass -File .\x4span.ps1 -Preset k2-triple -Simulate dell-uw-laptop   # "mi lenne, ha átrendezném"
powershell -ExecutionPolicy Bypass -File .\x4span.ps1 -Preset k2-triple       # élesben, a futó X4-re
powershell -ExecutionPolicy Bypass -File .\x4span.ps1 -Restore                # vissza
```

Rövidebben, a mellékelt indítóval (cmd-ből vagy dupla kattintás nélkül, ebben a mappában):

```bat
.\x4span.cmd -List
.\x4span.cmd K1 -WhatIf        :: K1=k1-uw-left K2=k2-triple K3=k3-triple-1080 K4=k4-surround K6=k6-virtual UW=single-uw
.\x4span.cmd K2
.\x4span.cmd -Restore
```

A `-WhatIf` csak kiírja a téglalapot és az elemzést: képpontszám a mai 3440×1440-hez képest, hova esik a célkereszt,
melyik monitoron az ablak melyik része látszik, mennyi a renderelt, de nem látható rész, és mekkora a képméret-ugrás
az egyes monitorokon (az EDID-ből olvasott mm/képpont alapján).

Presetek: `single-uw`, `k1-uw-left`, `k2-triple`, `k3-triple-1080`, `k4-surround`, `k6-virtual`, `custom -Area "x,y,w,h"`.
A téglalapokat mindig az aktuális Windows-elrendezésből számolja, tehát átrendezés után újra kell futtatni.

További kapcsolók: `-Handle 0x1234` (más ablakra, teszteléshez), `-NoActivate` (ne vegye el a fókuszt),
`-ZBottom` (az ablak a Z-sorrend aljára), `-Popup` (WS_POPUP stílus; a virtuális asztalnál nagyobb ablakhoz
automatikusan bekapcsol), `-Force` (lekicsinyített ablakot előbb visszaállít), `-ConfigPath`, `-StateDir`.

## Sorrend élesben

1. Játék bezárva → `config.xml` mentése, majd átírása a `presets.md` szerint (Windowed + `res_width/res_height`).
2. Játék indítása → mentés betöltése → `.\x4span.ps1 -Preset <név>`.
3. Ha valami rossz: `.\x4span.ps1 -Restore`, vagy kilépés a játékból.

## Visszavonás

- Ablak: `-Restore` — az első alkalmazás előtti stílust és téglalapot állítja vissza a `state\window-<hwnd>.json`
  alapján (többszöri preset-váltás után is az eredetit), majd törli az állapotfájlt. A játék újraindítása is
  visszaállít mindent, mert az x4span semmit nem ment el tartósan.
- Config: a mentett `config.xml.before-x4span` visszamásolása (a játék bezárt állapotában).
- Ha a Windows-elrendezést vagy az NVIDIA egyedi felbontást módosítottad: azt kézzel kell visszaállítani (`presets.md` vége).

## Tesztelve (2026-11-14)

- `-List`, `-WhatIf` minden presetre, `-Simulate dell-uw-laptop` és `uw-1080`: helyes téglalapok.
- Ablaklogika egy saját, ártalmatlan WinForms-ablakon (nem aktiválódik, a Z-sorrend alján van); az X4-et nem érintettem:
  `k1-uw-left` → kliensterület pontosan (−1920,0) 7280×1440; `single-uw` → (0,0) 3440×1440; `custom` 8602×1450 → pontos
  (automatikus WS_POPUP); `-Restore` → az eredeti stílus (0x16CF0000) és téglalap vissza.
- Mért Windows-korlát: WS_POPUP nélkül (keretes vagy csak keret-mentesített ablaknál) a Windows legfeljebb 7300×1460-ra
  enged (virtuális asztal + keret); WS_POPUP-pal 16384×2160 is átment.
- **Nem tesztelt:** hogy az X4 maga hogyan reagál (elfogadja-e a nagy ablakot, újraépíti-e a swapchaint). Ezt csak a
  játékban lehet kipróbálni.
