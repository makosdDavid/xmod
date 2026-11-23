"""Game-look checks of the shell (release gate part, run by smoke_shell.py; real browser, real build).

The UI follows X4: Foundations' own menus: colours 1:1 from the game's libraries/colors.xml UI mappings,
the bundled Titillium Web font (SIL OFL 1.1), flat panels, no gradients. These checks read the COMPUTED
styles of the real elements, the font the browser actually rendered with (CDP CSS.getPlatformFontsForNode),
the network log (font files 200, nothing external) and WCAG contrast of the text on its real background.
"""
from __future__ import annotations

import asyncio
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
