// Help: the 17 in-game hotkeys (name as the game shows it, what it does) + the browser keys.
import { Kbd } from "@/components/ui/kbd";
import { SectionTitle } from "@/components/bits";
import { FitScroll } from "@/components/FitScroll";
import { useBus, useT } from "@/core/hooks";
import { HOTKEYS } from "@/core/hotkeys";
import { S } from "@/core/store";

const KEYS: [string[], string][] = [
  [["1", "…", "8"], "help.k_views"], [["Esc"], "help.k_esc"], [["+", "−"], "help.k_zoom"], [["0"], "help.k_fit"], [["a"], "help.k_auto"],
  [["g"], "help.k_galaxy"], [["n", "N"], "help.k_ships"], [["↓", "↑", "Enter"], "help.k_list"], [["/"], "help.k_search"],
  [["Ctrl", "K"], "help.k_palette"], [["?"], "help.k_help"],
];

export function HotkeysPanel() {
  const { t, lang } = useT();
  useBus(["stats", "hello"], 2000);
  const n = S.stats ? S.stats.hk : (S.hello ? S.hello.hotkeys : null);
  return (
    <FitScroll>
      <div className="px-3.5 py-3 text-[0.8rem]">
        <p className="mb-2 text-foreground/80">
          {t("help.intro_1")}<b>{t("help.intro_api")}</b>{t("help.intro_2")}<b>{t("help.intro_path")}</b>{t("help.intro_3")}<b>{t("help.intro_req")}</b>{t("help.intro_4")}
        </p>
        <p className="mb-3 text-xs text-muted-foreground">
          {n === null || n === undefined ? t("help.not_reported") : Number(n) === 0 ? t("help.registered_zero") : t("help.registered", { n })}
        </p>
        <SectionTitle>{t("help.ingame_title")}</SectionTitle>
        <div className="flex flex-col">
          {HOTKEYS.map(([id, ingame]) => (
            <div key={id} data-key={id} className="grid grid-cols-1 gap-x-4 border-b border-border/40 py-1.5 @[40rem]:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
              <div>
                <div className="font-medium">{t("hk." + id)}</div>
                <div className="text-xs text-muted-foreground" title={t("help.col_name")}>
                  {lang === "hu" ? null : <span className="mr-1 text-[0.65rem] uppercase tracking-wider">{t("help.in_game")}</span>}{ingame}
                </div>
              </div>
              <div className="text-foreground/75">{t("hkdesc." + id)}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t("help.ingame_note")}</p>
        <SectionTitle className="mt-5">{t("help.browser_title")}</SectionTitle>
        <div className="flex flex-col">
          {KEYS.map(([keys, label]) => (
            <div key={label} data-key={label} className="grid grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] items-center gap-x-4 border-b border-border/40 py-1.5">
              <span className="flex flex-wrap gap-1">{keys.map((k) => k === "…" ? <span key={k} className="text-muted-foreground">–</span> : <Kbd key={k}>{k}</Kbd>)}</span>
              <span className="text-foreground/80">{t(label)}</span>
            </div>
          ))}
        </div>
      </div>
    </FitScroll>
  );
}
