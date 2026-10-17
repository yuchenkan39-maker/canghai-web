// 季沧海助手 · web — UI. All data comes straight from the public sources, nothing goes through a server of ours.
import {
  ROUTES, ROUTE_IDS, routeById, routeOrder, TRIPS, tripForHour, myt, hhmm, pad2, loadBundle, RouteIndex, towards,
  DepartureAlerter, etaText, WS_URL, reloadFrame, parseFrame, parseBuses, evaluateRain, LEVEL, radarSummary,
  nowcast, globalPixel, fitShift, PERSONAL_MIN, sunTimes, sunLine, ballStats, ballSummary, withReplacements,
  busHolidayHint, upcomingHolidays, holidayWhen, regionLabel, fxPoints, fxView, fxCheck, fxRate, fxPct, planB, planBText,
  aqiLabel, todayIso, dayNum, isoOf,
} from "./core.js";

const LAT = 3.1209, LNG = 101.6538; // Universiti Malaya
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("canghai." + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("canghai." + k, JSON.stringify(v));
    } catch (e) {
      /* private mode: settings just won't stick */
    }
  },
};
const darkMq = matchMedia("(prefers-color-scheme: dark)");
const colorOf = (id) => {
  const r = routeById(id);
  return r ? (darkMq.matches ? r.dark : r.color) : "#888";
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  bundle: null,
  index: null,
  buses: new Map(), // "route/plate" → { bus, seenMs }
  connected: false,
  status: "正在连接实时数据…",
  updatedAt: null,
  shown: new Set(store.get("routes", ROUTE_IDS).filter((id) => ROUTE_IDS.includes(id))),
  tripChoice: null,
  lead: store.get("lead", 10),
  alerting: false,
  alerter: new DepartureAlerter(),
  selected: null,
  radarOn: store.get("radarLayer", false),
  startHour: store.get("startHour", 17),
  duration: store.get("duration", 2),
  weather: null,
  radarMeta: null,
  holidays: [],
  fx: null,
};

// ------------------------------------------------------------------ toast, sound, notifications

let toastTimer = 0;
function toast(text, ms = 4000) {
  const t = $("toast");
  t.textContent = text;
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = "none"), ms);
}

let audio = null;
function unlockAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch (e) {
    audio = null;
  }
}
function chime() {
  if (!audio) return;
  const t0 = audio.currentTime;
  [[880, 0], [1175, 0.18], [1568, 0.36]].forEach(([f, dt]) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.45);
    o.connect(g).connect(audio.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 0.5);
  });
}
function notify(title, body) {
  chime();
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 600]);
  toast(`🔔 ${title}：${body}`, 15000);
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body, icon: "icons/icon-192.png", tag: "canghai-bus", renotify: true });
    } catch (e) {
      /* some mobile browsers only allow notifications from a service worker */
    }
  }
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) {
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  if (state.alerting && document.visibilityState === "visible") keepAwake(true);
});

// ------------------------------------------------------------------ live feed (Socket.IO v2 over a raw WebSocket)

async function inflateB64(b64) {
  const bin = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
  const fmt = bin[0] === 0x1f && bin[1] === 0x8b ? "gzip" : "deflate";
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream(fmt));
  return new Response(stream).text();
}

class Feed {
  constructor(routes) {
    this.routes = routes;
    this.backoff = 2000;
    this.timers = [];
  }
  start() {
    this.connect();
  }
  clear() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
  }
  connect() {
    this.clear();
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      return this.fail("连接失败");
    }
    this.ws = ws;
    this.lastData = Date.now();
    this.pingMs = 25000;
    this.dead = false;
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => this.fail("连接中断");
    ws.onerror = () => this.fail("网络错误");
    const send = (s) => {
      if (ws.readyState === 1) ws.send(s);
    };
    this.timers.push(setInterval(() => this.routes.forEach((r) => send(reloadFrame(r))), 5000));
    this.timers.push(setInterval(() => send("2"), this.pingMs));
    this.timers.push(setInterval(() => {
      if (Date.now() - this.lastData > 30000) {
        this.fail("30 秒没有收到数据");
      }
    }, 5000));
  }
  async onMessage(text) {
    const f = parseFrame(text);
    if (f.type === "connected") {
      setStatus("已连上实时数据", false);
      this.routes.forEach((r) => this.ws.send(reloadFrame(r)));
    } else if (f.type === "ping") {
      this.ws.send("3");
    } else if (f.type === "event" && f.name === "onFts-client" && typeof f.data === "string") {
      try {
        const buses = parseBuses(await inflateB64(f.data), Date.now(), this.routes);
        this.lastData = Date.now();
        this.backoff = 2000;
        onBuses(buses);
      } catch (e) {
        /* one bad payload: wait for the next */
      }
    } else if (f.type === "close") {
      this.fail("服务器断开");
    }
  }
  fail(msg) {
    if (this.dead) return;
    this.dead = true;
    this.clear();
    try {
      this.ws && this.ws.close();
    } catch (e) {
      /* already closed */
    }
    state.connected = false;
    setStatus(`${msg}，${Math.round(this.backoff / 1000)} 秒后重连…`, false);
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }
}

function setStatus(text, connected) {
  state.status = text;
  if (!connected) renderLive();
}

/** The server answers route by route; keep each bus until it misses a few polls. */
function onBuses(list) {
  const now = Date.now();
  for (const b of list) state.buses.set(b.route + "/" + b.id, { bus: b, seenMs: now });
  for (const [k, v] of state.buses) if (now - v.seenMs > 15000) state.buses.delete(k);
  state.connected = true;
  state.updatedAt = now;
  renderLive();
  renderBusMarkers();
  renderBusCards();
  renderDepartures();
  renderChips();
}
const allBuses = () => [...state.buses.values()].map((v) => v.bus);
const shownBuses = () =>
  allBuses().filter((b) => state.shown.has(b.route)).sort((a, b) => routeOrder(a.route) - routeOrder(b.route) || (a.dirCode || "").localeCompare(b.dirCode || "") || a.id.localeCompare(b.id));

function renderLive() {
  $("live-dot").className = "dot" + (state.connected ? " on" : "");
  $("live-text").textContent = state.connected
    ? `实时 · ${shownBuses().length} 辆在跑 · ${hhmm(state.updatedAt)}:${pad2(myt(state.updatedAt).s)} 更新`
    : state.status;
}

// ------------------------------------------------------------------ map

const map = L.map("map", { zoomControl: false, attributionControl: false, minZoom: 11, maxZoom: 19, zoomSnap: 0.25 }).setView([3.1135, 101.649], 13);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
map.createPane("radar").style.zIndex = 350;
// keep Leaflet's idea of the map size in step with the layout (rotation, desktop/mobile switch)
new ResizeObserver(() => map.invalidateSize()).observe($("map"));
map.getPane("radar").style.pointerEvents = "none";

const routeLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup();
const starLayer = L.layerGroup().addTo(map);
const busLayer = L.layerGroup().addTo(map);
let radarLayer = null;
const busMarkers = new Map();

const FACE = `<svg width="24" height="24" viewBox="-6 -6.4 12 12" aria-hidden="true"><g fill="#fff"><rect x="-4.1" y="2.4" width="2.1" height="2.6" rx=".7"/><rect x="2" y="2.4" width="2.1" height="2.6" rx=".7"/><rect x="-5" y="-5.8" width="10" height="9.8" rx="2.7"/></g><rect x="-3.7" y="-4.4" width="7.4" height="4.2" rx="1.2" fill="currentColor"/><rect x="-3" y="-3.8" width=".8" height="3" rx=".4" fill="#fff" opacity=".5"/><circle cx="-2.5" cy="1.9" r=".85" fill="currentColor"/><circle cx="2.5" cy="1.9" r=".85" fill="currentColor"/><path d="M-1.1 1.6 Q0 2.9 1.1 1.6" stroke="currentColor" stroke-width=".7" fill="none" stroke-linecap="round"/></svg>`;
const STAR = (c) => `<svg width="32" height="32" viewBox="-16 -16 32 32" aria-hidden="true"><path d="${starPath(14, 6.7)}" fill="${c}" stroke="#fff" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke"/></svg>`;
function starPath(R, r) {
  let d = "";
  for (let k = 0; k < 10; k++) {
    const rad = k % 2 ? r : R;
    const a = ((-90 + k * 36) * Math.PI) / 180;
    d += (k ? "L" : "M") + (rad * Math.cos(a)).toFixed(2) + " " + (rad * Math.sin(a) + 1).toFixed(2);
  }
  return d + "Z";
}

function drawRoutes() {
  routeLayer.clearLayers();
  stopLayer.clearLayers();
  if (!state.bundle) return;
  const lines = state.bundle.lines.filter((l) => state.shown.has(l.routeId));
  const casing = darkMq.matches ? "#101216" : "#ffffff";
  for (const l of lines) L.polyline(l.shape, { color: casing, weight: 8.5, opacity: 1, interactive: false }).addTo(routeLayer);
  for (const l of lines) L.polyline(l.shape, { color: colorOf(l.routeId), weight: 4.5, opacity: 0.9, interactive: false }).addTo(routeLayer);
  for (const l of lines) {
    for (const s of l.stops) {
      L.circleMarker(s.pos, { radius: 4.5, color: colorOf(l.routeId), weight: 2.5, fillColor: "#fff", fillOpacity: 1 })
        .on("click", () => toast(`🚏 ${s.name} · ${l.routeName} ${towards(l)}`))
        .addTo(stopLayer);
    }
  }
  applyStopVisibility();
}
function applyStopVisibility() {
  const show = map.getZoom() >= 14;
  if (show && !map.hasLayer(stopLayer)) stopLayer.addTo(map);
  if (!show && map.hasLayer(stopLayer)) map.removeLayer(stopLayer);
}
function drawStars() {
  starLayer.clearLayers();
  for (const s of state.bundle.myStops) {
    const names = s.routes.join("、");
    const html = `<div class="star-m">${STAR(getComputedStyle(document.documentElement).getPropertyValue("--star").trim() || "#FFB800")}<span class="lbl">${esc(s.name)}</span></div>`;
    L.marker(s.pos, { icon: L.divIcon({ className: "", html, iconSize: [0, 0] }), zIndexOffset: 500, keyboard: false })
      .on("click", () => toast(`⭐ ${s.code} ${s.name} · ${names} 停靠`))
      .addTo(starLayer);
  }
}
/** First view: your corridor — T790 between Paramount and Mid Valley, with both starred stops. */
function fitHome() {
  const pts = (state.bundle?.lines || []).filter((l) => l.routeId === "T7900").flatMap((l) => l.shape).concat((state.bundle?.myStops || []).map((s) => s.pos));
  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [24, 24] });
}
function fitAll() {
  const pts = (state.bundle?.lines || []).filter((l) => state.shown.has(l.routeId)).flatMap((l) => l.shape);
  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
}

function busHtml(b, sel, compact) {
  const name = routeById(b.route)?.name || b.route;
  const arrow = b.angle == null ? "" : `<div class="arrow" style="transform:rotate(${b.angle}deg)"></div>`;
  const label = compact && !sel ? `<b>${name}</b>` : `<b>${name}</b>${esc(b.id)}`;
  return `<div class="bus-m${sel ? " sel" : ""}" style="--c:${colorOf(b.route)}">${arrow}<div class="badge">${FACE}</div><span class="lbl">${label}</span></div>`;
}
function renderBusMarkers() {
  const compact = map.getZoom() < 14.5;
  const seen = new Set();
  for (const b of shownBuses()) {
    const key = b.route + "/" + b.id;
    seen.add(key);
    const sel = key === state.selected;
    const html = busHtml(b, sel, compact);
    let m = busMarkers.get(key);
    if (!m) {
      m = L.marker(b.pos, { icon: L.divIcon({ className: "", html, iconSize: [0, 0] }), zIndexOffset: 1000, keyboard: false });
      m.on("click", () => select(key, false));
      m._html = html;
      m.addTo(busLayer);
      busMarkers.set(key, m);
    } else {
      m.setLatLng(b.pos);
      if (m._html !== html) {
        m.setIcon(L.divIcon({ className: "", html, iconSize: [0, 0] }));
        m._html = html;
      }
    }
    m.setZIndexOffset(sel ? 2000 : 1000);
  }
  for (const [k, m] of busMarkers) {
    if (!seen.has(k)) {
      busLayer.removeLayer(m);
      busMarkers.delete(k);
    }
  }
}
function select(key, fly) {
  state.selected = key;
  const v = state.buses.get(key);
  if (v && fly) map.flyTo(v.bus.pos, Math.max(map.getZoom(), 15.5), { duration: 0.6 });
  renderBusMarkers();
  renderBusCards();
  const card = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (card) card.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
}
map.on("click", () => {
  if (state.selected) {
    state.selected = null;
    renderBusMarkers();
    renderBusCards();
  }
});
map.on("zoomend", () => {
  applyStopVisibility();
  renderBusMarkers();
});
$("fit").onclick = () => {
  state.selected = null;
  fitAll();
  renderBusMarkers();
  renderBusCards();
};

function renderChips() {
  const counts = {};
  for (const b of allBuses()) counts[b.route] = (counts[b.route] || 0) + 1;
  const el = $("chips");
  el.innerHTML = "";
  for (const r of ROUTES) {
    const on = state.shown.has(r.id);
    const n = counts[r.id] || 0;
    const btn = document.createElement("button");
    btn.className = "chip" + (on ? "" : " off");
    btn.setAttribute("aria-pressed", String(on));
    btn.innerHTML = `<span class="sw" style="background:${on ? colorOf(r.id) : "var(--line)"}"></span>${r.name}${n ? " · " + n : ""}`;
    btn.onclick = () => {
      on ? state.shown.delete(r.id) : state.shown.add(r.id);
      store.set("routes", [...state.shown]);
      drawRoutes();
      renderBusMarkers();
      renderBusCards();
      renderChips();
      renderLive();
    };
    el.appendChild(btn);
  }
  const rb = document.createElement("button");
  rb.className = "chip" + (state.radarOn ? " on-radar" : " off");
  rb.setAttribute("aria-pressed", String(state.radarOn));
  rb.textContent = "📡 雷达";
  rb.onclick = () => {
    state.radarOn = !state.radarOn;
    store.set("radarLayer", state.radarOn);
    applyRadarLayer();
    renderChips();
  };
  el.appendChild(rb);
}
function applyRadarLayer() {
  if (radarLayer) {
    map.removeLayer(radarLayer);
    radarLayer = null;
  }
  if (!state.radarOn || !state.radarMeta) return;
  const { host, path } = state.radarMeta;
  radarLayer = L.tileLayer(`${host}${path}/512/{z}/{x}/{y}/2/1_1.png`, { pane: "radar", tileSize: 512, zoomOffset: -1, maxNativeZoom: 8, opacity: 0.6 });
  radarLayer.addTo(map);
}

// ------------------------------------------------------------------ bus cards

function ageText(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return "定位 " + (s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分钟前`);
}
function renderBusCards() {
  const el = $("buses");
  const list = shownBuses();
  if (!list.length) {
    el.innerHTML = `<div class="bcard" style="width:auto"><span class="muted">${state.connected ? (state.shown.size ? "选中的线路现在没有车在跑 🚌💤" : "在地图下面选一条线路看看") : esc(state.status)}</span></div>`;
    return;
  }
  el.innerHTML = list.map((b) => {
    const key = b.route + "/" + b.id;
    const prog = state.index?.locate(b.route, b.pos, b.dirCode, b.angle);
    const next = !prog ? "" : prog.nextStop == null ? "不在线路上" : `${prog.arriving ? "到站" : "下一站"} · ${prog.nextStop}`;
    const speed = b.speed == null ? null : b.speed === 0 ? "停着" : `${b.speed} km/h`;
    const c = colorOf(b.route);
    return `<button class="bcard${key === state.selected ? " sel" : ""}" style="--c:${c}" data-key="${esc(key)}">
      <span class="bus-m" style="--c:${c};width:44px;height:44px;flex:none"><span class="badge" style="left:4px;top:4px">${FACE}</span></span>
      <span class="grow">
        <span class="t1"><span class="tag" style="background:${c}">${routeById(b.route)?.name}</span>${esc(b.id)}</span>
        <span class="t2" style="display:block">${prog ? towards(prog.line) : "方向未知"}</span>
        <span class="t3" style="display:block">${esc(next)}</span>
        <span class="t4" style="display:block" data-age="${b.gpsMs}">${[speed, ageText(b.gpsMs)].filter(Boolean).join(" · ")}</span>
      </span></button>`;
  }).join("");
  el.querySelectorAll(".bcard[data-key]").forEach((btn) => (btn.onclick = () => select(btn.dataset.key, true)));
}
setInterval(() => {
  document.querySelectorAll("[data-age]").forEach((n) => {
    const ms = +n.dataset.age;
    n.textContent = n.textContent.replace(/定位 .*$/, ageText(ms));
  });
}, 1000);

// ------------------------------------------------------------------ departures

const currentTrip = () => TRIPS[state.tripChoice] || tripForHour(myt().h);

function renderTrips() {
  const el = $("trips");
  el.innerHTML = "";
  for (const t of Object.values(TRIPS)) {
    const b = document.createElement("button");
    b.className = currentTrip().id === t.id ? "on" : "";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(currentTrip().id === t.id));
    b.textContent = `${t.label} · ${t.short}`;
    b.onclick = () => {
      state.tripChoice = t.id;
      state.alerter = new DepartureAlerter();
      renderTrips();
      renderDepartures();
    };
    el.appendChild(b);
  }
  const t = currentTrip();
  $("trip-desc").textContent = `在 ${t.stopName} 上车 · ` + ROUTES.filter((r) => t.routes.includes(r.id)).map((r) => r.name).join(" / ");
}

const GRAB_WEB = "https://www.grab.com/my/transport/";
// Android Chrome opens the Grab app through its grab:// link, or the website when it is not installed
const GRAB_HREF = /Android/i.test(navigator.userAgent)
  ? `intent://open#Intent;scheme=grab;package=com.grabtaxi.passenger;S.browser_fallback_url=${encodeURIComponent(GRAB_WEB)};end`
  : GRAB_WEB;

function renderPlanB(arr) {
  const el = $("planb");
  const next = arr ? (arr.length ? arr[0].minutes : null) : undefined;
  if (next === undefined || !planB(state.weather?.rainingNow, next)) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<div class="planb"><p>${esc(planBText(next))}</p><a href="${GRAB_HREF}" target="_blank" rel="noopener">🚕 打开 Grab</a></div>`;
}

function renderHolidayHint() {
  const h = busHolidayHint(state.holidays, todayIso());
  $("holiday-hint").innerHTML = h ? `<div class="hint">${esc(h)}</div>` : "";
}

function renderDepartures() {
  const t = currentTrip();
  const el = $("arrivals");
  if (!state.connected || !state.index) {
    el.innerHTML = `<p class="muted">${esc(state.connected ? "正在计算…" : state.status)}</p>`;
    renderPlanB(null);
    return;
  }
  const arr = state.index.arrivals(t.stopCode, t.routes, allBuses());
  renderPlanB(arr);
  if (!arr.length) {
    el.innerHTML = `<p>一小时内暂时没有车开往这里 🚌💤</p>`;
  } else {
    const f = arr[0];
    const tag = (a) => `<span class="tag" style="background:${colorOf(a.routeId)}">${a.routeName}</span>`;
    el.innerHTML = `<div class="next">${tag(f)}<span class="big">${f.minutes <= 1 ? "马上到" : f.minutes + " 分钟"}</span><span class="muted">${esc(f.busId)}${f.viaTerminus ? " · 掉头后" : ""}</span></div>
      <div class="list">${arr.slice(1, 4).map((a) => `<div class="row">${tag(a)}<span class="grow">${etaText(a)}</span><span class="muted small">${esc(a.busId)}</span></div>`).join("")}</div>`;
  }
  if (state.alerting) {
    const a = state.alerter.check(arr, state.lead, Date.now());
    if (a) notify("🚌 该出门了", `${a.routeName}（${a.busId}）${etaText(a)}到 ${t.stopName}`);
  }
}

function renderAlertControls() {
  $("alert-state").textContent = state.alerting ? "● 提醒中" : "未启动";
  $("alert-state").className = "pill" + (state.alerting ? " on" : "");
  const btn = $("alert-btn");
  btn.className = "btn" + (state.alerting ? " stop" : "");
  btn.textContent = state.alerting ? "停止提醒" : `开始提醒（车离站 ${state.lead} 分钟时响）`;
  $("lead-text").textContent = `提前 ${state.lead} 分钟提醒出门`;
}
$("alert-btn").onclick = async () => {
  unlockAudio();
  state.alerting = !state.alerting;
  if (state.alerting) {
    state.alerter = new DepartureAlerter();
    if ("Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch (e) {
        /* fine: sound and the banner still work */
      }
    }
    keepAwake(true);
    toast("开始提醒：网页保持打开，车快到时会响铃");
    renderDepartures();
  } else {
    keepAwake(false);
  }
  renderAlertControls();
};
const setLead = (m) => {
  state.lead = Math.min(20, Math.max(3, m));
  store.set("lead", state.lead);
  renderAlertControls();
};
$("lead-minus").onclick = () => setLead(state.lead - 1);
$("lead-plus").onclick = () => setLead(state.lead + 1);

// ------------------------------------------------------------------ weather, radar, basketball

/** fetch with a time limit, so one slow source never holds up the page */
function fetchT(url, ms = 12000) {
  const opts = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {};
  return fetch(url, opts);
}
async function getJson(url, ms) {
  const r = await fetchT(url, ms);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function loadWarnings() {
  const p = myt(Date.now() - 2 * 86400000);
  const since = `${p.y}-${pad2(p.m)}-${pad2(p.d)} 00:00:00@warning_issue__issued`;
  let list;
  try {
    list = await getJson(`https://api.data.gov.my/weather/warning/?limit=100&timestamp_start=${encodeURIComponent(since)}`);
  } catch (e) {
    list = await getJson("https://api.data.gov.my/weather/warning/?limit=100");
  }
  return list.map((w) => ({
    heading: [w.heading_en, w.heading_bm].filter(Boolean).join(" "),
    title: [w.warning_issue?.title_en, w.warning_issue?.title_bm].filter(Boolean).join(" "),
    text: [w.text_en, w.text_bm].filter(Boolean).join(" "),
    validFrom: w.valid_from || "",
    validTo: w.valid_to || "",
  }));
}

async function loadRadar() {
  const maps = await getJson("https://api.rainviewer.com/public/weather-maps.json");
  const past = maps.radar.past.slice(-4);
  const Z = 7, TILE = 512, HALF = 80, size = 2 * HALF + 1;
  const g = globalPixel(LAT, LNG, Z, TILE);
  const x0 = Math.floor(g.x) - HALF, y0 = Math.floor(g.y) - HALF;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const tiles = [];
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + size - 1) / TILE); ty++) {
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + size - 1) / TILE); tx++) tiles.push([tx, ty]);
  }
  // download every tile of every frame at once, then decode
  const images = await Promise.all(past.map((f) => Promise.all(tiles.map(async ([tx, ty]) => {
    const r = await fetchT(`${maps.host}${f.path}/${TILE}/${Z}/${tx}/${ty}/2/1_1.png`, 15000);
    if (!r.ok) throw new Error("radar " + r.status);
    return createImageBitmap(await r.blob());
  }))));
  const frames = [];
  for (const [fi, f] of past.entries()) {
    const rain = new Uint8Array(size * size);
    for (const [ti, [tx, ty]] of tiles.entries()) {
      {
        const bmp = images[fi][ti];
        if (bmp.width !== TILE || bmp.height !== TILE) throw new Error("radar tile size");
        ctx.clearRect(0, 0, TILE, TILE);
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, TILE, TILE).data;
        for (let wy = 0; wy < size; wy++) {
          const gy = y0 + wy - ty * TILE;
          if (gy < 0 || gy >= TILE) continue;
          for (let wx = 0; wx < size; wx++) {
            const gx = x0 + wx - tx * TILE;
            if (gx < 0 || gx >= TILE) continue;
            if (px[(gy * TILE + gx) * 4 + 3] > 0) rain[wy * size + wx] = 1;
          }
        }
      }
    }
    frames.push({ timeSec: f.time, size, rain });
  }
  state.radarMeta = { host: maps.host, path: past[past.length - 1].path };
  applyRadarLayer();
  const kmPerPx = (40075 * Math.cos((LAT * Math.PI) / 180)) / (2 ** Z * TILE);
  return nowcast(frames, kmPerPx);
}

function personal() {
  const fb = store.get("feedback", {});
  const fc = store.get("forecasts", {});
  const outcomes = Object.entries(fb).filter(([d]) => fc[d] != null).map(([d, label]) => ({ predicted: fc[d] / 100, rained: label === "rained" }));
  return { shift: fitShift(outcomes), samples: outcomes.length };
}

let weatherBusy = false;
let lastInputs = null;
function evaluate(radar) {
  if (!lastInputs) return;
  const { fc, air, warnings } = lastInputs;
  const { shift, samples } = personal();
  const r = evaluateRain({
    hourly: fc?.hourly, nowMs: Date.now(), startHour: state.startHour, durationHours: state.duration,
    warnings: warnings || [], warningsOk: warnings != null, air: air?.hourly, shift, samples, radar,
  });
  r.updatedAt = Date.now();
  state.weather = r;
  if (r.level !== "unknown" && !r.tomorrow) {
    // remember today's prediction, so a later 打成了/下雨了 tap is paired with it
    const n = myt();
    const fcs = store.get("forecasts", {});
    fcs[`${n.y}-${pad2(n.m)}-${pad2(n.d)}`] = r.chance;
    store.set("forecasts", fcs);
  }
  renderWeather();
}
async function loadWeather() {
  if (weatherBusy) return;
  weatherBusy = true;
  $("ball-refresh").textContent = "更新中…";
  // the radar is slower (many images): start it now, fold it in when it arrives
  const radarJob = loadRadar().catch(() => null);
  try {
    const q = new URLSearchParams({
      latitude: LAT, longitude: LNG, timezone: "Asia/Kuala_Lumpur", past_hours: 6, forecast_hours: 48,
      hourly: "precipitation_probability,precipitation,weather_code,cape,apparent_temperature",
    });
    const [fc, air, warnings] = await Promise.all([
      getJson("https://api.open-meteo.com/v1/forecast?" + q).catch(() => null),
      getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LNG}&hourly=us_aqi&timezone=Asia%2FKuala_Lumpur&forecast_days=2`).catch(() => null),
      loadWarnings().catch(() => null),
    ]);
    lastInputs = { fc, air, warnings };
    evaluate(state.weather?.radar ?? null);
    if (!fc) setTimeout(loadWeather, 30000); // a slow moment at the forecast service: try again shortly
  } finally {
    weatherBusy = false;
    $("ball-refresh").textContent = "刷新";
  }
  const radar = await radarJob;
  if (radar) evaluate(radar);
}

function chartSvg(bars) {
  const W = 360, Hh = 130, top = 16, bottom = Hh - 18;
  const slot = W / bars.length;
  const bw = Math.min(slot * 0.55, 18);
  const max = Math.max(60, ...bars.map((b) => b.prob));
  const col = (p) => (p >= 40 ? "var(--bad)" : p >= 25 ? "var(--caution)" : "var(--good)");
  let s = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="未来 12 小时每小时下雨机会：${bars.map((b) => `${b.label}点 ${b.prob}%`).join("，")}">`;
  bars.forEach((b, i) => {
    const cx = slot * i + slot / 2;
    const h = ((bottom - top) * b.prob) / max;
    s += `<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${bottom - top}" rx="4" fill="var(--surface2)"/>`;
    if (b.prob > 0) s += `<rect x="${cx - bw / 2}" y="${bottom - h}" width="${bw}" height="${h}" rx="4" fill="${col(b.prob)}"/>`;
    if (b.prob >= 10) s += `<text x="${cx}" y="${bottom - h - 3}" text-anchor="middle" font-size="10" fill="var(--muted)">${b.prob}</text>`;
    if (bars.length <= 8 || i % 2 === 0) s += `<text x="${cx}" y="${Hh - 3}" text-anchor="middle" font-size="10" fill="var(--muted)">${b.label}</text>`;
  });
  return s + "</svg>";
}

function renderSun() {
  const today = todayIso();
  const r = state.weather;
  const sun = sunTimes(r?.tomorrow ? isoOf(dayNum(today) + 1) : today, LAT, LNG);
  $("ball-sun").textContent = sunLine(sun, r?.tomorrow ? null : state.startHour + state.duration);
}

function renderWeather() {
  renderSun();
  renderDepartures(); // Plan B depends on whether it is raining now
  const r = state.weather;
  $("ball-window").textContent = (r?.windowLabel || `打球时段 ${pad2(state.startHour)}:00 起`) + " · 马大附近" + (r?.updatedAt ? ` · ${hhmm(r.updatedAt)} 更新` : "");
  if (!r) return;
  const L = LEVEL[r.level];
  const conds = [];
  if (r.feels != null) conds.push(`<span class="pill ${r.feels >= 42 ? "bad" : r.feels >= 39 ? "caution" : ""}">🌡 体感 ${r.feels}°C</span>`);
  if (r.aqi != null) {
    const cls = r.aqi <= 50 ? "good" : r.aqi <= 100 ? "" : r.aqi <= 150 ? "caution" : "bad";
    conds.push(`<span class="pill ${cls}">🌫 空气 ${r.aqi} · ${aqiLabel(r.aqi)}</span>`);
  }
  const rd = r.radar;
  const radarLine = rd ? `<div class="radar-line${rd.rainingHere || rd.etaMin != null ? " warn" : " muted"}">📡 雷达（${hhmm(rd.frameTimeSec * 1000)}）：${esc(radarSummary(rd))}</div>` : "";
  $("ball-body").innerHTML = `
    <div class="verdict ${r.level}">${L.emoji} ${L.headline}${r.chance >= 0 ? " · " + r.chance + "%" : ""}</div>
    ${conds.length ? `<div class="conds">${conds.join("")}</div>` : ""}
    ${radarLine}
    <ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${r.bars?.length ? `<div class="chart">${chartSvg(r.bars)}<div class="muted small">未来 12 小时每小时下雨机会（%，已按实况校准）</div></div>` : ""}`;
}

function renderFeedbackCount() {
  const fbMap = store.get("feedback", {});
  const fb = Object.values(fbMap);
  const { samples } = personal();
  $("fb-stats").textContent = ballSummary(ballStats(fbMap, todayIso()), todayIso());
  $("fb-count").textContent = `共记录 ${fb.length} 天` + (samples < PERSONAL_MIN ? `（满 ${PERSONAL_MIN} 天后按你的球场微调）` : " · 已按你的记录微调");
}
function record(label) {
  const n = myt();
  const fb = store.get("feedback", {});
  fb[`${n.y}-${pad2(n.m)}-${pad2(n.d)}`] = label;
  store.set("feedback", fb);
  renderFeedbackCount();
  toast("已记录，谢谢！");
}
$("fb-played").onclick = () => record("played");
$("fb-rained").onclick = () => record("rained");
$("ball-refresh").onclick = () => loadWeather();

// ------------------------------------------------------------------ public holidays, exchange rate

async function loadHolidays() {
  try {
    state.holidays = withReplacements((await getJson("holidays.json")).holidays || []);
  } catch (e) {
    state.holidays = [];
    $("holidays").innerHTML = `<p class="muted small">假期名单读取失败</p>`;
    return;
  }
  renderHolidayHint();
  renderHolidays();
}

function renderHolidays() {
  const today = todayIso();
  const next = upcomingHolidays(state.holidays, today, 90).slice(0, 4);
  $("holidays").innerHTML = next.length
    ? next.map((h) => `<div class="hol"><div class="grow"><div>${esc(h.name)}${h.tentative ? '<span class="muted small">（日期以官方为准）</span>' : ""}</div><div class="muted small">${esc(holidayWhen(h, today))}</div></div><span class="pill">${esc(regionLabel(h.regions))}</span></div>`).join("")
    : `<p class="muted small">90 天内没有公共假期</p>`;
}

const fxSettings = () => ({ target: store.get("fxTarget", null), above: store.get("fxAbove", true), armed: store.get("fxArmed", true) });

async function loadFx() {
  const start = isoOf(dayNum(todayIso()) - 45);
  try {
    state.fx = fxView(fxPoints(await getJson(`https://api.frankfurter.app/${start}..?from=MYR&to=CNY`)));
  } catch (e) {
    if (!state.fx) $("fx").innerHTML = `<p class="muted">汇率暂时没取到，稍后再看</p>`;
    return;
  }
  renderFx();
  // tell once when the rate reaches the target (the app does this every morning in the background)
  const f = fxSettings();
  if (state.fx && f.target != null) {
    const d = fxCheck(state.fx.latest.rate, f.target, f.above, f.armed);
    store.set("fxArmed", d.armed);
    if (d.alert) notify("💱 汇率到了", `1 令吉 = ${fxRate(state.fx.latest.rate)} 元，已${f.above ? "涨到" : "跌到"}你设的 ${fxRate(f.target)}`);
  }
}

function sparkSvg(v, target) {
  const W = 360, H = 64, pad = 4;
  let lo = v.min30, hi = v.max30;
  if (target != null && target >= lo - (hi - lo) && target <= hi + (hi - lo)) {
    lo = Math.min(lo, target);
    hi = Math.max(hi, target);
  }
  if (hi - lo < 1e-6) {
    lo -= 0.001;
    hi += 0.001;
  }
  const pts = v.points;
  const d0 = dayNum(pts[0].date);
  const span = Math.max(1, dayNum(pts[pts.length - 1].date) - d0);
  const x = (p) => (pad + ((W - 2 * pad) * (dayNum(p.date) - d0)) / span).toFixed(1);
  const y = (r) => (pad + (H - 2 * pad) * (1 - (r - lo) / (hi - lo))).toFixed(1);
  let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="近 30 天汇率，最低 ${fxRate(v.min30)}，最高 ${fxRate(v.max30)}">`;
  s += `<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="var(--line)"/>`;
  if (target != null && target >= lo && target <= hi) s += `<line x1="0" y1="${y(target)}" x2="${W}" y2="${y(target)}" stroke="var(--caution)" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  s += `<polyline fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${pts.map((p) => `${x(p)},${y(p.rate)}`).join(" ")}"/>`;
  const last = pts[pts.length - 1];
  return s + `<circle cx="${x(last)}" cy="${y(last.rate)}" r="4" fill="var(--primary)"/></svg>`;
}

function renderFx() {
  const v = state.fx;
  const f = fxSettings();
  $("fx-dir").value = f.above ? "up" : "down";
  if (f.target != null) $("fx-target").value = f.target.toFixed(3);
  else if (v && !$("fx-target").value) $("fx-target").value = (v.latest.rate * 1.01).toFixed(3);
  if (!v) return;
  const changes = [v.change7 != null ? `一周 ${fxPct(v.change7)}` : null, v.change30 != null ? `一个月 ${fxPct(v.change30)}` : null].filter(Boolean);
  const [, m, d] = v.latest.date.split("-").map(Number);
  const met = f.target != null && (f.above ? v.latest.rate >= f.target : v.latest.rate <= f.target);
  $("fx").innerHTML = `
    <div class="rate"><span>1 令吉 =</span><span class="big">${fxRate(v.latest.rate)}</span><span>元</span></div>
    <div>1000 令吉 ≈ ${Math.round(v.latest.rate * 1000)} 元${changes.length ? " · " + changes.join(" · ") : ""}</div>
    ${v.points.length >= 3 ? `<div class="spark">${sparkSvg(v, f.target)}</div><div class="muted small">近 30 天：最低 ${fxRate(v.min30)} · 最高 ${fxRate(v.max30)} · 更新到 ${m}月${d}日</div>` : ""}
    ${f.target != null ? `<div class="${met ? "ok" : "muted small"}">${met ? "✅ 现在已经" + (f.above ? "高于" : "低于") + "目标价 " + fxRate(f.target) : "🔔 " + (f.above ? "涨到" : "跌到") + " " + fxRate(f.target) + " 时提示"}</div>` : ""}`;
}

$("fx-save").onclick = () => {
  const t = parseFloat($("fx-target").value);
  if (!(t > 0.5 && t < 5)) {
    toast("请输入像 1.650 这样的汇率");
    return;
  }
  const above = $("fx-dir").value === "up";
  const rate = state.fx?.latest.rate;
  store.set("fxTarget", t);
  store.set("fxAbove", above);
  // already past the target: don't announce what is on screen, wait for the next crossing
  store.set("fxArmed", rate == null || !(above ? rate >= t : rate <= t));
  unlockAudio();
  renderFx();
  toast(`1 令吉${above ? "涨到" : "跌到"} ${fxRate(t)} 元时提示你（网页开着时）`);
};
$("fx-off").onclick = () => {
  store.set("fxTarget", null);
  store.set("fxArmed", true);
  $("fx-target").value = "";
  renderFx();
  toast("已关闭汇率提示");
};

function setupWindowSelects() {
  const sh = $("start-hour");
  for (let h = 12; h <= 21; h++) sh.add(new Option(`${pad2(h)}:00 开始`, h, false, h === state.startHour));
  const du = $("duration");
  for (let d = 1; d <= 3; d++) du.add(new Option(`打 ${d} 小时`, d, false, d === state.duration));
  sh.onchange = () => {
    state.startHour = +sh.value;
    store.set("startHour", state.startHour);
    loadWeather();
  };
  du.onchange = () => {
    state.duration = +du.value;
    store.set("duration", state.duration);
    loadWeather();
  };
}

// ------------------------------------------------------------------ start

async function main() {
  renderTrips();
  renderAlertControls();
  renderChips();
  renderLive();
  renderBusCards();
  renderDepartures();
  setupWindowSelects();
  renderFeedbackCount();
  renderSun();
  try {
    state.bundle = loadBundle(await getJson("routes.json"));
    state.index = new RouteIndex(state.bundle.lines);
    drawRoutes();
    drawStars();
    fitHome();
  } catch (e) {
    toast("线路数据读取失败，请刷新页面");
  }
  new Feed(ROUTE_IDS).start();
  loadWeather();
  loadHolidays();
  loadFx();
  setInterval(loadWeather, 10 * 60000);
  setInterval(loadFx, 3 * 3600000);
  // the trip switches by itself at 1 pm unless you picked one; the date can change too
  let day = todayIso();
  setInterval(() => {
    if (!state.tripChoice) {
      renderTrips();
      renderDepartures();
    }
    if (todayIso() !== day) {
      day = todayIso();
      renderHolidayHint();
      renderHolidays();
      renderFeedbackCount();
      renderSun();
    }
  }, 60000);
  darkMq.addEventListener?.("change", () => {
    drawRoutes();
    drawStars();
    renderBusMarkers();
    renderChips();
    renderBusCards();
    renderDepartures();
  });
}
main();
