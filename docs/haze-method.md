# Transboundary haze risk: method

## Goal

The page answers one question: **will there be haze in Singapore or Kuala Lumpur tomorrow or this week, and where does the smoke come from?** Two parts work together:

- **Haze outlook** (the main view): a 5-day outlook per city built from active fires, the wind forecast and the PM2.5 forecast.
- **Season index** (context): a monthly risk index since 2003 built from the harmonized MODIS + VIIRS series. It shows whether the current fire season is unusual. It lives in the collapsible "Season history" section of the page.

Both are **risk indicators, not official warnings**. They do not replace the national air quality services.

## Haze outlook

### What it does

For each city and each of the next 5 days, the page combines three things:

1. How much PM2.5 the forecast expects.
2. Which way the wind blows at the height where smoke travels.
3. Where fires burned in the last 7 days, and how many of them lie upwind.

The result is a daily level (Low, Moderate, High, Very high), the main source region, and a map with the upwind sector.

### Sources

| Data | Source | How it is loaded |
|---|---|---|
| Active fires, last 7 days | NASA FIRMS near real time: VIIRS S-NPP, NOAA-20 and NOAA-21, area lon 95 to 118.5 and lat -6 to 6 | `haze/fetch_active_fires.py` writes `web/haze/data/active_fires.json` |
| Wind forecast | Open-Meteo forecast API: `wind_speed_850hPa`, `wind_direction_850hPa`, `wind_speed_10m`, `wind_direction_10m`, hourly, 5 days | In the browser, no key |
| PM2.5 forecast | Open-Meteo air quality API: `pm2_5`, hourly, 5 days. The values come from the CAMS global atmospheric composition forecast (Copernicus Atmosphere Monitoring Service) | In the browser, no key |

For the current state all three VIIRS satellites are used. This is a snapshot, not a time series, so there is no problem in adding satellites (the monthly index uses S-NPP only for that reason).

**End of S-NPP data.** According to the FIRMS download page, Suomi NPP has no data since 2 November 2026. The script still requests it, and for the current state NOAA-20 (same 375 m VIIRS instrument) replaces it as the reference satellite for the comparison with usual activity. The JSON stores the satellite used (`summary.reference_satellite`) and the page shows it on the "Active fires" card. The historical series up to October 2026 is not affected.

### Active fires (the script)

`haze/fetch_active_fires.py` does the following:

- Downloads the last 7 days from the FIRMS area API. The API accepts at most 5 days per request, so the script makes two requests per satellite (2 days and 5 days).
- Keeps nominal and high confidence detections.
- Removes detections inside the static source cells of `data/processed/static_source_cells.csv` (volcanoes, flares, factories).
- Aggregates to a 0.25 degree grid: number of detections, total FRP (MW) and the day of the last detection.
- Gives each cell a source region from approximate boxes.
- Writes `web/haze/data/active_fires.json` (under 300 KB). If the file would be larger, the weakest cells are dropped and `truncated_cells` says how many.

Source regions (approximate boxes, not administrative borders; Sarawak, Brunei, the Malay Peninsula and other cells outside the boxes fall into "Other areas"):

| Region | Box (lon, lat) |
|---|---|
| North Sumatra | 95 to 100.4, 0.9 to 6 |
| Riau | 100.4 to 104.6, -1 to 2.6 |
| Jambi | 101 to 104.8, -2.7 to -1 |
| South Sumatra | 102 to 106, -4.9 to -2.7 |
| West Kalimantan | 108 to 111.2, -3.3 to 2.3 |
| Central Kalimantan | 111.2 to 114.2, -3.8 to 0.8 |
| South/East Kalimantan | 114.2 to 118.5, -4.5 to 4.5 |

To refresh the fires, run `python haze/fetch_active_fires.py` (needs `pandas` and `numpy`). The FIRMS map key is read from the `FIRMS_MAP_KEY` environment variable, or from a `FIRMS_MAP_KEY=...` line in a `.env` file in the repository root or in `haze/`. Both `.env` files are ignored by git. The key is never written to the output. `--days` changes the window and `--from-dir` reprocesses saved CSV files without downloading.

**Comparison with usual.** The JSON holds the total of the window and a rough comparison for the season. The script takes the median monthly count of 2003-2025 for Sumatra + Kalimantan from `web/haze/data/haze_risk.json`, spreads it evenly over the days of the month, and adds it up over the days of the window. It compares this with the detections of one reference satellite only (the monthly series is S-NPP-equivalent), counted inside the same two boxes: S-NPP when it has data in the window, otherwise NOAA-20. The result is a percent above or below usual. It is an approximation: the median is a monthly figure spread evenly over the days, the last day of the window can be incomplete, and NOAA-20 is close to S-NPP but not identical (different orbit timing, about 50 minutes apart, approx.).

### Why 850 hPa

- 850 hPa is a pressure level at about 1.5 km altitude (approx.).
- Smoke from fires rises with the heat and is carried by the winds of the lower atmosphere, not by the wind at ground level.
- The 10 m wind is bent by friction, terrain, and land and sea breezes. It often does not show where smoke is going over hundreds of kilometres.
- The wind at 850 hPa is above that layer and is a common choice for the transport of smoke and dust.
- The 10 m wind is shown on each day card as extra information, but it is not used in the calculation.

### Upwind sector method

For each city and each day:

1. **Daily wind at 850 hPa.** The hourly winds are averaged as vectors (east and north components), not as angles. Averaging angles gives wrong answers (the mean of 350 and 10 degrees is not 180). The direction is where the wind blows **from**. If the mean speed is below 1 m/s the direction is not reliable, the day is marked "light and variable" and no upwind sector is used.
2. **Upwind sector.** A fire cell counts as upwind if it lies within 30 degrees of the direction the wind comes from and less than 1500 km from the city.
3. **Source score.** The sum, over the upwind cells, of `FRP (MW) x 100 km / distance (km)`. Close and intense fires weigh more. Distances under 25 km count as 25 km. The region with the highest score is the **main source**. The number of detections inside the sector is shown as "upwind fires".

### PM2.5 bands and daily level

PM2.5 is the daily mean of the hourly CAMS forecast. The bands are approximate and meant for communication. They are not the official index of Singapore (PSI) or Malaysia (API).

| Level | PM2.5 (µg/m³) |
|---|---|
| Low | below 25 |
| Moderate | 25 to 50 |
| High | 50 to 100 |
| Very high | above 100 |

**Daily level rule.** The level is the one of the PM2.5 band. It is raised one step (up to Very high) if the upwind source score is **2000 or more**. The day card then shows "+1 fires". The 2000 threshold is a hand-picked heuristic. It is high for a quiet week and reached by a strong season with intense fires upwind. It has not been fitted or validated, and it can be changed in `haze.js` (`UPWIND_HIGH_SCORE`).

## Season index: data used

The season index reuses the harmonized MODIS + VIIRS series, so it covers 2003 to October 2026 on one consistent scale.

| File | Use |
|---|---|
| `ml/outputs/cell_monthly_harmonized.csv` | Harmonized hotspot count per 0.25 degree cell and month (`source` = `VIIRS` or `MODEL`) |
| `ml/outputs/monthly_counts.csv` | Context only (the two regions cover about 76% of the Indonesia total, 2003-2025) |

Cells are assigned to a source region by their centre:

| Region | Bounding box (lon, lat) | Cells with fire |
|---|---|---|
| Sumatra | 95 to 106, -6 to 6 | 750 |
| Kalimantan | 108 to 118.5, -4.5 to 4.5 | 751 |

The Kalimantan east limit is 118.5 so that the cells of west Sulawesi stay out. Belitung island falls between the two boxes and is left out.

November 2026 is excluded because the month is incomplete. August to October 2026 are VIIRS near real time (NRT) and did not go through the harmonization model; they are flagged `nrt` in the data and shown as such in the page. 2003 to January 2012 are model estimates (`model`), the rest is real VIIRS (`viirs`).

## Season index: formula

```
exposure = (Sumatra count x 1.0 + Kalimantan count x 0.6) x monsoon weight
index    = percentile of the exposure among all months of 2003-2025   (0 to 100)
```

| Weight | Values | Why |
|---|---|---|
| Monsoon | Jun 0.6, Jul 0.8, Aug 1.0, Sep 1.0, Oct 0.7, Nov to May 0.2 | During the southwest monsoon season the prevailing winds carry smoke towards Singapore and the Malay Peninsula. Fires in the other months matter far less for the region (see "Transport" below) |
| Region | Sumatra 1.0, Kalimantan 0.6 | Sumatra is directly west and southwest of Singapore and Kuala Lumpur, across the Strait of Malacca. Kalimantan is further away and its smoke mostly stays over Borneo |

Levels: **Low** (below 50), **Moderate** (50 to 75), **High** (75 to 90), **Very high** (90 and above).

Each month also stores the hotspot count per region, the percent versus the median of the same calendar month (2003-2025) and the percentile of the count within that same calendar month. The index is computed for three scopes: both regions, Sumatra only and Kalimantan only. The weights are expert judgement, not fitted values.

## Season index: sanity check

Years with known haze episodes should rank high. The annual ranking uses the **peak monthly index between June and October**. The June to October mean is shown as well.

| Year | Rank by peak (of 24) | Rank by mean | Peak index | Jun-Oct hotspots |
|---|---|---|---|---|
| 2015 | 1 | 1 | 99.8 | 583,390 |
| 2019 | 2 | 13 | 99.1 | 256,367 |
| 2006 | 3 | 2 | 98.7 | 490,913 |
| 2009 | 4 | 3 | 98.0 | 325,295 |
| 2023 | 15 | 15 | 89.7 | 116,129 |

- 2006, 2009, 2015 and 2019 come out at the top by peak.
- **2023 comes out as a moderate year.** The index follows the data: 2023 was the 13th of 24 years by hotspots, with little activity in Sumatra before October. The weights were not adjusted to change this. See "Why drought years burn" below.
- 2026 ranks 6th by peak and 11th by mean. Aug to Oct 2026 are NRT. The Oct 2026 index is 95 (Very high).
- The sanity check is a plausibility test on a handful of years. It is not a validation against measured air quality.

## Physics background

This section explains the ideas behind the data and the choices above. It is written for the whole team, no physics degree needed.

### a) How satellites detect fires

- Every hot object glows. The hotter it is, the shorter the wavelength where it glows most. This is Planck's law.
- Normal ground (about 300 K, around 25 °C) glows mostly in the thermal infrared, near 10 micrometres (µm).
- A fire (around 800 K or more, approx.) glows mostly in the mid infrared, near 4 µm.
- So a small fire inside a pixel makes the 4 µm channel jump a lot, while the 11 µm channel barely moves.
- Fire algorithms compare the two channels with the surrounding background. If the 4 µm value is much higher than expected, the pixel is flagged.
- A **hotspot is a pixel with a thermal anomaly**. It is not a whole fire. One big fire can give many hotspots, and a tiny fire can give one.

### b) Why MODIS and VIIRS disagree

- **Pixel size.** MODIS pixels are about 1 km wide. VIIRS (375 m product) pixels are 375 m wide, so about 7 times smaller in area. VIIRS sees smaller and cooler fires that MODIS misses, and it splits large fires into more pixels. That is why it reports roughly 4 to 5 times more detections (the ratio is about 4.5x to 6.2x depending on the year, see below).
- **Time of day.** Fires follow a daily cycle with a peak in the afternoon. Terra passes at about 10:30 local time, Aqua and Suomi NPP at about 13:30 (approx.). A satellite that passes near the afternoon peak sees more active fires than one that passes in the morning. So Terra and Aqua do not count the same thing, and neither does MODIS against VIIRS.
- **Confidence and false alarms.** Sun glint on water, cloud edges and hot bare ground can fake a fire signal. Each detection carries a confidence value. MODIS gives a number from 0 to 100, VIIRS gives low, nominal or high. We keep MODIS at 30 or more and VIIRS nominal and high.
- **Fixed heat sources.** Volcanoes, gas flares and factories show up as hotspots all year. Indonesia has many volcanoes. FIRMS tags these with a `type` field in the archive. For the latest months (NRT) that field does not exist, so we use a map of static-source cells instead (see `data/README.md`).

### c) Why we calibrate on the overlap

- From 2012 both sensors observe the same fires. That overlap lets us measure how many VIIRS detections correspond to a given number of MODIS detections.
- The ratio is not constant. Orbit changes matter: Terra and Aqua no longer keep their orbit, so their pass times have been drifting in recent years (approx., the direction and size should be checked against NASA notices). A drifting pass time changes what the satellite sees of the daily fire cycle, so the relationship between sensors has to be watched over time.
- What `ml/` does (numbers from `ml/README.md`):
  - It predicts VIIRS counts per 0.25 degree cell and month from MODIS counts, and applies it to 2003-2011.
  - The final model is a 50/50 blend of one VIIRS/MODIS ratio and a LightGBM model.
  - Validation hides one overlap year at a time (leave-one-year-out). The blend has a **typical annual error of 6.2%**, a worst year of **-15.7%** and a monthly error (MAPE) of **12.0%**. The ratio alone gets 7.4% and LightGBM alone 6.5%.
  - Held-out 2021 to 2026: monthly-total error 15.6%, bias +2.4%. Backcast of 2012 to 2016: monthly-total error 9.4%, bias -8.5%.
  - Some years miss by 10 to 17% (2015, 2020, 2025) because the VIIRS/MODIS ratio changes from year to year (about 4.5x to 6.2x).

### d) Fire Radiative Power (FRP)

- FRP is the heat energy a fire radiates, in megawatts (MW), measured by the satellite.
- A bigger or fiercer fire has a higher FRP. It is related to how fast the fire burns fuel.
- Counting hotspots treats a small grass fire and a huge peat fire the same. FRP tells them apart, and it depends less on the pixel size than the count.
- FRP is in `hotspots.csv` (`frp`) and in the cell table (`mean_frp`), and the harmonization model uses it as a feature. The haze index does not use it yet. Using total FRP instead of counts is a natural next step.

### e) From fire to haze

- Many fires in Sumatra and Kalimantan burn peat, the thick layer of partly decayed plants under the forest.
- Peat fires mostly **smoulder**: they burn without flames, at lower temperature, slowly, and for weeks. They can burn underground.
- Smouldering produces a lot of smoke, with much fine particulate matter (PM2.5) for each unit of fuel burned.
- A smouldering peat fire is cooler and harder for a satellite to see than a flaming fire. So one hotspot over peat can mean much more smoke than one hotspot over grass.
- **Limitation:** hotspot counts underestimate the smoke from peat fires. Our index measures fire activity, not smoke.

### f) Transport

- The **southwest monsoon** blows roughly from June to September (approx.) and often into October. Over Sumatra it pushes air towards the northeast, across the Strait of Malacca. Smoke from Sumatra then reaches Singapore and peninsular Malaysia.
- Kalimantan is further east. Its smoke affects Borneo first (Sarawak, Brunei) and reaches Singapore and Kuala Lumpur less directly. That is why Sumatra gets weight 1.0 and Kalimantan 0.6.
- The **northeast monsoon** (roughly November to March, approx.) brings rain and winds from the other side. Fires are fewer, and smoke is washed out and pushed away from Singapore.
- Between the two monsoons there are short transition periods with weak and changing winds.
- The seasonal weights follow this: 1.0 in the core months (August, September), lower at the edges of the season (June 0.6, July 0.8, October 0.7), and 0.2 for the rest of the year. The exact numbers are judgement, not fitted.

### g) Why drought years burn

- Peat only burns when it is dry. Farmers and companies also clear land with fire, and dry weather lets those fires escape.
- **El Niño** and a **positive Indian Ocean Dipole (IOD)** reduce rainfall over Indonesia. Peat dries out and fires grow.
- 2015 was a strong El Niño and the biggest year in our data. 2019 was driven mostly by a strong positive IOD (with a weak El Niño earlier in the year). 2006 and 2009 were also dry years.
- 2023 was an El Niño year but came out moderate in our data. This is coherent: **El Niño makes a bad fire year more likely, it does not guarantee one.** Timing of the rains, local conditions and fire prevention all matter. Other factors such as peat restoration and fire management after 2015 may also play a part (not tested here).
- The chart marks 2015, 2019 and 2023 as dry years (El Niño / IOD), so users can see that the link with the index is real but not automatic.

### h) Why the peak month and not the mean

- Haze episodes last weeks, and people are hurt by the worst days, not by the average of five months.
- A seasonal mean over June to October hides a short and intense season behind quiet months. The peak month keeps it visible.
- **Transparency:** the first version of the ranking used the June to October mean. In that version 2019 ranked 13th of 24. After seeing this we switched to the peak month, which puts 2019 2nd. The change was made after looking at the result, so 2019 moving up is partly by construction. Both ranks are published in the data (`rank` and `rank_by_mean`) and in the table above.
- The physical argument for the peak is sound, but the result should not be read as proof that the index is validated. 2023 is not high with either metric, and we did not tune the weights to change that.

### Key numbers

| Item | Value |
|---|---|
| MODIS pixel | about 1 km (at nadir) |
| VIIRS 375 m pixel | 375 m, about 7 times smaller in area |
| VIIRS / MODIS detections | about 4.5x to 6.2x depending on the year |
| Fire channels | mid infrared about 4 µm, thermal infrared about 11 µm |
| Pass times (local, approx.) | Terra about 10:30 day, Aqua about 13:30 day, Suomi NPP about 13:30 day (night passes about 12 hours later) |
| Pass time drift | Terra and Aqua drift in recent years (approx.) |
| FIRMS availability | Terra from Nov 2000, Aqua from Jul 2002, Suomi NPP from Jan 2012, NOAA-20 from Apr 2018, NOAA-21 from Mar 2023 |
| Used in this project | Terra + Aqua from 2003, Suomi NPP from 2012 (NOAA-20 and NOAA-21 not used) |
| Confidence filter | MODIS 30 or more, VIIRS nominal and high |
| Harmonization, leave-one-year-out | typical annual error 6.2%, worst year -15.7%, monthly MAPE 12.0% |
| Harmonization, held-out 2021-2026 | monthly-total MAPE 15.6%, bias +2.4% |
| Harmonization, backcast 2012-2016 | monthly-total MAPE 9.4%, bias -8.5% |
| Region weights | Sumatra 1.0, Kalimantan 0.6 |
| Monsoon weights | Jun 0.6, Jul 0.8, Aug 1.0, Sep 1.0, Oct 0.7, Nov to May 0.2 |
| Levels | Low below 50, Moderate 50-75, High 75-90, Very high 90 and above |
| Base period | 2003-2025 |

## Limitations

These limitations used to be listed on the page and now live here.

**Haze outlook**

- It is **not a real dispersion trajectory**. It uses the daily mean wind at one level and a fixed sector. A real trajectory model follows the air through changing winds and heights, day and night.
- The sector ignores wind changes during the day, plume rise, rain that washes out smoke, and the smoke already in the air from earlier days.
- The source regions are approximate boxes. Cells near the borders can be assigned to the wrong region.
- The fires are a **snapshot of the moment the script was run**. If the file is old, the page says so in the header. The last day of the window can be incomplete because of the near real time delay.
- PM2.5 comes from **CAMS, a model**, on a grid of tens of kilometres. It can differ from the measured values of the national stations, especially during sharp smoke episodes.
- The PM2.5 bands and the +1 threshold are heuristics for communication, not official standards, and the threshold was not fitted to observations.
- Fires in Malaysia, Thailand and other countries inside the box are counted as "Other areas".
- The wind forecast and the PM2.5 forecast are loaded from Open-Meteo in the browser. If a call fails, the page shows a notice and the rest keeps working.

**Season index**

- It is a risk indicator, not a forecast of haze or air quality.
- Monthly resolution. Real haze episodes depend on daily wind and weather.
- No wind data and no air quality data (PSI, API) are used, so the index has not been validated against measured air quality.
- Hotspot counts are detections, not unique fires, and not smoke volume. Peat fires emit much more smoke than their hotspot count suggests.
- Aug to Oct 2026 are NRT and not harmonized. Before 2012 the counts are MODIS-based estimates. The harmonization has a typical annual error of about 6%, and some years miss by 10 to 17%.
- The seasonal and regional weights are fixed assumptions.
- Only fires inside Indonesia are included (no Malaysian or other regional fires).
- Optional extension not done: MODIS aerosol optical depth (AOD) as an independent check.

## Files

| File | What |
|---|---|
| `haze/fetch_active_fires.py` | Downloads the last 7 days of VIIRS NRT detections and writes `active_fires.json` (needs `pandas`, `numpy` and a FIRMS map key) |
| `haze/build_haze_risk.py` | Builds the season index JSON from the two ML outputs (needs `pandas` and `numpy`; run `python haze/build_haze_risk.py`) |
| `web/haze/data/active_fires.json` | Output of the fires script, under 300 KB |
| `web/haze/data/haze_risk.json` | Output of the index script, about 240 KB. Metadata, monthly series, annual ranking and map data |
| `web/haze/index.html`, `haze.css`, `haze.js` | Standalone page (Leaflet and Chart.js from CDN, no build step) |

`active_fires.json` layout: `generated_at` (UTC), `period` (start, end, days), `source`, `filters`, `downloaded_rows`, `summary` (total detections, total FRP, detections per satellite, latest detection, comparison with usual), `region_boxes`, `regions` (summary per region), `region_names`, `truncated_cells` and `cells` (parallel arrays: `lat`, `lon`, `count`, `frp`, `last_day` as days after `period.start`, `region` as an index into `region_names`).

`haze_risk.json` layout: `meta` (method, weights, base period, levels, sources, `haze_years`, `el_nino_years`), `series` (arrays aligned by month: `year`, `month`, `source`, `counts`, and `scopes.{both,sumatra,kalimantan}` with `count`, `index`, `level`, `pct_vs_median`, `month_percentile`), `ranking` per scope, `map` (cell `lat`, `lon`, `region`, `median` and Jun-Oct `values` per year, as parallel arrays). The key `el_nino_years` holds the years marked as dry years on the chart.

## Integrating it in the main frontend

1. Test it alone: serve the `web/` folder (`python -m http.server` from `web/`) and open `/haze/`.
2. Quick integration: link to `haze/index.html` from the Watchlist or the navigation.
3. Component integration: the page logic is split into `renderKpis`, `renderForecastStrip`, `renderMap`, `renderSeasonContext` and `renderHistory` (which draws the chart, the season map and the ranking). The shared data is in one `app` object and the selections in one `state` object (`city`, `day` and the history selection), so each function maps to a component that receives them as props.
4. Styling: the page follows the team palette and fonts (League Spartan for titles, Inter for text). All colours, spacing and fonts are CSS variables at the top of `haze.css`. The guide red (`--red`, #E53935) is used for buttons, borders and large text; small red text (links, upward trends) uses the lighter `--red-text` tone (#FF6B66) because the guide red only reaches about 4:1 contrast on the card colour, below the 4.5:1 needed for small text.
5. The data files are loaded with relative paths (`RISK_URL` and `FIRES_URL` at the top of `haze.js`). The forecast URLs are at the top too.
6. Refresh the fires by running `fetch_active_fires.py` (every day, or more often during the fire season) and commit or deploy the new `active_fires.json`. Rebuild `haze_risk.json` whenever `ml/outputs` changes, and if new months arrive update `LAST_MONTH` and `NRT_MONTHS` in `build_haze_risk.py`.
7. Open-Meteo is free for non-commercial use and asks for attribution, and the CAMS data needs the Copernicus notice. Both are in the page footer: keep them if the footer is replaced.
