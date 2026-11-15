# Első éles próba v1.1 – 10 perc (a legkockázatosabb feltevések elöl)

Előtte: a szerver fut (`run.cmd`), böngésző a `http://127.0.0.1:8788` címen, a mod (v110) az `extensions\x4_companion\`-ben,
a térképikonok exportálva (`uv run --with pillow==11.3.0 python export_icons.py`, ~4 mp). Protected UI Mode ki.
A játék indítása `-debug all -logfile debuglog.txt`. Ha valami nem stimmel, ne javítsd kézzel: sorszám + `logs\x4companion.log` + `debuglog.txt`.

| # | Mit nézz | Rendben, ha | Ha nem |
|---|---|---|---|
| 1 | Betöltés után 10 mp: felső sáv | „élő”, név, kredit | debuglog `x4_companion` sorai |
| 2 | **Térkép (M a játékban) és a Companion egymás mellett, ugyanaz a szektor** | ugyanazok az ikonok (hajótípus, állomástípus, kapu, műhold), ugyanazok a színek (saját / semleges / ellenséges / támadó), a radar által látott terület világos | képernyőkép mindkettőről – ez a fő próba |
| 3 | Jelmagyarázat (térkép → Rétegek → Jelmagyarázat) | a fejléc „(a játék színei)” – nem „közelítő” | „közelítő”: a `GetHoloMapColors` nem jött át → Állapot → kikapcsolt források (`th.holo`) |
| 4 | Állapot → „Időmérés” | `qpc` vagy `qpc-k32`; a csatornatábla ms-oszlopai nem csupa 0 | `frame`: nincs óra – a „hívás/kocka” oszlop a mérés, ezt jegyezd fel |
| 5 | Állapot → „Kapuk (MD)” | „MD N kaput talált, átvéve N” – a két szám egyezik, N > 100 | ha átvéve ≠ talált: írd fel mindkettőt |
| 6 | Galaxis (2): kapukapcsolatok | a felfedezett szektorok közti összes kapuvonal megvan, ismeretlen felé „?” | képernyőkép |
| 7 | Saját hajó kijelölése (lista / térkép) | Info: parancssor; a térképen szaggatott vonal a parancs céljáig | |
| 8 | Útvonal kijelölése a játékban (Plot course) | sárgás szaggatott vonal a célig / a kapuig, galaxisban az útvonal | |
| 9 | Nagyítás ki–be: görgő, +/−, gombok | mindkét irányba azonnal reagál | |
| 10 | Hotkey Management → Hotkey Bindings: „Companion: következő nézet”, „vissza a térképre”, „nagyítás” | a böngésző vált, felül „Gyorsgomb: …” | Gyorsgombok nézet: hány regisztrált (17 kell; ha „pool full”, Hotkey Requests) |
| 11 | Ugrás kapun | a térkép az új szektorra és a hajóra áll | |
| 12 | `/reloadui` | 5 mp-en belül újra „élő” | |
