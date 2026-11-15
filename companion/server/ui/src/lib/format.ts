// Locale-aware, null-safe formatters. Every function returns a string, or null when there is no usable
// value (null, undefined, NaN, ±Infinity, empty / non-numeric string). Callers hide a row, cell or
// section when the result is null — nothing ever prints "null", "undefined" or "NaN".
// Pure (no DOM, no i18next instance): the unit templates come straight from the token files, so the
// formatters are unit-tested in node (format.test.ts).
import en from "@/i18n/en.json";
import hu from "@/i18n/hu.json";

export type Lang = "en" | "hu";
export const LANGS: Lang[] = ["en", "hu"];
const DICTS: Record<Lang, typeof en> = { en, hu };
const LOCALES: Record<Lang, string> = { en: "en-US", hu: "hu-HU" };

export function fill(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (vars[k] === undefined ? "" : String(vars[k])));
}

/** finite number from a number or a numeric string, else null */
export function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** non-empty trimmed text, else null (numbers are stringified) */
export function text(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

export interface Fmt {
  lang: Lang;
  locale: string;
  num(v: unknown, digits?: number): string | null;
  signed(v: unknown): string | null;
  pct(v: unknown): string | null;
  money(v: unknown, short?: boolean): string | null;
  dist(m: unknown): string | null;
  speed(v: unknown): string | null;
  seconds(v: unknown, digits?: number): string | null;
  dur(s: unknown): string | null;
  gameTime(t: unknown): string | null;
  ago(gt: unknown, now: unknown): string | null;
  compare(a: string, b: string): number;
}

const cache = new Map<Lang, Fmt>();

export function makeFmt(lang: Lang): Fmt {
  const hit = cache.get(lang);
  if (hit) return hit;
  const d = DICTS[lang] || DICTS.en;
  const locale = LOCALES[lang] || LOCALES.en;
  const nf = [0, 1, 2].map((n) => new Intl.NumberFormat(locale, { maximumFractionDigits: n }));
  const nfd = (digits: number) => nf[Math.max(0, Math.min(2, digits | 0))];
  const coll = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const pad = (n: number) => String(n).padStart(2, "0");

  const f: Fmt = {
    lang,
    locale,
    num(v, digits = 0) {
      const n = toNum(v);
      return n === null ? null : nfd(digits).format(n);
    },
    signed(v) {
      const n = toNum(v);
      if (n === null) return null;
      return (n > 0 ? "+" : "") + nfd(0).format(n);
    },
    pct(v) {
      const n = toNum(v);
      return n === null ? null : fill(d.units.pct, { v: nfd(0).format(n) });
    },
    money(v, short = false) {
      const n = toNum(v);
      if (n === null) return null;
      if (short) {
        const a = Math.abs(n);
        if (a >= 1e9) return fill(d.units.cr_b, { v: nfd(1).format(n / 1e9) });
        if (a >= 1e6) return fill(d.units.cr_m, { v: nfd(1).format(n / 1e6) });
        if (a >= 1e4) return fill(d.units.cr_k, { v: nfd(0).format(n / 1e3) });
      }
      return fill(d.units.cr, { v: nfd(0).format(n) });
    },
    dist(m) {
      const n = toNum(m);
      if (n === null) return null;
      return Math.abs(n) >= 10000 ? fill(d.units.km, { v: nfd(1).format(n / 1000) }) : fill(d.units.m, { v: nfd(0).format(n) });
    },
    speed(v) {
      const n = toNum(v);
      return n === null ? null : fill(d.units.mps, { v: nfd(0).format(n) });
    },
    seconds(v, digits = 1) {
      const n = toNum(v);
      return n === null ? null : fill(d.units.s, { v: nfd(digits).format(n) });
    },
    dur(s) {
      let n = toNum(s);
      if (n === null || n < 0) return null;
      n = Math.round(n);
      const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), x = n % 60;
      return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
    },
    gameTime(t) {
      const n = toNum(t);
      if (n === null || n < 0) return null;
      const day = Math.floor(n / 86400), h = Math.floor((n % 86400) / 3600), m = Math.floor((n % 3600) / 60);
      return fill(d.time.game, { d: day, hh: pad(h), mm: pad(m) });
    },
    ago(gt, now) {
      const a = toNum(gt), b = toNum(now);
      if (a === null || b === null) return null;
      const s = Math.max(0, b - a);
      if (s < 60) return d.time.now;
      if (s < 3600) return fill(d.time.min_ago, { n: Math.floor(s / 60) });
      if (s < 86400) return fill(d.time.h_ago, { n: Math.floor(s / 3600) });
      return fill(d.time.d_ago, { n: Math.floor(s / 86400) });
    },
    compare(a, b) { return coll.compare(a, b); },
  };
  cache.set(lang, f);
  return f;
}

/** clamp a percentage to 0..100, null if not a number */
export function pct01(v: unknown): number | null {
  const n = toNum(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

/** joins the non-empty parts with a separator; null if nothing is left */
export function joinParts(parts: Array<string | null | undefined | false>, sep = " · "): string | null {
  const ok = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return ok.length ? ok.join(sep) : null;
}
