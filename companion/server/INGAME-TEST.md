# Első éles próba – 10 perc (a legkockázatosabb feltevések elöl)

Előtte: `run.cmd` fut, böngésző a `http://127.0.0.1:8788` címen, a mod az `extensions\x4_companion\`-ben,
Protected UI Mode ki. A játék indítása: `-debug all -logfile debuglog.txt` (a log miatt). Ha valami nem stimmel,
ne javítsd kézzel: írd fel a sorszámot, és küldd a `logs\x4companion.log`-ot + a `debuglog.txt`-t.

| # | Mit nézz | Rendben, ha | Ha nem |
|---|---|---|---|
| 1 | Mentés betöltése után 10 mp; felső sáv állapota | „élő”, a kapitánynév és a kredit látszik | debuglog: `x4_companion` sorok; ha „SN Pipes API not available” → SN nincs betöltve |
| 2 | Állapot fül → „Kikapcsolt források” | „nincs” (vagy csak `p.speed`) | a felsorolt forrásnevek = mely játékfüggvény nem működik így |
| 3 | Állapot fül → „Híd költsége / képkocka” és a csatornatábla | átlag < 0,5 ms, egyik csatorna sem „KI” | jegyezd fel a legdrágább csatornát (a híd magától ritkít) |
| 4 | Galaxisnézet (`g` vagy gyorsgomb) vs. a játék térképe | **csak** a felfedezett szektorok; ismeretlen felé „?” | képernyőkép mindkettőről – ez az ismertségi szabály próbája |
| 5 | Szektornézet: a te jelölőd (sárga „TE”) a helyén; repülj egyenesen 10 mp-ig | a nyíl a haladás irányába mutat; Állapot → yaw-konvenció „a” vagy „b” | ha „c” vagy rossz irány: írd fel |
| 6 | Szektornézet: más hajók száma vs. a játék térképe ugyanott | közel azonos; a radaron kívüli hajók nem látszanak | ha több látszik: a `CanViewLiveData` szabály mást jelent |
| 7 | Állapot → „Kapuk (MD)” | „received”, a szám > 0; a szektorban kapuk a célszektor nevével | „requested” marad → az MD-fájl nem fut |
| 8 | Hotkey Management → Hotkey Bindings: rendelj gombot a „Companion: galaxis / szektor nézet” és „Companion: következő saját hajó” sorhoz; nyomd meg repülés közben | a böngésző vált / kijelöl, felül „Gyorsgomb: …” | Állapot → „Gyorsgombok” sor (0 = nem regisztrált) |
| 9 | Kattints a böngészőre (fókuszvesztés) 15 mp-ig | „játék háttérben”, szürke, adatok megmaradnak; Borderless + `-nocputhrottle` esetén tovább frissül (forrás: md) | exkluzív teljes képernyőn ez várt; a felület nem írhat „nincs kapcsolat”-ot |
| 10 | Tulajdon panel: hajók száma vs. játék (Birtokok) | egyezik; a parancs oszlop értelmes | jegyezd fel a hiányzókat |
| 11 | Napló: várj egy új bejegyzésre (vagy dokkolj) | megjelenik; riasztásnál piros felirat + villogó fül | |
| 12 | Felső sáv „Vezérlés engedélyezése” → egy saját hajón „Megnyitás a játék térképén” | a játékban megnyílik a térkép a hajóra fókuszálva; felül „✓ openmap” | ha másik menü nyitva: üzenet, ez szándékos |
| 13 | `/reloadui` a játék konzolján | 5 mp-en belül újra „élő” | |

Utána: ugorj át egy kapun – a térkép magától az új szektorra és a hajóra áll.
