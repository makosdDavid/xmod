// Status / diagnostics: connection, bridge, timing, gates, per-channel cost measured by the bridge.
import { Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Empty, SectionTitle } from "@/components/bits";
import { FitScroll } from "@/components/FitScroll";
import { useBus, useT } from "@/core/hooks";
import { connState, resync, S, yawConvention, type Any } from "@/core/store";
import { toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

// channel table columns by priority (container width from which they show)
const CH_COLS: { k: string; label: string; at: string }[] = [
  { k: "avg", label: "diag.c_avg", at: "" }, { k: "max", label: "diag.c_max", at: "" }, { k: "err", label: "diag.c_err", at: "" },
  { k: "runs", label: "diag.c_runs", at: "@[30rem]:table-cell" }, { k: "iv", label: "diag.c_iv", at: "@[36rem]:table-cell" },
  { k: "ops", label: "diag.c_ops", at: "@[42rem]:table-cell" }, { k: "pops", label: "diag.c_pops", at: "@[48rem]:table-cell" },
  { k: "pass", label: "diag.c_pass", at: "@[54rem]:table-cell" },
];

export function DiagPanel() {
  const { t, f } = useT();
  useBus(["stats", "status", "hello", "ws", "icons"], 1000);
  const st: Any = S.status || {};
  const h: Any = S.hello || {};
  const s: Any | null = S.stats;
  const state = connState();
  const n = (v: unknown, d = 0) => f.num(v, d) ?? "–";
  const rows: [string, string][] = [
    [t("diag.browser"), S.wsOpen ? t("diag.ws_open") : t("diag.ws_closed")],
    [t("diag.game_state"), t("state." + state, { defaultValue: state })],
    [t("diag.pipe"), st.pipe_connected ? t("diag.pipe_on", { n: n(st.pipe_connects) }) : t("diag.pipe_off")],
    [t("diag.messages"), t("diag.messages_v", { n: n(st.msgs), rate: n(st.rate_hz, 1), bad: n(st.bad) })],
    [t("diag.last_rx"), toNum(st.last_rx_age) === null ? "–" : t("diag.last_rx_v", { v: n(st.last_rx_age, 1) })],
    [t("diag.server"), toNum(st.ws_clients) === null ? "–" : t("diag.ws_clients", { n: n(st.ws_clients) })],
    [t("diag.bridge"), h.mod ? t("diag.bridge_v", { mod: h.mod, ver: h.ver ?? "?", session: h.session ?? "?" }) : "–"],
    [t("diag.timer"), s && s.frame ? ((s.hires === false || s.timer === "frame" || s.timer === "realtime")
      ? t("diag.timer_frame", { timer: s.timer, ops: n(s.frame.ops, 1) }) : t("diag.timer_hires", { timer: s.timer, ops: n(s.frame.ops, 1) })) : (h.timer || "–")],
    [t("diag.allowed"), (Array.isArray(h.allow) && h.allow.join(", ")) || "–"],
    [t("diag.hotkeys"), s ? t("diag.hotkeys_v", { n: n(s.hk) }) : (h.hotkeys ?? "–")],
    [t("diag.loglib"), h.loglib ? t("diag.yes") : t("diag.no")],
    [t("diag.gates"), s ? t("diag.gates_v", { gates: s.gates ?? "–", md: s.gates_md ?? "?", rx: s.gates_rx ?? "?", hw: s.gates_hw ?? 0, known: n(s.ngates) }) : "–"],
    [t("diag.tick"), s ? t("diag.tick_v", { frame: n(s.nframe), md: n(s.nmd) }) : "–"],
    [t("diag.yaw"), t("diag.yaw_v", { conv: yawConvention(), a: S.yaw.a, b: S.yaw.b, c: S.yaw.c })],
    [t("diag.cost"), s && s.frame ? t("diag.cost_v", { avg: n(s.frame.avg, 2), max: n(s.frame.max, 2) }) : "–"],
    [t("diag.sent"), s ? t("diag.sent_v", { n: n(s.sent), kb: n((toNum(s.bytes) ?? 0) / 1024), dropped: n(s.dropped), wfail: n(s.wfail) }) : "–"],
    [t("diag.srcoff"), s && Array.isArray(s.srcoff) && s.srcoff.length ? s.srcoff.join(", ") : t("diag.none")],
    [t("diag.icons"), S.icons ? t("diag.icons_v", { n: n(S.icons) }) : t("diag.icons_none")],
  ];
  const ch: [string, Any][] = s && s.ch ? Object.entries(s.ch as Record<string, Any>).sort(([a], [b]) => a.localeCompare(b)) : [];
  return (
    <FitScroll deps={ch.length}>
      <div className="px-3 py-2.5">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.8rem]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt data-key={"d-" + k} className="whitespace-nowrap text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
        <SectionTitle className="mt-4" right={
          <Button size="sm" variant="secondary" className="ml-auto h-6 gap-1 px-2 text-xs normal-case tracking-normal" onClick={resync} title={t("control.resync_tip")}>
            <RefreshCw className="size-3" />{t("control.resync")}
          </Button>}>{t("diag.channels")}</SectionTitle>
        {ch.length ? (
          <table className="w-full table-fixed text-[0.78rem] tabular-nums">
            <thead>
              <tr className="border-b text-[0.65rem] tracking-wider text-muted-foreground uppercase">
                <th className="px-1.5 py-1 text-left font-semibold">{t("diag.c_channel")}</th>
                {CH_COLS.map((c) => <th key={c.k} className={cn("truncate px-1.5 py-1 text-right font-semibold", c.at && "hidden " + c.at)} title={t(c.label)}>{t(c.label)}</th>)}
              </tr>
            </thead>
            <tbody>
              {ch.map(([k, c]) => (
                <tr key={k} data-key={"c-" + k} className={cn("border-b border-border/40", c.off && "text-warn")}>
                  <td className="truncate px-1.5 py-0.5">{k}{c.off && <Badge variant="destructive" className="ml-1 h-4 px-1 text-[0.6rem]">{t("diag.off_badge")}</Badge>}</td>
                  {CH_COLS.map((col) => (
                    <td key={col.k} className={cn("truncate px-1.5 py-0.5 text-right", col.at && "hidden " + col.at)} title={col.k === "err" ? c.le || "" : undefined}>
                      {col.k === "runs" || col.k === "pops" || col.k === "err" ? n(c[col.k]) : (c[col.k] === undefined || c[col.k] === null ? "–" : String(c[col.k]))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty icon={Activity} title={t("diag.no_stats")} className="py-4" />}
      </div>
    </FitScroll>
  );
}
