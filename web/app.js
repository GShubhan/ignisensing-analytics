// Ignisensing Analytics dashboard. Plain ES module, no dependencies.
// Every figure is computed in the browser from web/data/*.json, which web/build_data.py
// builds from the committed pipeline outputs (ml/outputs, data/processed).

const SVGNS = "http://www.w3.org/2000/svg";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const VIEWS = {
  overview: "Overview",
  calendar: "Activity calendar",
  map: "Fire map",
  history: "Historical analysis",
  watchlist: "Priority watchlist",
  about: "Methods & Data",
};
const SOURCE_NOTE = "Source: NASA FIRMS MODIS and VIIRS S-NPP, harmonized by Ignisensing Analytics";

// ---------- small helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

function svg(tag, attrs = {}, kids = []) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const kid of [].concat(kids)) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}
function html(tag, attrs = {}, kids = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of [].concat(kids)) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}
const text = (x, y, str, attrs = {}) => svg("text", { x, y, ...attrs }, str);

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v) ? "n/a" : nf.format(Math.round(v)));
function fmtShort(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${+v.toFixed(a < 10 && a % 1 ? 1 : 0)}`;
}
const MINUS = "−";
function pct(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const r = +Math.abs(v).toFixed(digits);
  if (r === 0) return "0%";
  const body = r >= 1000 ? nf.format(Math.round(r)) : r.toFixed(digits);
  return `${v > 0 ? "+" : MINUS}${body}%`;
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function median(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function quantile(values, q) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}
function ticks(min, max, count = 4) {
  const step = niceStep(max - min, count);
  const out = [];
  const top = Math.ceil(max / step - 1e-9) * step;
  for (let t = Math.floor(min / step + 1e-9) * step; t <= top + step * 1e-9; t += step) out.push(+t.toFixed(10));
  return out;
}

// ---------- colour, read from the tokens in tokens.css ----------
const C = {};
function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const t = (n) => cs.getPropertyValue(n).trim();
  Object.assign(C, {
    paper: t("--color-paper"), card: t("--color-paper-2"), raised: t("--color-paper-3"),
    ink: t("--color-ink"), ink2: t("--color-ink-2"), muted: t("--color-muted"),
    rule: t("--color-rule"), ruleStrong: t("--color-rule-strong"),
    info: t("--color-info"), active: t("--color-active"), fire: t("--color-fire"), error: t("--color-error"),
    zero: t("--ramp-0"),
    ramp: [1, 2, 3, 4, 5, 6].map((i) => t(`--ramp-${i}`)),
    cool: [1, 2, 3].map((i) => t(`--cool-${i}`)),
    mid: t("--diverge-mid"),
    font: t("--font-body"), fontDisplay: t("--font-display"),
  });
}
function rgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function mix(a, b, t) {
  const A = rgb(a), B = rgb(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
function ramp(stops, t) {
  t = clamp(t, 0, 1);
  const n = stops.length - 1, i = Math.min(n - 1, Math.floor(t * n));
  return mix(stops[i], stops[i + 1], t * n - i);
}
/** Log colour scale for detection counts from lo to hi; under half a detection is the empty colour. */
function countScale(lo, hi) {
  const a = Math.log10(Math.max(0.5, lo)), b = Math.log10(Math.max(lo * 1.01, hi, 1));
  const pos = (v) => clamp((Math.log10(Math.max(v, 1e-9)) - a) / (b - a || 1), 0, 1);
  const f = (v) => (v === null || v < 0.5 ? C.zero : ramp(C.ramp, pos(v)));
  f.pos = pos;
  return f;
}
/** Legend labels for a count scale: both ends plus powers of ten that sit clear of them. */
function countLabels(scale, lo, hi) {
  const out = [[0, fmtShort(lo)]];
  for (let t = 10; t < hi; t *= 10) { const q = scale.pos(t); if (q > 0.14 && q < 0.8) out.push([q, fmtShort(t)]); }
  out.push([1, fmtShort(hi)]);
  return out;
}
/** Diverging scale on log2 of (value + 1) / (median + 1), clamped to a quarter and four times. */
function ratioColour(v, med) {
  const r = Math.log2((v + 1) / (med + 1)) / 2;
  if (r >= 0) return ramp([C.mid, C.ramp[1], C.ramp[3], C.ramp[4], C.ramp[5]], r);
  return ramp([C.mid, C.cool[0], C.cool[1], C.cool[2]], -r);
}

// ---------- data model ----------
let D = null; // dashboard.json
let M = null; // derived constants
const mapData = { provinces: null, cells: null, statics: null, years: new Map(), image: null, current: null };

function derive(d) {
  const [y0] = d.meta.start;
  const n = d.meta.months;
  const last = n - 1;
  const lastComplete = d.meta.lastPartial ? n - 2 : n - 1;
  const yearOf = (i) => y0 + Math.floor(i / 12);
  const monthOf = (i) => (i % 12) + 1;
  const curYear = yearOf(last);
  const years = [];
  for (let y = y0; y <= curYear; y++) years.push(y);
  const completeYears = years.filter((y) => (y - y0) * 12 + 11 <= lastComplete);
  const bySlug = new Map(d.provinces.map((p, i) => [p.slug, { ...p, index: i }]));
  return { y0, n, last, lastComplete, yearOf, monthOf, curYear, years, completeYears, bySlug,
    modelLast: d.meta.modelLastIndex, err: d.meta.typicalAnnualErrorPct };
}
const idx = (y, m) => (y - M.y0) * 12 + (m - 1);
const baseLabel = () => `${M.completeYears[0]} to ${M.completeYears.at(-1)}`;
const monthLabel = (i) => `${MONTHS_LONG[M.monthOf(i) - 1]} ${M.yearOf(i)}`;
const isModel = (i) => i <= M.modelLast;
const sourceOf = (i) => (isModel(i) ? "Model estimate from MODIS" : "VIIRS observed");

function areaName(area) {
  return area === "indonesia" ? "Indonesia" : M.bySlug.get(area)?.name ?? "Indonesia";
}
function series(area) {
  return area === "indonesia" ? D.national.HARMONIZED : M.bySlug.get(area).series;
}
function monthsSpan(months) {
  if (months.length === 12) return "";
  if (months.length === 1) return MONTHS_LONG[months[0] - 1];
  return `${MONTHS[months[0] - 1]} to ${MONTHS[months.at(-1) - 1]}`;
}
/** The selected period: status ok (complete months), partial (the month in progress) or none. */
function period(year = state.year, month = state.month) {
  if (month) {
    const i = idx(year, month);
    const label = `${MONTHS_LONG[month - 1]} ${year}`;
    if (i > M.last) return { status: "none", months: [month], label, span: MONTHS_LONG[month - 1] };
    if (i > M.lastComplete) return { status: "partial", months: [month], label, span: MONTHS_LONG[month - 1] };
    return { status: "ok", months: [month], label, span: MONTHS_LONG[month - 1] };
  }
  const months = [];
  for (let m = 1; m <= 12; m++) if (idx(year, m) <= M.lastComplete) months.push(m);
  if (!months.length) return { status: "partial", months: [1], label: `${MONTHS_LONG[0]} ${year}`, span: MONTHS_LONG[0] };
  const span = monthsSpan(months);
  return { status: "ok", months, label: span ? `${span} ${year}` : `${year}`, span: span || "Annual", partialYear: months.length < 12 };
}
const total = (ser, year, months) => sum(months.map((m) => ser[idx(year, m)] ?? 0));
const yearsWith = (months) => M.years.filter((y) => months.every((m) => idx(y, m) <= M.lastComplete));

/** Selected period against the same months in every complete year (the dashboard's one baseline). */
function compare(ser, year, months) {
  const totals = yearsWith(months).map((y) => ({ year: y, value: total(ser, y, months) }));
  const med = median(totals.filter((t) => M.completeYears.includes(t.year)).map((t) => t.value));
  const value = total(ser, year, months);
  const higher = totals.filter((t) => t.value > value).map((t) => t.year);
  return { value, median: med, diff: med > 0 ? ((value - med) / med) * 100 : null,
    rank: higher.length + 1, of: totals.length, higher, totals };
}
function monthMedians(ser) {
  return MONTHS.map((_, k) => median(M.completeYears.map((y) => ser[idx(y, k + 1)])));
}
function rankText(c) {
  if (c.rank === 1) return `Highest since ${M.y0}`;
  if (c.higher.length <= 3) return `Only ${listJoin(c.higher)} ${c.higher.length === 1 ? "was" : "were"} higher`;
  return `${c.higher.length} years were higher`;
}
function listJoin(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// ---------- state, kept in the URL ----------
const state = { view: "overview", area: "indonesia", year: null, month: 0, calMode: "count", statics: false, sort: "priority", mapCell: null };

function readURL() {
  const p = new URLSearchParams(location.search);
  state.view = VIEWS[p.get("view")] ? p.get("view") : "overview";
  const area = p.get("area");
  state.area = area && M.bySlug.has(area) ? area : "indonesia";
  const year = +p.get("year");
  state.year = M.years.includes(year) ? year : M.curYear;
  const month = +p.get("month");
  state.month = month >= 1 && month <= 12 && idx(state.year, month) <= M.last ? month : 0;
  state.calMode = p.get("colour") === "median" ? "anomaly" : "count";
}
function writeURL(push = false) {
  const p = new URLSearchParams();
  if (state.view !== "overview") p.set("view", state.view);
  if (state.area !== "indonesia") p.set("area", state.area);
  if (state.year !== M.curYear) p.set("year", state.year);
  if (state.month) p.set("month", state.month);
  if (state.calMode === "anomaly") p.set("colour", "median");
  const url = `${location.pathname}${p.toString() ? `?${p}` : ""}`;
  if (url !== `${location.pathname}${location.search}`) history[push ? "pushState" : "replaceState"](null, "", url);
}
function setState(patch, { push = false } = {}) {
  if (Object.hasOwn(patch, "area") && patch.area !== state.area) state.mapCell = null;
  Object.assign(state, patch);
  if (state.month && idx(state.year, state.month) > M.last) state.month = 0;
  writeURL(push);
  syncFilters();
  render();
}

// ---------- tooltip ----------
const tip = $("#tooltip");
function key(colour, kind = "line") {
  return svg("svg", { viewBox: "0 0 14 10", "aria-hidden": "true" },
    kind === "line"
      ? svg("line", { x1: 0, y1: 5, x2: 14, y2: 5, stroke: colour, "stroke-width": 2.5, "stroke-linecap": "round" })
      : svg("rect", { x: 2, y: 1, width: 10, height: 8, rx: 2, fill: colour }));
}
/** rows: [{value, label, colour?, kind?}] ; values lead, labels follow. */
function showTip(title, rows, note, anchor) {
  tip.replaceChildren(
    html("div", { class: "tip-title", text: title }),
    ...rows.map((r) => html("div", { class: "tip-row" }, [r.colour ? key(r.colour, r.kind) : null, html("strong", { text: r.value }), document.createTextNode(` ${r.label ?? ""}`)])),
    ...(note ? [html("div", { class: "tip-note", text: note })] : []),
  );
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  let x = anchor.x + 14, y = anchor.y - height - 12;
  if (x + width > innerWidth - 8) x = anchor.x - width - 14;
  if (y < 8) y = anchor.y + 16;
  tip.style.left = `${clamp(x, 8, innerWidth - width - 8)}px`;
  tip.style.top = `${clamp(y, 8, innerHeight - height - 8)}px`;
}
const hideTip = () => { tip.hidden = true; };
const anchorOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top }; };

/** Arrow-key navigation over a chart's marks; the tooltip follows focus. */
function keyNav(el, count, { onFocus, onEnter, cols = null, start = 0 }) {
  let i = clamp(start, 0, count - 1);
  el.setAttribute("tabindex", "0");
  el.addEventListener("focus", () => onFocus(i));
  el.addEventListener("blur", () => { hideTip(); onFocus(-1); });
  el.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols || 0, ArrowUp: -(cols || 0), Home: -count, End: count }[e.key];
    if (step) {
      e.preventDefault();
      i = clamp(i + (e.shiftKey && !cols ? step * 12 : step), 0, count - 1);
      onFocus(i);
    } else if ((e.key === "Enter" || e.key === " ") && onEnter) {
      e.preventDefault();
      onEnter(i);
    } else if (e.key === "Escape") hideTip();
  });
}

// ---------- shared chart parts ----------
function frame(container, height, margin, label) {
  const w = Math.max(280, Math.floor(container.clientWidth));
  const root = svg("svg", { viewBox: `0 0 ${w} ${height}`, width: w, height, role: "img", "aria-label": label,
    "font-family": C.font, "font-size": 12, fill: C.ink2 });
  return { root, w, h: height, m: margin, iw: w - margin.l - margin.r, ih: height - margin.t - margin.b };
}
function yAxis(f, scale, tickValues, format = fmtShort) {
  const g = svg("g");
  for (const t of tickValues) {
    const y = scale(t);
    g.append(svg("line", { x1: f.m.l, x2: f.w - f.m.r, y1: y, y2: y, stroke: t === 0 ? C.ruleStrong : C.rule, "stroke-width": 1 }));
    g.append(text(f.m.l - 8, y + 4, format(t), { "text-anchor": "end", fill: C.muted, "font-size": 11 }));
  }
  return g;
}
function yearLabels(band) {
  if (band >= 36) return { every: 1, label: (y) => String(y) };
  return { every: Math.max(1, Math.ceil(24 / band)), label: (y) => `’${String(y).slice(2)}` };
}
function barPath(x, y, w, h, r = 2) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function barPathDown(x, y, w, h, r = 2) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}
function hatchDef(id, colour) {
  return svg("pattern", { id, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
    svg("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: colour, "stroke-width": 2, "stroke-opacity": 0.55 }));
}
function legend(container, items) {
  container.replaceChildren(...items.map((it) => html("span", { class: "legend-item" }, [key(it.colour, it.kind), document.createTextNode(it.label)])));
}
function legendHatch(label) {
  const s = svg("svg", { viewBox: "0 0 14 10", "aria-hidden": "true" }, [
    svg("defs", {}, hatchDef("lh", C.paper)),
    svg("rect", { x: 2, y: 1, width: 10, height: 8, rx: 2, fill: C.ramp[2] }),
    svg("rect", { x: 2, y: 1, width: 10, height: 8, rx: 2, fill: "url(#lh)" }),
  ]);
  return html("span", { class: "legend-item" }, [s, document.createTextNode(label)]);
}
function rampLegend(container, { stops, labels, title, extra = [] }) {
  const w = 220, s = svg("svg", { viewBox: `0 0 ${w} 26`, role: "img", "aria-label": title });
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  const stopEl = (st, k) => (Array.isArray(st) ? svg("stop", { offset: `${st[1] * 100}%`, "stop-color": st[0] }) : svg("stop", { offset: `${(k / (stops.length - 1)) * 100}%`, "stop-color": st }));
  s.append(svg("defs", {}, svg("linearGradient", { id }, stops.map(stopEl))));
  s.append(svg("rect", { x: 0, y: 0, width: w, height: 10, rx: 3, fill: `url(#${id})` }));
  labels.forEach(([pos, lab]) => s.append(text(pos * w, 23, lab, { "text-anchor": pos === 0 ? "start" : pos === 1 ? "end" : "middle", fill: C.ink2, "font-size": 11, "font-family": C.font })));
  container.replaceChildren(html("span", { class: "legend-ramp" }, [html("span", { text: title }), s]), ...extra);
}
function emptyState(container, title, body, action) {
  container.replaceChildren(html("div", { class: "state" }, [
    html("h3", { text: title }), html("p", { text: body }),
    action ? html("button", { class: "btn", type: "button", text: action.label, onclick: action.run }) : null,
  ]));
}
function lastCompleteAction() {
  const i = M.lastComplete;
  return { label: `Show ${monthLabel(i)}`, run: () => setState({ year: M.yearOf(i), month: M.monthOf(i) }) };
}
function cardEls(name) {
  const card = $(`[data-card="${name}"]`);
  return { card, chart: $("[data-chart]", card), sub: $("[data-sub]", card), title: $("[data-title]", card),
    legend: $("[data-legend]", card), note: $("[data-note]", card) };
}

// ---------- exports ----------
const exporters = {};
function downloadBlob(blob, filename) {
  const a = html("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function downloadCSV(rows, filename) {
  const esc = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  downloadBlob(new Blob([rows.map((r) => r.map(esc).join(",")).join("\n") + "\n"], { type: "text/csv" }), filename);
}
async function imageDataURL(src) {
  if (mapData.image) return mapData.image;
  const blob = await (await fetch(src)).blob();
  mapData.image = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  return mapData.image;
}
async function downloadPNG(name, filename) {
  const { card, chart } = cardEls(name);
  const src = $("svg", chart);
  if (!src) return;
  const w = +src.getAttribute("width"), h = +src.getAttribute("height");
  const clone = src.cloneNode(true);
  for (const im of clone.querySelectorAll("image")) im.setAttribute("href", await imageDataURL(im.getAttribute("href")));
  clone.setAttribute("x", 24); clone.setAttribute("y", 84);
  const W = w + 48;
  // Legend row(s): ramps and keyed items, laid out left to right and wrapped to the width.
  const legendG = svg("g");
  let lx = 24, ly = 84 + h + 20, rowH = 0;
  const place = (width, height) => { if (lx + width > W - 24 && lx > 24) { lx = 24; ly += rowH + 10; rowH = 0; } const at = [lx, ly]; lx += width + 20; rowH = Math.max(rowH, height); return at; };
  for (const item of $$("[data-legend] > *", card)) {
    const label = item.textContent.trim();
    if (item.classList.contains("legend-ramp")) {
      const rampSvg = $("svg", item).cloneNode(true);
      const title = item.firstChild.textContent;
      const [x0, y0] = place(Math.max(220, title.length * 6.4), 44);
      legendG.append(text(x0, y0 + 10, title, { fill: C.ink2, "font-size": 12 }));
      rampSvg.setAttribute("x", x0); rampSvg.setAttribute("y", y0 + 16); rampSvg.setAttribute("width", 220); rampSvg.setAttribute("height", 26);
      legendG.append(rampSvg);
    } else {
      const keySvg = $("svg", item)?.cloneNode(true);
      const [x0, y0] = place(20 + label.length * 6.4, 16);
      if (keySvg) { keySvg.setAttribute("x", x0); keySvg.setAttribute("y", y0 + 2); keySvg.setAttribute("width", 14); keySvg.setAttribute("height", 10); legendG.append(keySvg); }
      legendG.append(text(x0 + 20, y0 + 11, label, { fill: C.ink2, "font-size": 12 }));
    }
  }
  const legendH = legendG.childElementCount ? ly + rowH - (84 + h) : 0;
  const H = h + 84 + legendH + 48;
  const title = $("h2", card).textContent, sub = $(".card-sub", card)?.textContent ?? "";
  const out = svg("svg", { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}`, "font-family": C.font }, [
    svg("rect", { width: W, height: H, fill: C.card }),
    text(24, 38, title, { fill: C.ink, "font-size": 20, "font-weight": 600 }),
    text(24, 62, sub.length > 140 ? `${sub.slice(0, 137)}...` : sub, { fill: C.ink2, "font-size": 13 }),
    clone,
    legendG,
    text(24, H - 20, SOURCE_NOTE, { fill: C.muted, "font-size": 11 }),
  ]);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(out)], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const canvas = html("canvas", { width: W * 2, height: H * 2 });
    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((b) => downloadBlob(b, filename), "image/png");
  };
  img.src = url;
}
const DL_ICON = '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>';
function addActions(name, { png = true, csv = true } = {}) {
  const box = $(`[data-card="${name}"] [data-actions]`);
  if (!box || box.childElementCount) return;
  const title = () => $(`[data-card="${name}"] h2`).textContent;
  const slug = () => `ignisensing-${name}-${state.area}-${state.year}${state.month ? `-${String(state.month).padStart(2, "0")}` : ""}`;
  const button = (label, kind, run) => {
    const b = html("button", { class: "btn btn-small", type: "button", onclick: run });
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DL_ICON}</svg>`;
    b.append(document.createTextNode(label));
    b.setAttribute("aria-label", `Download ${title()} as ${kind}`);
    b.addEventListener("focus", () => b.setAttribute("aria-label", `Download ${title()} as ${kind}`));
    return b;
  };
  if (png) box.append(button("PNG", "PNG image", () => downloadPNG(name, `${slug()}.png`)));
  if (csv) box.append(button("CSV", "CSV data", () => { const rows = exporters[name]?.(); if (rows) downloadCSV(rows, `${slug()}.csv`); }));
}

// ---------- filters ----------
function buildFilters() {
  const area = $("#f-area"), year = $("#f-year");
  area.replaceChildren(html("option", { value: "indonesia", text: "All of Indonesia" }),
    ...D.provinces.map((p) => html("option", { value: p.slug, text: p.name })));
  year.replaceChildren(...[...M.years].reverse().map((y) => html("option", { value: y, text: y === M.curYear ? `${y} (in progress)` : `${y}` })));
  for (const el of [area, year, $("#f-month")]) el.disabled = false;
}
function syncFilters() {
  $("#f-area").value = state.area;
  $("#f-year").value = state.year;
  const month = $("#f-month");
  month.replaceChildren(html("option", { value: 0, text: "All months" }), ...MONTHS_LONG.map((name, k) => {
    const i = idx(state.year, k + 1);
    const label = i > M.last ? `${name} (no data yet)` : i > M.lastComplete ? `${name} (in progress)` : name;
    return html("option", { value: k + 1, text: label, disabled: i > M.last });
  }));
  month.value = state.month;
  $("#f-reset").disabled = state.area === "indonesia" && state.year === M.curYear && !state.month;
  $("#filters").hidden = state.view === "about";
}

// ---------- navigation shell ----------
function setupMode() {
  const root = document.documentElement, btn = $("#mode-btn"), label = $(".mode-label", btn);
  const sync = () => {
    const light = root.dataset.mode === "light";
    btn.setAttribute("aria-pressed", String(light));
    label.textContent = light ? "Dark mode" : "Light mode";
    btn.setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
    $('meta[name="theme-color"]').setAttribute("content", getComputedStyle(root).getPropertyValue("--color-paper").trim());
  };
  sync();
  btn.addEventListener("click", () => {
    if (root.dataset.mode === "light") delete root.dataset.mode;
    else root.dataset.mode = "light";
    try { localStorage.setItem("ignisensing-mode", root.dataset.mode || "dark"); } catch { /* storage unavailable */ }
    sync();
    readTokens();
    render();
  });
}
function setupShell() {
  setupMode();
  const body = document.body;
  try { if (localStorage.getItem("ignisensing-sidebar") === "collapsed") body.dataset.sidebar = "collapsed"; } catch { /* storage unavailable */ }
  const collapse = $("#collapse-btn");
  const syncCollapse = () => {
    const collapsed = body.dataset.sidebar === "collapsed";
    collapse.setAttribute("aria-expanded", String(!collapsed));
    $(".nav-label", collapse).textContent = collapsed ? "Expand sidebar" : "Collapse sidebar";
    for (const link of $$(".nav-link")) link.title = collapsed ? $(".nav-label", link).textContent : "";
  };
  syncCollapse();
  collapse.addEventListener("click", () => {
    body.dataset.sidebar = body.dataset.sidebar === "collapsed" ? "" : "collapsed";
    try { localStorage.setItem("ignisensing-sidebar", body.dataset.sidebar || "open"); } catch { /* storage unavailable */ }
    syncCollapse();
    requestAnimationFrame(render);
  });
  const menu = $("#menu-btn"), backdrop = $("#backdrop");
  const openNav = (open) => {
    body.dataset.nav = open ? "open" : "";
    backdrop.hidden = !open;
    menu.setAttribute("aria-expanded", String(open));
    if (open) $(".nav-link[aria-current]")?.focus();
    else if (document.activeElement?.closest(".sidebar")) menu.focus();
  };
  menu.addEventListener("click", () => openNav(true));
  backdrop.addEventListener("click", () => openNav(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && body.dataset.nav === "open") openNav(false); });
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-view-link]");
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    openNav(false);
    if (!D) return;
    setState({ view: link.dataset.viewLink }, { push: true });
    $("#main").focus({ preventScroll: true });
    scrollTo({ top: 0 });
  });
  addEventListener("popstate", () => { if (!D) return; readURL(); syncFilters(); render(); });
}

// ---------- render ----------
function render() {
  if (!D) return;
  hideTip();
  for (const sec of $$("[data-view]")) sec.hidden = sec.dataset.view !== state.view;
  for (const link of $$(".nav-link")) {
    if (link.dataset.viewLink === state.view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const p = period(), area = areaName(state.area);
  const subs = {
    overview: `${area}, ${p.label}. Counts are VIIRS-equivalent hotspot detections.`,
    calendar: `${area}, every month since ${M.y0}.`,
    map: `${area}, ${p.label}. Harmonized detections in 0.25° grid cells.`,
    history: `${area}, the monthly record and how each year compares.`,
    watchlist: `${p.label}. All ${D.provinces.length} provinces against their own ${baseLabel()} median.`,
    about: "Where the data come from and how to read them.",
  };
  $("#page-title").textContent = VIEWS[state.view];
  $("#page-sub").textContent = subs[state.view];
  document.title = `${VIEWS[state.view]}: Ignisensing Analytics`;
  ({ overview: renderOverview, calendar: renderCalendar, map: renderMap, history: renderHistory, watchlist: renderWatchlist, about: renderAbout })[state.view]();
}

// ---------- overview ----------
function kpi(label, value, sub, cls = "") {
  return html("div", { class: "card kpi" }, [html("span", { class: "kpi-label", text: label }), html("span", { class: `kpi-value ${cls}`, text: value }), html("span", { class: "kpi-sub", text: sub })]);
}
function renderOverview() {
  const ser = series(state.area), p = period(), area = areaName(state.area);
  $("#overview-selection").textContent = `${area} · ${p.label}`;
  const kpis = $("#kpis");
  // Peak month of the selected year, complete months only.
  const yearMonths = [];
  for (let m = 1; m <= 12; m++) if (idx(state.year, m) <= M.lastComplete) yearMonths.push(m);
  const peak = yearMonths.length ? yearMonths.reduce((a, m) => (ser[idx(state.year, m)] > ser[idx(state.year, a)] ? m : a), yearMonths[0]) : null;
  const peakTile = peak
    ? kpi("Peak activity month", `${MONTHS_LONG[peak - 1]}`, `${state.year} · ${fmt(ser[idx(state.year, peak)])} VIIRS-equivalent detections`)
    : kpi("Peak activity month", "No complete month yet", `${state.year}`, "is-empty");

  if (p.status === "none") {
    kpis.replaceChildren(kpi("Selected-period activity", "No data yet", `${p.label} is unavailable`, "is-empty"),
      kpi("Compared with historical median", "Not available", "A comparison needs a complete period", "is-empty"), peakTile);
  } else if (p.status === "partial") {
    const v = total(ser, state.year, p.months);
    kpis.replaceChildren(kpi("Selected-period activity", fmt(v), `${p.label} · VIIRS-equivalent detections so far`),
      kpi("Compared with historical median", "Not comparable yet", "This month is still being collected", "is-empty"), peakTile);
  } else {
    const c = compare(ser, state.year, p.months);
    const context = c.diff === null ? "Historical median is zero"
      : Math.abs(c.diff) < 0.5 ? `At the ${baseLabel()} median of ${fmt(c.median)}`
      : `${Math.abs(c.diff).toFixed(0)}% ${c.diff > 0 ? "above" : "below"} the ${baseLabel()} median of ${fmt(c.median)}`;
    kpis.replaceChildren(
      kpi("Selected-period activity", fmt(c.value), `${p.label} · VIIRS-equivalent detections · ${area}`),
      kpi("Compared with historical median", c.diff !== null && Math.abs(c.diff) < 0.5 ? "At the median" : pct(c.diff), context, c.diff > 0 ? "is-up" : c.diff < 0 ? "is-down" : ""),
      peakTile,
    );
  }
  renderOverviewMap(p);
  renderOverviewMonths(ser);
  renderInsights(ser, p);
}

let overviewMapToken = 0;
async function renderOverviewMap(p) {
  const { chart, sub, title, legend: lg } = cardEls("overview-map");
  const token = ++overviewMapToken;
  title.textContent = `Fire activity across ${areaName(state.area)}`;
  sub.textContent = `${p.label}. Harmonized detections in the dashboard’s 0.25° grid.`;
  let rows;
  try {
    await loadMapGeography();
    rows = p.status === "none" ? [] : await loadYear(state.year);
  } catch {
    if (token !== overviewMapToken) return;
    lg.replaceChildren();
    return emptyState(chart, "The spatial preview did not load", "Use the Fire Map to retry the detailed spatial view.");
  }
  if (token !== overviewMapToken || state.view !== "overview") return;
  if (p.status === "none") {
    lg.replaceChildren();
    return emptyState(chart, `No spatial data for ${p.label}`, `The newest detections are from ${monthLabel(M.last)}.`);
  }

  const fr = mapData.provinces.frame;
  const FW = (fr.lon1 - fr.lon0) * fr.scale, FH = (fr.lat1 - fr.lat0) * fr.scale;
  const areaIdx = state.area === "indonesia" ? -1 : M.bySlug.get(state.area).index;
  const months = p.months.map((m) => m - 1);
  const values = rows.map((r) => ({ cell: r[0], v: sum(months.map((k) => r[1 + k])) })).filter((d) => d.v >= 0.5);
  const areaValues = values.filter((d) => areaIdx < 0 || mapData.cells[d.cell][2] === areaIdx);
  const scaleMax = Math.max(1, ...areaValues.map((d) => d.v));
  const colour = countScale(1, scaleMax);
  const width = Math.max(300, Math.floor(chart.clientWidth));
  const height = Math.round(areaIdx >= 0 ? Math.min(430, Math.max(260, width * 0.58)) : width * (FH / FW));
  let box = [0, 0, FW, FH];
  if (areaIdx >= 0) {
    const b = mapData.provinces.provinces.find((pr) => pr.slug === state.area).box;
    box = [b[0], b[1], b[2] - b[0], b[3] - b[1]];
    const padX = Math.max(box[2] * 0.12, 20), padY = Math.max(box[3] * 0.12, 20);
    box = [box[0] - padX, box[1] - padY, box[2] + padX * 2, box[3] + padY * 2];
  }
  const aspect = width / height;
  if (box[2] / box[3] > aspect) { const h = box[2] / aspect; box[1] -= (h - box[3]) / 2; box[3] = h; }
  else { const w = box[3] * aspect; box[0] -= (w - box[2]) / 2; box[2] = w; }
  const px = box[2] / width;
  const root = svg("svg", { viewBox: box.map((v) => v.toFixed(1)).join(" "), width, height, role: "img",
    "aria-label": `Map preview of harmonized fire activity across ${areaName(state.area)} for ${p.label}` });
  root.append(svg("rect", { x: box[0], y: box[1], width: box[2], height: box[3], fill: C.paper }));
  root.append(svg("image", { href: "assets/bluemarble.jpg", x: 0, y: 0, width: FW, height: FH, preserveAspectRatio: "none" }));
  root.append(svg("rect", { x: 0, y: 0, width: FW, height: FH, fill: C.paper, "fill-opacity": 0.5 }));
  const provinces = svg("g", { fill: "transparent", stroke: C.ink2, "stroke-opacity": 0.5, "stroke-width": 0.8 * px, "stroke-linejoin": "round" });
  mapData.provinces.provinces.forEach((pr) => provinces.append(svg("path", { d: pr.path })));
  root.append(provinces);
  const size = 0.25 * fr.scale;
  const cells = svg("g");
  values.forEach((d) => {
    const [lat, lon, province] = mapData.cells[d.cell];
    cells.append(svg("rect", {
      x: ((lon - 0.125 - fr.lon0) * fr.scale).toFixed(1), y: ((fr.lat1 - lat - 0.125) * fr.scale).toFixed(1),
      width: size, height: size, fill: colour(d.v), "fill-opacity": areaIdx >= 0 && province !== areaIdx ? 0.22 : 0.92,
    }));
  });
  root.append(cells);
  if (areaIdx >= 0) root.append(svg("path", { d: mapData.provinces.provinces.find((pr) => pr.slug === state.area).path,
    fill: "none", stroke: C.active, "stroke-width": 2 * px, "stroke-linejoin": "round" }));
  chart.replaceChildren(root);
  const provenance = spatialProvenance(p);
  const extra = [
    html("span", { class: "legend-item", text: `${provenance.kind}: ${provenance.detail}` }),
    ...(p.status === "partial" ? [html("span", { class: "legend-item", text: "Partial month, still being collected." })] : []),
  ];
  rampLegend(lg, { title: `VIIRS-equivalent detections per cell, ${p.label}`, stops: C.ramp,
    labels: countLabels(colour, 1, scaleMax), extra });
}

function renderOverviewMonths(ser) {
  const { chart, sub, title } = cardEls("overview-months");
  title.textContent = `Monthly activity in ${state.year}`;
  sub.textContent = `${areaName(state.area)}. Select a bar to update the shared month; unavailable months are left blank.`;
  const data = MONTHS.map((month, k) => {
    const i = idx(state.year, k + 1);
    return { month, long: MONTHS_LONG[k], value: i <= M.last ? ser[i] : null, partial: i > M.lastComplete && i <= M.last };
  });
  const f = frame(chart, 180, { t: 12, r: 8, b: 30, l: 8 }, `Monthly activity for ${areaName(state.area)} in ${state.year}. Use arrow keys to read months and Enter to select one.`);
  const max = Math.max(1, ...data.map((d) => d.value ?? 0));
  const band = f.iw / 12, bw = Math.max(8, Math.min(28, band - 8));
  const y = (v) => f.m.t + f.ih - (v / max) * f.ih;
  const bars = svg("g"), hits = svg("g");
  data.forEach((d, k) => {
    const x = f.m.l + k * band + (band - bw) / 2;
    const selected = state.month === k + 1;
    if (d.value !== null) bars.append(svg("rect", { x, y: y(d.value), width: bw, height: Math.max(2, f.m.t + f.ih - y(d.value)),
      rx: 2, fill: selected ? C.fire : C.ramp[3], "fill-opacity": selected ? 1 : 0.7, stroke: selected ? C.ink : null, "stroke-width": selected ? 1 : null }));
    else bars.append(svg("line", { x1: x, x2: x + bw, y1: f.m.t + f.ih, y2: f.m.t + f.ih, stroke: C.rule, "stroke-width": 2 }));
    f.root.append(text(x + bw / 2, f.h - 8, d.month, { "text-anchor": "middle", fill: selected ? C.ink : C.muted, "font-size": 11, "font-weight": selected ? 600 : 400 }));
    hits.append(svg("rect", { x: f.m.l + k * band, y: f.m.t, width: band, height: f.ih, fill: "transparent", "data-k": k, cursor: "pointer" }));
  });
  f.root.append(bars, hits);
  const show = (k, anchor) => {
    if (k < 0) return hideTip();
    const d = data[k];
    showTip(`${d.long} ${state.year}`, [{ value: d.value === null ? "Unavailable" : fmt(d.value), label: d.partial ? "detections so far" : "VIIRS-equivalent detections", colour: d.value === null ? null : state.month === k + 1 ? C.fire : C.ramp[3], kind: "rect" }],
      d.partial ? "Partial month, still being collected." : null, anchor ?? anchorOf(hits.children[k]));
  };
  hits.addEventListener("pointermove", (e) => { const k = +e.target.dataset.k; if (!Number.isNaN(k)) show(k, { x: e.clientX, y: e.clientY }); });
  hits.addEventListener("pointerleave", () => hideTip());
  hits.addEventListener("click", (e) => { const k = +e.target.dataset.k; if (data[k]?.value !== null) setState({ month: k + 1 }); });
  keyNav(f.root, 12, { start: Math.max(0, (state.month || 1) - 1), onFocus: (k) => show(k), onEnter: (k) => { if (data[k].value !== null) setState({ month: k + 1 }); } });
  chart.replaceChildren(f.root);
}

function renderTrend(ser, p) {
  const { chart, sub, title, legend: lg } = cardEls("trend");
  addActions("trend");
  const months = p.months;
  const years = yearsWith(months);
  const data = years.map((y) => ({ year: y, value: total(ser, y, months) }));
  const med = median(data.filter((d) => M.completeYears.includes(d.year)).map((d) => d.value));
  title.textContent = p.span === "Annual" ? "Detections by year" : `${p.span} detections by year`;
  sub.textContent = `${areaName(state.area)}, ${years[0]} to ${years.at(-1)}.${p.status !== "ok" ? ` ${p.label} is not complete, so it is not shown.` : p.partialYear ? ` Every year is cut to ${monthsSpan(months)} so ${state.year} compares fairly.` : ""}`;
  exporters.trend = () => [["year", "months", "detections_viirs_equivalent", "source"], ...data.map((d) => [d.year, monthsSpan(months) || "Jan to Dec", d.value.toFixed(1), idx(d.year, months.at(-1)) <= M.modelLast ? "model" : "viirs"])];

  lg.replaceChildren(
    years.includes(state.year) ? html("span", { class: "legend-item" }, [key(C.fire, "rect"), document.createTextNode(`Selected year (${state.year})`)]) : "",
    html("span", { class: "legend-item" }, [key(C.ramp[2], "rect"), document.createTextNode("Other years")]),
    legendHatch("Model estimate (before 2012)"),
    html("span", { class: "legend-item" }, [key(C.info), document.createTextNode(`Median, ${baseLabel()}`)]),
  );

  const f = frame(chart, 300, { t: 16, r: 12, b: 28, l: 48 }, `Bar chart of ${title.textContent.toLowerCase()} for ${areaName(state.area)}`);
  const max = Math.max(...data.map((d) => d.value), med ?? 0) || 1;
  const yT = ticks(0, max, 4);
  const y = (v) => f.m.t + f.ih - (v / yT.at(-1)) * f.ih;
  const band = f.iw / data.length, bw = Math.max(2, Math.min(24, band - 3));
  f.root.append(svg("defs", {}, hatchDef("hatch-trend", C.paper)), yAxis(f, y, yT));
  const marks = svg("g"), hits = svg("g");
  data.forEach((d, k) => {
    const x = f.m.l + k * band + (band - bw) / 2;
    const sel = d.year === state.year;
    const path = barPath(x, y(d.value), bw, f.m.t + f.ih - y(d.value));
    marks.append(svg("path", { d: path, fill: sel ? C.fire : C.ramp[2], "data-k": k }));
    if (idx(d.year, months.at(-1)) <= M.modelLast) marks.append(svg("path", { d: path, fill: "url(#hatch-trend)", "pointer-events": "none" }));
    const yl = yearLabels(band);
    if ((d.year - years[0]) % yl.every === 0)
      f.root.append(text(x + bw / 2, f.h - 8, yl.label(d.year), { "text-anchor": "middle", fill: sel ? C.ink : C.muted, "font-size": 11, "font-weight": sel ? 600 : 400 }));
    hits.append(svg("rect", { x: f.m.l + k * band, y: f.m.t, width: band, height: f.ih, fill: "transparent", "data-k": k, cursor: "pointer" }));
  });
  f.root.append(marks);
  if (med !== null) {
    f.root.append(svg("line", { x1: f.m.l, x2: f.w - f.m.r, y1: y(med), y2: y(med), stroke: C.info, "stroke-width": 1.5 }));
  }
  f.root.append(hits);
  const focusBar = (k, anchor) => {
    for (const el of $$("path[data-k]", marks)) el.setAttribute("fill-opacity", k < 0 || +el.dataset.k === k ? 1 : 0.55);
    if (k < 0) return;
    const d = data[k];
    showTip(`${monthsSpan(months) ? `${monthsSpan(months)} ` : ""}${d.year}`, [
      { value: fmt(d.value), label: "detections", colour: d.year === state.year ? C.fire : C.ramp[2], kind: "rect" },
      { value: pct(med > 0 ? ((d.value - med) / med) * 100 : null), label: "against the median", colour: C.info },
    ], idx(d.year, months.at(-1)) <= M.modelLast ? `Model estimate, typical annual error ±${M.err.toFixed(1)}%` : "VIIRS observed", anchor ?? anchorOf(hits.children[k]));
  };
  hits.addEventListener("pointermove", (e) => { const k = +e.target.dataset.k; if (!Number.isNaN(k)) focusBar(k, { x: e.clientX, y: e.clientY }); });
  hits.addEventListener("pointerleave", () => { hideTip(); focusBar(-1); });
  hits.addEventListener("click", (e) => { const k = +e.target.dataset.k; if (!Number.isNaN(k)) setState({ year: data[k].year }); });
  keyNav(f.root, data.length, {
    start: Math.max(0, data.findIndex((d) => d.year === state.year)),
    onFocus: (k) => { if (k < 0) return focusBar(-1); focusBar(k, anchorOf(hits.children[k])); },
    onEnter: (k) => setState({ year: data[k].year }),
  });
  f.root.setAttribute("aria-label", `${f.root.getAttribute("aria-label")}. Use the arrow keys to read each year and Enter to select it.`);
  chart.replaceChildren(f.root);
}

function renderInsights(ser, p) {
  const { chart, sub } = cardEls("insights");
  const area = areaName(state.area);
  sub.textContent = `${area}, computed from the harmonized series.`;
  let item;
  if (p.status === "partial") {
    item = [p.label, " is still being collected. Its historical comparison will appear once the month is complete."];
  } else if (p.status === "none") {
    item = [p.label, " has no available observations in the current record."];
  } else {
    const c = compare(ser, state.year, p.months);
    if (c.diff !== null) {
      const rel = Math.abs(c.diff) < 0.5 ? "in line with" : `${Math.round(Math.abs(c.diff))}% ${c.diff > 0 ? "above" : "below"}`;
      const source = spatialProvenance(p).kind === "VIIRS" ? "observed VIIRS activity" : "a MODIS-derived VIIRS-equivalent estimate";
      item = [p.label, ` is ${rel} the ${baseLabel()} median. This selection uses ${source}.`];
    }
  }
  if (!item) {
    const byMonth = MONTHS.map((_, k) => sum(M.completeYears.map((y) => ser[idx(y, k + 1)] ?? 0)));
    let best = 0, bestK = 0;
    for (let k = 0; k < 12; k++) { const s3 = byMonth[k] + byMonth[(k + 1) % 12] + byMonth[(k + 2) % 12]; if (s3 > best) { best = s3; bestK = k; } }
    item = best > 0
      ? [`${MONTHS_LONG[bestK]} to ${MONTHS_LONG[(bestK + 2) % 12]}`, ` is the strongest three-month seasonal window in the ${baseLabel()} record.`]
      : ["Harmonized record", " supports like-for-like historical comparison between modeled MODIS years and observed VIIRS years."];
  }
  chart.replaceChildren(html("li", {}, [html("strong", { text: item[0] }), document.createTextNode(item[1])]));
}

function renderProvinceBars(p) {
  const { chart, sub, title } = cardEls("provinces");
  addActions("provinces");
  if (p.status === "none") {
    title.textContent = "Provinces with the most detections";
    sub.textContent = "";
    exporters.provinces = null;
    return emptyState(chart, `No data for ${p.label} yet`, `The latest complete month is ${monthLabel(M.lastComplete)}.`, lastCompleteAction());
  }
  const rows = D.provinces.map((pr) => ({ name: pr.name, slug: pr.slug, v: total(pr.series, state.year, p.months) })).sort((a, b) => b.v - a.v);
  const national = sum(rows.map((r) => r.v));
  let shown = rows.slice(0, 10);
  const selK = rows.findIndex((r) => r.slug === state.area);
  if (selK >= 10) shown = [...shown.slice(0, 9), rows[selK]];
  title.textContent = `Provinces with the most detections, ${p.label}`;
  sub.textContent = `${p.status === "partial" ? "Partial month, counts so far. " : ""}Share of Indonesia’s total in brackets. Select a province to filter every view.`;
  exporters.provinces = () => [["rank", "province", "detections_viirs_equivalent", "share_of_indonesia_pct"], ...rows.map((r, k) => [k + 1, r.name, r.v.toFixed(1), national ? ((r.v / national) * 100).toFixed(1) : ""])];

  const narrow = chart.clientWidth < 560;
  const rowH = narrow ? 46 : 30;
  const f = frame(chart, shown.length * rowH + 8, narrow ? { t: 4, r: 96, b: 4, l: 0 } : { t: 4, r: 130, b: 4, l: 150 }, `Horizontal bar chart of the ten provinces with the most detections in ${p.label}`);
  const barTop = narrow ? 24 : 7, barBottom = narrow ? 6 : 7;
  const max = Math.max(1, ...shown.map((r) => r.v));
  const g = svg("g");
  shown.forEach((r, k) => {
    const rank = rows.indexOf(r) + 1;
    const yy = f.m.t + k * rowH;
    const w = (r.v / max) * f.iw;
    const sel = r.slug === state.area || (state.area === "indonesia");
    const row = svg("g", { "data-slug": r.slug, cursor: "pointer", tabindex: 0, role: "button", "aria-label": `${r.name}, ${fmt(r.v)} detections. Select to filter every view.` }, [
      svg("rect", { x: 0, y: yy, width: f.w, height: rowH, fill: "transparent" }),
      narrow
        ? text(0, yy + 16, `${rank}. ${r.name}`, { fill: r.slug === state.area ? C.ink : C.ink2, "font-size": 12, "font-weight": r.slug === state.area ? 600 : 400 })
        : text(f.m.l - 10, yy + rowH / 2 + 4, `${rank}. ${r.name}`, { "text-anchor": "end", fill: r.slug === state.area ? C.ink : C.ink2, "font-size": 12, "font-weight": r.slug === state.area ? 600 : 400 }),
      svg("path", { d: `M${f.m.l},${yy + barTop}H${f.m.l + Math.max(0, w - 2)}Q${f.m.l + w},${yy + barTop} ${f.m.l + w},${yy + barTop + 2}V${yy + rowH - barBottom - 2}Q${f.m.l + w},${yy + rowH - barBottom} ${f.m.l + Math.max(0, w - 2)},${yy + rowH - barBottom}H${f.m.l}Z`, fill: sel ? C.fire : C.ramp[2] }),
      text(f.m.l + w + 8, yy + (barTop + rowH - barBottom) / 2 + 4, `${fmt(r.v)} (${national ? Math.round((r.v / national) * 100) : 0}%)`, { fill: C.ink2, "font-size": 12, "font-variant-numeric": "tabular-nums" }),
    ]);
    g.append(row);
  });
  const pick = (el) => { const slug = el?.closest("[data-slug]")?.dataset.slug; if (slug) setState({ area: slug }); };
  g.addEventListener("click", (e) => pick(e.target));
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e.target); } });
  f.root.append(g);
  f.root.removeAttribute("role");
  chart.replaceChildren(f.root);
}

// ---------- activity calendar ----------
function renderCalendar() {
  const { chart, sub, title, legend: lg } = cardEls("calendar");
  addActions("calendar");
  for (const b of $$("[data-calmode]")) b.setAttribute("aria-pressed", String(b.dataset.calmode === state.calMode));
  const ser = series(state.area), area = areaName(state.area);
  const meds = monthMedians(ser);
  const anomaly = state.calMode === "anomaly";
  title.textContent = anomaly ? "Each month against its median" : "Monthly detections";
  sub.textContent = anomaly
    ? `${area}. Colour shows how far each month sits from the median for that calendar month, ${baseLabel()}.`
    : `${area}, VIIRS-equivalent detections per month. Colour uses a log scale.`;
  exporters.calendar = () => [["year", "month", "detections_viirs_equivalent", "median_same_month", "difference_from_median_pct", "source", "status"],
    ...Array.from({ length: M.n }, (_, i) => {
      const v = ser[i], med = meds[M.monthOf(i) - 1];
      const status = i > M.last || v === null || v === undefined ? "unavailable" : i > M.lastComplete ? "partial" : "complete";
      return [M.yearOf(i), M.monthOf(i), v?.toFixed(1), med?.toFixed(1), v !== null && v !== undefined && med > 0 ? (((v - med) / med) * 100).toFixed(1) : "", isModel(i) ? "model" : "viirs", status];
    })];

  const years = M.years;
  const w = Math.max(300, Math.floor(chart.clientWidth));
  const m = { t: 22, r: 4, b: 4, l: 66 };
  const gap = 2;
  const cw = (w - m.l - m.r) / 12;
  const ch = clamp(cw * 0.5, 15, 22);
  const h = m.t + years.length * ch + m.b;
  const f = { root: svg("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img", "font-family": C.font, "font-size": 11, fill: C.ink2,
    "aria-label": `Calendar heatmap of ${anomaly ? "monthly difference from the median" : "monthly detections"} for ${area}, ${years[0]} to ${years.at(-1)}. Use the arrow keys to read each month and Enter to select it.` }) };
  const root = f.root;
  root.append(svg("defs", {}, hatchDef("hatch-cal", C.paper)));
  const shown = ser.slice(0, M.lastComplete + 1);
  const maxV = Math.max(1, ...shown);
  const minV = Math.max(1, Math.min(...shown.filter((v) => v >= 0.5)));
  const colour = countScale(minV, maxV);
  MONTHS.forEach((mm, k) => root.append(text(m.l + k * cw + cw / 2, 14, cw < 30 ? mm[0] : mm, { "text-anchor": "middle", fill: state.month === k + 1 ? C.ink : C.muted, "font-weight": state.month === k + 1 ? 600 : 400 })));
  // Source band: model rows and VIIRS rows.
  // Rows that are wholly or mostly model estimates (the model ends in January 2012).
  const modelRows = M.yearOf(M.modelLast) - M.y0 + (M.monthOf(M.modelLast) >= 6 ? 1 : 0);
  const band = (r0, r1, colourBand, label) => {
    const y0 = m.t + r0 * ch, y1 = m.t + (r1 + 1) * ch - gap;
    root.append(svg("rect", { x: 2, y: y0, width: 3, height: y1 - y0, rx: 1.5, fill: colourBand }));
    root.append(text(14, (y0 + y1) / 2, label, { transform: `rotate(-90 14 ${(y0 + y1) / 2})`, "text-anchor": "middle", fill: C.muted, "font-size": 10, "dominant-baseline": "middle" }));
  };
  band(0, modelRows - 1, C.muted, "Model");
  band(modelRows, years.length - 1, C.fire, "VIIRS observed");

  const cells = svg("g");
  years.forEach((y, r) => {
    const yy = m.t + r * ch;
    root.append(text(m.l - 8, yy + ch / 2 + 3.5, y, { "text-anchor": "end", fill: y === state.year ? C.ink : C.muted, "font-weight": y === state.year ? 600 : 400, "font-variant-numeric": "tabular-nums" }));
    for (let k = 0; k < 12; k++) {
      const i = idx(y, k + 1);
      const x = m.l + k * cw;
      const attrs = { x: x + gap / 2, y: yy, width: cw - gap, height: ch - gap, rx: 3, "data-i": i };
      if (i > M.last) { cells.append(svg("rect", { ...attrs, fill: "none", stroke: C.rule, "stroke-width": 1 })); continue; }
      const v = ser[i], med = meds[k];
      cells.append(v === null || v === undefined
        ? svg("rect", { ...attrs, fill: "none", stroke: C.rule, "stroke-width": 1 })
        : svg("rect", { ...attrs, fill: anomaly ? ratioColour(v, med ?? 0) : colour(v) }));
      if (i > M.lastComplete) cells.append(svg("rect", { ...attrs, fill: "url(#hatch-cal)", "pointer-events": "none" }));
    }
  });
  root.append(cells);
  // Selection outline: the year row, or the single cell when a month is chosen.
  const ry = m.t + years.indexOf(state.year) * ch;
  const outline = state.month
    ? svg("rect", { x: m.l + (state.month - 1) * cw, y: ry - 1, width: cw, height: ch, rx: 4, fill: "none", stroke: C.active, "stroke-width": 2, "pointer-events": "none" })
    : svg("rect", { x: m.l - 1, y: ry - 1, width: 12 * cw + 2, height: ch, rx: 4, fill: "none", stroke: C.active, "stroke-width": 1.5, "pointer-events": "none" });
  root.append(outline);
  const cursor = svg("rect", { fill: "none", stroke: C.ink, "stroke-width": 1.5, rx: 3, visibility: "hidden", "pointer-events": "none" });
  root.append(cursor);

  const describe = (i, anchor) => {
    if (i < 0) { cursor.setAttribute("visibility", "hidden"); return hideTip(); }
    const k = M.monthOf(i) - 1, r = years.indexOf(M.yearOf(i));
    cursor.setAttribute("x", m.l + k * cw + gap / 2); cursor.setAttribute("y", m.t + r * ch);
    cursor.setAttribute("width", cw - gap); cursor.setAttribute("height", ch - gap); cursor.setAttribute("visibility", "visible");
    if (i > M.last) return showTip(monthLabel(i), [], "No data yet", anchor);
    const v = ser[i], med = meds[k], missing = v === null || v === undefined;
    const c = !missing && i <= M.lastComplete ? compare(ser, M.yearOf(i), [M.monthOf(i)]) : null;
    const status = missing ? "Unavailable" : i > M.lastComplete ? "Partial" : "Complete";
    const rows = [
      { value: missing ? "N/A" : fmt(v), label: i > M.lastComplete && !missing ? "detections so far" : "detections", colour: missing ? null : anomaly ? ratioColour(v, med ?? 0) : colour(v), kind: "rect" },
      { value: fmt(med), label: `historical median for ${MONTHS_LONG[k]}` },
      { value: c?.diff !== null && c?.diff !== undefined ? pct(c.diff) : "N/A", label: "against the median" },
      { value: status, label: "data status" },
    ];
    const note = missing ? "No monthly record is available." : i > M.lastComplete ? `${sourceOf(i)}. Still being collected.` : sourceOf(i);
    showTip(monthLabel(i), rows, note, anchor);
  };
  cells.addEventListener("pointermove", (e) => { const i = e.target.dataset?.i; if (i !== undefined) describe(+i, { x: e.clientX, y: e.clientY }); });
  cells.addEventListener("pointerleave", () => describe(-1));
  cells.addEventListener("click", (e) => { const i = e.target.dataset?.i; if (i !== undefined && +i <= M.last) setState({ year: M.yearOf(+i), month: M.monthOf(+i) }); });
  cells.style.cursor = "pointer";
  const total12 = years.length * 12;
  const start = idx(state.year, state.month || 1);
  keyNav(root, total12, {
    cols: 12, start,
    onFocus: (i) => { if (i < 0) return describe(-1); const r = Math.floor(i / 12), k = i % 12; describe(i, { x: root.getBoundingClientRect().left + m.l + k * cw + cw / 2, y: root.getBoundingClientRect().top + m.t + r * ch }); },
    onEnter: (i) => { if (i <= M.last) setState({ year: M.yearOf(i), month: M.monthOf(i) }); },
  });
  chart.replaceChildren(root);

  const hatchNote = html("span", { class: "legend-item" }, [svg("svg", { viewBox: "0 0 14 10", "aria-hidden": "true" }, [svg("defs", {}, hatchDef("lh2", C.paper)), svg("rect", { x: 2, y: 1, width: 10, height: 8, rx: 2, fill: C.ramp[3] }), svg("rect", { x: 2, y: 1, width: 10, height: 8, rx: 2, fill: "url(#lh2)" })]), document.createTextNode("Partial month")]);
  const selNote = html("span", { class: "legend-item" }, [svg("svg", { viewBox: "0 0 14 10", "aria-hidden": "true" }, svg("rect", { x: 1.5, y: 1.5, width: 11, height: 7, rx: 2, fill: "none", stroke: C.active, "stroke-width": 1.5 })), document.createTextNode("Selected")]);
  if (anomaly) {
    rampLegend(lg, { title: "Compared with the median for that month", stops: [[C.cool[2], 0], [C.cool[1], 1 / 6], [C.cool[0], 2 / 6], [C.mid, 0.5], [C.ramp[1], 0.625], [C.ramp[3], 0.75], [C.ramp[4], 0.875], [C.ramp[5], 1]],
      labels: [[0, "¼ or less"], [0.25, "½"], [0.5, "Median"], [0.75, "2×"], [1, "4× or more"]], extra: [hatchNote, selNote] });
  } else {
    rampLegend(lg, { title: "Detections per month (log scale)", stops: C.ramp, labels: countLabels(colour, minV, maxV), extra: [hatchNote, selNote] });
  }
  renderCalendarInspector(ser, meds);
  renderSeason(ser, meds);
}

function renderCalendarInspector(ser, meds) {
  const card = $('[data-card="calendar-inspector"]');
  const title = $("#calendar-inspector-title", card);
  const sub = $("[data-inspector-sub]", card);
  const body = $("[data-inspector]", card);
  if (!state.month) {
    title.textContent = "Choose a month";
    sub.textContent = `${areaName(state.area)}. Select any available heatmap cell.`;
    body.replaceChildren(html("div", { class: "inspector-empty" }, [
      html("p", { text: "The selected month’s activity, historical baseline, provenance, and satellite sources will appear here." }),
      html("p", { class: "inspector-source", text: SOURCE_NOTE }),
    ]));
    return;
  }

  const i = idx(state.year, state.month);
  const p = period(state.year, state.month);
  const value = ser[i];
  const med = meds[state.month - 1];
  const available = i <= M.last && value !== null && value !== undefined;
  const complete = available && p.status === "ok";
  const c = complete ? compare(ser, state.year, [state.month]) : null;
  const status = !available || p.status === "none" ? "Unavailable" : p.status === "partial" ? "Partial" : "Complete";
  const provenance = available ? sourceOf(i) : "No monthly record available";
  let interpretation;
  if (!available) interpretation = "Activity is unavailable for this month.";
  else if (!complete) interpretation = "Activity is still being collected, so comparison with the historical median is deferred.";
  else if (c.diff === null) interpretation = "The historical median is zero, so a percentage comparison is not available.";
  else if (Math.abs(c.diff) < 0.5) interpretation = "Activity was in line with the historical median for this month.";
  else interpretation = `Activity was ${c.diff > 0 ? "above" : "below"} the historical median for this month.`;

  title.textContent = p.label;
  sub.textContent = areaName(state.area);

  const facts = html("dl", { class: "inspector-facts" }, [
    html("div", { class: "inspector-primary" }, [
      html("dt", { text: "Harmonized activity" }),
      html("dd", { class: "inspector-value", text: available ? fmt(value) : "N/A" }),
      html("span", { class: "inspector-unit", text: available ? "VIIRS-equivalent hotspot detections" : "No confirmed value" }),
    ]),
    html("div", {}, [html("dt", { text: "Historical median" }), html("dd", { text: med === null || med === undefined ? "N/A" : fmt(med) })]),
    html("div", {}, [html("dt", { text: "Difference" }), html("dd", { class: c?.diff > 0 ? "is-up" : c?.diff < 0 ? "is-down" : "", text: c ? pct(c.diff) : "N/A" })]),
    html("div", {}, [html("dt", { text: "Baseline" }), html("dd", { text: baseLabel() })]),
    html("div", {}, [html("dt", { text: "Provenance" }), html("dd", { text: provenance })]),
    html("div", {}, [html("dt", { text: "Data status" }), html("dd", {}, html("span", { class: `status-label status-${status.toLowerCase()}`, text: status }))]),
  ]);

  const sourceRows = state.area === "indonesia"
    ? [
        ["MODIS", D.national.MODIS[i], D.national.MODIS[i] === null || D.national.MODIS[i] === undefined ? "Unavailable for this month" : "Terra + Aqua observation"],
        ["VIIRS", D.national.VIIRS[i], D.national.VIIRS[i] === null || D.national.VIIRS[i] === undefined ? "Unavailable for this month" : "S-NPP observation"],
        ["Harmonized", D.national.HARMONIZED[i], D.national.HARMONIZED[i] === null || D.national.HARMONIZED[i] === undefined ? "Unavailable for this month" : isModel(i) ? "Constructed estimate from MODIS" : "Observed VIIRS used directly"],
      ]
    : [
        ["MODIS", null, "Not available by province"],
        ["VIIRS", null, "Not available by province"],
        ["Harmonized", value, available ? provenance : "Unavailable for this month"],
      ];
  const table = html("table", { class: "data-table source-table" }, [
    html("thead", {}, html("tr", {}, [
      html("th", { scope: "col", text: "Source" }),
      html("th", { scope: "col", class: "num", text: "Activity" }),
      html("th", { scope: "col", text: "Provenance / availability" }),
    ])),
    html("tbody", {}, sourceRows.map(([name, v, note]) => html("tr", {}, [
      html("th", { scope: "row", text: name }),
      html("td", { class: "num", text: v === null || v === undefined ? "N/A" : fmt(v) }),
      html("td", { text: note }),
    ]))),
  ]);
  const comparisonNote = state.area === "indonesia"
    ? "MODIS and VIIRS have different detection capabilities. Harmonized is a constructed series; where it uses observed VIIRS directly, those values may match."
    : "Source-specific MODIS and VIIRS monthly series are not available for individual provinces in the current dataset.";
  const details = html("details", { class: "source-comparison" }, [
    html("summary", { text: "Compare satellite sources" }),
    html("div", { class: "table-wrap" }, table),
    html("p", { text: comparisonNote }),
  ]);
  const mapParams = new URLSearchParams(location.search);
  mapParams.set("view", "map");
  mapParams.set("year", state.year);
  mapParams.set("month", state.month);
  if (state.area === "indonesia") mapParams.delete("area");
  else mapParams.set("area", state.area);

  body.replaceChildren(
    facts,
    html("p", { class: "inspector-interpretation", text: interpretation }),
    details,
    html("div", { class: "inspector-meta" }, [
      html("p", { class: "inspector-source", text: SOURCE_NOTE }),
      html("a", { class: "btn btn-small", href: `?${mapParams}`, "data-view-link": "map", text: "View on Fire Map" }),
    ]),
  );
}

function renderSeason(ser, meds) {
  const { chart, sub, title, legend: lg, note } = cardEls("season");
  addActions("season");
  const p25 = MONTHS.map((_, k) => quantile(M.completeYears.map((y) => ser[idx(y, k + 1)]), 0.25));
  const p75 = MONTHS.map((_, k) => quantile(M.completeYears.map((y) => ser[idx(y, k + 1)]), 0.75));
  const sel = MONTHS.map((_, k) => (idx(state.year, k + 1) <= M.lastComplete ? ser[idx(state.year, k + 1)] : null));
  title.textContent = `Seasonal cycle, ${state.year} against the usual year`;
  sub.textContent = `${areaName(state.area)}, detections per month.`;
  note.textContent = `The band covers the middle half of years (25th to 75th percentile), ${baseLabel()}.${sel.some((v) => v === null) ? " Months without complete data are left out of the selected year." : ""}`;
  exporters.season = () => [["month", `detections_${state.year}`, "median", "p25", "p75"], ...MONTHS.map((mm, k) => [mm, sel[k]?.toFixed(1) ?? "", meds[k]?.toFixed(1), p25[k]?.toFixed(1), p75[k]?.toFixed(1)])];
  legend(lg, [{ colour: C.fire, label: `${state.year}` }, { colour: C.info, label: `Median, ${baseLabel()}` }]);
  lg.append(html("span", { class: "legend-item" }, [svg("svg", { viewBox: "0 0 14 10", "aria-hidden": "true" }, svg("rect", { x: 1, y: 1, width: 12, height: 8, rx: 2, fill: C.info, "fill-opacity": 0.22 })), document.createTextNode("Middle half of years")]));

  const f = frame(chart, 200, { t: 8, r: 12, b: 24, l: 48 }, `Line chart of the seasonal cycle for ${areaName(state.area)}: ${state.year} against the median`);
  const max = Math.max(1, ...p75, ...sel.filter((v) => v !== null));
  const yT = ticks(0, max, 4);
  const x = (k) => f.m.l + (k / 11) * f.iw;
  const y = (v) => f.m.t + f.ih - (v / yT.at(-1)) * f.ih;
  f.root.append(yAxis(f, y, yT));
  MONTHS.forEach((mm, k) => f.root.append(text(x(k), f.h - 8, f.iw < 360 ? mm[0] : mm, { "text-anchor": "middle", fill: C.muted, "font-size": 11 })));
  f.root.append(svg("path", { d: `M${p75.map((v, k) => `${x(k)},${y(v)}`).join("L")}L${[...p25].reverse().map((v, k) => `${x(11 - k)},${y(v)}`).join("L")}Z`, fill: C.info, "fill-opacity": 0.16 }));
  f.root.append(svg("path", { d: `M${meds.map((v, k) => `${x(k)},${y(v)}`).join("L")}`, fill: "none", stroke: C.info, "stroke-width": 2, "stroke-linejoin": "round" }));
  const segs = []; let cur = [];
  sel.forEach((v, k) => { if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(k), y(v)]); });
  if (cur.length) segs.push(cur);
  for (const s of segs) f.root.append(svg("path", { d: `M${s.map((pt) => pt.join(",")).join("L")}`, fill: "none", stroke: C.fire, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  const cross = svg("line", { y1: f.m.t, y2: f.m.t + f.ih, stroke: C.ink2, "stroke-width": 1, visibility: "hidden" });
  const dotA = svg("circle", { r: 4.5, fill: C.fire, stroke: C.card, "stroke-width": 2, visibility: "hidden" });
  const dotB = svg("circle", { r: 4.5, fill: C.info, stroke: C.card, "stroke-width": 2, visibility: "hidden" });
  f.root.append(cross, dotB, dotA);
  const show = (k, anchor) => {
    if (k < 0) { [cross, dotA, dotB].forEach((el) => el.setAttribute("visibility", "hidden")); return hideTip(); }
    cross.setAttribute("x1", x(k)); cross.setAttribute("x2", x(k)); cross.setAttribute("visibility", "visible");
    dotB.setAttribute("cx", x(k)); dotB.setAttribute("cy", y(meds[k])); dotB.setAttribute("visibility", "visible");
    if (sel[k] !== null) { dotA.setAttribute("cx", x(k)); dotA.setAttribute("cy", y(sel[k])); dotA.setAttribute("visibility", "visible"); } else dotA.setAttribute("visibility", "hidden");
    showTip(MONTHS_LONG[k], [
      { value: sel[k] === null ? "no complete data" : fmt(sel[k]), label: `${state.year}`, colour: C.fire },
      { value: fmt(meds[k]), label: "median", colour: C.info },
      { value: `${fmt(p25[k])} to ${fmt(p75[k])}`, label: "middle half" },
    ], null, anchor ?? { x: f.root.getBoundingClientRect().left + x(k), y: f.root.getBoundingClientRect().top + y(Math.max(meds[k], sel[k] ?? 0)) });
  };
  const hit = svg("rect", { x: f.m.l - 10, y: f.m.t, width: f.iw + 20, height: f.ih, fill: "transparent" });
  hit.addEventListener("pointermove", (e) => { const r = f.root.getBoundingClientRect(); const k = clamp(Math.round(((e.clientX - r.left) * (f.w / r.width) - f.m.l) / (f.iw / 11)), 0, 11); show(k, { x: e.clientX, y: e.clientY }); });
  hit.addEventListener("pointerleave", () => show(-1));
  f.root.append(hit);
  keyNav(f.root, 12, { start: (state.month || 1) - 1, onFocus: (k) => show(k) });
  chart.replaceChildren(f.root);
}

// ---------- fire map ----------
async function loadMapGeography() {
  if (mapData.provinces && mapData.cells) return;
  const [prov, cells] = await Promise.all(["provinces", "cells"].map((n) => fetch(`data/${n}.json`).then((r) => { if (!r.ok) throw new Error(n); return r.json(); })));
  mapData.provinces = prov;
  mapData.cells = cells.cells;
}
async function loadMapBase() {
  await loadMapGeography();
  if (mapData.statics) return;
  const statics = await fetch("data/static_sources.json").then((r) => { if (!r.ok) throw new Error("static_sources"); return r.json(); });
  mapData.statics = statics.cells;
}
function loadYear(year) {
  if (!mapData.years.has(year)) {
    mapData.years.set(year, fetch(`data/cells/${year}.json`).then((r) => { if (!r.ok) throw new Error(`cells ${year}`); return r.json(); }).then((d) => d.rows)
      .catch((e) => { mapData.years.delete(year); throw e; }));
  }
  return mapData.years.get(year);
}
function spatialProvenance(p) {
  const modeled = p.months.filter((m) => isModel(idx(state.year, m))).length;
  if (modeled === p.months.length) {
    return { kind: "MODEL", detail: "MODIS-derived modeled VIIRS-equivalent activity." };
  }
  if (modeled === 0) {
    return { kind: "VIIRS", detail: "Observation-derived VIIRS activity." };
  }
  return { kind: "MIXED", detail: "This period combines a MODIS-derived modeled estimate with observed VIIRS activity." };
}
let mapToken = 0;
async function renderMap() {
  const { chart, sub, title, legend: lg, card } = cardEls("map");
  addActions("map");
  addActions("topcells", { png: false });
  const notice = $("[data-notice]", card);
  const p = period();
  const token = ++mapToken;
  const old = $("svg", chart);
  if (old) old.style.opacity = 0.5;
  let rows;
  try {
    await loadMapBase();
    rows = p.status === "none" ? [] : await loadYear(state.year);
  } catch {
    if (token !== mapToken) return;
    emptyState(chart, "The map data did not load", "Check your connection, then try again.", { label: "Try again", run: () => renderMap() });
    chart.firstChild.classList.add("is-error");
    return;
  }
  if (token !== mapToken || state.view !== "map") return;

  const area = state.area, areaIdx = area === "indonesia" ? -1 : M.bySlug.get(area).index;
  const months = p.months.map((mm) => mm - 1);
  const values = rows.map((r) => ({ cell: r[0], v: sum(months.map((k) => r[1 + k])) })).filter((d) => d.v > 0);
  const provenance = spatialProvenance(p);
  title.textContent = `Detections per 0.25° cell, ${p.label}`;
  sub.textContent = `Harmonized VIIRS-equivalent counts${area === "indonesia" ? "" : `, zoomed to ${areaName(area)}`}. Colour uses a log scale.`;
  notice.hidden = p.status !== "partial" && provenance.kind === "VIIRS";
  notice.textContent = p.status === "partial"
    ? `${p.label} is still being collected, so these counts are incomplete.`
    : provenance.detail;
  const cells = mapData.cells;
  exporters.map = () => [["cell_lat", "cell_lon", "province", "detections_viirs_equivalent", "period"],
    ...values.filter((d) => areaIdx < 0 || cells[d.cell][2] === areaIdx).sort((a, b) => b.v - a.v).map((d) => [cells[d.cell][0], cells[d.cell][1], D.provinces[cells[d.cell][2]].name, d.v.toFixed(2), p.label])];

  if (p.status === "none") {
    renderMapInspector({ p, values: [], provenance });
    renderTopCells([], p);
    lg.replaceChildren();
    return emptyState(chart, `No data for ${p.label} yet`, `The newest detections are from ${monthLabel(M.last)}.`, lastCompleteAction());
  }

  const fr = mapData.provinces.frame;
  const FW = (fr.lon1 - fr.lon0) * fr.scale, FH = (fr.lat1 - fr.lat0) * fr.scale;
  const w = Math.max(300, Math.floor(chart.clientWidth));
  const h = Math.round(areaIdx >= 0 ? Math.max(w * (FH / FW), Math.min(420, w * 0.75)) : w * (FH / FW));
  // Fit the view box to the selected province (padded), at the container's aspect ratio.
  let box = [0, 0, FW, FH];
  if (areaIdx >= 0) {
    const b = mapData.provinces.provinces.find((pr) => pr.slug === area).box;
    box = [b[0], b[1], b[2] - b[0], b[3] - b[1]];
    const padX = Math.max(box[2] * 0.12, 20), padY = Math.max(box[3] * 0.12, 20);
    box = [box[0] - padX, box[1] - padY, box[2] + 2 * padX, box[3] + 2 * padY];
  }
  const aspect = w / h;
  if (box[2] / box[3] > aspect) { const nh = box[2] / aspect; box[1] -= (nh - box[3]) / 2; box[3] = nh; }
  else { const nw = box[3] * aspect; box[0] -= (nw - box[2]) / 2; box[2] = nw; }
  const px = box[2] / w; // map units per screen pixel

  const root = svg("svg", { viewBox: box.map((v) => v.toFixed(1)).join(" "), width: w, height: h, role: "img", "font-family": C.font,
    "aria-label": `Map of Indonesia showing harmonized detections per 0.25 degree cell for ${p.label}${areaIdx >= 0 ? `, zoomed to ${areaName(area)}` : ""}. Use the arrow keys to inspect rendered cells and Enter to select one. The table below lists the most active cells.` });
  root.append(svg("rect", { x: box[0], y: box[1], width: box[2], height: box[3], fill: C.paper }));
  root.append(svg("image", { href: "assets/bluemarble.jpg", x: 0, y: 0, width: FW, height: FH, preserveAspectRatio: "none" }));
  root.append(svg("rect", { x: 0, y: 0, width: FW, height: FH, fill: C.paper, "fill-opacity": 0.5 }));

  const provG = svg("g", { fill: "transparent", stroke: C.ink2, "stroke-opacity": 0.45, "stroke-width": 0.8 * px, "stroke-linejoin": "round" });
  mapData.provinces.provinces.forEach((pr, k) => provG.append(svg("path", { d: pr.path, "data-p": k })));
  root.append(provG);

  const visible = values.filter((d) => d.v >= 0.5);
  const scaleMax = Math.max(1, ...visible.filter((d) => areaIdx < 0 || cells[d.cell][2] === areaIdx).map((d) => d.v));
  const colour = countScale(1, scaleMax);
  const cellG = svg("g");
  const size = 0.25 * fr.scale;
  const cellBox = (cell) => {
    const [lat, lon] = cells[cell];
    return {
      x: +((lon - 0.125 - fr.lon0) * fr.scale).toFixed(1),
      y: +((fr.lat1 - lat - 0.125) * fr.scale).toFixed(1),
      width: size,
      height: size,
    };
  };
  for (const d of visible) {
    const pos = cellBox(d.cell);
    const selected = d.cell === state.mapCell;
    cellG.append(svg("rect", { ...pos,
      fill: colour(d.v), "fill-opacity": areaIdx >= 0 && cells[d.cell][2] !== areaIdx ? 0.35 : 0.92,
      stroke: selected ? C.active : null, "stroke-width": selected ? 2 : null, "vector-effect": selected ? "non-scaling-stroke" : null,
      "data-map-selection": selected ? "" : null, "data-c": d.cell, "data-v": d.v }));
  }
  root.append(cellG);

  if (state.statics) {
    const sg = svg("g", { fill: C.info, stroke: C.paper, "stroke-width": 0.6 * px });
    for (const [lat, lon] of mapData.statics) sg.append(svg("circle", { cx: ((lon - fr.lon0) * fr.scale).toFixed(1), cy: ((fr.lat1 - lat) * fr.scale).toFixed(1), r: 2.2 * px, "pointer-events": "none" }));
    root.append(sg);
  }
  if (areaIdx >= 0) {
    root.append(svg("path", { d: mapData.provinces.provinces.find((pr) => pr.slug === area).path, fill: "none", stroke: C.active, "stroke-width": 2 * px, "stroke-linejoin": "round", "pointer-events": "none" }));
  }
  const hoverProvince = svg("path", { fill: "none", stroke: C.info, "stroke-width": 1.5 * px, "pointer-events": "none", visibility: "hidden" });
  const hoverCell = svg("rect", { fill: "none", stroke: C.ink, "stroke-width": 1.5 * px, "pointer-events": "none", visibility: "hidden" });
  root.append(hoverProvince, hoverCell);

  const provinceActivity = (k) => {
    const ser = D.provinces[k].series;
    return p.months.every((m) => ser[idx(state.year, m)] !== null && ser[idx(state.year, m)] !== undefined)
      ? total(ser, state.year, p.months)
      : null;
  };
  const showCellTip = (d, anchor) => {
    if (!d) {
      hoverCell.setAttribute("visibility", "hidden");
      return hideTip();
    }
    const [lat, lon] = cells[d.cell];
    Object.entries(cellBox(d.cell)).forEach(([k, v]) => hoverCell.setAttribute(k, v));
    hoverCell.setAttribute("visibility", "visible");
    showTip(`${D.provinces[cells[d.cell][2]].name}`, [
      { value: fmt(d.v), label: `VIIRS-equivalent detections, ${p.label}`, colour: colour(d.v), kind: "rect" },
      { value: `${fmtLat(lat)}, ${fmtLon(lon)}`, label: "cell centre" },
      { value: provenance.kind, label: "provenance" },
      { value: p.status === "partial" ? "Partial" : "Available", label: "data status" },
    ], provenance.detail, anchor);
  };
  root.addEventListener("pointermove", (e) => {
    const c = e.target.dataset?.c, pk = c !== undefined ? cells[+c][2] : e.target.dataset?.p;
    if (pk === undefined) {
      hoverProvince.setAttribute("visibility", "hidden");
      hoverCell.setAttribute("visibility", "hidden");
      return hideTip();
    }
    if (c !== undefined) {
      hoverProvince.setAttribute("visibility", "hidden");
      showCellTip({ cell: +c, v: +e.target.dataset.v }, { x: e.clientX, y: e.clientY });
    } else {
      hoverCell.setAttribute("visibility", "hidden");
      hoverProvince.setAttribute("d", mapData.provinces.provinces[+pk].path);
      hoverProvince.setAttribute("visibility", "visible");
      const value = provinceActivity(+pk);
      showTip(D.provinces[+pk].name, [
        { value: value === null ? "N/A" : fmt(value), label: `harmonized detections, ${p.label}` },
        { value: provenance.kind, label: "provenance" },
      ], "Select to update the shared area.", { x: e.clientX, y: e.clientY });
    }
  });
  root.addEventListener("pointerleave", () => {
    hoverProvince.setAttribute("visibility", "hidden");
    hoverCell.setAttribute("visibility", "hidden");
    hideTip();
  });
  root.addEventListener("click", (e) => {
    const c = e.target.dataset?.c, pk = c !== undefined ? cells[+c][2] : e.target.dataset?.p;
    if (c !== undefined && (areaIdx < 0 || +pk === areaIdx)) selectMapCell(+c);
    else if (pk !== undefined) setState({ area: D.provinces[+pk].slug, mapCell: null });
  });
  root.style.cursor = "pointer";
  const keyboardCells = visible.filter((d) => areaIdx < 0 || cells[d.cell][2] === areaIdx);
  if (keyboardCells.length) {
    keyNav(root, keyboardCells.length, {
      start: Math.max(0, keyboardCells.findIndex((d) => d.cell === state.mapCell)),
      onFocus: (k) => k < 0 ? showCellTip(null) : showCellTip(keyboardCells[k], anchorOf(cellG.querySelector(`[data-c="${keyboardCells[k].cell}"]`))),
      onEnter: (k) => selectMapCell(keyboardCells[k].cell),
    });
  }
  chart.replaceChildren(root);

  const extra = areaIdx >= 0 ? [html("span", { class: "legend-item" }, [key(C.active), document.createTextNode("Selected province")])] : [];
  $("#map-reset").hidden = areaIdx < 0;
  if (state.statics) extra.push(html("span", { class: "legend-item" }, [svg("svg", { viewBox: "0 0 14 10", "aria-hidden": "true" }, svg("circle", { cx: 7, cy: 5, r: 3, fill: C.info })), document.createTextNode(`Static heat source, masked from counts (${fmt(mapData.statics.length)})`)]));
  extra.push(html("span", { class: "legend-item", text: "Cells below 0.5 detections are not drawn." }));
  rampLegend(lg, { title: `VIIRS-equivalent detections per cell, ${p.label} · ${provenance.kind}`, stops: C.ramp,
    labels: countLabels(colour, 1, scaleMax), extra });
  const areaValues = values.filter((d) => areaIdx < 0 || cells[d.cell][2] === areaIdx);
  mapData.current = { p, values, areaValues, provenance };
  renderMapInspector({ p, values, provenance });
  renderTopCells(areaValues, p);
}
const fmtLat = (v) => `${Math.abs(v).toFixed(3)}°${v < 0 ? "S" : "N"}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(3)}°E`;
function selectMapCell(cell) {
  state.mapCell = cell;
  const current = mapData.current;
  if (!current || state.view !== "map") return;
  const root = $('[data-card="map"] [data-chart] > svg');
  const previous = $("[data-map-selection]", root);
  if (previous) {
    previous.removeAttribute("data-map-selection");
    previous.removeAttribute("stroke");
    previous.removeAttribute("stroke-width");
    previous.removeAttribute("vector-effect");
  }
  const target = $(`[data-c="${cell}"]`, root);
  if (target) {
    target.setAttribute("stroke", C.active);
    target.setAttribute("stroke-width", 2);
    target.setAttribute("vector-effect", "non-scaling-stroke");
    target.setAttribute("data-map-selection", "");
    target.parentNode.append(target);
  }
  renderMapInspector(current);
  renderTopCells(current.areaValues, current.p);
}
function renderMapInspector({ p, values, provenance }) {
  const card = $('[data-card="map-inspector"]');
  const title = $("#map-inspector-title", card);
  const sub = $("[data-map-inspector-sub]", card);
  const body = $("[data-map-inspector]", card);
  const statusFact = (status) => html("div", {}, [
    html("dt", { text: "Data status" }),
    html("dd", {}, html("span", { class: `status-label status-${status.toLowerCase()}`, text: status })),
  ]);
  const provenanceFact = html("div", {}, [
    html("dt", { text: "Provenance" }),
    html("dd", {}, html("span", { class: `map-source map-source-${provenance.kind.toLowerCase()}`, text: provenance.kind })),
  ]);
  const sourceNote = html("p", { class: "inspector-source", text: `${provenance.detail} Counts represent hotspot detections, not individual fires or burned area.` });

  if (state.mapCell !== null) {
    const [lat, lon, provinceIndex] = mapData.cells[state.mapCell];
    const datum = values.find((d) => d.cell === state.mapCell);
    const available = p.status !== "none" && datum !== undefined;
    const status = !available ? "Unavailable" : p.status === "partial" ? "Partial" : "Complete";
    title.textContent = "Grid cell";
    sub.textContent = D.provinces[provinceIndex].name;
    const facts = html("dl", { class: "inspector-facts map-inspector-facts" }, [
      html("div", { class: "inspector-primary" }, [
        html("dt", { text: "Reported activity" }),
        html("dd", { class: "inspector-value", text: available ? fmt(datum.v) : "N/A" }),
        html("span", { class: "inspector-unit", text: available ? "VIIRS-equivalent hotspot detections" : "No spatial record for this period" }),
      ]),
      html("div", {}, [html("dt", { text: "Cell centre" }), html("dd", { text: `${fmtLat(lat)}, ${fmtLon(lon)}` })]),
      html("div", {}, [html("dt", { text: "Grid resolution" }), html("dd", { text: "0.25° × 0.25°" })]),
      html("div", {}, [html("dt", { text: "Selected period" }), html("dd", { text: p.label })]),
      provenanceFact,
      statusFact(status),
    ]);
    let interpretation;
    if (!available) interpretation = "No spatial record is available for this cell and period. This is not presented as a confirmed zero.";
    else if (p.status === "partial") interpretation = "This value is still being collected and may increase.";
    else if (datum.v < 0.5) interpretation = "Recorded activity is below the map’s 0.5-detection display threshold for this period.";
    else interpretation = "This is the harmonized activity value shown for the selected grid cell and period.";
    body.replaceChildren(
      facts,
      html("p", { class: "inspector-interpretation", text: interpretation }),
      sourceNote,
    );
    return;
  }

  if (state.area !== "indonesia") {
    const province = M.bySlug.get(state.area);
    const ser = series(state.area);
    const available = p.status !== "none" && p.months.every((m) => ser[idx(state.year, m)] !== null && ser[idx(state.year, m)] !== undefined);
    const value = available ? total(ser, state.year, p.months) : null;
    const status = !available ? "Unavailable" : p.status === "partial" ? "Partial" : "Complete";
    title.textContent = province.name;
    sub.textContent = "Province";
    const facts = html("dl", { class: "inspector-facts map-inspector-facts" }, [
      html("div", { class: "inspector-primary" }, [
        html("dt", { text: "Harmonized provincial activity" }),
        html("dd", { class: "inspector-value", text: value === null ? "N/A" : fmt(value) }),
        html("span", { class: "inspector-unit", text: value === null ? "No provincial record for this period" : "VIIRS-equivalent hotspot detections" }),
      ]),
      html("div", {}, [html("dt", { text: "Selected period" }), html("dd", { text: p.label })]),
      provenanceFact,
      statusFact(status),
    ]);
    const params = new URLSearchParams(location.search);
    params.set("view", "history");
    params.set("area", state.area);
    body.replaceChildren(
      facts,
      html("p", { class: "inspector-interpretation", text: available
        ? "This value comes from the existing provincial harmonized series, not a sum of the visible map cells."
        : "No provincial record is available for this period. This is not presented as a confirmed zero." }),
      html("p", { class: "map-limitation", text: "Province boundaries use the dashboard’s existing 34-province geography. Cell display thresholds do not change the provincial value." }),
      sourceNote,
      html("a", { class: "btn btn-small", href: `?${params}`, "data-view-link": "history", text: "Open Historical Analysis" }),
    );
    return;
  }

  title.textContent = "No location selected";
  sub.textContent = p.label;
  body.replaceChildren(html("div", { class: "inspector-empty" }, [
    html("p", { text: "Select a grid cell or province to explore its recorded activity." }),
    html("p", { class: "inspector-source", text: `${provenance.kind}: ${provenance.detail}` }),
  ]));
}
function renderTopCells(values, p) {
  const { chart, sub } = cardEls("topcells");
  const cells = mapData.cells;
  const top = [...values].sort((a, b) => b.v - a.v).slice(0, 10);
  const all = sum(values.map((d) => d.v));
  sub.textContent = `${state.area === "indonesia" ? "Indonesia" : areaName(state.area)}, ${p.label}. ${fmt(values.filter((d) => d.v >= 0.5).length)} cells had detections; the ten below hold ${all ? Math.round((sum(top.map((d) => d.v)) / all) * 100) : 0}% of them.`;
  exporters.topcells = exporters.map;
  if (!top.length) return emptyState(chart, "No detections in this selection", p.status === "none" ? "There is no data for this month yet." : "No cell recorded a detection for this area and period.");
  const table = html("table", { class: "data-table" }, [
    html("thead", {}, html("tr", {}, [html("th", { scope: "col", text: "Rank" }), html("th", { scope: "col", text: "Cell centre" }), html("th", { scope: "col", text: "Province" }), html("th", { scope: "col", class: "num", text: "Detections" }), html("th", { scope: "col", class: "num", text: "Share" }), html("th", { scope: "col", text: "" })])),
    html("tbody", {}, top.map((d, k) => html("tr", { class: d.cell === state.mapCell ? "is-selected" : null }, [
      html("td", { class: "num", text: k + 1 }),
      html("td", { text: `${fmtLat(cells[d.cell][0])}, ${fmtLon(cells[d.cell][1])}` }),
      html("th", { scope: "row", text: D.provinces[cells[d.cell][2]].name }),
      html("td", { class: "num", text: fmt(d.v) }),
      html("td", { class: "num", text: `${all ? ((d.v / all) * 100).toFixed(1) : 0}%` }),
      html("td", {}, html("button", { class: "btn btn-small", type: "button", text: d.cell === state.mapCell ? "Selected" : "Select",
        "aria-pressed": String(d.cell === state.mapCell), "aria-label": `Select cell at ${fmtLat(cells[d.cell][0])}, ${fmtLon(cells[d.cell][1])}`,
        onclick: () => selectMapCell(d.cell) })),
    ]))),
  ]);
  chart.replaceChildren(html("div", { class: "table-wrap" }, table));
}

// ---------- historical analysis ----------
function renderHistory() {
  renderSeries();
  renderAnomaly();
  renderRatio();
}
function renderSeries() {
  const { chart, sub, title, legend: lg, note } = cardEls("series");
  addActions("series");
  const national = state.area === "indonesia";
  const harm = series(state.area);
  const last = M.lastComplete;
  const list = [];
  if (national) {
    list.push({ name: "MODIS raw (Terra and Aqua)", data: D.national.MODIS, colour: C.muted, width: 1.5 });
    list.push({ name: "VIIRS raw (S-NPP)", data: D.national.VIIRS, colour: C.info, width: 1.5 });
  }
  list.push({ name: "Harmonized (VIIRS-equivalent)", data: harm, colour: C.fire, width: 2 });
  title.textContent = national ? "Monthly detections by sensor, 2003 to now" : "Monthly harmonized detections, 2003 to now";
  sub.textContent = `${areaName(state.area)}, ${monthLabel(0)} to ${monthLabel(last)}. The shaded column marks ${state.year}. Click a year to select it.`;
  note.textContent = `${national ? "From February 2012 the harmonized line is the observed VIIRS count, so the two overlap. " : "Raw MODIS and VIIRS series are published for Indonesia as a whole only. "}The band around the model years shows the typical annual error of ±${M.err.toFixed(1)}% from the leave-one-year-out test.${D.meta.lastPartial ? ` ${monthLabel(M.last)} is still being collected and is not drawn.` : ""}`;
  exporters.series = () => [["year", "month", ...list.map((s) => s.name)], ...Array.from({ length: last + 1 }, (_, i) => [M.yearOf(i), M.monthOf(i), ...list.map((s) => s.data[i]?.toFixed(1) ?? "")])];
  legend(lg, [...list].reverse().map((s) => ({ colour: s.colour, label: s.name })));
  lg.append(html("span", { class: "legend-item" }, [svg("svg", { viewBox: "0 0 14 10", "aria-hidden": "true" }, svg("rect", { x: 1, y: 1, width: 12, height: 8, rx: 2, fill: C.fire, "fill-opacity": 0.25 })), document.createTextNode(`Model error band (±${M.err.toFixed(1)}%)`)]));

  const f = frame(chart, 340, { t: 12, r: 14, b: 26, l: 52 }, `Line chart of monthly detections for ${areaName(state.area)} from ${M.y0}. Use the arrow keys to move by month, with Shift to move by year.`);
  const max = Math.max(1, ...list.flatMap((s) => s.data.slice(0, last + 1).filter((v) => v !== null)));
  const yT = ticks(0, max, 4);
  const x = (i) => f.m.l + (i / last) * f.iw;
  const y = (v) => f.m.t + f.ih - (v / yT.at(-1)) * f.ih;
  const sy = idx(state.year, 1);
  f.root.append(svg("rect", { x: x(sy), y: f.m.t, width: Math.max(2, x(Math.min(last, sy + 11)) - x(sy)), height: f.ih, fill: C.raised }));
  f.root.append(yAxis(f, y, yT));
  const every = f.iw < 500 ? 4 : f.iw < 900 ? 2 : 1;
  for (let yr = M.y0; yr <= M.yearOf(last); yr++) if ((yr - M.y0) % every === 0) f.root.append(text(x(idx(yr, 1)), f.h - 8, yr, { "text-anchor": "start", fill: yr === state.year ? C.ink : C.muted, "font-size": 11 }));
  const e = M.err / 100;
  const ml = Math.min(M.modelLast, last);
  f.root.append(svg("path", { d: `M${Array.from({ length: ml + 1 }, (_, i) => `${x(i)},${y(harm[i] * (1 + e))}`).join("L")}L${Array.from({ length: ml + 1 }, (_, k) => ml - k).map((i) => `${x(i)},${y(harm[i] * (1 - e))}`).join("L")}Z`, fill: C.fire, "fill-opacity": 0.22 }));
  for (const s of list) {
    let d = "", pen = false;
    for (let i = 0; i <= last; i++) { const v = s.data[i]; if (v === null || v === undefined) { pen = false; continue; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }
    f.root.append(svg("path", { d, fill: "none", stroke: s.colour, "stroke-width": s.width, "stroke-linejoin": "round" }));
  }
  const cross = svg("line", { y1: f.m.t, y2: f.m.t + f.ih, stroke: C.ink2, "stroke-width": 1, visibility: "hidden" });
  const dots = list.map((s) => svg("circle", { r: 4, fill: s.colour, stroke: C.card, "stroke-width": 2, visibility: "hidden" }));
  f.root.append(cross, ...dots);
  const show = (i, anchor) => {
    if (i < 0) { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); return hideTip(); }
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    list.forEach((s, k) => { const v = s.data[i]; if (v === null || v === undefined) dots[k].setAttribute("visibility", "hidden"); else { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v)); dots[k].setAttribute("visibility", "visible"); } });
    showTip(monthLabel(i), [...list].reverse().map((s) => ({ value: s.data[i] === null || s.data[i] === undefined ? "not flying" : fmt(s.data[i]), label: s.name.split(" (")[0], colour: s.colour })),
      isModel(i) ? `Harmonized value is a model estimate (±${M.err.toFixed(1)}% typical annual error)` : "Harmonized value is the observed VIIRS count",
      anchor ?? { x: f.root.getBoundingClientRect().left + x(i), y: f.root.getBoundingClientRect().top + y(Math.max(...list.map((s) => s.data[i] ?? 0))) });
  };
  const hit = svg("rect", { x: f.m.l, y: f.m.t, width: f.iw, height: f.ih, fill: "transparent", cursor: "pointer" });
  const pointIdx = (e) => { const r = f.root.getBoundingClientRect(); return clamp(Math.round((((e.clientX - r.left) * (f.w / r.width)) - f.m.l) / f.iw * last), 0, last); };
  hit.addEventListener("pointermove", (ev) => show(pointIdx(ev), { x: ev.clientX, y: ev.clientY }));
  hit.addEventListener("pointerleave", () => show(-1));
  hit.addEventListener("click", (ev) => { const i = pointIdx(ev); setState({ year: M.yearOf(i), month: M.monthOf(i) }); });
  f.root.append(hit);
  keyNav(f.root, last + 1, { start: Math.min(last, idx(state.year, state.month || 1)), onFocus: (i) => show(i), onEnter: (i) => setState({ year: M.yearOf(i), month: M.monthOf(i) }) });
  chart.replaceChildren(f.root);
}

function renderAnomaly() {
  const { chart, sub, title, legend: lg } = cardEls("anomaly");
  addActions("anomaly");
  const ser = series(state.area);
  const p = period();
  const months = p.months;
  const c = compare(ser, state.year, months);
  const data = c.totals.map((t) => ({ ...t, diff: c.median > 0 ? ((t.value - c.median) / c.median) * 100 : 0 }));
  title.textContent = `Each year against the median${p.span === "Annual" ? "" : `, ${p.span}`}`;
  sub.textContent = `${areaName(state.area)}. Difference from the ${baseLabel()} median of ${fmt(c.median)} detections.${p.status !== "ok" ? ` ${p.label} is not complete, so it is not shown.` : ""}`;
  exporters.anomaly = () => [["year", "detections", "median", "difference_pct"], ...data.map((d) => [d.year, d.value.toFixed(1), c.median?.toFixed(1), d.diff.toFixed(1)])];
  legend(lg, [{ colour: C.fire, label: "Above the median", kind: "rect" }, { colour: C.cool[2], label: "Below the median", kind: "rect" }]);
  if (!data.length || c.median === null || c.median <= 0) { exporters.anomaly = null; return emptyState(chart, "Too few detections to compare", "This area has no detections in the median years for these months."); }

  const f = frame(chart, 280, { t: 12, r: 10, b: 26, l: 52 }, `Bar chart of each year's difference from the median for ${areaName(state.area)}`);
  const lo = Math.min(0, ...data.map((d) => d.diff)), hi = Math.max(0, ...data.map((d) => d.diff));
  const yT = ticks(lo, hi, 4);
  const y0v = yT[0], y1v = yT.at(-1);
  const y = (v) => f.m.t + f.ih - ((v - y0v) / (y1v - y0v)) * f.ih;
  f.root.append(yAxis(f, y, yT, (t) => (t === 0 ? "0" : pct(t))));
  const band = f.iw / data.length, bw = Math.max(2, Math.min(22, band - 3));
  const marks = svg("g"), hits = svg("g");
  data.forEach((d, k) => {
    const xx = f.m.l + k * band + (band - bw) / 2;
    const sel = d.year === state.year;
    const up = d.diff >= 0;
    const fill = up ? (sel ? C.fire : C.ramp[2]) : (sel ? C.cool[2] : C.cool[1]);
    marks.append(svg("path", { d: up ? barPath(xx, y(d.diff), bw, y(0) - y(d.diff)) : barPathDown(xx, y(0), bw, y(d.diff) - y(0)), fill, "data-k": k }));
    const yl = yearLabels(band);
    if ((d.year - data[0].year) % yl.every === 0) f.root.append(text(xx + bw / 2, f.h - 8, yl.label(d.year), { "text-anchor": "middle", fill: sel ? C.ink : C.muted, "font-size": 11, "font-weight": sel ? 600 : 400 }));
    hits.append(svg("rect", { x: f.m.l + k * band, y: f.m.t, width: band, height: f.ih, fill: "transparent", "data-k": k, cursor: "pointer" }));
  });
  f.root.append(marks, hits);
  const show = (k, anchor) => {
    if (k < 0) return hideTip();
    const d = data[k];
    showTip(`${p.span === "Annual" ? "" : `${p.span} `}${d.year}`, [{ value: pct(d.diff), label: "against the median", colour: d.diff >= 0 ? C.fire : C.cool[2], kind: "rect" }, { value: fmt(d.value), label: "detections" }], null, anchor ?? anchorOf(hits.children[k]));
  };
  hits.addEventListener("pointermove", (e) => { const k = +e.target.dataset.k; if (!Number.isNaN(k)) show(k, { x: e.clientX, y: e.clientY }); });
  hits.addEventListener("pointerleave", () => hideTip());
  hits.addEventListener("click", (e) => { const k = +e.target.dataset.k; if (!Number.isNaN(k)) setState({ year: data[k].year }); });
  keyNav(f.root, data.length, { start: Math.max(0, data.findIndex((d) => d.year === state.year)), onFocus: (k) => show(k), onEnter: (k) => setState({ year: data[k].year }) });
  chart.replaceChildren(f.root);
}

function renderRatio() {
  const { chart, sub, note } = cardEls("ratio");
  addActions("ratio");
  const first = D.national.VIIRS.findIndex((v) => v !== null && v !== undefined);
  const start = first + 1; // the first VIIRS month is partial, so it is left out
  const data = M.completeYears.filter((y) => idx(y, 12) >= start).map((y) => {
    const ms = MONTHS.map((_, k) => idx(y, k + 1)).filter((i) => i >= start);
    const v = sum(ms.map((i) => D.national.VIIRS[i] ?? 0)), mo = sum(ms.map((i) => D.national.MODIS[i] ?? 0));
    return { year: y, ratio: mo > 0 ? v / mo : null, viirs: v, modis: mo, from: M.monthOf(ms[0]) };
  }).filter((d) => d.ratio !== null);
  const lo = data.reduce((a, d) => (d.ratio < a.ratio ? d : a), data[0]), hi = data.reduce((a, d) => (d.ratio > a.ratio ? d : a), data[0]);
  sub.textContent = `Indonesia. VIIRS detections for every MODIS detection, by year. It ranges from ${lo.ratio.toFixed(1)} in ${lo.year} to ${hi.ratio.toFixed(1)} in ${hi.year}, so no single factor converts one sensor to the other.`;
  note.textContent = `${data[0].year} counts start in ${MONTHS_LONG[data[0].from - 1]}, the first full month of VIIRS data. Complete years only.`;
  exporters.ratio = () => [["year", "viirs_detections", "modis_detections", "viirs_per_modis"], ...data.map((d) => [d.year, d.viirs.toFixed(0), d.modis.toFixed(0), d.ratio.toFixed(3)])];
  const f = frame(chart, 280, { t: 22, r: 10, b: 26, l: 40 }, `Bar chart of VIIRS detections per MODIS detection by year, ${data[0].year} to ${data.at(-1).year}`);
  const yT = ticks(0, hi.ratio * 1.1, 4);
  const y = (v) => f.m.t + f.ih - (v / yT.at(-1)) * f.ih;
  f.root.append(yAxis(f, y, yT, (t) => `${t}×`));
  const band = f.iw / data.length, bw = Math.max(2, Math.min(22, band - 3));
  const hits = svg("g");
  data.forEach((d, k) => {
    const xx = f.m.l + k * band + (band - bw) / 2;
    f.root.append(svg("path", { d: barPath(xx, y(d.ratio), bw, y(0) - y(d.ratio)), fill: C.info, "fill-opacity": d === lo || d === hi ? 1 : 0.6 }));
    if (d === lo || d === hi) f.root.append(text(xx + bw / 2, y(d.ratio) - 6, d.ratio.toFixed(1), { "text-anchor": "middle", fill: C.ink, "font-size": 11, "font-weight": 600 }));
    const yl = yearLabels(band);
    if ((d.year - data[0].year) % yl.every === 0) f.root.append(text(xx + bw / 2, f.h - 8, yl.label(d.year), { "text-anchor": "middle", fill: C.muted, "font-size": 11 }));
    hits.append(svg("rect", { x: f.m.l + k * band, y: f.m.t, width: band, height: f.ih, fill: "transparent", "data-k": k }));
  });
  f.root.append(hits);
  const show = (k, anchor) => { if (k < 0) return hideTip(); const d = data[k]; showTip(String(d.year), [{ value: `${d.ratio.toFixed(2)}×`, label: "VIIRS per MODIS", colour: C.info, kind: "rect" }, { value: fmt(d.viirs), label: "VIIRS" }, { value: fmt(d.modis), label: "MODIS" }], null, anchor ?? anchorOf(hits.children[k])); };
  hits.addEventListener("pointermove", (e) => { const k = +e.target.dataset.k; if (!Number.isNaN(k)) show(k, { x: e.clientX, y: e.clientY }); });
  hits.addEventListener("pointerleave", hideTip);
  keyNav(f.root, data.length, { onFocus: (k) => show(k) });
  chart.replaceChildren(f.root);
}

// ---------- priority watchlist ----------
const PRIORITY = {
  high: { label: "High anomaly", order: 0, cls: "badge-high", shape: '<path d="M6 1 11 10H1Z"/>' },
  watch: { label: "Elevated", order: 1, cls: "badge-watch", shape: '<rect x="2" y="2" width="8" height="8" rx="1"/>' },
  typical: { label: "Within baseline", order: 2, cls: "badge-typical", shape: '<circle cx="6" cy="6" r="4"/>' },
  low: { label: "Low activity volume", order: 3, cls: "badge-low", shape: '<path d="M2 6h8" stroke="currentColor" stroke-width="2"/>' },
};
const LOW_VOLUME = 100; // detections; below this in both the period and its median, a ratio is noise
function classify(c) {
  if (c.value < LOW_VOLUME && (c.median ?? 0) < LOW_VOLUME) return "low";
  if (c.median > 0 && c.value >= 2 * c.median && c.rank <= 3) return "high";
  if (c.median > 0 && c.value >= 1.5 * c.median) return "watch";
  if (!(c.median > 0)) return "low";
  return "typical";
}
function sparkline(ser, meds) {
  const w = 112, h = 30;
  const vals = MONTHS.map((_, k) => (idx(state.year, k + 1) <= M.lastComplete ? ser[idx(state.year, k + 1)] : null));
  const max = Math.max(1, ...meds, ...vals.filter((v) => v !== null));
  const x = (k) => 2 + (k / 11) * (w - 4), y = (v) => h - 3 - (v / max) * (h - 6);
  const line = (arr) => { let d = "", pen = false; arr.forEach((v, k) => { if (v === null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return d; };
  return svg("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h, "aria-hidden": "true" }, [
    svg("path", { d: line(meds), fill: "none", stroke: C.muted, "stroke-width": 1.5 }),
    svg("path", { d: line(vals), fill: "none", stroke: C.fire, "stroke-width": 2, "stroke-linejoin": "round" }),
  ]);
}
let watchSelection = null;
let watchAreaShown = null; // the area the Watchlist last drew, to scroll to the row only when it changes
function watchBadge(category) {
  const pri = PRIORITY[category];
  const badge = html("span", { class: `badge ${pri.cls}` });
  badge.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${pri.shape}</svg>`;
  badge.append(document.createTextNode(pri.label));
  return badge;
}
function renderWatchInspector(row, p) {
  const panel = $("#watch-inspector");
  panel.hidden = !row;
  if (!row) return;
  const { pr, c, pri, excess, share } = row;
  const explanations = {
    high: "This province meets the High anomaly screening rule because its activity is at least twice its historical median and ranks among its three highest comparable periods.",
    watch: "This province meets the Elevated screening rule because its activity is at least 1.5 times its historical median, after the low-volume and High anomaly rules are evaluated.",
    typical: "This province is Within baseline because it does not meet the elevated screening thresholds and has a positive historical median. This label does not mean no physical fires occurred.",
    low: c.value < LOW_VOLUME && (c.median ?? 0) < LOW_VOLUME
      ? `This province has Low activity volume because both its activity and historical median are below ${LOW_VOLUME} detections, so a relative comparison may be misleading.`
      : "This province has Low activity volume because its historical median is nonpositive or unavailable, so a percentage comparison is not supported.",
  };
  const metric = (label, value) => html("div", {}, [html("dt", { text: label }), html("dd", { text: value })]);
  const investigate = (view, label) => {
    const params = new URLSearchParams(location.search);
    params.set("view", view); params.set("area", pr.slug);
    return html("a", { class: "btn btn-small", href: `?${params}`, text: label,
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        setState({ area: pr.slug, view }, { push: true });
        $("#main").focus({ preventScroll: true });
        scrollTo({ top: 0 });
      } });
  };
  $("#watch-inspector-content").replaceChildren(
    html("p", { class: "eyebrow", text: "Selected province" }),
    html("h3", { id: "watch-inspector-title", text: pr.name }),
    html("p", { class: "card-sub", text: p.label }),
    watchBadge(pri),
    html("p", { class: "watch-explanation", text: explanations[pri] }),
    html("dl", { class: "watch-metrics" }, [
      metric("Harmonized activity", `${fmt(c.value)} VIIRS-equivalent detections`),
      metric("Historical median", `${fmt(c.median)} detections`),
      metric("Absolute difference", `${excess > 0 ? "+" : ""}${fmt(excess)} detections`),
      metric("Difference from median", c.diff === null ? "Not available: no positive median" : pct(c.diff)),
      metric("Historical rank", `${ordinal(c.rank)} of ${c.of} comparable periods`),
      metric("Share of Indonesia", `${share.toFixed(1)}%`),
    ]),
    html("p", { class: "card-note", text: `Baseline: the same months in complete years, ${baseLabel()}. ${spatialProvenance(p).detail}` }),
    html("div", { class: "watch-investigate" }, [investigate("calendar", "Explore Activity Calendar"), investigate("map", "Explore Fire Map")]),
  );
}
function renderWatchlist() {
  const { chart, sub, title, card } = cardEls("watch");
  addActions("watch", { png: false });
  const p = period();
  // the selected province follows the Area filter (and a clicked row sets the filter, see below)
  watchSelection = state.area === "indonesia" ? null : state.area;
  const areaChanged = state.area !== watchAreaShown;
  watchAreaShown = state.area;
  title.textContent = "Priority Watchlist";
  sub.textContent = `${p.label} · ${D.provinces.length} provinces · Baseline: the same months in complete years, ${baseLabel()}. ${spatialProvenance(p).detail}`;
  $("#watch-rules").replaceChildren(...[
    `Low activity volume safeguard: first, activity below ${LOW_VOLUME} and median below ${LOW_VOLUME} are classified as low volume.`,
    "High anomaly: with a positive median, activity at least twice that median and a rank among the three highest comparable periods.",
    "Elevated: with a positive median, activity at least 1.5 times that median if the preceding rules do not apply.",
    "Low activity volume fallback: any remaining period without a positive median.",
    "Within baseline: all remaining periods, which do not meet the elevated thresholds.",
  ].map((text) => html("li", { text })));
  $("#watch-sort").value = state.sort;
  const counts = $("[data-counts]", card);
  if (p.status !== "ok") {
    counts.textContent = "";
    exporters.watch = null;
    renderWatchInspector(null, p);
    return emptyState(chart, p.status === "partial" ? `${p.label} is still being collected` : `No data for ${p.label} yet`,
      "The watchlist compares complete months only, so the ranking is fair to every year.", lastCompleteAction());
  }
  const nationalTotal = sum(D.provinces.map((pr) => total(pr.series, state.year, p.months)));
  const rows = D.provinces.map((pr) => {
    const c = compare(pr.series, state.year, p.months);
    return { pr, c, pri: classify(c), excess: c.value - (c.median ?? 0), share: nationalTotal ? (c.value / nationalTotal) * 100 : 0 };
  });
  const sorters = {
    priority: (a, b) => PRIORITY[a.pri].order - PRIORITY[b.pri].order || b.excess - a.excess,
    excess: (a, b) => b.excess - a.excess,
    diff: (a, b) => (b.c.diff ?? -Infinity) - (a.c.diff ?? -Infinity),
    value: (a, b) => b.c.value - a.c.value,
    name: (a, b) => a.pr.name.localeCompare(b.pr.name),
  };
  rows.sort(sorters[state.sort] ?? sorters.priority);
  const tally = Object.keys(PRIORITY).map((k) => `${rows.filter((r) => r.pri === k).length} ${PRIORITY[k].label.toLowerCase()}`);
  counts.textContent = `${tally.join(", ")}.`;
  exporters.watch = () => [["province", "priority", "detections", "median", "difference_pct", "rank", "years_compared", "share_of_indonesia_pct", "period"],
    ...rows.map((r) => [r.pr.name, ({ high: "High", watch: "Watch", typical: "Typical", low: "Low volume" })[r.pri], r.c.value.toFixed(1), r.c.median?.toFixed(1), r.c.diff?.toFixed(1) ?? "", r.c.rank, r.c.of, r.share.toFixed(1), p.label])];

  const head = ["Province", "Screening indicator", "Selected-period activity", "Historical median", "Difference from median", `${state.year} by month`];
  const numCols = new Set([2, 3, 4]);
  const table = html("table", { class: "data-table watch-table" }, [
    html("caption", { class: "visually-hidden", text: `Provinces ranked for ${p.label}` }),
    html("thead", {}, html("tr", {}, head.map((hd, k) => html("th", { scope: "col", class: numCols.has(k) ? "num" : null, text: hd })))),
    html("tbody", {}, rows.map((r) => {
      const line = sparkline(r.pr.series, monthMedians(r.pr.series));
      const monthlyText = MONTHS.map((m, k) => {
        const i = idx(state.year, k + 1), v = r.pr.series[i];
        return `${m}: ${i > M.lastComplete || v === null || v === undefined ? "no complete data" : fmt(v)} detections`;
      }).join("; ");
      const row = html("tr", { "data-province": r.pr.slug, class: r.pr.slug === watchSelection ? "is-selected" : null }, [
        html("th", { scope: "row" }, html("button", { type: "button", class: "watch-province", text: r.pr.name,
          "aria-controls": "watch-inspector", "aria-pressed": String(r.pr.slug === watchSelection), "aria-label": `Inspect ${r.pr.name}` })),
        html("td", {}, watchBadge(r.pri)),
        html("td", { class: "num", text: fmt(r.c.value) }),
        html("td", { class: "num", text: fmt(r.c.median) }),
        html("td", { class: "num", text: r.c.median > 0 ? pct(r.c.diff) : "no median" }),
        html("td", { class: "watch-spark", title: `${r.pr.name}, ${state.year}. ${monthlyText}` }, [
          line, html("span", { class: "visually-hidden", text: `${state.year}, ${monthlyText}. Grey line: ${baseLabel()} monthly historical median.` }),
        ]),
      ]);
      row.addEventListener("click", () => {
        watchSelection = r.pr.slug;
        if (state.area !== r.pr.slug) {
          // same effect as choosing the province in the filter, without redrawing the table
          state.area = r.pr.slug;
          state.mapCell = null;
          watchAreaShown = r.pr.slug;
          writeURL();
          syncFilters();
        }
        for (const el of $$("tbody tr", table)) {
          const selected = el.dataset.province === watchSelection;
          el.classList.toggle("is-selected", selected);
          $("button", el).setAttribute("aria-pressed", String(selected));
        }
        renderWatchInspector(r, p);
      });
      return row;
    })),
  ]);
  chart.replaceChildren(html("div", { class: "table-wrap" }, table),
    html("p", { class: "card-note", text: `Sparklines: ${state.year} by month in orange, the ${baseLabel()} monthly median in grey.` }));
  renderWatchInspector(rows.find((r) => r.pr.slug === watchSelection), p);
  // when the filter chose the province, bring its row into view
  if (areaChanged && watchSelection) {
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    $("tbody tr.is-selected", table)?.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  }
}

// ---------- about ----------
function renderAbout() {
  $("#about-static").textContent = `${fmt(D.meta.staticSourceCells)} static heat-source cells are masked from every count. Show them on the Fire map with the "Show masked static heat sources" option.`;
  $("#about-provinces").textContent = `Each 0.25° cell is assigned to the province that contains its centre. Coastal cells whose centre falls just offshore of the simplified outlines (${D.meta.outsideDetectionSharePct}% of detections) go to the nearest province.`;
  $("#about-model").textContent = `${monthLabel(0)} to ${monthLabel(M.modelLast)} are model estimates from MODIS; later months are the observed VIIRS S-NPP count. The model is a 50/50 blend of a single VIIRS-to-MODIS ratio model and a LightGBM Tweedie model.`;
  const { chart, legend: lg, card } = cardEls("loyo");
  addActions("loyo");
  const data = D.loyo.years;
  exporters.loyo = () => [["year", "real_viirs", "ratio_bias_pct", "lightgbm_bias_pct", "blend_bias_pct"], ...data.map((d) => [d.year, d.viirs, d.ratio, d.lightgbm, d.blend])];
  legend(lg, [{ colour: C.info, label: "Final model (blend) error for the hidden year", kind: "rect" }]);
  lg.append(html("span", { class: "legend-item" }, [svg("svg", { viewBox: "0 0 14 10", "aria-hidden": "true" }, svg("rect", { x: 1, y: 1, width: 12, height: 8, rx: 2, fill: C.ink2, "fill-opacity": 0.18 })), document.createTextNode(`Typical error, ±${M.err.toFixed(1)}%`)]));
  const f = frame(chart, 260, { t: 12, r: 10, b: 26, l: 44 }, "Bar chart of the final model's annual error for each hidden year, 2012 to 2026");
  const lim = Math.max(...data.map((d) => Math.abs(d.blend))) * 1.15;
  const yT = ticks(-lim, lim, 4);
  const y = (v) => f.m.t + f.ih - ((v - yT[0]) / (yT.at(-1) - yT[0])) * f.ih;
  f.root.append(svg("rect", { x: f.m.l, y: y(M.err), width: f.iw, height: y(-M.err) - y(M.err), fill: C.ink2, "fill-opacity": 0.12 }));
  f.root.append(yAxis(f, y, yT, (t) => (t === 0 ? "0" : pct(t))));
  const band = f.iw / data.length, bw = Math.max(2, Math.min(22, band - 3));
  const hits = svg("g");
  data.forEach((d, k) => {
    const xx = f.m.l + k * band + (band - bw) / 2;
    f.root.append(svg("path", { d: d.blend >= 0 ? barPath(xx, y(d.blend), bw, y(0) - y(d.blend)) : barPathDown(xx, y(0), bw, y(d.blend) - y(0)), fill: C.info }));
    const yl = yearLabels(band);
    if ((d.year - data[0].year) % yl.every === 0) f.root.append(text(xx + bw / 2, f.h - 8, yl.label(d.year), { "text-anchor": "middle", fill: C.muted, "font-size": 11 }));
    hits.append(svg("rect", { x: f.m.l + k * band, y: f.m.t, width: band, height: f.ih, fill: "transparent", "data-k": k }));
  });
  f.root.append(hits);
  const show = (k, anchor) => { if (k < 0) return hideTip(); const d = data[k]; showTip(`${d.year} hidden`, [{ value: pct(d.blend, 1), label: "final model", colour: C.info, kind: "rect" }, { value: pct(d.ratio, 1), label: "ratio alone" }, { value: pct(d.lightgbm, 1), label: "LightGBM alone" }, { value: fmt(d.viirs), label: "real VIIRS detections" }], null, anchor ?? anchorOf(hits.children[k])); };
  hits.addEventListener("pointermove", (e) => { const k = +e.target.dataset.k; if (!Number.isNaN(k)) show(k, { x: e.clientX, y: e.clientY }); });
  hits.addEventListener("pointerleave", hideTip);
  keyNav(f.root, data.length, { onFocus: (k) => show(k) });
  chart.replaceChildren(f.root);

  const summary = $("[data-summary]", card);
  if (!summary.childElementCount) {
    summary.append(html("table", { class: "data-table" }, [
      html("thead", {}, html("tr", {}, ["Model", "Typical annual error", "Worst year", "Monthly error (MAPE)"].map((hd, k) => html("th", { scope: "col", class: k ? "num" : null, text: hd })))),
      html("tbody", {}, D.loyo.summary.map((s) => html("tr", {}, [
        html("th", { scope: "row", text: s.model.startsWith("Blend") ? "Blend 50/50 (final)" : s.model }),
        html("td", { class: "num", text: `${s.meanAbsAnnualBiasPct.toFixed(1)}%` }),
        html("td", { class: "num", text: pct(s.worstAnnualBiasPct, 1) }),
        html("td", { class: "num", text: `${s.monthlyMapePct.toFixed(1)}%` }),
      ]))),
    ]));
  }
}

// ---------- boot ----------
function showLoadError() {
  const view = new URLSearchParams(location.search).get("view");
  for (const sec of $$("[data-view]")) sec.hidden = sec.dataset.view !== (VIEWS[view] ? view : "overview");
  $("#data-status").textContent = "Data unavailable";
  const kpis = $("#kpis");
  kpis.replaceChildren();
  for (const chart of $$("[data-chart]")) {
    emptyState(chart, "The dashboard data did not load", "The file data/dashboard.json could not be read. Check your connection, then try again.", { label: "Try again", run: boot });
    chart.firstChild.classList.add("is-error");
  }
}
async function boot() {
  readTokens();
  try {
    const res = await fetch("data/dashboard.json");
    if (!res.ok) throw new Error(res.status);
    D = await res.json();
  } catch {
    showLoadError();
    return;
  }
  M = derive(D);
  readURL();
  buildFilters();
  syncFilters();
  $("#data-status").textContent = `Data through ${monthLabel(M.lastComplete)}${D.meta.lastPartial ? `, ${MONTHS_LONG[M.monthOf(M.last) - 1]} in progress` : ""}`;
  if (!wired) wire();
  render();
}
let wired = false;
/** Event wiring that must happen once, even if boot runs again after a failed load. */
function wire() {
  wired = true;
  $("#f-area").addEventListener("change", (e) => setState({ area: e.target.value }));
  $("#f-year").addEventListener("change", (e) => setState({ year: +e.target.value }));
  $("#f-month").addEventListener("change", (e) => setState({ month: +e.target.value }));
  $("#f-reset").addEventListener("click", () => setState({ area: "indonesia", year: M.curYear, month: 0 }));
  for (const b of $$("[data-calmode]")) b.addEventListener("click", () => setState({ calMode: b.dataset.calmode }));
  $("#map-static").addEventListener("change", (e) => setState({ statics: e.target.checked }));
  $("#map-reset").addEventListener("click", () => setState({ area: "indonesia" }));
  $("#watch-sort").addEventListener("change", (e) => setState({ sort: e.target.value }));
  let width = $("#main").clientWidth, timer;
  new ResizeObserver(() => {
    const nw = $("#main").clientWidth;
    if (Math.abs(nw - width) < 4) return;
    width = nw;
    clearTimeout(timer);
    timer = setTimeout(render, 120);
  }).observe($("#main"));
}
setupShell();
boot();
