import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { bus } from "./store";
import { makeFmt, type Fmt, type Lang } from "@/lib/format";

/** re-render when any of the bus events fires (throttled; trailing call guaranteed) */
export function useBus(events: string[], ms = 250): number {
  const [v, setV] = useState(0);
  const key = events.join(",");
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      const now = performance.now();
      if (now - last >= ms) { last = now; setV((x) => x + 1); }
      else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); setV((x) => x + 1); }, ms - (now - last));
    };
    const offs = key.split(",").filter(Boolean).map((e) => bus.on(e, fire));
    return () => { offs.forEach((o) => o()); if (timer) clearTimeout(timer); };
  }, [key, ms]);
  return v;
}

/** periodic re-render (e.g. "x s ago" texts) */
export function useTick(ms: number): number {
  const [v, setV] = useState(0);
  useEffect(() => { const i = setInterval(() => setV((x) => x + 1), ms); return () => clearInterval(i); }, [ms]);
  return v;
}

/** translate + locale formatter of the current language */
export function useT() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language === "hu" ? "hu" : "en") as Lang;
  const f: Fmt = makeFmt(lang);
  return { t, f, lang };
}

/** localStorage-backed per-panel settings (same keys as the old shell: x4c.<panel>) */
export function useSettings<T extends object>(panel: string, defaults: T): [T, (patch: Partial<T>) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem("x4c." + panel);
      return { ...defaults, ...(raw ? JSON.parse(raw) : {}) };
    } catch { return { ...defaults }; }
  });
  const ref = useRef(v);
  ref.current = v;
  const update = (patch: Partial<T>) => {
    const n = { ...ref.current, ...patch };
    ref.current = n;
    setV(n);
    try { localStorage.setItem("x4c." + panel, JSON.stringify(n)); } catch { /* blocked */ }
  };
  return [v, update];
}
