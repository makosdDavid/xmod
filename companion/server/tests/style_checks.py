"""Game-look checks of the shell (release gate part, run by smoke_shell.py; real browser, real build).

The UI follows X4: Foundations' own menus: colours 1:1 from the game's libraries/colors.xml UI mappings,
the bundled Titillium Web font (SIL OFL 1.1), flat panels, no gradients. These checks read the COMPUTED
styles of the real elements, the font the browser actually rendered with (CDP CSS.getPlatformFontsForNode),
the network log (font files 200, nothing external) and WCAG contrast of the text on its real background.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from urllib.parse import urlparse

# the game's values (libraries/colors.xml) the shell must show; (r, g, b, a) with a in 0..1
GAME = {
    "row_title": (0, 105, 179, 160 / 255),                 # azure_dark_alpha_160 -> header bars
    "row_title_background": (0, 60, 102, 224 / 255),       # azure_very_dark_alpha_224 -> sub-headers
    "row_background_selected": (77, 181, 255, 160 / 255),  # azure_bright_alpha_160_glow -> selected row
    "frame_background_semitransparent": (0, 0, 0, 248 / 255),  # black_alpha_248 -> panels
    "frameborder_default": (255, 255, 255, 12 / 255),      # white_alpha_12 -> panel frame
    "dropdown_border_default": (0, 105, 179, 160 / 255),   # azure_dark_alpha_160_glow -> menus / popovers
    "dropdown_background_options": (0, 0, 0, 1.0),         # black -> menus / popovers
    "text_normal": (255, 255, 255, 1.0),                   # white
    "azure_bright": (77, 181, 255, 1.0),                   # highlight
}

# JS helpers in the page: colour parsing, compositing over black, WCAG contrast, effective background
JS_LIB = r"""
window.__st = (() => {
  // rgb()/rgba() exactly; anything else (oklab(), color(srgb …) from color-mix) through a 1x1 canvas
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const g = cv.getContext('2d', { willReadFrequently: true });
  const parse = (s) => { const m = String(s).match(/^rgba?\(([^)]+)\)$/);
    if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    if (!s || s === 'none') return null;
    g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255]; };   // ImageData is not premultiplied
  const over = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); if (!a) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat([a]); };
  // the background the element's text is drawn on: its own + all ancestors' background colours, over the page
  const bgOf = (el) => { const layers = []; for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) layers.push(c); }
    let acc = [0, 0, 0, 1]; for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc); return acc; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const contrast = (fg, bg) => { const t = over(fg, bg), a = lum(t), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  const textContrast = (el) => { const bg = bgOf(el); const fg = parse(getComputedStyle(el).color); return fg ? contrast(fg, bg) : 0; };
  return { parse, bgOf, contrast, textContrast };
})(); true
"""


# semantic colours, verified in libraries/colors.xml (9.x) and, for the holomap ones, equal to what
# GetHoloMapColors() returned in a live session
HOLO = {  # map icons + object list rows (menu_map.lua:7348-7364)
    "playercolor": (77, 255, 77),              # holomap_player :809 green_bright
    "currentplayershipcolor": (204, 255, 204),  # holomap_playerlocation_playerowned :810 green_extra_bright
    "friendcolor": (0, 149, 255),              # holomap_neutral :807 azure (map icons only)
    "enemycolor": (255, 153, 153),             # holomap_enemy :805 red_very_bright
    "hostilecolor": (255, 0, 0),               # holomap_hostile :803 red
    "missioncolor": (255, 191, 0),             # holomap_missiontarget :815 amber
}
TEXT = {
    "text_normal": (255, 255, 255),            # :267
    "text_mission": (255, 191, 0),             # :310 amber_glow
    "text_mission_inactive": (179, 134, 0),    # :311 amber_dark
    "text_enemy": (255, 153, 153),             # :288
    "text_hostile": (255, 0, 0),               # :289
    "text_logbook_highlight": (255, 0, 0),     # :307
}


def near(c, want, tol_rgb=1.5, tol_a=0.006) -> bool:
    return bool(c) and all(abs(c[i] - want[i]) <= tol_rgb for i in range(3)) and abs(c[3] - want[3]) <= tol_a


async def style_checks(b, base: str, check, map_ready: str, dist) -> None:
    """open the shell (default 'nav' layout, map view) and check the game look"""
    p = await b.page("about:blank", 1600, 1000)
    await p.call("Network.enable")
    await p.goto(base + "/")
    await asyncio.sleep(0.8)
    await p.eval("localStorage.clear(); localStorage.setItem('x4c.lang', 'en'); localStorage.setItem('x4c.ui', JSON.stringify({view: 'map', font: 100})); true")
    p.events.clear()
    await p.goto(base + "/")
    await p.wait_for(map_ready, 25)
    await p.eval("document.fonts.ready.then(() => true)")
    await asyncio.sleep(1.0)
    await p.eval(JS_LIB)

    # ---- the font: declared, loaded, and really used for rendering (not a fallback)
    st = await p.eval("""(() => { const fam = getComputedStyle(document.body).fontFamily;
        const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'X4UI');
        return [fam, faces.length, faces.filter((f) => f.status === 'loaded').map((f) => f.weight).sort().join(','), document.fonts.check('14px X4UI')]; })()""")
    check(st and st[0].replace('"', "").startswith("X4UI") and st[1] == 6 and st[2] and st[3],
          f"font: body font-family starts with the bundled X4UI (Titillium Web), 6 faces declared, loaded weights [{st and st[2]}] ({st})")
    used = {}
    await p.call("DOM.enable")
    await p.call("CSS.enable")
    # mark the first element of each kind that holds its own text (CSS.getPlatformFontsForNode reports the node's own text runs)
    await p.eval("""(() => { const own = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const kinds = { head: 'section[data-panel] header h2, section[data-panel] header .x4map-title, section[data-panel] header span',
                        nav: 'nav [role=tab] *', body: 'section[data-panel=objects] [data-key] *, section[data-panel=info] *' };
        for (const [k, sel] of Object.entries(kinds)) { const e = [...document.querySelectorAll(sel)].find((x) => x.offsetParent && own(x)); if (e) e.setAttribute('data-x4font', k); }
        return true; })()""")
    doc = await p.call("DOM.getDocument", {"depth": -1})
    for name, sel in (("panel header", "[data-x4font=head]"), ("nav tab", "[data-x4font=nav]"), ("body text", "[data-x4font=body]")):
        q = await p.call("DOM.querySelector", {"nodeId": doc["root"]["nodeId"], "selector": sel})
        if not q.get("nodeId"):
            used[name] = None
            continue
        fonts = await p.call("CSS.getPlatformFontsForNode", {"nodeId": q["nodeId"]})
        used[name] = sorted({(f["familyName"], bool(f.get("isCustomFont"))) for f in fonts.get("fonts", [])})
    ok = all(v and any(fam.startswith("Titillium Web") and custom for fam, custom in v) for v in used.values())
    check(ok, f"font: the rendered glyphs come from the bundled Titillium Web web font ({used})")

    # ---- network: the font files load (200), nothing leaves the server's own origin
    for _ in range(3):
        await p.eval("1")
    origin = urlparse(base)
    reqs = [e["params"] for e in p.events if e.get("method") == "Network.requestWillBeSent"]
    resps = [e["params"] for e in p.events if e.get("method") == "Network.responseReceived"]
    external = sorted({r["request"]["url"] for r in reqs
                       if urlparse(r["request"]["url"]).scheme in ("http", "https", "ws", "wss")
                       and urlparse(r["request"]["url"]).netloc != origin.netloc})
    fonts = [(urlparse(r["response"]["url"]).path.rsplit("/", 1)[-1], r["response"]["status"], r["response"].get("mimeType"))
             for r in resps if r["response"]["url"].endswith(".woff2")]
    check(not external, f"network: no request leaves {origin.netloc} ({external[:5]})")
    check(fonts and all(s == 200 for _, s, _m in fonts) and all(m == "font/woff2" for _, _s, m in fonts),
          f"network: the bundled font files load with HTTP 200, font/woff2 ({fonts})")
    lic = Path(dist) / "assets" / "titillium-web-OFL-1.1-LICENSE.txt"
    woffs = sorted(x.name for x in (Path(dist) / "assets").glob("titillium-web-*.woff2"))
    lic_ok = lic.is_file() and "SIL OPEN FONT LICENSE Version 1.1" in lic.read_text(encoding="utf-8") and "Accademia di Belle Arti di Urbino" in lic.read_text(encoding="utf-8")
    check(lic_ok and len(woffs) == 6, f"build: the 6 Titillium Web files ship with their SIL OFL 1.1 licence next to them ({len(woffs)} files, {lic.name if lic.is_file() else 'licence MISSING'})")

    # ---- computed colours of the key elements = the game's values
    st = await p.eval("""(() => { const s = document.querySelector('section[data-panel=objects]') || document.querySelector('section[data-panel]');
        const h = s.querySelector('header'), cs = getComputedStyle(s), hs = getComputedStyle(h);
        return { panelBg: __st.parse(cs.backgroundColor), frame: __st.parse(cs.borderTopColor), frameW: cs.borderTopWidth, radius: cs.borderTopLeftRadius,
                 headBg: __st.parse(hs.backgroundColor), headFg: __st.parse(hs.color), upper: hs.textTransform, tracking: hs.letterSpacing, fs: hs.fontSize }; })()""")
    check(near(st["panelBg"], GAME["frame_background_semitransparent"]) and near(st["frame"], GAME["frameborder_default"]) and st["frameW"] == "1px"
          and float(st["radius"].rstrip("px") or 0) <= 2.01,
          f"panel = frame_background_semitransparent {st['panelBg']}, 1px frameborder_default {st['frame']}, square corners {st['radius']}")
    check(near(st["headBg"], GAME["row_title"]) and near(st["headFg"], GAME["text_normal"]) and st["upper"] == "uppercase",
          f"panel header bar = row_title {st['headBg']}, white uppercase text, tracking {st['tracking']} ({st['headFg']}, {st['upper']})")
    nav = await p.eval("""(() => { const t = document.querySelector('nav [role=tab][aria-selected=true]'), cs = getComputedStyle(t);
        return [__st.parse(cs.backgroundColor), __st.parse(cs.borderTopColor), cs.boxShadow !== 'none', cs.textTransform]; })()""")
    check(near(nav[0], GAME["row_title"]) and near(nav[1], GAME["azure_bright"]) and nav[2],
          f"active navigation tab = on-state: row_title fill, azure_bright border, glow ({nav})")

    # selected row: click the first object of the Objects list
    clicked = await p.click_el("document.querySelector('section[data-panel=objects] [data-key]')")
    await asyncio.sleep(0.6)
    sel = await p.eval("""(() => { const r = document.querySelector('section[data-panel=objects] .x4-sel'); if (!r) return null;
        const cs = getComputedStyle(r); return [__st.parse(cs.backgroundColor), cs.boxShadow !== 'none', __st.textContrast(r),
        Math.min(...[...r.querySelectorAll('span,div')].filter((e) => e.textContent.trim() && !e.children.length).map((e) => __st.textContrast(e)))]; })()""")
    check(clicked and sel and near(sel[0], GAME["row_background_selected"]) and sel[1] and sel[2] >= 4.5 and sel[3] >= 4.5,
          f"selected list row = row_background_selected with glow, its text >= 4.5:1 ({sel})")

    # a menu (Modules): black, dropdown border, label = sub-header, focused item = selected look
    await p.click_el(f"[...document.querySelectorAll('nav button')].find((e) => e.textContent.includes('Modules'))")
    await asyncio.sleep(0.5)
    menu = await p.eval("""(() => { const m = document.querySelector('[data-slot=dropdown-menu-content]'); if (!m) return null;
        const cs = getComputedStyle(m), l = m.querySelector('[data-slot=dropdown-menu-label]');
        return [__st.parse(cs.backgroundColor), __st.parse(cs.borderTopColor), cs.borderTopLeftRadius, l ? __st.parse(getComputedStyle(l).backgroundColor) : null]; })()""")
    check(menu and near(menu[0], GAME["dropdown_background_options"]) and near(menu[1], GAME["dropdown_border_default"]) and near(menu[3], GAME["row_title_background"]),
          f"menu = black with the game's dropdown border, its label a row_title_background sub-header ({menu})")
    await p.key("Escape")
    await asyncio.sleep(0.3)

    # ---- no gradient backgrounds anywhere (elements and their ::before / ::after)
    grads = await p.eval("""(() => { const out = []; for (const e of document.querySelectorAll('*')) for (const pe of [null, '::before', '::after']) {
          const bi = getComputedStyle(e, pe).backgroundImage; if (bi && bi.includes('gradient')) out.push((e.className && e.className.baseVal === undefined ? String(e.className).slice(0, 60) : e.tagName) + (pe || '')); }
        return out; })()""")
    check(not grads, f"no gradient backgrounds ({grads[:5]})")

    # ---- readability: WCAG AA (4.5:1) for body text on the near-black panels and on the bars
    ctr = await p.eval("""(() => { const pick = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent && e.textContent.trim()).slice(0, 40);
        const worst = (els) => els.length ? Math.round(Math.min(...els.map((e) => __st.textContrast(e))) * 100) / 100 : null;
        return { body: worst(pick('section[data-panel] [data-key] span, section[data-panel] [data-key] div')),
                 muted: worst(pick('section[data-panel] .text-muted-foreground')),
                 header: worst(pick('section[data-panel] header h2, section[data-panel] header .x4map-title')),
                 nav: worst(pick('nav [role=tab]')), top: worst(pick('header b')) }; })()""")
    low = {k: v for k, v in ctr.items() if v is None or v < 4.5}
    check(not low, f"text contrast >= 4.5:1 (WCAG AA) on its real background: {ctr}")

    # ---- focus ring visible (keyboard)
    await p.click(5, 300)
    await p.key("Tab", code="Tab", vk=9)
    await asyncio.sleep(0.2)
    fr = await p.eval("""(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e);
        return [e.tagName, cs.outlineStyle, cs.outlineWidth, __st.parse(cs.outlineColor), e.matches(':focus-visible')]; })()""")
    check(fr and fr[1] != "none" and float(fr[2].rstrip("px")) >= 2 and near(fr[3], GAME["azure_bright"]) and fr[4],
          f"keyboard focus ring visible: 2px azure_bright outline ({fr})")
    await b.close_page(p)


def rgbeq(c, want) -> bool:
    return bool(c) and all(abs(c[i] - want[i]) <= 1.5 for i in range(3)) and (len(c) < 4 or c[3] > 0.99)


async def color_checks(b, base: str, check, map_ready: str) -> None:
    """semantic colours (relation / ownership / mission) on the map and in every list = the game's"""
    p = await b.page("about:blank", 1920, 1040)
    await p.goto(base + "/")
    await asyncio.sleep(0.8)
    await p.eval("localStorage.clear(); localStorage.setItem('x4c.lang', 'en'); localStorage.setItem('x4c.ui', JSON.stringify({view: 'map', font: 100})); true")
    await p.goto(base + "/")
    await p.wait_for(map_ready, 25)
    await asyncio.sleep(1.5)
    await p.eval(JS_LIB)
    holo_js = json.dumps(HOLO)
    # the theme the game (or the simulator) sends = the verified game values
    th = await p.eval("(() => { const h = (window.__x4map.S.theme || {}).holo || {}; const o = {}; for (const k of Object.keys(" + holo_js + ")) o[k] = h[k] ? [h[k].r, h[k].g, h[k].b] : null; return o; })()")
    bad = {k: v for k, v in th.items() if not v or tuple(v) != HOLO[k]}
    check(not bad, f"colours: the theme's holomap colours are the verified game values ({bad or 'all ' + str(len(th))})")

    # expected category of an object: the game's list rule / icon rule, computed here from the raw flags
    CAT = """const cur = S.player && S.player.object ? String(S.player.object.id) : null;
      const cat = (o) => o.mt ? 'missioncolor' : (o.pl || o.o === 'player' || o.k) ? (String(o.id) === cur ? 'currentplayershipcolor' : 'playercolor') : o.h ? 'hostilecolor' : o.e ? 'enemycolor' : 'neutral';"""
    # ---- Sector objects list (nav preset) and the map icon colour of the same objects.
    # The data may lack an enemy / hostile / mission target in the shown sector: three test objects (enemy, hostile, mission
    # target) are kept in the scan for a moment (the simulator keeps replacing the scan) and the list re-rendered.
    await p.eval("""(() => { const m = window.__x4map, S = m.S, sid = m.currentSid(), P = S.player.object;
        const add = () => { const sc = S.scans[sid]; if (!sc || !sc.objs) return; if (sc.objs.some((o) => o.id === 'x4ctest_enemy')) return;
          sc.objs.push({ id: 'x4ctest_enemy', c: 'ship_s', n: 'X4C test enemy', o: 'argon', e: true, x: P.x + 60, z: P.z + 60 },
                       { id: 'x4ctest_hostile', c: 'ship_s', n: 'X4C test hostile', o: 'xenon', h: true, e: true, x: P.x + 60, z: P.z - 60 },
                       { id: 'x4ctest_mission', c: 'ship_m', n: 'X4C test mission target', o: 'teladi', mt: true, x: P.x - 60, z: P.z + 60 });
          m.c.bus.emit('theme'); };
        add(); window.__x4ctest = setInterval(add, 100); setTimeout(() => clearInterval(window.__x4ctest), 8000); return true; })()""")
    await p.wait_for("['x4ctest_enemy', 'x4ctest_hostile', 'x4ctest_mission'].every((k) => document.querySelector('section[data-panel=objects] [data-key=' + k + ']'))", 7, 0.1)
    res = await p.eval("""(() => { const S = window.__x4map.S, m = window.__x4map; """ + CAT + """
        const H = """ + holo_js + """, sid = m.currentSid(), objs = ((S.scans[sid] || {}).objs || []);
        const byId = new Map(objs.map((o) => [String(o.id), o])); if (S.player && S.player.object) byId.set(String(S.player.object.id), { ...S.player.object, pl: true });
        const seen = {}, bad = [];
        for (const row of document.querySelectorAll('section[data-panel=objects] [data-key]')) {
          const o = byId.get(row.getAttribute('data-key')); if (!o) continue;
          const c = cat(o), want = c === 'neutral' ? [255, 255, 255] : H[c];
          const name = row.querySelector('span.truncate.font-medium'), got = name && __st.parse(getComputedStyle(name).color);
          const icon = m.colorOf(o.id === (S.player.object || {}).id ? { ...o, pl: true } : o), iwant = c === 'neutral' ? H.friendcolor : H[c];
          const okL = got && [0, 1, 2].every((i) => Math.abs(got[i] - want[i]) <= 1.5);
          const okI = (o.c === 'gate' || o.c === 'highwayentrygate') || (icon && icon.r === iwant[0] && icon.g === iwant[1] && icon.b === iwant[2]);
          seen[c] = (seen[c] || 0) + 1; if (!okL || !okI) bad.push([c, o.n, got, icon]);
        }
        return { seen, bad: bad.slice(0, 5) }; })()""")
    check(res and res["seen"] and not res["bad"] and all(k in res["seen"] for k in ("playercolor", "currentplayershipcolor", "neutral", "hostilecolor", "enemycolor", "missioncolor")),
          f"Sector objects list text = the game's list rule (neutral white) and the map icon = holomap colour (neutral friendcolor), per category {res and res['seen']} ({res and res['bad']})")
    # ---- legend swatches (Own, Neutral, Enemy, Hostile, Mission target) drawn in the holomap colours
    await p.eval("(() => { const m = window.__x4map; m.cfg.legend = true; m.renderLegend(); return true; })()")
    await asyncio.sleep(0.4)
    lg = await p.eval("""(() => { const cvs = [...window.__x4map.legendBox.querySelectorAll('.lgi canvas')].slice(0, 5);
        return cvs.map((cv) => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, cnt = new Map();
          for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) { const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
          return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]); }); })()""")
    want = [HOLO[k] for k in ("playercolor", "friendcolor", "enemycolor", "hostilecolor", "missioncolor")]
    ok = lg and len(lg) == 5 and all(any(tuple(map(int, s.split(","))) == w for s in sw) for sw, w in zip(lg, want))
    check(ok, f"map legend Own / Neutral / Enemy / Hostile / Mission swatches = holomap colours ({lg})")
    await p.eval("(() => { const m = window.__x4map; m.cfg.legend = false; m.renderLegend(); return true; })()")
    # ---- guidance line: drawn from player.gd in missioncolor (amber_glow)
    gd = await p.eval("""(() => { const m = window.__x4map; m.dirty = true; m.frame(performance.now()); const G = m.lastGuidance;
        if (!G || !G.runs.length || !G.runs[0] || G.runs[0].length < 2) return { drawn: !!G, color: G && G.color };
        const a = G.runs[0][0], b2 = G.runs[0][1], dpr = window.devicePixelRatio || 1, x = Math.round((a[0] + b2[0]) / 2 * dpr), y = Math.round((a[1] + b2[1]) / 2 * dpr);
        const d = m.canvas.getContext('2d').getImageData(x - 3, y - 3, 7, 7).data; let best = 1e9;
        for (let i = 0; i < d.length; i += 4) best = Math.min(best, Math.abs(d[i] - 255) + Math.abs(d[i + 1] - 191) + Math.abs(d[i + 2] - 0));
        return { drawn: true, color: G.color, pixel: best, gd: !!m.S.player.gd }; })()""")
    c = gd and gd.get("color")
    has_gd = await p.eval("!!(window.__x4map.S.player && window.__x4map.S.player.gd)")
    check((not has_gd) or (gd and gd.get("drawn") and c and (c["r"], c["g"], c["b"]) == HOLO["missioncolor"] and gd.get("pixel", 999) <= 40),
          f"mission guidance (from player.gd) drawn in missioncolor = amber_glow #ffbf00, pixel on the line matches ({gd if has_gd else 'N/A: no player.gd in this data (bridge older than v130)'})")

    # ---- Property list (fleet preset): own -> playercolor, the ship you are in -> currentplayershipcolor
    await p.eval("window.__x4ui.applyPreset('fleet'); true")
    await asyncio.sleep(1.5)
    res = await p.eval("""(() => { const S = window.__x4map.S; """ + CAT + """ const H = """ + holo_js + """, seen = {}, bad = [];
        for (const row of document.querySelectorAll('section[data-panel=property] [data-key]')) {
          const e = S.property.get(row.getAttribute('data-key')); const n = row.querySelector('[data-list-name]'); if (!e || !n) continue;
          const c = cat({ ...e, k: e.k || 'ship' }), got = __st.parse(getComputedStyle(n).color), want = H[c];
          seen[c] = (seen[c] || 0) + 1; if (!got || [0, 1, 2].some((i) => Math.abs(got[i] - want[i]) > 1.5)) bad.push([c, e.n, got]); }
        return { seen, bad: bad.slice(0, 5) }; })()""")
    check(res and res["seen"].get("playercolor") and not res["bad"], f"Property list names = playercolor / currentplayershipcolor / missioncolor ({res})")

    # ---- Missions, Factions, Logbook (all-modules preset)
    await p.eval("window.__x4ui.applyPreset('all'); true")
    await asyncio.sleep(1.8)
    res = await p.eval("""(() => { const out = {};
        const col = (sel) => [...document.querySelectorAll(sel)].map((e) => __st.parse(getComputedStyle(e).color).slice(0, 3).join(','));
        out.missionActive = col('[data-mission-name=active]'); out.missionInactiveName = col('[data-mission-name=inactive]').slice(0, 3);
        out.targetActive = col('[data-mission-target=active]'); out.targetInactive = col('[data-mission-target=inactive]').slice(0, 3);
        out.hostile = col('[data-relation=hostile]'); out.enemy = col('[data-relation=enemy]'); out.normal = col('[data-relation=normal]').slice(0, 3);
        out.logHl = col('section[data-panel=log] [data-log-hl]').slice(0, 3);
        const rows = [...document.querySelectorAll('section[data-panel=log] [data-key]')];
        out.logNormal = rows.filter((r) => !r.hasAttribute('data-log-hl')).slice(0, 3).map((r) => __st.parse(getComputedStyle(r).color).slice(0, 3).join(','));
        out.logSep = rows.slice(0, 3).map((r) => { const cs = getComputedStyle(r); return [cs.borderBottomWidth, __st.parse(cs.borderBottomColor)]; });
        return out; })()""")
    s = lambda t: ",".join(str(v) for v in t)
    allm = lambda arr, want: bool(arr) and all(x == s(want) for x in arr)
    check(allm(res["missionActive"], TEXT["text_mission"]) and allm(res["targetActive"], TEXT["text_mission"]) and
          (not res["targetInactive"] or allm(res["targetInactive"], TEXT["text_mission_inactive"])) and
          (not res["missionInactiveName"] or allm(res["missionInactiveName"], TEXT["text_normal"])),
          f"Missions: active mission + its target text_mission #ffbf00, inactive targets text_mission_inactive #b38600, inactive titles white "
          f"({res['missionActive']}, {res['targetActive']}, {res['targetInactive']}, {res['missionInactiveName']})")
    check((res["hostile"] or res["enemy"]) and (not res["hostile"] or allm(res["hostile"], TEXT["text_hostile"])) and
          (not res["enemy"] or allm(res["enemy"], TEXT["text_enemy"])) and allm(res["normal"], TEXT["text_normal"]),
          f"Factions: hostile text_hostile #ff0000, enemy text_enemy #ff9999, others text_normal ({res['hostile'][:2]}, {res['enemy'][:2]}, {res['normal'][:2]})")
    sep_ok = res["logSep"] and all(w == "1px" and near(c2, GAME["row_title"]) for w, c2 in res["logSep"])
    no_log = not res["logSep"]
    check(no_log or (allm(res["logNormal"], TEXT["text_normal"]) and (not res["logHl"] or allm(res["logHl"], TEXT["text_logbook_highlight"])) and sep_ok),
          f"Logbook: text_normal, highlighted entries text_logbook_highlight, entries separated by a 1px row_title line ({'N/A: no entries in this data' if no_log else (res['logNormal'][:1], res['logHl'][:1], res['logSep'][:1])})")
    await b.close_page(p)
