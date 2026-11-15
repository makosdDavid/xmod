// Ctrl+K: find own ships / stations, objects of the scanned sectors, discovered sectors, views and
// actions, and jump to them (the map centres on the object / shows the sector).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, LayoutTemplate, Map as MapIcon, Ship, Building2, Crosshair } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { GameIcon } from "@/components/bits";
import { PRESETS } from "@/core/layout";
import { getMap } from "@/core/mapHost";
import { S, sectorName, select, type Any } from "@/core/store";
import { applyPreset, setPalette, setView, useUI, VIEWS, type ViewId } from "@/core/ui";
import { isOwnerlessShip, OWNERLESS_CSS, wantsOwnerless } from "@/lib/objects";

const LIMIT = 40;

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useUI((s) => s.paletteOpen);
  const [q, setQ] = useState("");
  const close = () => { setPalette(false); setQ(""); };
  const ql = q.trim().toLowerCase();
  const hit = (s: string) => !ql || s.toLowerCase().includes(ql);

  const jumpObj = (o: Any, sid?: string | null) => {
    close();
    setView("map");
    select({ kind: "obj", id: String(o.id), from: "palette", obj: o, sid: sid ?? o.s ?? null });
    getMap()?.centerOn(String(o.id));
  };
  const jumpSector = (id: string) => { close(); setView("map"); select({ kind: "sector", id, from: "palette" }); };

  const prop = [...S.property.values()];
  const ships = open ? prop.filter((e) => e.k === "ship" && hit(`${e.n || ""} ${e.code || ""} ${sectorName(e.s)}`)) : [];
  const stations = open ? prop.filter((e) => e.k === "station" && hit(`${e.n || ""} ${e.code || ""} ${sectorName(e.s)}`)) : [];
  const own = new Set(prop.map((e) => String(e.id)));
  const objs: { o: Any; sid: string }[] = [];
  if (open && ql) for (const [sid, sc] of Object.entries(S.scans)) for (const o of (sc.objs || []) as Any[]) {
    if (!own.has(String(o.id)) && hit(`${o.n || ""} ${o.code || ""}`)) objs.push({ o, sid });
  }
  // "ownerless" / "gazdátlan" / "abandoned"…: every abandoned ship of the scanned sectors
  const abandoned: { o: Any; sid: string }[] = [];
  if (open && wantsOwnerless(ql)) for (const [sid, sc] of Object.entries(S.scans)) for (const o of (sc.objs || []) as Any[]) {
    if (isOwnerlessShip(o)) abandoned.push({ o, sid });
  }
  const sectors = open ? [...S.sectors.values()].filter((s) => hit(`${s.name || ""} ${s.cname || ""}`)) : [];
  const views = [...VIEWS.map((v) => ({ id: v.id as ViewId, key: v.key })), { id: "hotkeys" as ViewId, key: "?" }].filter((v) => hit(t("views." + v.id)));
  const presets = PRESETS.filter((p) => hit(t("layout." + p)) || hit(t("nav.layout")));
  const more = (n: number) => n > LIMIT ? <CommandItem disabled value={"more-" + n}>{t("palette.more", { n: n - LIMIT })}</CommandItem> : null;

  return (
    <CommandDialog open={open} onOpenChange={(o) => (o ? setPalette(true) : close())} title={t("palette.title")} description={t("palette.desc")}
      shouldFilter={false} className="sm:max-w-2xl">
      <CommandInput value={q} onValueChange={setQ} placeholder={t("palette.placeholder")} />
      <CommandList className="no-scrollbar max-h-[60vh]">
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>
        {ships.length > 0 && (
          <CommandGroup heading={t("palette.ships")}>
            {ships.slice(0, LIMIT).map((e) => (
              <CommandItem key={e.id} value={"ship-" + e.id} onSelect={() => jumpObj(e)}>
                <GameIcon o={e} size={16} /><span className="truncate">{e.n || "–"}</span>
                <CommandShortcut className="tracking-normal">{[e.code, sectorName(e.s)].filter(Boolean).join(" · ")}</CommandShortcut>
              </CommandItem>
            ))}
            {more(ships.length)}
          </CommandGroup>
        )}
        {stations.length > 0 && (
          <CommandGroup heading={t("palette.stations")}>
            {stations.slice(0, LIMIT).map((e) => (
              <CommandItem key={e.id} value={"st-" + e.id} onSelect={() => jumpObj(e)}>
                <Building2 className="text-primary" /><span className="truncate">{e.n || "–"}</span>
                <CommandShortcut className="tracking-normal">{sectorName(e.s)}</CommandShortcut>
              </CommandItem>
            ))}
            {more(stations.length)}
          </CommandGroup>
        )}
        {abandoned.length > 0 && (
          <CommandGroup heading={t("palette.ownerless")}>
            {abandoned.slice(0, LIMIT).map(({ o, sid }) => (
              <CommandItem key={"ab" + sid + o.id} value={"ab-" + sid + "-" + o.id} onSelect={() => jumpObj(o, sid)}>
                <GameIcon o={o} size={16} /><span className="truncate">{o.n || t("class." + o.c, { defaultValue: "?" })}</span>
                <span className="shrink-0 rounded-full border border-dashed px-1.5 text-[0.65rem] font-semibold uppercase" style={{ color: OWNERLESS_CSS, borderColor: OWNERLESS_CSS }}>{t("objects.ownerless_badge")}</span>
                <CommandShortcut className="tracking-normal">{sectorName(sid)}</CommandShortcut>
              </CommandItem>
            ))}
            {more(abandoned.length)}
          </CommandGroup>
        )}
        {objs.length > 0 && (
          <CommandGroup heading={t("palette.objects")}>
            {objs.slice(0, LIMIT).map(({ o, sid }) => (
              <CommandItem key={sid + o.id} value={"o-" + sid + "-" + o.id} onSelect={() => jumpObj(o, sid)}>
                <GameIcon o={o} size={16} /><span className="truncate">{o.n || t("class." + o.c, { defaultValue: "?" })}</span>
                <CommandShortcut className="tracking-normal">{sectorName(sid)}</CommandShortcut>
              </CommandItem>
            ))}
            {more(objs.length)}
          </CommandGroup>
        )}
        {sectors.length > 0 && (
          <CommandGroup heading={t("palette.sectors")}>
            {sectors.slice(0, LIMIT).map((s) => (
              <CommandItem key={s.id} value={"sec-" + s.id} onSelect={() => jumpSector(String(s.id))}>
                <Globe className="text-primary" /><span className="truncate">{s.name}</span>
                {s.cname && s.cname !== s.name && <CommandShortcut className="tracking-normal">{s.cname}</CommandShortcut>}
              </CommandItem>
            ))}
            {more(sectors.length)}
          </CommandGroup>
        )}
        {views.length > 0 && <CommandGroup heading={t("palette.views")}>
          {views.map((v) => (
              <CommandItem key={v.id} value={"view-" + v.id} onSelect={() => { close(); setView(v.id); }}>
                {v.id === "galaxy" ? <Globe /> : v.id === "map" ? <MapIcon /> : <Ship />}{t("views." + v.id)}<CommandShortcut>{v.key}</CommandShortcut>
              </CommandItem>
            ))}
        </CommandGroup>}
        {(hit(t("palette.back_ship")) || presets.length > 0) && <CommandGroup heading={t("palette.actions")}>
          {hit(t("palette.back_ship")) && (
            <CommandItem value="act-auto" onSelect={() => { close(); select(null); setView("map"); getMap()?.auto(); }}>
              <Crosshair />{t("palette.back_ship")}<CommandShortcut>a</CommandShortcut>
            </CommandItem>
          )}
          {presets.map((p) => (
            <CommandItem key={p} value={"preset-" + p} onSelect={() => { close(); applyPreset(p); setView("map"); }}>
              <LayoutTemplate />{t("nav.layout")}: {t("layout." + p)}
            </CommandItem>
          ))}
        </CommandGroup>}
      </CommandList>
    </CommandDialog>
  );
}
