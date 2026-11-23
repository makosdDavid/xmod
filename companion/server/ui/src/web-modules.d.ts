// Types for the framework-free map module imported from ../web via the "@web" Vite alias.
// The files are owned and maintained in web/ (public API: web/MAP-API.md); this shell only imports them.
/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "@web/map.js" {
  export type MapTranslator = (key: string, params?: Record<string, unknown>) => string | null | undefined;
  export class MapView {
    constructor(container: HTMLElement, ctx: {
      S: any; bus: any; t?: MapTranslator;
      select?: (sel: any) => void; watchSector?: (sid: string | null) => void;
      sectorName?: (id: unknown) => string; factionName?: (id: unknown) => string; whereText?: (w: any) => string;
      headingOf?: (yaw: number) => number; titleEl?: HTMLElement; toolsEl?: HTMLElement; onTitle?: (text: string) => void;
      settingsKey?: string;
    });
    mode: "sector" | "galaxy";
    setMode(m: "sector" | "galaxy"): void;
    toggleMode(): void;
    showSector(sid: string | null): void;
    centerOn(id: string): void;
    showGuidance?(): boolean;
    currentSid(): string | null;
    resize(): void;
    auto(): void;
    fit(): void;
    zoom(f: number, sx?: number, sy?: number): void;
    setTranslator(t: MapTranslator | null): void;
    setStaticMap?(json: unknown): void;
    overlayRects?(): { w: number; h: number; rects: Record<string, { l: number; t: number; r: number; b: number } | undefined> };
    destroy(): void;
  }
}

declare module "@web/mapstyle.js" {
  export interface RGB { r: number; g: number; b: number }
  export function setIconIndex(names: string[] | null, cb?: (name?: string) => void): void;
  export function objColor(o: any, theme: any, opts?: Record<string, any>): RGB;
  export function listColorKey(o: any, opts?: { currentId?: string | null }): string | null;
  export function listColor(o: any, theme: any, opts?: { currentId?: string | null }): RGB;
  export function holo(theme: any, name: string): RGB;
  export const FALLBACK_HOLO: Record<string, RGB>;
  export const TEXT_NORMAL: RGB;
  export function iconFor(o: any): string;
  export function tintedURL(name: string, col: RGB): string | null;
  export function rgb(c: RGB | null | undefined, a?: number): string;
  export function hasIconExport(): boolean;
  export function staticClusterIndex(json: unknown): any;
  export function isOwnerlessShip(o: any): boolean;
  export function takeSectorExtras(S: any, scan: any): any;
  export function guidanceModel(S: any): any | null;
  export function guidanceRuns(model: any, sid: string, from?: [number, number] | null): { runs: [number, number][][]; end: any | null };
  export const OWNERLESS_COLOR: RGB;
  export function galaxyIndex(liveGalaxy: any[], gates?: any[], scans?: Record<string, any>, hwlinks?: any[], staticByMacro?: any): {
    sectors: Map<string, any>; clusters: Map<string, any>; sectorByMacro: Map<string, string>;
    links: { a: string; b: string; kind: string }[]; stubs: any[]; gatesBySector: Map<string, any[]>;
  };
}

declare module "@web/map-strings.js" {
  export const STRINGS: { en: Record<string, string>; hu: Record<string, string> };
  export const MAP_KEYS: string[];
  export function createTranslator(lang?: string): (key: string, params?: Record<string, unknown>) => string;
}
