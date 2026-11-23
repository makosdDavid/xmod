// Navigation row: the 8 views (keys 1–8, unread badge on the logbook), "back to map", where you are,
// the Modules menu (show / hide) and the Layout menu (presets + saved user layouts).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity, ArrowLeft, BarChart3, Check, Flag, Globe, LayoutGrid, LayoutTemplate, Map as MapIcon, Pencil, RotateCcw, Save, ScrollText, Shield, Ship, Star, StarOff, Trash2, Boxes,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBus } from "@/core/hooks";
import { PANEL_IDS, PRESETS, panelsIn } from "@/core/layout";
import { unread } from "@/core/logbook";
import { applyLayout, deleteLayout, layoutsDoc, layoutsOnline, NAME_RE, renameLayout, saveLayout, setDefaultLayout } from "@/core/savedLayouts";
import { S, toast, whereText } from "@/core/store";
import { applyPreset, getUI, isMapView, resetLayout, setView, togglePanel, useUI, VIEWS, type ViewId } from "@/core/ui";
import { PANEL_ICON } from "@/panels/registry";
import { AlertBanner, StaleBanner } from "@/components/Overlays";
import { cn } from "@/lib/utils";

const VIEW_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  map: MapIcon, galaxy: Globe, property: Ship, log: ScrollText, missions: Flag, factions: Shield, economy: BarChart3, diag: Activity,
};

function ModulesMenu() {
  const { t } = useTranslation();
  const tree = useUI((s) => s.tree);
  const shown = new Set(panelsIn(tree));
  return (
    <DropdownMenu>
      <Tooltip><TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs"><Boxes className="size-3.5" />{t("nav.modules")}</Button>
        </DropdownMenuTrigger>
      </TooltipTrigger><TooltipContent>{t("nav.modules_tip")}</TooltipContent></Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t("nav.modules_tip")}</DropdownMenuLabel>
        {PANEL_IDS.map((id) => {
          const Icon = PANEL_ICON[id];
          return (
            <DropdownMenuCheckboxItem key={id} checked={shown.has(id)} onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => { togglePanel(id); if (!isMapView(getUI().view)) setView("map"); }}>
              <Icon className="size-4 text-primary" />{t("modules." + id)}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-xs whitespace-normal text-muted-foreground">{t("nav.modules_hint")}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


type NameDialog = { mode: "save" | "rename"; from?: string } | null;

function LayoutMenu() {
  const { t } = useTranslation();
  useBus(["layouts"], 50);
  const preset = useUI((s) => s.preset);
  const doc = layoutsDoc();
  const names = Object.keys(doc.items).sort((a, b) => a.localeCompare(b));
  const [dlg, setDlg] = useState<NameDialog>(null);
  const [name, setName] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const valid = NAME_RE.test(name.trim());
  const exists = valid && !!doc.items[name.trim()] && (dlg?.mode === "save" || name.trim() !== dlg?.from);
  const submit = async () => {
    if (!valid || !dlg) return;
    const ok = dlg.mode === "save" ? await saveLayout(name) : await renameLayout(dlg.from!, name);
    if (ok) setDlg(null);
  };
  const go = (fn: () => void) => { fn(); if (!isMapView(getUI().view)) setView("map"); };
  return (
    <>
      <DropdownMenu>
        <Tooltip><TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs"><LayoutGrid className="size-3.5" />{t("nav.layout")}</Button>
          </DropdownMenuTrigger>
        </TooltipTrigger><TooltipContent>{t("nav.layout_tip")}</TooltipContent></Tooltip>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>{t("layout.presets")}</DropdownMenuLabel>
          {PRESETS.map((p) => (
            <DropdownMenuItem key={p} onSelect={() => go(() => { applyPreset(p); toast(t("layout.applied", { name: t("layout." + p) }), "info", 1500); })}>
              <LayoutTemplate />{t("layout." + p)}{preset === p && <Check className="ml-auto" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => go(() => { resetLayout(); toast(t("layout.reset_done"), "info", 1500); })}><RotateCcw />{t("layout.reset")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-2">
            {t("saved.title")}
            {!layoutsOnline() && <Badge variant="outline" className="h-4 px-1 text-[0.6rem] text-warn" title={t("saved.offline_tip")}>{t("saved.offline")}</Badge>}
          </DropdownMenuLabel>
          {names.map((n) => (
            <DropdownMenuSub key={n}>
              <DropdownMenuSubTrigger>
                {doc.default === n ? <Star className="size-4 text-gold" /> : <LayoutGrid className="size-4" />}
                <span className="truncate">{n}</span>
                {preset === "user:" + n && <Check className="ml-auto size-4" />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <DropdownMenuItem onSelect={() => go(() => applyLayout(n))}><Check />{t("saved.apply")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void saveLayout(n)}><Save />{t("saved.overwrite")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { setName(n); setDlg({ mode: "rename", from: n }); }}><Pencil />{t("saved.rename")}</DropdownMenuItem>
                {doc.default === n
                  ? <DropdownMenuItem onSelect={() => void setDefaultLayout(null)}><StarOff />{t("saved.unset_default")}</DropdownMenuItem>
                  : <DropdownMenuItem onSelect={() => void setDefaultLayout(n)}><Star />{t("saved.set_default")}</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDel(n)}><Trash2 />{t("saved.delete")}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
          {!names.length && <div className="px-2 py-1 text-xs text-muted-foreground">{t("saved.none")}</div>}
          <DropdownMenuItem onSelect={() => { setName(""); setDlg({ mode: "save" }); }}><Save />{t("saved.save_as")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={!!dlg} onOpenChange={(o) => !o && setDlg(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dlg?.mode === "rename" ? t("saved.rename_title") : t("saved.save_title")}</DialogTitle>
            <DialogDescription>{t("saved.save_desc")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-2">
            <Input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t("saved.name_ph")} aria-label={t("saved.name")} />
            <div className={cn("min-h-4 text-xs", !valid && name ? "text-bad" : "text-muted-foreground")}>
              {!valid && name ? t("saved.bad_name") : exists ? t("saved.will_overwrite") : t("saved.name_hint")}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDlg(null)}>{t("control.cancel")}</Button>
              <Button type="submit" disabled={!valid}>{dlg?.mode === "rename" ? t("saved.rename") : exists ? t("saved.overwrite") : t("saved.save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!confirmDel} onOpenChange={(o) => !o && setConfirmDel(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("saved.delete_title")}</DialogTitle>
            <DialogDescription>{t("saved.delete_desc", { name: confirmDel ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDel(null)}>{t("control.cancel")}</Button>
            <Button variant="destructive" onClick={() => { if (confirmDel) void deleteLayout(confirmDel); setConfirmDel(null); }}>{t("saved.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function NavBar() {
  const { t } = useTranslation();
  useBus(["log", "ticker", "messages", "logread", "player", "mapmode"], 500);
  const view = useUI((s) => s.view);
  const logN = unread("all"), alerts = unread("alerts");
  const onMap = isMapView(view);
  const where = S.player ? whereText(S.player.where) : "";
  return (
    <nav aria-label={t("nav.label")} className="flex h-11 shrink-0 items-center gap-2 border-b border-frame bg-card px-2">
      <div role="tablist" className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {VIEWS.map((v) => {
          const Icon = VIEW_ICON[v.id];
          const on = view === v.id;
          return (
            <Tooltip key={v.id}>
              <TooltipTrigger asChild>
                <button type="button" role="tab" aria-selected={on} onClick={() => setView(v.id as ViewId)}
                  className={cn("relative inline-flex h-8 items-center gap-1.5 rounded-sm border border-input bg-sub-head px-2.5 text-[0.8rem] font-semibold whitespace-nowrap text-foreground transition-colors hover:bg-(--x4-button-hover) focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    on && "x4-on")}>
                  <Icon className="size-4" />
                  <span className={cn("hidden xl:inline", on && "inline")}>{t("views." + v.id)}</span>
                  <Kbd className="hidden h-4 px-1 text-[0.6rem] min-[1800px]:inline-flex">{v.key}</Kbd>
                  {v.id === "log" && logN > 0 && (
                    <Badge variant={alerts ? "destructive" : "default"} className={cn("h-4 min-w-4 px-1 text-[0.6rem] tabular-nums", alerts > 0 && "animate-pulse")}>{logN >= 99 ? "99+" : logN}</Badge>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("views.tip", { label: t("views." + v.id), key: v.key })}</TooltipContent>
            </Tooltip>
          );
        })}
        {view === "hotkeys" && (
          <span className="ml-1 inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-[0.8rem] font-semibold x4-on">{t("views.hotkeys")}</span>
        )}
      </div>
      {!onMap && (
        <Button variant="default" size="sm" onClick={() => setView("map")} title={t("nav.back_to_map_tip")} className="h-8 shrink-0 gap-1.5 text-xs">
          <ArrowLeft className="size-4" />{t("nav.back_to_map")}<Kbd className="h-4 px-1 text-[0.6rem]">Esc</Kbd>
        </Button>
      )}
      <div className="flex min-w-0 flex-1 justify-center gap-2"><StaleBanner inline /><AlertBanner inline /></div>
      {where && <span className="hidden max-w-[26rem] truncate text-xs text-muted-foreground 2xl:inline" title={where}>{where}</span>}
      <ModulesMenu />
      <LayoutMenu />
    </nav>
  );
}

