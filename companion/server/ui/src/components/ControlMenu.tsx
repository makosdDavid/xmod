// "Game commands" menu (formerly "Vezérlés"): switch command sending on/off (with a confirmation),
// see which commands the mod allows, re-request everything from the game.
import { useTranslation } from "react-i18next";
import { Gamepad2, RefreshCw } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useBus } from "@/core/hooks";
import { cmdLabel, resync, S, setControl, toast } from "@/core/store";
import { setConfirmControl, useUI } from "@/core/ui";
import { cn } from "@/lib/utils";

export function ControlMenu() {
  const { t } = useTranslation();
  useBus(["control", "hello"], 100);
  const confirm = useUI((s) => s.confirmControl);
  const on = S.control;
  const allow: string[] = S.hello && Array.isArray(S.hello.allow) ? S.hello.allow : [];
  const toggle = (v: boolean) => {
    if (v && !on) { setConfirmControl(true); return; }
    if (!v && on) { setControl(false); toast(t("control.off_toast"), "info", 1500); }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" title={t("control.tip")}
            className={cn("h-7 gap-1.5 px-2 text-xs", on && "border-[#ffa050]/70 bg-[#ff8c32]/15 text-[#ffc590] hover:bg-[#ff8c32]/25")}>
            <Gamepad2 className="size-3.5" />{t("control.button")}
            <Badge variant="outline" className={cn("h-4 px-1 text-[0.6rem]", on ? "border-[#ffa050]/70 text-[#ffc590]" : "text-muted-foreground")}>
              {on ? t("control.on") : t("control.off")}
            </Badge>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel>{t("control.menu_title")}</DropdownMenuLabel>
          <div className="flex items-start gap-3 px-2 py-1.5">
            <Switch id="ctl-switch" checked={on} onCheckedChange={toggle} disabled={!S.originOk} />
            <label htmlFor="ctl-switch" className="text-sm">
              <div className="font-medium">{t("control.enable")}</div>
              <div className="text-xs text-muted-foreground">{!S.originOk ? t("control.origin_bad") : on ? t("control.enabled_desc") : t("control.disabled_desc")}</div>
            </label>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("control.allowed")}</DropdownMenuLabel>
          <div className="flex flex-wrap gap-1 px-2 pb-2">
            {allow.length ? allow.map((c) => <Badge key={c} variant="secondary" className="text-[0.7rem]">{cmdLabel(c)}</Badge>)
              : <span className="text-xs text-muted-foreground">{t("control.allowed_none")}</span>}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => resync()}>
            <RefreshCw />{t("control.resync")}<span className="ml-auto text-xs text-muted-foreground">{t("control.resync_tip_short")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirm} onOpenChange={setConfirmControl}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("control.confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("control.confirm_text")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("control.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setControl(true); toast(t("control.on_toast"), "ok", 1500); }}>{t("control.confirm_ok")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
