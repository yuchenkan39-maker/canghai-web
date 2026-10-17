// 季沧海助手 · web — pure logic, a line-for-line port of the Android app's Kotlin
// (data/RouteProgress.kt, data/RapidBusProtocol.kt, domain/RainCalibration.kt, domain/RainIndex.kt,
//  domain/PersonalCalibration.kt, domain/RadarNowcaster.kt). No DOM here, so Node can test it.

// ------------------------------------------------------------------ routes and trips

/** Live-feed / GTFS route ids, names, measured speeds (km/h, p75 incl. stops) and colours. */
export const ROUTES = [
  { id: "T7900", name: "T790", speed: 22, color: "#2F7FED", dark: "#6AA6FF" },
  { id: "T7860", name: "T786", speed: 19, color: "#0E9F76", dark: "#4FD1A8" },
  { id: "P0010", name: "PJ01", speed: 25, color: "#8B5CF6", dark: "#B79CFF" },
  { id: "P0020", name: "PJ02", speed: 20, color: "#E5487F", dark: "#FF7EAE" },
];
export const ROUTE_IDS = ROUTES.map((r) => r.id);
export const routeById = (id) => ROUTES.find((r) => r.id === id);
export const routeOrder = (id) => {
  const i = ROUTES.findIndex((r) => r.id === id);
  return i < 0 ? ROUTES.length : i;
};

export const TRIPS = {
  work: { id: "work", label: "上班", stopCode: "PJ212", stopName: "Jaya One Mall（对面）", short: "Jaya One", routes: ROUTE_IDS },
  home: { id: "home", label: "下班", stopCode: "PJ258", stopName: "PPUM", short: "PPUM", routes: ["T7900"] },
};
/** Before 1 pm you are going to work. */
export const tripForHour = (h) => (h < 13 ? TRIPS.work : TRIPS.home);

// ------------------------------------------------------------------ Malaysia time helpers

const MYT_MS = 8 * 3600 * 1000;
/** Calendar parts of an instant in Malaysia time. */
export function myt(ms = Date.now()) {
  const d = new Date(ms + MYT_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
/** Instant of a Malaysia wall-clock time. */
export const mytMs = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - MYT_MS;
/** "2026-10-16T17:00" or "2026-10-16 17:00:00" (Malaysia time) → instant, or NaN. */
export function parseLocal(s) {
  if (!s || s.length < 16) return NaN;
  const t = Date.parse(s.slice(0, 16).replace(" ", "T") + ":00+08:00");
  return t;
}
export const pad2 = (n) => String(n).padStart(2, "0");
export const hhmm = (ms) => {
  const p = myt(ms);
  return `${pad2(p.h)}:${pad2(p.min)}`;
};

// ------------------------------------------------------------------ geometry

const RAD = Math.PI / 180;
export function approxM(a, b) {
  const x = (b.lng - a.lng) * 111320 * Math.cos(((a.lat + b.lat) / 2) * RAD);
  const y = (b.lat - a.lat) * 110574;
  return Math.hypot(x, y);
}
export function bearing(a, b) {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * RAD);
  const y = b.lat - a.lat;
  return ((Math.atan2(x, y) / RAD) + 360) % 360;
}

// ------------------------------------------------------------------ stop names

const CODE_PREFIX = /^(\(M\)\s*)?[A-Z]{2}\d{3,4}\s+/;
const STOP_CODE = /^(?:\(M\)\s*)?([A-Z]{2}\d{3,4})\s/;
const KEEP_UPPER = new Set(["LRT", "MRT", "KL", "PJ", "SS2", "PPUM", "UIA", "SMK", "AM", "MAHSA", "KWSP"]);
const SIDE = [["(OPP)", "对面"], ["(UTARA)", "北"], ["(SELATAN)", "南"], ["(TIMUR)", "东"], ["(BARAT)", "西"]];

/** "PJ237 PUSAT ASASI UIA (SELATAN)" → "Pusat Asasi UIA（南）". */
export function prettyStopName(raw) {
  let s = raw.trim().replace(CODE_PREFIX, "").trim();
  let side = null;
  for (const [k, v] of SIDE) {
    if (s.endsWith(k)) {
      s = s.slice(0, -k.length).trim();
      side = v;
    }
  }
  s = s.split(" ").filter(Boolean).map((w) => {
    const core = w.replace(/^\(+|\)+$/g, "");
    if (KEEP_UPPER.has(core) || /\d/.test(core)) return w;
    const lower = w.toLowerCase();
    const i = lower.search(/\p{L}/u);
    return i < 0 ? lower : lower.slice(0, i) + lower[i].toUpperCase() + lower.slice(i + 1);
  }).join(" ");
  return side ? `${s}（${side}）` : s;
}

/** "往 Mid Valley", or "环线" for loop routes. */
export const towards = (line) =>
  !line.dirCode || !line.headsign ? "环线" : "往 " + prettyStopName(line.headsign).replace(/^Stesen /, "");

/** assets/routes.json → { lines, myStops } with points as {lat, lng}. */
export function loadBundle(json) {
  const lines = [];
  for (const r of json.routes) {
    for (const l of r.lines) {
      lines.push({
        routeId: r.id,
        routeName: r.name,
        dirCode: l.dir || "",
        headsign: l.headsign || "",
        shape: l.shape.filter((p) => p.length >= 2).map(([lat, lng]) => ({ lat, lng })),
        stops: l.stops.map((s) => ({
          id: s.id,
          code: (STOP_CODE.exec(s.name) || [])[1] || null,
          name: prettyStopName(s.name),
          pos: { lat: s.lat, lng: s.lng },
        })),
      });
    }
  }
  const myStops = (json.myStops || []).map((s) => ({ code: s.code, name: prettyStopName(s.name), pos: { lat: s.lat, lng: s.lng }, routes: s.routes || [] }));
  return { lines, myStops };
}

// ------------------------------------------------------------------ route index: next stop and arrivals

const OFF_ROUTE_M = 300;
const ARRIVING_M = 80;
const NEAR_M = 120;
const LEAVE_M = 300;
const M_PER_DEGREE = 2;
export const DEFAULT_SPEED_KMH = 20;
export const DEFAULT_LAYOVER_MIN = 3;

function firstPass(shape, pos, from) {
  let best = Math.min(Math.max(from, 0), shape.length - 1);
  let bd = Infinity;
  for (let i = best; i < shape.length; i++) {
    const d = approxM(shape[i], pos);
    if (d < bd) {
      bd = d;
      best = i;
    }
    if (bd < NEAR_M && d > bd + LEAVE_M) break;
  }
  return best;
}

function nearest(shape, pos, from, heading) {
  let best = { index: Math.min(Math.max(from, 0), shape.length - 1), distance: Infinity, score: Infinity };
  for (let i = best.index; i < shape.length; i++) {
    const d = approxM(shape[i], pos);
    let score = d;
    if (heading != null) {
      const a = i < shape.length - 1 ? shape[i] : shape[i - 1];
      const b = i < shape.length - 1 ? shape[i + 1] : shape[i];
      const diff = Math.abs(((((bearing(a, b) - heading) % 360) + 540) % 360) - 180);
      score += diff * M_PER_DEGREE;
    }
    if (score < best.score) best = { index: i, distance: d, score };
  }
  return best;
}

export class RouteIndex {
  constructor(lines) {
    this.byRoute = new Map();
    for (const line of lines) {
      if (line.shape.length < 2) continue;
      let from = 0;
      const stopIdx = line.stops.map((s) => (from = firstPass(line.shape, s.pos, from)));
      const cum = new Float64Array(line.shape.length);
      for (let i = 1; i < line.shape.length; i++) cum[i] = cum[i - 1] + approxM(line.shape[i - 1], line.shape[i]);
      const p = { line, stopIdx, cum, total: cum[cum.length - 1] };
      if (!this.byRoute.has(line.routeId)) this.byRoute.set(line.routeId, []);
      this.byRoute.get(line.routeId).push(p);
    }
  }

  position(routeId, pos, dirCode, heading) {
    const all = this.byRoute.get(routeId);
    if (!all) return null;
    const exact = dirCode ? all.filter((p) => p.line.dirCode === dirCode) : [];
    let best = null;
    for (const p of exact.length ? exact : all) {
      const hit = nearest(p.line.shape, pos, 0, heading);
      if (!best || hit.score < best.hit.score) best = { p, hit };
    }
    return best;
  }

  /** Where a bus is: its line, next stop, and whether it is about to stop there. */
  locate(routeId, pos, dirCode, heading) {
    const r = this.position(routeId, pos, dirCode, heading);
    if (!r) return null;
    const { p, hit } = r;
    if (hit.distance > OFF_ROUTE_M || !p.line.stops.length) return { line: p.line, nextStop: null, arriving: false };
    let k = p.stopIdx.findIndex((i) => i >= hit.index);
    if (k < 0) k = p.line.stops.length - 1;
    const stop = p.line.stops[k];
    return { line: p.line, nextStop: stop.name, arriving: approxM(pos, stop.pos) <= ARRIVING_M };
  }

  /** Buses on [routes] reaching the stop [stopCode], soonest first, within [maxMinutes]. */
  arrivals(stopCode, routes, buses, { speedKmh = null, layoverMin = DEFAULT_LAYOVER_MIN, maxMinutes = 60 } = {}) {
    const out = [];
    for (const b of buses) {
      if (!routes.includes(b.route)) continue;
      const r = this.position(b.route, b.pos, b.dirCode, b.angle);
      if (!r || r.hit.distance > OFF_ROUTE_M) continue;
      const { p, hit } = r;
      const here = p.cum[hit.index];
      const targets = p.line.stops.map((s, i) => (s.code === stopCode ? i : -1)).filter((i) => i >= 0);
      let meters = null;
      let via = false;
      const ahead = targets.find((i) => p.stopIdx[i] >= hit.index);
      if (ahead !== undefined) {
        meters = p.cum[p.stopIdx[ahead]] - here;
      } else if (!p.line.dirCode && targets.length) {
        meters = p.total - here + p.cum[p.stopIdx[targets[0]]];
        via = true;
      } else {
        for (const other of this.byRoute.get(b.route) || []) {
          if (other === p) continue;
          const k = other.line.stops.findIndex((s) => s.code === stopCode);
          if (k < 0) continue;
          meters = p.total - here + other.cum[other.stopIdx[k]];
          via = true;
          break;
        }
      }
      if (meters == null) continue;
      const mps = (speedKmh ?? routeById(b.route)?.speed ?? DEFAULT_SPEED_KMH) / 3.6;
      const minutes = Math.ceil(meters / mps / 60 + (via ? layoverMin : 0));
      if (minutes > maxMinutes) continue;
      out.push({ routeId: b.route, routeName: p.line.routeName, busId: b.id, minutes, meters: Math.round(meters), viaTerminus: via });
    }
    return out.sort((a, b) => a.minutes - b.minutes);
  }
}

export const etaText = (a) => (a.minutes <= 1 ? "马上到" : `约 ${a.minutes} 分钟`) + (a.viaTerminus ? "（掉头后）" : "");

/** Announces each bus once when it is within the lead time. */
export class DepartureAlerter {
  constructor(repeatMs = 20 * 60000) {
    this.repeatMs = repeatMs;
    this.announced = new Map();
  }
  check(arrivals, leadMin, nowMs) {
    for (const [k, t] of this.announced) if (nowMs - t > this.repeatMs) this.announced.delete(k);
    const a = arrivals.find((x) => x.minutes <= leadMin && !this.announced.has(x.routeId + "/" + x.busId));
    if (!a) return null;
    this.announced.set(a.routeId + "/" + a.busId, nowMs);
    return a;
  }
}

// ------------------------------------------------------------------ live feed protocol (Socket.IO v2 / Engine.IO 3)

export const WS_URL = "wss://rapidbus-socketio-avl.prasarana.com.my/socket.io/?EIO=3&transport=websocket";
export const reloadFrame = (route) =>
  "42" + JSON.stringify(["onFts-reload", { sid: "", uid: "", provider: "RKL", route }]);

export function parseFrame(text) {
  if (!text) return { type: "other" };
  switch (text[0]) {
    case "0": {
      let ping = 25000;
      try {
        ping = JSON.parse(text.slice(1)).pingInterval || ping;
      } catch (e) {
        /* keep default */
      }
      return { type: "open", ping };
    }
    case "1": return { type: "close" };
    case "2": return { type: "ping" };
    case "3": return { type: "pong" };
    case "4": {
      const p = text.slice(1);
      if (p[0] === "0") return { type: "connected" };
      if (p[0] === "1") return { type: "close" };
      if (p[0] === "2") {
        const i = p.indexOf("[");
        try {
          const arr = JSON.parse(p.slice(i));
          return { type: "event", name: arr[0], data: arr[1] };
        } catch (e) {
          return { type: "other" };
        }
      }
      return { type: "other" };
    }
    default: return { type: "other" };
  }
}

const MAX_AGE_MS = 5 * 60000;
/** Decoded payload → buses on [routes] with a fresh GPS fix. */
export function parseBuses(payloadText, nowMs, routes) {
  const root = JSON.parse(payloadText);
  const items = Array.isArray(root) ? root : root && typeof root === "object" ? Object.values(root) : [];
  const seen = new Set();
  const out = [];
  for (const o of items) {
    if (!o || typeof o !== "object") continue;
    const route = String(o.route || "").trim().toUpperCase();
    if (!routes.includes(route)) continue;
    const id = String(o.bus_no || "").trim().toUpperCase();
    const lat = parseFloat(o.latitude);
    const lng = parseFloat(o.longitude);
    if (!id || !(lat >= 1 && lat <= 7.5) || !(lng >= 99 && lng <= 120)) continue;
    const gps = parseLocal(String(o.dt_gps || ""));
    if (Number.isNaN(gps)) continue;
    const age = nowMs - gps;
    if (age > MAX_AGE_MS || age < -60000) continue;
    const key = route + "/" + id;
    if (seen.has(key)) continue;
    seen.add(key);
    const dirRaw = String(o.dir ?? "").trim().replace(/^0+/, "");
    const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(parseFloat(v)) ? null : Math.round(parseFloat(v)));
    out.push({ id, route, pos: { lat, lng }, dirCode: dirRaw ? dirRaw.padStart(2, "0") : null, speed: num(o.speed), angle: num(o.angle), gpsMs: gps });
  }
  return out;
}

// ------------------------------------------------------------------ rain: calibration and the basketball index

const MODELS = {
  1: [-4.21396, 3.58072, 0.34392, -0.097, 0.09295],
  2: [-4.02709, 3.5371, 0.32342, 0.14852, 0.12252],
  3: [-3.93535, 3.49609, 0.37756, 0.16313, 0.14014],
};
export const GREEN_BELOW = 0.25;
export const RED_FROM = 0.4;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => {
  const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return Math.log(q / (1 - q));
};

/** Calibrated chance (0–1) of rain at the court in a window of [hours] hours (see tools/calibrate.py). */
export function rainChance(hours, maxProb, sumMm, thunder, cape) {
  const [b0, bp, bmm, bt, bc] = MODELS[Math.min(Math.max(hours, 1), 3)];
  return sigmoid(b0 + (bp * Math.min(Math.max(maxProb, 0), 100)) / 100 + bmm * Math.log(1 + Math.max(0, sumMm)) + (thunder ? bt : 0) + (bc * (cape ?? 1000)) / 1000);
}

/** Your own records → a small logit shift (ridge-penalised); 0 until 8 days. */
export const PERSONAL_MIN = 8;
export function fitShift(outcomes, ridge = 3) {
  if (outcomes.length < PERSONAL_MIN) return 0;
  let d = 0;
  for (let it = 0; it < 25; it++) {
    let g = ridge * d;
    let h = ridge;
    for (const o of outcomes) {
      const p = sigmoid(logit(o.predicted) + d);
      g += p - (o.rained ? 1 : 0);
      h += p * (1 - p);
    }
    d -= g / h;
  }
  return Math.min(Math.max(d, -1.5), 1.5);
}
export const applyShift = (p, shift) => (shift === 0 ? p : sigmoid(logit(p) + shift));

const THUNDER = new Set([95, 96, 99]);
export function isRelevantWarning(w) {
  const head = `${w.heading} ${w.title}`.toLowerCase();
  const text = (w.text || "").toLowerCase();
  return ["thunder", "rain", "ribut petir", "hujan"].some((k) => head.includes(k)) && (text.includes("kuala lumpur") || text.includes("petaling"));
}

/**
 * The basketball verdict for today's (or tomorrow's) play window.
 * hourly: Open-Meteo arrays (Malaysia time, value = preceding hour). warnings: [{heading,title,text,validFrom,validTo}].
 */
export function evaluateRain({ hourly, nowMs, startHour = 17, durationHours = 2, warnings = [], warningsOk = true, air = null, shift = 0, samples = 0, radar = null }) {
  if (!hourly || !hourly.time || !hourly.time.length) return { level: "unknown", reasons: ["天气数据获取失败，请稍后刷新"], chance: -1, bars: [] };
  const n = myt(nowMs);
  const dur = Math.min(Math.max(durationHours, 1), 6);
  let start = mytMs(n.y, n.m, n.d, Math.min(Math.max(startHour, 0), 23));
  let end = start + dur * 3600000;
  const tomorrow = nowMs >= end;
  if (tomorrow) {
    start += 86400000;
    end += 86400000;
  }
  const windowLabel = `${tomorrow ? "明天" : "今天"} ${hhmm(start)}–${hhmm(end)}`;
  const nowHour = mytMs(n.y, n.m, n.d, n.h);
  let maxProb = -1, sum = 0, thunder = false, maxCape = null, maxFeels = null, covered = 0, recent = 0, nowMm = 0;
  const bars = [];
  const H = hourly;
  for (let i = 0; i < H.time.length; i++) {
    const t = parseLocal(H.time[i]);
    if (Number.isNaN(t)) continue;
    const p = H.precipitation_probability?.[i] ?? -1;
    const mm = H.precipitation?.[i] ?? 0;
    const c = H.weather_code?.[i] ?? -1;
    if (t > start && t <= end) {
      covered++;
      if (p > maxProb) maxProb = p;
      if (mm > 0) sum += mm;
      if (THUNDER.has(c)) thunder = true;
      const cp = H.cape?.[i];
      if (cp != null) maxCape = Math.max(maxCape ?? cp, cp);
      const f = H.apparent_temperature?.[i];
      if (f != null) maxFeels = Math.max(maxFeels ?? f, f);
    }
    if (t > nowHour - 3 * 3600000 && t <= nowHour && mm > 0) recent += mm;
    if (t === nowHour + 3600000) nowMm = mm; // the entry covering the current hour
    if (t > nowHour && t <= nowHour + 12 * 3600000) {
      const hc = p < 0 ? 0 : Math.round(applyShift(rainChance(1, p, mm, THUNDER.has(c), H.cape?.[i]), shift) * 100);
      bars.push({ label: pad2(myt(t).h), prob: hc });
    }
  }
  if (!covered) return { level: "unknown", windowLabel, tomorrow, reasons: ["预报里没有这个时段的数据"], chance: -1, bars };

  const r1 = (x) => Math.round(x * 10) / 10;
  const sumPrecip = r1(sum);
  const recentRain = r1(recent);
  const p = applyShift(rainChance(dur, Math.max(maxProb, 0), sum, thunder, maxCape), shift);
  const chance = Math.round(p * 100);
  const order = ["unknown", "green", "yellow", "red"];
  let level = p >= RED_FROM ? "red" : p >= GREEN_BELOW ? "yellow" : "green";
  const raise = (l) => {
    if (order.indexOf(l) > order.indexOf(level)) level = l;
  };
  const why = [];

  let warnUntil = null;
  for (const w of warnings) {
    if (!isRelevantWarning(w)) continue;
    const from = parseLocal(w.validFrom);
    const to = parseLocal(w.validTo);
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    if (!(from > end) && !(to < start)) warnUntil = to;
  }
  if (warnUntil != null) {
    raise(p >= 0.3 ? "red" : "yellow");
    const u = myt(warnUntil);
    why.push(`MET 对吉隆坡/八打灵发布了雷暴或大雨警报（至 ${pad2(u.m)}-${pad2(u.d)} ${pad2(u.h)}:${pad2(u.min)}）`);
  }
  if (thunder) why.push("模型预报这个时段可能有雷暴");

  let aqi = null, aqiNow = null, aqiDayMax = null;
  const dayEnd = mytMs(n.y, n.m, n.d, 20);
  if (air && air.time) {
    for (let i = 0; i < air.time.length; i++) {
      const t = parseLocal(air.time[i]);
      const v = air.us_aqi?.[i];
      if (Number.isNaN(t) || v == null) continue;
      if (t > start - 3600000 && t <= end) aqi = Math.max(aqi ?? v, Math.round(v));
      if (t === nowHour) aqiNow = Math.round(v);
      if (t >= nowHour && t <= dayEnd) aqiDayMax = Math.max(aqiDayMax ?? v, Math.round(v));
    }
  }
  if (aqi != null) {
    if (aqi > 150) {
      raise("yellow");
      why.push(`空气很差（AQI ${aqi}），不建议在户外剧烈运动`);
    } else if (aqi > 100) why.push(`空气对敏感人群不健康（AQI ${aqi}），注意别太拼`);
  }
  const feels = maxFeels == null ? null : Math.round(maxFeels);
  if (feels != null) {
    if (feels >= 42) {
      raise("yellow");
      why.push(`体感 ${feels}°C，太热了，多喝水、别打太久`);
    } else if (feels >= 39) why.push(`体感 ${feels}°C，挺热，记得带水`);
  }
  if (!tomorrow && recentRain >= 0.5 && start < nowMs + 4 * 3600000) {
    raise("yellow");
    why.push(`过去 3 小时下过雨（${recentRain} mm），场地可能是湿的`);
  }
  if (radar) {
    const inWindow = nowMs >= start && nowMs < end;
    const minsToStart = Math.floor((start - nowMs) / 60000);
    if (inWindow || (minsToStart >= 0 && minsToStart <= 90)) {
      if (radar.rainingHere) {
        raise(inWindow || minsToStart <= 30 ? "red" : "yellow");
        why.push("雷达：马大附近现在就在下雨");
      } else if (radar.etaMin != null) {
        const arrive = nowMs + radar.etaMin * 60000;
        if (arrive < end) {
          raise(radar.etaMin <= 40 && arrive > start - 15 * 60000 ? "red" : "yellow");
          why.push("雷达：" + radarSummary(radar));
        }
      }
    }
  }
  if (shift !== 0) why.push(`已按你的 ${samples} 条记录微调（你那边${shift > 0 ? "比预报更容易下雨" : "比预报更少下雨"}）`);
  if (!warningsOk) why.push("MET 警报没取到，这次只按预报判断");
  why.unshift(`${windowLabel} 下雨机会约 ${chance}%`, `Open-Meteo 原始概率 ${Math.max(maxProb, 0)}%、雨量 ${sumPrecip} mm；原始概率普遍偏高，已按梳邦站两年多的实况校准`);
  const rainingNow = radar ? !!radar.rainingHere : nowMm >= 1.0;
  return { level, windowLabel, tomorrow, reasons: why, chance, maxProb, sumPrecip, bars, feels, aqi, thunder, radar, rainingNow, aqiNow, aqiDayMax };
}

export const LEVEL = {
  green: { emoji: "🟢", headline: "可以打" },
  yellow: { emoji: "🟡", headline: "看情况" },
  red: { emoji: "🔴", headline: "多半会下" },
  unknown: { emoji: "⚪", headline: "暂无数据" },
};

// ------------------------------------------------------------------ radar nowcast

const HERE_KM = 2.5;
const MAX_SHIFT_PX = 14;
const HORIZON_MIN = 90;
const MIN_RAIN_PX = 12;

function compass(dx, dy) {
  return Math.round(((Math.atan2(dx, -dy) / RAD) + 360) % 360) % 360;
}
export const direction = (deg) => ["北", "东北", "东", "东南", "南", "西南", "西", "西北"][Math.floor((deg + 22.5) / 45) % 8];

function bestShift(a, b) {
  const n = a.size;
  const src = [];
  for (let i = 0; i < a.rain.length; i++) if (a.rain[i]) src.push(i);
  if (src.length < MIN_RAIN_PX) return null;
  let best = { dx: 0, dy: 0, hit: -1 };
  for (let dy = -MAX_SHIFT_PX; dy <= MAX_SHIFT_PX; dy++) {
    for (let dx = -MAX_SHIFT_PX; dx <= MAX_SHIFT_PX; dx++) {
      let hit = 0;
      for (const i of src) {
        const x = (i % n) + dx;
        const y = Math.floor(i / n) + dy;
        if (x >= 0 && x < n && y >= 0 && y < n && b.rain[y * n + x]) hit++;
      }
      if (hit > best.hit || (hit === best.hit && dx * dx + dy * dy < best.dx * best.dx + best.dy * best.dy)) best = { dx, dy, hit };
    }
  }
  return best.hit >= MIN_RAIN_PX ? best : null;
}

/** frames: [{timeSec, size, rain: Uint8Array}] centred on the court. */
export function nowcast(frames, kmPerPx) {
  const last = frames[frames.length - 1];
  if (!last) return null;
  const n = last.size;
  const c = Math.floor(n / 2);
  const hereR = HERE_KM / kmPerPx;
  let rainingHere = false;
  let nearest = Infinity, nx = 0, ny = 0;
  const pts = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!last.rain[y * n + x]) continue;
      pts.push([x, y]);
      const d = Math.hypot(x - c, y - c);
      if (d <= hereR) rainingHere = true;
      if (d < nearest) {
        nearest = d;
        nx = x;
        ny = y;
      }
    }
  }
  const rangeKm = c * kmPerPx;
  const base = { frameTimeSec: last.timeSec, rangeKm };
  if (!pts.length) return { ...base, rainingHere: false, nearestKm: null, nearestBearing: null, etaMin: null, speedKmh: null };
  const brg = compass(nx - c, ny - c);
  let vx = 0, vy = 0, w = 0;
  for (let i = Math.max(1, frames.length - 3); i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const dt = (b.timeSec - a.timeSec) / 60;
    if (dt <= 0 || a.size !== n) continue;
    const s = bestShift(a, b);
    if (!s) continue;
    vx += (s.dx / dt) * s.hit;
    vy += (s.dy / dt) * s.hit;
    w += s.hit;
  }
  if (w <= 0) return { ...base, rainingHere, nearestKm: nearest * kmPerPx, nearestBearing: brg, etaMin: rainingHere ? 0 : null, speedKmh: null };
  vx /= w;
  vy /= w;
  const speedKmh = Math.hypot(vx, vy) * kmPerPx * 60;
  let eta = rainingHere ? 0 : null;
  if (eta == null && speedKmh >= 3) {
    outer: for (let t = 2; t <= HORIZON_MIN; t += 2) {
      for (const [x, y] of pts) {
        if (Math.hypot(x + vx * t - c, y + vy * t - c) <= hereR) {
          eta = t;
          break outer;
        }
      }
    }
  }
  return { ...base, rainingHere, nearestKm: nearest * kmPerPx, nearestBearing: brg, etaMin: eta, speedKmh };
}

export function radarSummary(r) {
  if (r.rainingHere) return "马大附近现在就在下雨";
  if (r.etaMin != null && r.nearestKm != null) return `${direction(r.nearestBearing)} ${r.nearestKm.toFixed(0)} km 有雨，正往这边移动，约 ${r.etaMin} 分钟到`;
  if (r.nearestKm != null) return `最近的雨在${direction(r.nearestBearing)} ${r.nearestKm.toFixed(0)} km，暂时没往这边来`;
  return `周围 ${r.rangeKm.toFixed(0)} km 内没有雨`;
}

/** Web-mercator global pixel of a point at zoom [z] with [tile]-pixel tiles. */
export function globalPixel(lat, lng, z, tile) {
  const n = 2 ** z;
  const s = Math.sin(lat * RAD);
  return { x: ((lng + 180) / 360) * n * tile, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * tile };
}

// ------------------------------------------------------------------ everyday life (domain/SunTimes.kt, BallStats.kt, Holidays.kt, Fx.kt, DailyLife.kt)

/** "YYYY-MM-DD" ↔ day number, so date maths needs no time zones. */
export const dayNum = (iso) => Math.floor(Date.parse(iso + "T00:00:00Z") / 86400000);
export const isoOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
export const todayIso = (ms = Date.now()) => {
  const p = myt(ms);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
};
/** 1 = Monday … 7 = Sunday */
export const weekday = (iso) => ((dayNum(iso) + 3) % 7 + 7) % 7 + 1;
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const hmOf = (min) => `${pad2(Math.floor(min / 60))}:${pad2(Math.floor(min % 60))}`;

/** NOAA solar calculator: minutes after local midnight for sunrise, sunset and civil dusk. */
export function sunTimes(iso, lat, lng, tz = 8) {
  const rad = (d) => d * RAD, deg = (r) => r / RAD;
  const jd = dayNum(iso) + 2440587.5 + (12 - tz) / 24;
  const t = (jd - 2451545) / 36525;
  const l0 = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(rad(m)) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(rad(2 * m)) * (0.019993 - 0.000101 * t) + Math.sin(rad(3 * m)) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const appLong = l0 + c - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(appLong))));
  const y = Math.tan(rad(obliq / 2)) ** 2;
  const eqTime = 4 * deg(y * Math.sin(2 * rad(l0)) - 2 * e * Math.sin(rad(m)) + 4 * e * y * Math.sin(rad(m)) * Math.cos(2 * rad(l0)) - 0.5 * y * y * Math.sin(4 * rad(l0)) - 1.25 * e * e * Math.sin(2 * rad(m)));
  const noon = 720 - 4 * lng - eqTime + tz * 60;
  const ha = (z) => deg(Math.acos(Math.min(1, Math.max(-1, Math.cos(rad(z)) / (Math.cos(rad(lat)) * Math.cos(rad(decl))) - Math.tan(rad(lat)) * Math.tan(rad(decl))))));
  const h = ha(90.833);
  const round = (x) => Math.round(x * 60) / 60; // to the second, like the app
  return { sunrise: round(noon - 4 * h), sunset: round(noon + 4 * h), dusk: round(noon + 4 * ha(96)) };
}
export function sunLine(sun, endHour) {
  const base = `🌇 日落 ${hmOf(sun.sunset)}，${hmOf(sun.dusk)} 天黑`;
  if (endHour == null) return base;
  const endMin = endHour * 60;
  const sunsetMin = Math.floor(sun.sunset);
  if (endMin < sunsetMin - 90) return base;
  if (endMin <= sunsetMin) return `${base} · 打到 ${pad2(endHour)}:00 天还亮`;
  if (endMin <= Math.floor(sun.dusk)) return `${base} · 最后一会儿天会暗下来`;
  return `${base} · 打到 ${pad2(endHour)}:00 得有灯`;
}

/** feedback: { "YYYY-MM-DD": "played" | "rained" } (one value per day, the last tap). */
export function ballStats(feedback, today) {
  const t = dayNum(today);
  const [ty, tm] = today.split("-");
  const played = Object.entries(feedback).filter(([d, v]) => v === "played" && dayNum(d) <= t).map(([d]) => d).sort();
  const rained = Object.entries(feedback).filter(([, v]) => v === "rained").map(([d]) => d);
  const inMonth = (d) => d.startsWith(`${ty}-${tm}-`);
  const monday = (iso) => dayNum(iso) - (weekday(iso) - 1);
  const weeks = new Set(played.map(monday));
  let w = monday(today);
  if (!weeks.has(w)) w -= 7;
  let streak = 0;
  while (weeks.has(w)) {
    streak++;
    w -= 7;
  }
  return { monthPlayed: played.filter(inMonth).length, monthRained: rained.filter(inMonth).length, weekStreak: streak, totalPlayed: played.length, lastPlayed: played[played.length - 1] ?? null };
}
export function ballSummary(s, today) {
  if (s.totalPlayed === 0 && s.monthRained === 0) return "📊 还没有记录：打完球点一下「打成了」，这里会帮你统计";
  const parts = [`本月打了 ${s.monthPlayed} 次`];
  if (s.monthRained > 0) parts.push(`雨天 ${s.monthRained} 次`);
  if (s.weekStreak >= 2) parts.push(`连续 ${s.weekStreak} 周都打了 🔥`);
  else if (s.lastPlayed) {
    const ago = dayNum(today) - dayNum(s.lastPlayed);
    parts.push(ago === 0 ? "今天打了" : ago === 1 ? "上次是昨天" : `上次是 ${ago} 天前`);
  }
  return "📊 " + parts.join(" · ");
}

/** holidays.json → list with the Sunday replacement days added (Holidays Act 1951), per region. */
export function withReplacements(list) {
  const extra = [];
  for (const region of new Set(list.flatMap((h) => h.regions))) {
    const inRegion = list.filter((h) => h.regions.includes(region)).sort((a, b) => dayNum(a.date) - dayNum(b.date));
    const taken = new Set(inRegion.map((h) => h.date));
    for (const h of inRegion) {
      if (weekday(h.date) !== 7) continue;
      let d = dayNum(h.date) + 1;
      while (taken.has(isoOf(d)) || weekday(isoOf(d)) === 7) d++;
      taken.add(isoOf(d));
      extra.push({ date: isoOf(d), name: h.name + "补假", regions: [region], tentative: !!h.tentative, replacement: true });
    }
  }
  const merged = new Map();
  for (const h of extra) {
    const k = h.date + "|" + h.name;
    if (merged.has(k)) merged.get(k).regions.push(...h.regions);
    else merged.set(k, { ...h, regions: [...h.regions] });
  }
  return [...list.map((h) => ({ tentative: false, replacement: false, ...h })), ...merged.values()]
    .sort((a, b) => dayNum(a.date) - dayNum(b.date) || Number(a.replacement) - Number(b.replacement));
}
export const holidaysOn = (list, iso) => list.filter((h) => h.date === iso);
export const upcomingHolidays = (list, from, days) => list.filter((h) => dayNum(h.date) >= dayNum(from) && dayNum(h.date) < dayNum(from) + days);
export const regionLabel = (r) => (r.includes("KUL") && r.includes("SGR") ? "雪州、吉隆坡" : r.includes("KUL") ? "仅吉隆坡" : "仅雪州");
export const holidayLabel = (h) => `${h.name}（${regionLabel(h.regions)}${h.tentative ? "，日期以官方为准" : ""}）`;
export const isWorkday = (list, iso) => weekday(iso) <= 5 && holidaysOn(list, iso).length === 0;
export function busHolidayHint(list, today) {
  const t = holidaysOn(list, today);
  if (t.length) return `🎉 今天公共假期：${t.map(holidayLabel).join("、")} · 公交可能按假日班次，车会少一些`;
  const m = holidaysOn(list, isoOf(dayNum(today) + 1));
  if (m.length) return `📅 明天公共假期：${m.map(holidayLabel).join("、")}`;
  return null;
}
export function holidayWhen(h, today) {
  const days = dayNum(h.date) - dayNum(today);
  const rel = days === 0 ? "今天" : days === 1 ? "明天" : days === 2 ? "后天" : `${days} 天后`;
  const [, m, d] = h.date.split("-").map(Number);
  return `${m}月${d}日 ${WEEKDAYS[weekday(h.date) - 1]} · ${rel}`;
}

/** Frankfurter series {rates:{date:{CNY:x}}} → points, oldest first. */
export const fxPoints = (json) => Object.entries(json?.rates || {}).filter(([, v]) => v?.CNY != null).map(([date, v]) => ({ date, rate: v.CNY })).sort((a, b) => dayNum(a.date) - dayNum(b.date));
export function fxView(points) {
  if (!points.length) return null;
  const latest = points[points.length - 1];
  const L = dayNum(latest.date);
  const month = points.filter((p) => dayNum(p.date) >= L - 30);
  const since = (days) => {
    const base = [...points].reverse().find((p) => dayNum(p.date) <= L - days);
    return base ? (latest.rate / base.rate - 1) * 100 : null;
  };
  return { latest, change7: since(7), change30: since(30), min30: Math.min(...month.map((p) => p.rate)), max30: Math.max(...month.map((p) => p.rate)), points: month };
}
export function fxCheck(rate, target, above, armed, hysteresis = 0.003) {
  const met = above ? rate >= target : rate <= target;
  const back = above ? rate < target - hysteresis : rate > target + hysteresis;
  if (met && armed) return { alert: true, armed: false };
  if (!met && back) return { alert: false, armed: true };
  return { alert: false, armed };
}
export const fxRate = (r) => r.toFixed(4);
export const fxPct = (p) => (p >= 0 ? "+" : "−") + Math.abs(p).toFixed(1) + "%";

export const PLAN_B_WAIT = 20;
/** nextMin: minutes to the first bus, null = none within the hour. */
export const planB = (rainingNow, nextMin) => !!rainingNow && (nextMin == null || nextMin >= PLAN_B_WAIT);
export const planBText = (nextMin) => `🌧 正在下雨，${nextMin == null ? "一小时内都没看到车" : `下一班还要 ${nextMin} 分钟`}，要不要叫个 Grab？`;

export const aqiLabel = (a) => (a <= 50 ? "好" : a <= 100 ? "一般" : a <= 150 ? "敏感人群注意" : a <= 200 ? "不健康" : a <= 300 ? "很不健康" : "危险");
