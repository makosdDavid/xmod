// i18next setup: English default, Hungarian = the texts of the original UI. The choice is persisted
// in localStorage (x4c.lang). Formatters (numbers, distances, times) follow the language (lib/format).
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import hu from "./hu.json";
import { makeFmt, type Fmt, type Lang, LANGS } from "@/lib/format";
import { STRINGS as MAP_STRINGS } from "@web/map-strings.js";

const KEY = "x4c.lang";

function stored(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (LANGS as string[]).includes(v)) return v as Lang;
  } catch { /* storage blocked */ }
  return "en";
}

// The map module's texts (web/map-strings.js, maintained with the map) are served by the same i18next
// instance in a flat namespace "map" (its keys are dotted and nest into each other, and it uses
// "{name}" placeholders), so the map follows the language switch like every other text.
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en, map: MAP_STRINGS.en },
    hu: { translation: hu, map: MAP_STRINGS.hu },
  },
  lng: stored(),
  fallbackLng: "en",
  ns: ["translation", "map"],
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** translator injected into the map (MapView option `t` / setTranslator); unknown keys fall back to English there */
export function mapT(key: string, params?: Record<string, unknown>): string {
  return i18n.t(key, {
    ...(params || {}), ns: "map", keySeparator: false, nsSeparator: false,
    interpolation: { prefix: "{", suffix: "}", escapeValue: false },
  } as never) as unknown as string;
}

export function currentLang(): Lang {
  return (LANGS as string[]).includes(i18n.language) ? (i18n.language as Lang) : "en";
}

export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* storage blocked */ }
  void i18n.changeLanguage(l);
}

/** formatter for the current language */
export function fmt(): Fmt { return makeFmt(currentLang()); }

/** plain translate function for non-React code (store, hotkeys, map translator) */
export const t = (key: string, vars?: Record<string, unknown>): string => i18n.t(key, vars as never) as unknown as string;

function syncHtml() { document.documentElement.lang = currentLang(); }
i18n.on("languageChanged", syncHtml);
syncHtml();

export default i18n;
