/* Haze Outlook page.
 *
 * Data sources:
 *   data/active_fires.json  recent VIIRS detections (built by haze/fetch_active_fires.py)
 *   data/haze_risk.json     monthly risk index since 2003 (built by haze/build_haze_risk.py)
 *   Open-Meteo forecast     wind at 850 hPa and 10 m (loaded in the browser, no key)
 *   Open-Meteo air quality  PM2.5 forecast from CAMS (loaded in the browser, no key)
 *
 * Each render function takes no arguments except where noted and only touches its own part
 * of the page, so they can be ported to components later. The shared data lives in `app`,
 * the selections in `state`.
 */
(function () {
  'use strict';

  // ---------- configuration ----------

  var RISK_URL = 'data/haze_risk.json';
  var FIRES_URL = 'data/active_fires.json';
  var WIND_API = 'https://api.open-meteo.com/v1/forecast';
  var AQ_API = 'https://air-quality-api.open-meteo.com/v1/air-quality';
  var TIMEZONE = 'Asia%2FSingapore';
  var FORECAST_DAYS = 5;
  var REQUEST_TIMEOUT_MS = 15000;

  var CITIES = {
    singapore: { name: 'Singapore', latlng: [1.35, 103.82] },
    kuala_lumpur: { name: 'Kuala Lumpur', latlng: [3.14, 101.69] }
  };

  // Upwind sector: where the wind blows FROM, plus or minus this angle
  var SECTOR_HALF_ANGLE = 30;
  var UPWIND_RADIUS_KM = 1500;
  var MIN_DISTANCE_KM = 25;            // closer cells are treated as 25 km away
  var MIN_RELIABLE_WIND = 1.0;         // m/s: weaker daily mean wind has no reliable direction
  // Upwind source score = sum over upwind cells of FRP (MW) x 100 km / distance (km).
  // At or above this value the day level is raised one step. Rough, hand-picked threshold.
  var UPWIND_HIGH_SCORE = 2000;

  // PM2.5 bands in ug/m3, approximate, for communication only
  var PM_BANDS = [
    { name: 'Low', max: 25 },
    { name: 'Moderate', max: 50 },
    { name: 'High', max: 100 },
    { name: 'Very high', max: Infinity }
  ];

  var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var SCOPE_LABELS = { both: 'Sumatra + Kalimantan', sumatra: 'Sumatra', kalimantan: 'Kalimantan' };
  var SOURCE_LABELS = {
    model: 'Harmonized model estimate',
    viirs: 'VIIRS',
    nrt: 'VIIRS near real time'
  };
  var MIN_CELL_VALUE = 1;              // season map: hide cells with less than one hotspot
  var CELL_SIZE = 0.25;

  // Schematic southwest monsoon flow for the season map
  var MONSOON_ARROWS = [
    { from: [-2.6, 101.2], to: [0.2, 103.2] },
    { from: [-2.0, 110.6], to: [0.7, 106.4] }
  ];

  // ---------- shared data and selections ----------

  var app = {
    risk: null,        // haze_risk.json
    fires: null,       // active_fires.json
    forecast: {},      // city key -> { days: [...] } (null when the forecast failed)
    notes: [],         // discreet warnings shown at the top
    geo: {}            // city key -> distance and bearing of every fire cell
  };
  var state = {
    city: 'singapore',
    day: 1,                                   // 0 = today, 1 = tomorrow
    hist: { year: null, month: null, scope: 'both' }
  };

  var map = null, cellLayer = null, overlayLayer = null, cityMarkers = {};
  var histMap = null, histLayer = null, chart = null, histReady = false;

  // ---------- small helpers ----------

  function $(id) { return document.getElementById(id); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }
  function levelColor(level) { return cssVar('--lvl-' + level); }
  function compass(deg) { return COMPASS[Math.round(deg / 22.5) % 16]; }

  function note(message) { app.notes.push(message); }

  /** GET a JSON file. Network errors and timeouts are retried once (not HTTP errors such as 404). */
  function fetchJson(url, retried) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(url, { signal: ctrl.signal }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.json();
    }, function (err) {
      clearTimeout(timer);
      if (retried) { throw err; }
      return new Promise(function (resolve) { setTimeout(resolve, 800); })
        .then(function () { return fetchJson(url, true); });
    });
  }

  /** Great-circle distance in km. */
  function haversineKm(a, b) {
    var dLat = toRad(b[0] - a[0]);
    var dLon = toRad(b[1] - a[1]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  /** Initial bearing from a to b in degrees clockwise from north. */
  function bearingDeg(a, b) {
    var p1 = toRad(a[0]), p2 = toRad(b[0]), dl = toRad(b[1] - a[1]);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** Point at a distance (km) and bearing from a start point. */
  function destination(ll, bearing, km) {
    var d = km / 6371, b = toRad(bearing), lat1 = toRad(ll[0]), lon1 = toRad(ll[1]);
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
    var lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return [toDeg(lat2), toDeg(lon2)];
  }

  /** Smallest absolute difference between two bearings. */
  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function dayLabel(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // ---------- forecast loading and daily summaries ----------

  function windUrl(city) {
    return WIND_API + '?latitude=' + city.latlng[0] + '&longitude=' + city.latlng[1] +
      '&hourly=wind_speed_10m,wind_direction_10m,wind_speed_850hPa,wind_direction_850hPa' +
      '&forecast_days=' + FORECAST_DAYS + '&timezone=' + TIMEZONE + '&wind_speed_unit=ms';
  }

  function aqUrl(city) {
    return AQ_API + '?latitude=' + city.latlng[0] + '&longitude=' + city.latlng[1] +
      '&hourly=pm2_5&forecast_days=' + FORECAST_DAYS + '&timezone=' + TIMEZONE;
  }

  /** Vector mean of the hourly wind (not a mean of angles). Direction is where the wind blows FROM. */
  function vectorMean(speeds, dirs, idxs) {
    var u = 0, v = 0, n = 0;
    idxs.forEach(function (i) {
      var s = speeds[i], d = dirs[i];
      if (s === null || s === undefined || d === null || d === undefined) { return; }
      u += -s * Math.sin(toRad(d));
      v += -s * Math.cos(toRad(d));
      n++;
    });
    if (!n) { return null; }
    u /= n; v /= n;
    var speed = Math.hypot(u, v);
    return {
      dirFrom: (toDeg(Math.atan2(-u, -v)) + 360) % 360,
      speed: speed,
      reliable: speed >= MIN_RELIABLE_WIND
    };
  }

  function meanOf(values, idxs) {
    var sum = 0, n = 0;
    idxs.forEach(function (i) {
      if (values[i] !== null && values[i] !== undefined) { sum += values[i]; n++; }
    });
    return n ? sum / n : null;
  }

  /** One entry per local day with wind at 850 hPa and 10 m, and the mean PM2.5. */
  function buildDays(wind, aq) {
    var times = wind ? wind.hourly.time : (aq ? aq.hourly.time : null);
    if (!times) { return null; }
    var order = [], byDate = {};
    times.forEach(function (t, i) {
      var date = t.slice(0, 10);
      if (!byDate[date]) { byDate[date] = []; order.push(date); }
      byDate[date].push(i);
    });
    var aqIndex = {};
    if (aq) { aq.hourly.time.forEach(function (t, i) { aqIndex[t] = i; }); }

    return order.map(function (date) {
      var idxs = byDate[date];
      var day = { date: date, wind850: null, wind10: null, pm25: null };
      if (wind) {
        var h = wind.hourly;
        day.wind850 = vectorMean(h.wind_speed_850hPa, h.wind_direction_850hPa, idxs);
        day.wind10 = vectorMean(h.wind_speed_10m, h.wind_direction_10m, idxs);
      }
      if (aq) {
        var aqIdxs = idxs.map(function (i) { return aqIndex[times[i]]; })
          .filter(function (i) { return i !== undefined; });
        day.pm25 = meanOf(aq.hourly.pm2_5, aqIdxs);
      }
      return day;
    });
  }

  function loadCity(key) {
    var city = CITIES[key];
    var wind = fetchJson(windUrl(city)).catch(function (err) {
      note('Wind forecast for ' + city.name + ' could not be loaded (' + err.message + ').');
      return null;
    });
    var aq = fetchJson(aqUrl(city)).catch(function (err) {
      note('PM2.5 forecast for ' + city.name + ' could not be loaded (' + err.message + ').');
      return null;
    });
    return Promise.all([wind, aq]).then(function (res) {
      app.forecast[key] = { days: buildDays(res[0], res[1]), hasWind: !!res[0], hasPm: !!res[1] };
    });
  }

  // ---------- outlook logic ----------

  function pmBand(pm) {
    for (var i = 0; i < PM_BANDS.length; i++) { if (pm < PM_BANDS[i].max) { return i; } }
    return PM_BANDS.length - 1;
  }

  /** Distance and bearing from a city to every active fire cell (computed once). */
  function geoFor(cityKey) {
    if (app.geo[cityKey]) { return app.geo[cityKey]; }
    var f = app.fires, c = CITIES[cityKey].latlng;
    var g = { dist: [], brg: [] };
    for (var i = 0; i < f.cells.lat.length; i++) {
      var p = [f.cells.lat[i], f.cells.lon[i]];
      g.dist.push(haversineKm(c, p));
      g.brg.push(bearingDeg(c, p));
    }
    app.geo[cityKey] = g;
    return g;
  }

  /** Fires inside the upwind sector, their source score and the main source region. */
  function upwindFor(cityKey, wind) {
    var res = { count: 0, frp: 0, score: 0, main: null, idx: [] };
    if (!app.fires || !wind || !wind.reliable) { return res; }
    var cells = app.fires.cells, g = geoFor(cityKey), regionScore = {};
    for (var i = 0; i < cells.lat.length; i++) {
      if (g.dist[i] > UPWIND_RADIUS_KM) { continue; }
      if (angleDiff(g.brg[i], wind.dirFrom) > SECTOR_HALF_ANGLE) { continue; }
      var s = cells.frp[i] * 100 / Math.max(g.dist[i], MIN_DISTANCE_KM);
      res.count += cells.count[i];
      res.frp += cells.frp[i];
      res.score += s;
      regionScore[cells.region[i]] = (regionScore[cells.region[i]] || 0) + s;
      res.idx.push(i);
    }
    var best = null;
    Object.keys(regionScore).forEach(function (r) {
      if (best === null || regionScore[r] > regionScore[best]) { best = r; }
    });
    if (best !== null) { res.main = app.fires.region_names[Number(best)]; }
    return res;
  }

  /** Outlook of one city: one object per forecast day, or null without forecast. */
  function outlookFor(cityKey) {
    var f = app.forecast[cityKey];
    if (!f || !f.days) { return null; }
    return f.days.map(function (day) {
      var up = upwindFor(cityKey, day.wind850);
      var level = null, boosted = false;
      if (day.pm25 !== null) {
        var base = pmBand(day.pm25);
        boosted = up.score >= UPWIND_HIGH_SCORE && base < PM_BANDS.length - 1;
        level = boosted ? base + 1 : base;
      }
      return { day: day, up: up, level: level, boosted: boosted };
    });
  }

  function levelName(level) { return level === null ? 'n/a' : PM_BANDS[level].name; }

  function windText(w) {
    if (!w) { return 'no wind data'; }
    if (!w.reliable) { return 'light and variable'; }
    return 'from ' + compass(w.dirFrom) + ' (' + Math.round(w.dirFrom) + '°), ' + w.speed.toFixed(1) + ' m/s';
  }

  // ---------- KPIs ----------

  function setKpi(id, value, sub, valueClass, subClass) {
    var v = $(id + '-value'), s = $(id + '-sub');
    v.textContent = value;
    v.className = 'value' + (valueClass ? ' ' + valueClass : '');
    s.textContent = sub || '';
    s.className = 'sub' + (subClass ? ' ' + subClass : '');
  }

  function renderKpis() {
    var out = outlookFor(state.city);
    var f = app.fires;

    if (!out) {
      setKpi('kpi-tomorrow', 'n/a', 'Forecast unavailable');
      setKpi('kpi-peak', 'n/a', 'Forecast unavailable');
      setKpi('kpi-source', 'n/a', 'Forecast unavailable');
    } else {
      var tomorrow = out[1] || out[0];
      if (tomorrow.level === null) {
        setKpi('kpi-tomorrow', 'n/a', 'PM2.5 forecast unavailable');
      } else {
        setKpi('kpi-tomorrow', levelName(tomorrow.level),
          'PM2.5 ' + Math.round(tomorrow.day.pm25) + ' µg/m³ · ' + dayLabel(tomorrow.day.date),
          'lvl-' + tomorrow.level);
      }

      var peak = null;
      out.forEach(function (o) {
        if (o.day.pm25 !== null && (peak === null || o.day.pm25 > peak.day.pm25)) { peak = o; }
      });
      if (!peak) {
        setKpi('kpi-peak', 'n/a', 'PM2.5 forecast unavailable');
      } else {
        setKpi('kpi-peak', dayLabel(peak.day.date),
          levelName(peak.level) + ' · PM2.5 ' + Math.round(peak.day.pm25) + ' µg/m³',
          'lvl-' + peak.level);
      }

      var sel = out[state.day] || out[0];
      if (!f) {
        setKpi('kpi-source', 'n/a', 'Active fire data unavailable');
      } else if (!sel.day.wind850) {
        setKpi('kpi-source', 'n/a', 'Wind forecast unavailable');
      } else if (!sel.day.wind850.reliable) {
        setKpi('kpi-source', 'None clear', 'Light and variable wind · ' + dayLabel(sel.day.date));
      } else if (!sel.up.main) {
        setKpi('kpi-source', 'None upwind', 'No active fires upwind, wind ' + windText(sel.day.wind850));
      } else {
        setKpi('kpi-source', sel.up.main, 'Wind ' + windText(sel.day.wind850) + ' · ' + dayLabel(sel.day.date));
      }
    }

    if (!f) {
      setKpi('kpi-fires', 'n/a', 'Active fire data unavailable');
    } else {
      var pct = f.summary.pct_vs_usual;
      var sub = 'No seasonal reference', cls = '';
      // the comparison uses one satellite (S-NPP, or NOAA-20 when S-NPP has no data)
      var ref = f.summary.reference_satellite;
      if (ref === undefined) {
        // files written before the reference satellite was stored: S-NPP only
        var snpp = f.summary.by_satellite ? f.summary.by_satellite['S-NPP'] : null;
        ref = snpp === 0 ? null : 'S-NPP';
      }
      if (!ref) {
        sub = 'No seasonal reference (no reference satellite data)';
      } else if (pct !== null && pct !== undefined) {
        sub = (pct > 0 ? '+' : '') + Math.round(pct) + '% vs usual for the season · reference: ' + ref;
        cls = pct > 0 ? 'up' : 'down';
      }
      setKpi('kpi-fires', fmt(f.summary.total_detections), sub, null, cls);
    }
  }

  // ---------- five day strip ----------

  function renderForecastStrip() {
    var strip = $('strip');
    $('strip-city').textContent = CITIES[state.city].name;
    var out = outlookFor(state.city);
    if (!out) {
      strip.innerHTML = '<p class="hint">The forecast could not be loaded. The rest of the page still works.</p>';
      return;
    }
    strip.innerHTML = out.map(function (o, i) {
      var w = o.day.wind850;
      var arrow = w && w.reliable
        ? '<span class="wind-arrow" style="transform: rotate(' + ((w.dirFrom + 180) % 360) + 'deg)" title="Wind blows towards">&#8593;</span>'
        : '<span class="wind-arrow">~</span>';
      var when = i === 0 ? 'Today' : (i === 1 ? 'Tomorrow' : '');
      var levelHtml = o.level === null
        ? '<div class="d-level muted">n/a</div>'
        : '<div class="d-level lvl-' + o.level + '">' + levelName(o.level) +
          (o.boosted ? '<span class="badge" title="Raised one step by active fires upwind">+1 fires</span>' : '') + '</div>';
      var w10 = o.day.wind10;
      return '<button type="button" class="day' + (i === state.day ? ' selected' : '') + '" data-day="' + i + '"' +
        ' data-level="' + (o.level === null ? '' : o.level) + '" aria-pressed="' + (i === state.day) + '">' +
        '<div class="d-name">' + dayLabel(o.day.date) + '</div>' +
        '<div class="d-sub">' + (when || '&nbsp;') + '</div>' +
        levelHtml +
        '<div class="d-pm">' + (o.day.pm25 === null ? 'PM2.5 n/a' : 'PM2.5 ' + Math.round(o.day.pm25) + ' µg/m³') + '</div>' +
        '<div class="d-wind">' + arrow + '<span>850 hPa ' + windText(w) + '</span></div>' +
        '<div class="d-fires">Surface: ' + (w10 && w10.reliable ? compass(w10.dirFrom) + ' ' + w10.speed.toFixed(1) + ' m/s' : 'variable') + '</div>' +
        '<div class="d-fires">Upwind fires: ' + (app.fires ? fmt(o.up.count) : 'n/a') + '</div>' +
        '</button>';
    }).join('');
  }

  // ---------- fire map ----------

  function frpColor(frp) {
    if (frp < 10) { return cssVar('--frp-1'); }
    if (frp < 30) { return cssVar('--frp-2'); }
    if (frp < 100) { return cssVar('--frp-3'); }
    return cssVar('--frp-4');
  }

  /** Triangle marker pointing towards `bearing` (degrees clockwise from north). */
  function arrowHead(latlng, bearing) {
    return L.marker(latlng, {
      interactive: false,
      icon: L.divIcon({
        className: 'haze-arrow',
        html: '<div style="transform: rotate(' + bearing + 'deg)">&#9650;</div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      })
    });
  }

  function addBasemap(m) {
    // Dark basemap that needs no API key
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors',
      maxZoom: 12
    }).addTo(m);
  }

  function initMap() {
    map = L.map('map', { preferCanvas: true, scrollWheelZoom: false });
    addBasemap(map);
    map.fitBounds([[-6.5, 94.5], [6.5, 119]]);
    cellLayer = L.layerGroup().addTo(map);
    overlayLayer = L.layerGroup().addTo(map);
    // the selected city is drawn in red (active state), the other one in blue
    Object.keys(CITIES).forEach(function (k) {
      cityMarkers[k] = L.circleMarker(CITIES[k].latlng, {
        radius: 7, color: '#ffffff', weight: 2, fillColor: cssVar('--blue'), fillOpacity: 1
      }).bindTooltip(CITIES[k].name, { permanent: true, direction: 'top', className: 'haze-label', offset: [0, -6] })
        .addTo(map);
    });
    var items = [
      ['--frp-1', 'Under 10 MW'], ['--frp-2', '10-30 MW'], ['--frp-3', '30-100 MW'], ['--frp-4', 'Over 100 MW']
    ];
    $('map-legend').innerHTML =
      '<span class="item">Fire radiative power per cell, 7 days:</span>' +
      items.map(function (it) {
        return '<span class="item"><span class="swatch" style="background:' + cssVar(it[0]) + '"></span>' + it[1] + '</span>';
      }).join('') +
      '<span class="item"><span class="swatch cone"></span>Upwind sector (wind from, +/- ' + SECTOR_HALF_ANGLE + '°, up to ' + UPWIND_RADIUS_KM + ' km)</span>' +
      '<span class="item"><span class="swatch outline"></span>Upwind fire cell</span>';
  }

  function renderMap() {
    if (typeof L === 'undefined') { return; }
    if (!map) { initMap(); }
    cellLayer.clearLayers();
    overlayLayer.clearLayers();
    Object.keys(cityMarkers).forEach(function (k) {
      cityMarkers[k].setStyle({ fillColor: cssVar(k === state.city ? '--red' : '--blue') });
    });

    var out = outlookFor(state.city);
    var sel = out ? (out[state.day] || out[0]) : null;
    var upwindSet = {};
    if (sel) { sel.up.idx.forEach(function (i) { upwindSet[i] = true; }); }

    var f = app.fires;
    if (f) {
      var c = f.cells;
      // weakest first so strong cells are drawn on top
      for (var i = c.lat.length - 1; i >= 0; i--) {
        var half = CELL_SIZE / 2;
        var inSector = !!upwindSet[i];
        var rect = L.rectangle(
          [[c.lat[i] - half, c.lon[i] - half], [c.lat[i] + half, c.lon[i] + half]],
          {
            stroke: inSector, color: '#ffffff', weight: 1, opacity: 0.85,
            fillColor: frpColor(c.frp[i]), fillOpacity: 0.85
          }
        );
        var last = new Date(f.period.start + 'T00:00:00');
        last.setDate(last.getDate() + c.last_day[i]);
        rect.bindTooltip(
          f.region_names[c.region[i]] + '<br>' + fmt(c.count[i]) + ' detections · FRP ' + fmt(c.frp[i]) +
          ' MW<br>last: ' + last.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
          { sticky: true }
        );
        rect.addTo(cellLayer);
      }
    }

    var caption = CITIES[state.city].name;
    if (sel && sel.day.wind850 && sel.day.wind850.reliable) {
      var w = sel.day.wind850, center = CITIES[state.city].latlng;
      var pts = [center];
      for (var a = w.dirFrom - SECTOR_HALF_ANGLE; a <= w.dirFrom + SECTOR_HALF_ANGLE + 0.01; a += 5) {
        pts.push(destination(center, a, UPWIND_RADIUS_KM));
      }
      L.polygon(pts, {
        color: cssVar('--blue'), weight: 1, dashArray: '5 5', fillColor: cssVar('--blue'),
        fillOpacity: 0.10, interactive: false
      }).addTo(overlayLayer);
      // arrow pointing at the city, ending clear of the city label
      var tail = destination(center, w.dirFrom, 560), head = destination(center, w.dirFrom, 170);
      L.polyline([tail, head], { color: cssVar('--blue'), weight: 3, interactive: false }).addTo(overlayLayer);
      arrowHead(head, (w.dirFrom + 180) % 360).addTo(overlayLayer);
      caption += ' · ' + dayLabel(sel.day.date) + ' · wind ' + windText(w);
    } else if (sel) {
      caption += ' · ' + dayLabel(sel.day.date) + ' · ' + (sel.day.wind850 ? 'light and variable wind' : 'no wind data');
    }
    $('map-caption').textContent = caption;
  }

  // ---------- season context ----------

  function renderSeasonContext() {
    var box = $('season-context');
    var risk = app.risk;
    if (!risk) {
      box.innerHTML = '<p class="hint">The historical risk index could not be loaded.</p>';
      return;
    }
    var last = risk.meta.last_month, i = risk.series.year.length - 1;
    var sc = risk.series.scopes.both;
    var level = sc.level[i], index = sc.index[i];
    var isNrt = risk.series.source[i] === 'nrt';

    var rows = risk.ranking.both, total = rows.length, rank = null;
    rows.forEach(function (r) { if (r.year === last[0]) { rank = r.rank; } });
    var top = rank ? Math.ceil(rank / total * 100) : null;

    var first = risk.meta.first_month[0];
    box.innerHTML =
      '<div><div class="big lvl-' + level + '">' + risk.meta.levels[level].name + '</div>' +
      '<div class="line">' + MONTHS[last[1] - 1] + ' ' + last[0] + ' risk index ' + Math.round(index) + ' / 100' +
      (isNrt ? ' <span class="badge nrt">near real-time data, not harmonized</span>' : '') + '</div></div>' +
      (top ? '<div><div class="big">Top ' + top + '%</div>' +
        '<div class="line">This fire season ranks in the top ' + top + '% since ' + first + ' (' + rank + ' of ' + total +
        ' years by peak monthly index).</div></div>' : '');
  }

  // ---------- season history (collapsible) ----------

  function seriesIndex(year, month) {
    var first = app.risk.meta.first_month;
    return (year - first[0]) * 12 + (month - first[1]);
  }

  function riskLevelOf(score) {
    var lvl = 0;
    app.risk.meta.levels.forEach(function (l, i) { if (score >= l.min) { lvl = i; } });
    return lvl;
  }

  function riskLevelName(level) { return app.risk.meta.levels[level].name; }
  function isNrtAt(i) { return app.risk.series.source[i] === 'nrt'; }

  /** Level thresholds (reference lines): dashed blue, labelled on the right. */
  var thresholdsPlugin = {
    id: 'levelThresholds',
    beforeDatasetsDraw: function (c) {
      var area = c.chartArea, y = c.scales.y, levels = app.risk.meta.levels, ctx = c.ctx;
      ctx.save();
      ctx.strokeStyle = cssVar('--blue');
      ctx.fillStyle = cssVar('--blue');
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 5]);
      ctx.font = '12px ' + cssVar('--font-body');
      ctx.textAlign = 'right';
      levels.forEach(function (l) {
        if (l.min <= 0) { return; }
        var py = y.getPixelForValue(l.min);
        ctx.beginPath();
        ctx.moveTo(area.left, py);
        ctx.lineTo(area.right, py);
        ctx.stroke();
      });
      ctx.restore();
    },
    // labels are drawn after the series, on a small card-coloured box so they stay readable
    afterDatasetsDraw: function (c) {
      var area = c.chartArea, y = c.scales.y, ctx = c.ctx;
      ctx.save();
      ctx.font = '12px ' + cssVar('--font-body');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      app.risk.meta.levels.forEach(function (l) {
        if (l.min <= 0) { return; }
        var text = l.name + ' ' + l.min;
        var w = ctx.measureText(text).width + 10;
        var px = area.right - w - 14, py = y.getPixelForValue(l.min);
        ctx.fillStyle = cssVar('--card');
        ctx.fillRect(px, py - 9, w, 18);
        ctx.fillStyle = cssVar('--blue');
        ctx.fillText(text, px + 5, py);
      });
      ctx.restore();
    }
  };

  /** Dotted vertical lines on the dry years (El Niño / IOD) listed in the metadata. */
  var dryYearsPlugin = {
    id: 'dryYears',
    afterDatasetsDraw: function (c) {
      var area = c.chartArea, x = c.scales.x, ctx = c.ctx;
      ctx.save();
      ctx.strokeStyle = cssVar('--text-2');
      ctx.fillStyle = cssVar('--text-2');
      ctx.font = '12px ' + cssVar('--font-body');
      ctx.textAlign = 'center';
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1.5;
      app.risk.meta.el_nino_years.forEach(function (year) {
        var px = x.getPixelForValue(year + 0.5);
        if (px < area.left || px > area.right) { return; }
        ctx.beginPath();
        ctx.moveTo(px, area.top);
        ctx.lineTo(px, area.bottom);
        ctx.stroke();
        ctx.fillText(String(year), px, area.top - 6);
      });
      ctx.setLineDash([]);
      ctx.textAlign = 'left';
      ctx.fillText('Dotted lines: Dry years (El Niño / IOD)', area.left + 4, area.top - 6);
      ctx.restore();
    }
  };

  function chartPoints(d, scope) {
    var idx = d.series.scopes[scope].index;
    return d.series.year.map(function (yr, i) { return { x: yr + (d.series.month[i] - 1) / 12, y: idx[i] }; });
  }

  function selectedPoint(d, s) {
    var i = seriesIndex(s.year, s.month);
    return [{ x: s.year + (s.month - 1) / 12, y: d.series.scopes[s.scope].index[i] }];
  }

  function renderHistoryChart() {
    var d = app.risk, s = state.hist;
    var i = seriesIndex(s.year, s.month);
    var level = d.series.scopes[s.scope].level[i];

    if (chart) {
      chart.data.datasets[0].data = chartPoints(d, s.scope);
      chart.data.datasets[1].data = selectedPoint(d, s);
      chart.data.datasets[1].backgroundColor = levelColor(level);
      chart.update('none');
      return;
    }
    var lastX = d.series.year[d.series.year.length - 1] + d.series.month[d.series.month.length - 1] / 12;
    Chart.defaults.color = cssVar('--text-2');
    Chart.defaults.borderColor = cssVar('--grid');
    Chart.defaults.font.family = cssVar('--font-body');
    Chart.defaults.font.size = 13;

    chart = new Chart($('chart'), {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Risk index',
            data: chartPoints(d, s.scope),
            borderColor: cssVar('--orange'),
            borderWidth: 1.8,
            pointRadius: 0,
            pointHitRadius: 6,
            tension: 0,
            // near real-time months: dashed line in a different colour
            segment: {
              borderDash: function (ctx) { return isNrtAt(ctx.p1DataIndex) ? [5, 4] : undefined; },
              borderColor: function (ctx) { return isNrtAt(ctx.p1DataIndex) ? cssVar('--nrt') : undefined; }
            }
          },
          {
            label: 'Selected month',
            data: selectedPoint(d, s),
            showLine: false,
            pointRadius: 7,
            pointHoverRadius: 7,
            pointBorderColor: cssVar('--text'),
            pointBorderWidth: 2,
            backgroundColor: levelColor(level)
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        layout: { padding: { top: 18 } },
        scales: {
          x: {
            type: 'linear',
            min: d.meta.first_month[0],
            max: lastX,
            ticks: { stepSize: 2, maxRotation: 0, autoSkip: false, callback: function (v) { return String(v); } },
            // one tick every two years (the default would add the fractional last value)
            afterBuildTicks: function (scale) {
              var ticks = [];
              for (var yr = Math.ceil(scale.min / 2) * 2; yr <= scale.max; yr += 2) { ticks.push({ value: yr }); }
              scale.ticks = ticks;
            },
            grid: { display: false }
          },
          y: { min: 0, max: 100, ticks: { stepSize: 25 }, title: { display: true, text: 'Risk index (0-100)' } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: function (item) { return item.datasetIndex === 0; },
            callbacks: {
              title: function (items) {
                var k = items[0].dataIndex;
                return MONTHS[d.series.month[k] - 1] + ' ' + d.series.year[k];
              },
              label: function (item) {
                return 'Index ' + item.parsed.y.toFixed(1) + ' (' + riskLevelName(riskLevelOf(item.parsed.y)) + ')';
              },
              afterLabel: function (item) { return SOURCE_LABELS[d.series.source[item.dataIndex]]; }
            }
          }
        },
        onClick: function (evt, _els, c) {
          var hits = c.getElementsAtEventForMode(evt, 'nearest', { axis: 'x', intersect: false }, false)
            .filter(function (h) { return h.datasetIndex === 0; });
          if (!hits.length) { return; }
          setHist({ year: d.series.year[hits[0].index], month: d.series.month[hits[0].index] });
        }
      },
      plugins: [thresholdsPlugin, dryYearsPlugin]
    });
  }

  function seasonCellClass(value, median) {
    if (median <= 0) { return { color: cssVar('--map-new'), label: 'No baseline' }; }
    var r = value / median;
    if (r < 0.5) { return { color: cssVar('--map-below'), label: 'Below typical' }; }
    if (r < 1.5) { return { color: cssVar('--map-typical'), label: 'Typical' }; }
    if (r < 3) { return { color: cssVar('--map-elevated'), label: 'Elevated' }; }
    if (r < 6) { return { color: cssVar('--map-high'), label: 'High' }; }
    return { color: cssVar('--map-extreme'), label: 'Extreme' };
  }

  function initHistMap() {
    histMap = L.map('hist-map', { preferCanvas: true, scrollWheelZoom: false });
    addBasemap(histMap);
    histMap.fitBounds([[-7, 94], [7.5, 120]]);

    Object.keys(app.risk.meta.regions).forEach(function (name) {
      var b = app.risk.meta.regions[name].bbox;
      L.rectangle([[b[1], b[0]], [b[3], b[2]]], {
        color: cssVar('--blue'), weight: 1, opacity: 0.6, dashArray: '4 4', fill: false, interactive: false
      }).addTo(histMap);
    });
    histLayer = L.layerGroup().addTo(histMap);
    Object.keys(CITIES).forEach(function (k) {
      L.circleMarker(CITIES[k].latlng, {
        radius: 7, color: '#ffffff', weight: 2, fillColor: cssVar('--blue'), fillOpacity: 1
      }).bindTooltip(CITIES[k].name, { permanent: true, direction: 'top', className: 'haze-label', offset: [0, -6] })
        .addTo(histMap);
    });
    MONSOON_ARROWS.forEach(function (a) {
      L.polyline([a.from, a.to], { color: cssVar('--blue'), weight: 2.5, dashArray: '6 6', opacity: 0.9, interactive: false }).addTo(histMap);
      var rotation = toDeg(Math.atan2(a.to[1] - a.from[1], a.to[0] - a.from[0]));
      arrowHead(a.to, rotation).addTo(histMap);
    });
    var noteCtl = L.control({ position: 'bottomleft' });
    noteCtl.onAdd = function () {
      var el = L.DomUtil.create('div', 'haze-note');
      el.textContent = 'Southwest monsoon flow, Jun-Oct (schematic)';
      return el;
    };
    noteCtl.addTo(histMap);

    var items = [
      ['--map-below', 'Below median (under 0.5x)'], ['--map-typical', 'Typical (0.5-1.5x)'],
      ['--map-elevated', 'Elevated (1.5-3x)'], ['--map-high', 'High (3-6x)'],
      ['--map-extreme', 'Extreme (over 6x)'], ['--map-new', 'No baseline (median 0)']
    ];
    $('hist-legend').innerHTML = items.map(function (it) {
      return '<span class="item"><span class="swatch" style="background:' + cssVar(it[0]) + '"></span>' + it[1] + '</span>';
    }).join('');
  }

  function renderHistoryMap() {
    if (typeof L === 'undefined') { return; }
    if (!histMap) { initHistMap(); }
    histLayer.clearLayers();
    var d = app.risk, s = state.hist, m = d.map;
    var values = m.values[String(s.year)];
    var wantRegion = s.scope === 'both' ? null : (s.scope === 'sumatra' ? 0 : 1);
    var half = CELL_SIZE / 2, total = 0;

    for (var k = 0; k < m.lat.length; k++) {
      if (wantRegion !== null && m.region[k] !== wantRegion) { continue; }
      var v = values[k];
      total += v;
      if (v < MIN_CELL_VALUE) { continue; }
      var cls = seasonCellClass(v, m.median[k]);
      var rect = L.rectangle(
        [[m.lat[k] - half, m.lon[k] - half], [m.lat[k] + half, m.lon[k] + half]],
        { stroke: false, fillColor: cls.color, fillOpacity: 0.78 }
      );
      rect.bindTooltip(cls.label + '<br>' + fmt(v) + ' hotspots (median ' + m.median[k].toFixed(1) + ')', { sticky: true });
      rect.addTo(histLayer);
    }
    $('hist-map-hint').textContent = s.year + ' June to October, ' + SCOPE_LABELS[s.scope] + ': ' +
      fmt(total) + ' hotspots. Each cell is compared with its own ' + d.meta.base_period.join('-') + ' median.';
  }

  function renderRanking() {
    var d = app.risk, s = state.hist;
    var list = d.ranking[s.scope].slice(0, 10);
    $('ranking').innerHTML = list.map(function (r) {
      var color = levelColor(riskLevelOf(r.max_index));
      var badges = (d.meta.haze_years.indexOf(r.year) >= 0 ? '<span class="badge haze-year">haze year</span>' : '') +
        (r.nrt ? '<span class="badge nrt">NRT</span>' : '');
      return '<li class="rank-row' + (r.year === s.year ? ' selected' : '') + '" role="button" tabindex="0"' +
        ' data-year="' + r.year + '" data-month="' + r.peak_month + '">' +
        '<span class="pos">' + r.rank + '</span>' +
        '<span class="year">' + r.year + '</span>' +
        '<span><span class="rank-bar"><span style="width:' + r.max_index + '%;background:' + color + '"></span></span>' +
        '<span class="meta" style="display:block;text-align:left">peak ' + r.max_index.toFixed(0) + ' in ' +
        MONTHS[r.peak_month - 1] + badges + '</span></span>' +
        '<span class="meta">' + fmt(r.season_count) + ' hotspots</span></li>';
    }).join('');
  }

  function syncHistSelects() {
    var last = app.risk.meta.last_month, s = state.hist;
    $('sel-year').value = String(s.year);
    var monthSel = $('sel-month');
    Array.prototype.forEach.call(monthSel.options, function (opt) {
      opt.disabled = s.year === last[0] && Number(opt.value) > last[1];
    });
    monthSel.value = String(s.month);
    $('sel-region').value = s.scope;
  }

  function renderHistory() {
    if (!app.risk || !histReady) { return; }
    syncHistSelects();
    renderHistoryChart();
    renderHistoryMap();
    renderRanking();
  }

  function setHist(patch) {
    Object.keys(patch).forEach(function (k) { state.hist[k] = patch[k]; });
    var last = app.risk.meta.last_month;
    if (state.hist.year === last[0] && state.hist.month > last[1]) { state.hist.month = last[1]; }
    renderHistory();
  }

  /** CSV text of the risk series for one scope. */
  function buildCsv(d, scope) {
    var sc = d.series.scopes[scope];
    var rows = ['year,month,sumatra_hotspots,kalimantan_hotspots,scope,scope_hotspots,' +
      'risk_index,risk_level,pct_vs_same_month_median,same_month_percentile,data_source'];
    d.series.year.forEach(function (yr, i) {
      rows.push([
        yr, d.series.month[i], d.series.counts.sumatra[i], d.series.counts.kalimantan[i],
        scope, sc.count[i], sc.index[i], riskLevelName(sc.level[i]),
        sc.pct_vs_median[i] === null ? '' : sc.pct_vs_median[i],
        sc.month_percentile[i], d.series.source[i]
      ].join(','));
    });
    return rows.join('\n') + '\n';
  }

  function downloadCsv() {
    var blob = new Blob([buildCsv(app.risk, state.hist.scope)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'haze_risk_' + state.hist.scope + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- header, notices, wiring ----------

  function renderStamp() {
    var firesText = 'unavailable';
    if (app.fires) {
      var gen = new Date(app.fires.generated_at);
      firesText = gen.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      if (Date.now() - gen.getTime() > 36 * 3600 * 1000) { firesText += ' (old, rerun fetch_active_fires.py)'; }
    }
    var keys = Object.keys(CITIES);
    var complete = keys.filter(function (k) { var f = app.forecast[k]; return f && f.days && f.hasWind && f.hasPm; }).length;
    var any = keys.filter(function (k) { var f = app.forecast[k]; return f && f.days; }).length;
    var forecastText = complete === keys.length ? 'live' : (any === 0 ? 'unavailable' : 'partial');
    $('stamp').textContent = 'Fires: ' + firesText + ' · Forecast: ' + forecastText;
    if (app.risk) { $('generated').textContent = 'Risk index generated ' + app.risk.meta.generated + '.'; }
  }

  function renderNotices() {
    $('notices').innerHTML = app.notes.map(function (n) { return '<p>' + n + '</p>'; }).join('');
  }

  function renderAll() {
    renderStamp();
    renderNotices();
    renderKpis();
    renderForecastStrip();
    renderMap();
    renderSeasonContext();
    renderHistory();
  }

  function fillHistorySelects() {
    var last = app.risk.meta.last_month, first = app.risk.meta.first_month;
    var yearSel = $('sel-year');
    for (var y = last[0]; y >= first[0]; y--) { yearSel.add(new Option(String(y), String(y))); }
    var monthSel = $('sel-month');
    MONTHS.forEach(function (name, i) { monthSel.add(new Option(name, String(i + 1))); });
    state.hist.year = last[0];
    state.hist.month = last[1];
  }

  function bindEvents() {
    $('sel-city').addEventListener('change', function (e) { state.city = e.target.value; renderKpis(); renderForecastStrip(); renderMap(); });
    $('strip').addEventListener('click', function (e) {
      var btn = e.target.closest('.day');
      if (!btn) { return; }
      state.day = Number(btn.dataset.day);
      renderKpis(); renderForecastStrip(); renderMap();
    });

    if (!app.risk) { $('history').hidden = true; return; }
    $('sel-year').addEventListener('change', function (e) { setHist({ year: Number(e.target.value) }); });
    $('sel-month').addEventListener('change', function (e) { setHist({ month: Number(e.target.value) }); });
    $('sel-region').addEventListener('change', function (e) { setHist({ scope: e.target.value }); });
    $('btn-csv').addEventListener('click', downloadCsv);

    var rankingEl = $('ranking');
    function pick(e) {
      var row = e.target.closest('.rank-row');
      if (row) { setHist({ year: Number(row.dataset.year), month: Number(row.dataset.month) }); }
    }
    rankingEl.addEventListener('click', pick);
    rankingEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); }
    });

    // the history is built the first time the section is opened (charts and maps need a visible box)
    $('history').addEventListener('toggle', function () {
      if (!$('history').open) { return; }
      var first = !histReady;
      histReady = true;
      renderHistory();
      if (first && histMap) { histMap.invalidateSize(); }
      if (chart) { chart.resize(); }
    });
  }

  // ---------- dashboard sidebar (same behaviour as setupShell in ../app.js) ----------

  /** Collapse button (desktop) and slide-in menu (mobile). Shares the dashboard's saved state. */
  function setupSidebar() {
    var body = document.body;
    try { if (localStorage.getItem('ignisensing-sidebar') === 'collapsed') { body.dataset.sidebar = 'collapsed'; } } catch (e) { /* storage unavailable */ }

    var collapse = $('collapse-btn');
    function syncCollapse() {
      var collapsed = body.dataset.sidebar === 'collapsed';
      collapse.setAttribute('aria-expanded', String(!collapsed));
      collapse.querySelector('.nav-label').textContent = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      Array.prototype.forEach.call(document.querySelectorAll('.nav-link'), function (link) {
        link.title = collapsed ? link.querySelector('.nav-label').textContent : '';
      });
    }
    syncCollapse();
    collapse.addEventListener('click', function () {
      body.dataset.sidebar = body.dataset.sidebar === 'collapsed' ? '' : 'collapsed';
      try { localStorage.setItem('ignisensing-sidebar', body.dataset.sidebar || 'open'); } catch (e) { /* storage unavailable */ }
      syncCollapse();
      // the content width changed: let the maps and the chart fit again
      requestAnimationFrame(function () {
        if (map) { map.invalidateSize(); }
        if (histMap) { histMap.invalidateSize(); }
        if (chart) { chart.resize(); }
      });
    });

    var menu = $('menu-btn'), backdrop = $('backdrop');
    function openNav(open) {
      body.dataset.nav = open ? 'open' : '';
      backdrop.hidden = !open;
      menu.setAttribute('aria-expanded', String(open));
      if (open) {
        var current = document.querySelector('.nav-link[aria-current]');
        if (current) { current.focus(); }
      } else if (document.activeElement && document.activeElement.closest('.sidebar')) {
        menu.focus();
      }
    }
    menu.addEventListener('click', function () { openNav(true); });
    backdrop.addEventListener('click', function () { openNav(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && body.dataset.nav === 'open') { openNav(false); }
    });
  }

  function init() {
    setupSidebar();
    if (typeof L === 'undefined') { note('The map library could not be loaded. Check your connection and reload.'); }
    if (typeof Chart === 'undefined') { note('The chart library could not be loaded. Check your connection and reload.'); }

    var risk = fetchJson(RISK_URL).catch(function (err) {
      note('Historical risk data could not be loaded (' + err.message + ').');
      return null;
    });
    var fires = fetchJson(FIRES_URL).catch(function (err) {
      note('Active fire data could not be loaded (' + err.message + '). Run haze/fetch_active_fires.py to create it.');
      return null;
    });

    Promise.all([risk, fires, loadCity('singapore'), loadCity('kuala_lumpur')]).then(function (res) {
      app.risk = res[0];
      app.fires = res[1];
      if (app.risk) { fillHistorySelects(); }
      bindEvents();
      renderAll();
    });
  }

  init();
})();
