// Regression fixture (v1.3.1): the guidance route exactly as the deployed 1.30 bridge sent it on live data
// (2026-11-23, player in sector "309789", cut + target hidden). Ids / sectors / positions only, no game text.
// The 1.30 MD hand-over repeated both ends of each gate hop (A, B, A) and every local highway entry/exit pair.
export const ROUTE_130_LIVE = [
  {"s": "309789", "x": 97603, "z": -67126, "id": "310122", "k": "g"},
  {"s": "517981", "x": -72404, "z": -23213, "id": "519199", "k": "g"},
  {"s": "309789", "x": 97603, "z": -67126, "id": "310122", "k": "g"},
  {"s": "517981", "x": -19500, "z": -65000, "id": "521257", "k": "he"},
  {"s": "517981", "x": 40500, "z": 85000, "id": "519185", "k": "hx"},
  {"s": "517981", "x": -19500, "z": -65000, "id": "521257", "k": "he"},
  {"s": "517981", "x": 40500, "z": 85000, "id": "519185", "k": "hx"},
  {"s": "517981", "x": -19500, "z": -65000, "id": "521257", "k": "he"},
  {"s": "517981", "x": 40500, "z": 85000, "id": "519185", "k": "hx"},
  {"s": "517981", "x": 40000, "z": 85000, "id": "518878", "k": "g"},
  {"s": "538918", "x": 50000, "z": -110000, "id": "546525", "k": "g"},
  {"s": "517981", "x": 40000, "z": 85000, "id": "518878", "k": "g"},
  {"s": "538918", "x": 50500, "z": -110000, "id": "547009", "k": "he"},
  {"s": "538918", "x": 50500, "z": 120000, "id": "550618", "k": "hx"},
  {"s": "538918", "x": 50500, "z": -110000, "id": "547009", "k": "he"},
  {"s": "538918", "x": 50500, "z": 120000, "id": "550618", "k": "hx"},
  {"s": "538918", "x": -94977, "z": 21304, "id": "547935", "k": "g"}
];
// the clean route (first occurrence of every point, in order) - what bridge 1.31 sends and the web draws
export const ROUTE_130_CLEAN = ["310122", "519199", "521257", "519185", "518878", "546525", "547009", "550618", "547935"];
export const ROUTE_130_PLAYER = { sector: "309789", x: 0, z: 0 };
