// X4 Companion — inline SVG icons (stroke, currentColor, 24x24). No external assets.
"use strict";

const P = {
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  galaxy: '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><circle cx="12" cy="12" r="2.2"/>',
  ships: '<path d="M12 3l4 9-4 2-4-2z"/><path d="M5 20l7-4 7 4"/>',
  log: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 9h6M9 13h6M9 17h4"/>',
  missions: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  factions: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  economy: '<path d="M4 19h16"/><path d="M7 15v-4M12 15V7M17 15v-6"/>',
  status: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  objects: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  ship: '<path d="M12 2l5 14-5-3-5 3z"/>',
  back: '<path d="M10 6l-6 6 6 6"/><path d="M4 12h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  max: '<rect x="4" y="4" width="16" height="16" rx="1.5"/>',
  restore: '<rect x="4" y="8" width="12" height="12" rx="1.5"/><path d="M8 8V4h12v12h-4"/>',
  collapse: '<path d="M6 14l6-6 6 6"/>',
  expand: '<path d="M6 10l6 6 6-6"/>',
  popout: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 10h18M10 10v11"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  station: '<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  gate: '<path d="M12 3l9 9-9 9-9-9z"/>',
  cargo: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  auto: '<path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="5"/>',
};

export function icon(name, size = 18, cls = "") {
  const body = P[name] || P.info;
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function iconEl(name, size = 18, cls = "") {
  const t = document.createElement("template");
  t.innerHTML = icon(name, size, cls);
  return t.content.firstChild;
}
