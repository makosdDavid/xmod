// A scroll container without visible scrollbars (U7): it shows what fits; when more rows are below
// (or above) the visible part, a clear "+N more" / "N above" pill appears — click it (or use the mouse
// wheel / keyboard list navigation) to page on. Rows are the descendants with a data-key attribute.
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

export const FitScroll = React.forwardRef<HTMLDivElement, { children: React.ReactNode; className?: string; deps?: unknown }>(
  function FitScroll({ children, className, deps }, outerRef) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDivElement | null>(null);
    const [below, setBelow] = useState(0);
    const [above, setAbove] = useState(0);
    const setRefs = (el: HTMLDivElement | null) => {
      ref.current = el;
      if (typeof outerRef === "function") outerRef(el); else if (outerRef) outerRef.current = el;
    };
    const measure = useCallback(() => {
      const el = ref.current;
      if (!el) return;
      if (el.scrollHeight <= el.clientHeight + 1) { setBelow(0); setAbove(0); return; }
      const top = el.getBoundingClientRect().top, bottom = top + el.clientHeight;
      const rows = el.querySelectorAll<HTMLElement>("[data-key]:not(.contents)");
      // rows are in vertical order: binary search the first one below / the first one not above
      const first = (pred: (r: DOMRect) => boolean) => {
        let lo = 0, hi = rows.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (pred(rows[mid].getBoundingClientRect())) hi = mid; else lo = mid + 1; }
        return lo;
      };
      let b = rows.length - first((r) => r.top >= bottom - 2);
      const a = first((r) => r.bottom > top + 2);
      if (b < 0) b = 0;
      // content without row markers still gets an affordance
      if (!rows.length && el.scrollTop + el.clientHeight < el.scrollHeight - 2) b = 1;
      setBelow(b); setAbove(a);
    }, []);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
      el.addEventListener("scroll", measure, { passive: true });
      measure();
      return () => { ro.disconnect(); el.removeEventListener("scroll", measure); };
    }, [measure]);
    useEffect(() => { const id = requestAnimationFrame(measure); return () => cancelAnimationFrame(id); }, [deps, children, measure]);
    const page = (d: number) => { const el = ref.current; if (el) el.scrollBy({ top: d * el.clientHeight * 0.85, behavior: "smooth" }); };
    return (
      <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
        <div ref={setRefs} className="no-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          <div>{children}</div>
        </div>
        {above > 0 && (
          <button type="button" onClick={() => page(-1)}
            className="absolute top-1 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-sm border border-input bg-popover px-2.5 py-0.5 text-[0.7rem] font-semibold text-foreground hover:border-primary hover:bg-accent">
            <ChevronUp className="size-3" />{t("fit.above", { n: above })}
          </button>
        )}
        {below > 0 && (
          <>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-input" />
            <button type="button" onClick={() => page(1)}
              className="absolute bottom-1.5 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-sm border border-input bg-popover px-2.5 py-0.5 text-[0.7rem] font-semibold text-foreground hover:border-primary hover:bg-accent">
              <ChevronDown className="size-3" />{t("fit.more", { n: below })}
            </button>
          </>
        )}
      </div>
    );
  });
