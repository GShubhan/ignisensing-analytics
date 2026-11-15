# Ignisensing Analytics

**2026 NASA Space Apps Challenge**: a harmonized burning activity calendar for Indonesia, built from MODIS and VIIRS active fire hotspots.

**Live site:** https://ignisensing-analytics-web.vercel.app/

## The challenge

Satellites have tracked active fire hotspots for more than 20 years, but the record is split between two sensors that cannot be compared directly:

- **MODIS** (Terra and Aqua, 2000 onward): 1 km pixels, misses many small fires.
- **VIIRS** (Suomi NPP from 2012, NOAA-20 and NOAA-21 later): 375 m pixels, detects about 4.5 to 6 times more hotspots for the same fires.

Joined naively, the record shows a large jump in 2012 that comes from the sensor change, not from more fire. This project removes that jump and turns the result into a fire history tool for responders, land managers and scientists.

## What we built

1. **A data pipeline** that cleans NASA FIRMS hotspots for Indonesia and counts them per 0.25° grid cell (about 28 km) per month.
2. **A harmonization model** that converts MODIS counts into VIIRS-equivalent counts, giving one consistent record from 2003 to today.
3. **A web dashboard** built on the harmonized record:
   - **Overview**: headline figures, map preview and monthly activity for the selected area and period
   - **Activity calendar**: month by year heatmap with Activity, Anomaly (against the monthly median) and **Raw sensors** modes, plus the seasonal cycle
   - **Fire map**: harmonized detections per grid cell, province zoom, masked static heat sources
   - **Historical analysis**: each year against the 2003 to 2025 median, the VIIRS to MODIS ratio by year, and the monthly series with the model's error band
   - **Priority watchlist**: all 34 provinces ranked against their own history for the selected period (a screening indicator, not an official warning)
   - **Haze outlook**: recent active fires combined with wind and PM2.5 forecasts for Singapore and Kuala Lumpur, plus a monthly haze risk index since 2003
   - **Custom area of interest**: enter a latitude, longitude and radius, or draw a box on the map, and every view updates for that area
   - CSV and PNG downloads for every chart, and shareable links (all filters are kept in the URL)

## Key results

- **Harmonization changes the conclusion.** Taken at face value, raw sensor counts suggest fire activity in 2013 to 2025 was **3.4 times** higher than in 2003 to 2011. On the harmonized scale it was **31% lower**.
- **Model accuracy** (leave-one-year-out: each overlap year is hidden in turn and predicted from the others, which matches how the model is used on 2003 to 2011):

  | Model | Typical annual error | Monthly error (MAPE) |
  |---|---|---|
  | Single VIIRS/MODIS ratio | 7.4% | 13.8% |
  | LightGBM alone | 6.5% | 13.1% |
  | **Blend of ratio and LightGBM (final)** | **6.2%** | **12.0%** |

  LightGBM alone under-predicted record fire years such as 2015 (decision trees cannot extrapolate beyond their training range), so the final model blends it with the ratio. The remaining error mostly reflects real year-to-year variation in the VIIRS/MODIS relationship (4.6 to 6.2 times), and the dashboard shows it as an uncertainty band. Details: [ml/README.md](ml/README.md), [ml/outputs/metrics.md](ml/outputs/metrics.md), [ml/outputs/loyo.md](ml/outputs/loyo.md).
- **2026 is an exceptional year:** January to October is 186% above the 2003 to 2025 median for Indonesia, and Kalimantan Tengah is 766% above its own median.

## How it works

```
NASA FIRMS hotspots (MODIS + VIIRS, archive and near real time)
   │  data/clean_data.py: filters, static heat-source mask, 0.25° monthly counts
   ▼
data/processed/cell_monthly_counts.csv
   │  ml/harmonize.py: MODIS → VIIRS-equivalent model (ratio + LightGBM blend)
   ▼
ml/outputs/monthly_counts.csv, cell_monthly_harmonized.csv
   │  web/build_data.py: small JSON files for the browser
   │  haze/build_haze_risk.py, haze/fetch_active_fires.py: haze outlook data
   ▼
web/ (static site, deployed automatically on Vercel)
```

**Data filters** (full rationale in [docs/data-quality-filters.md](docs/data-quality-filters.md), column definitions in [data/SCHEMA.md](data/SCHEMA.md)):

- Nominal and high confidence only, with the same rule for both sensors (MODIS ≥ 30, VIIRS `n` and `h`)
- Vegetation fires only (FIRMS `type` 0), plus a 0.01° mask of recurring static heat sources (volcanoes, gas flares, industry), which also covers near-real-time data that has no `type` field
- One consistent satellite set so counts do not jump when satellites are added: MODIS Terra and Aqua from 2003 (the first full year with both), VIIRS Suomi NPP only from 2012

The web app has no backend. All figures, including custom areas, are computed in the browser from the files in `web/data/`.

## Run it yourself

Requires Python 3 with `pandas`, `numpy`, `scikit-learn`, `lightgbm`, `matplotlib` and `tabulate`.

```bash
# 1. Data: put FIRMS archive downloads (fire_archive_*.csv, fire_nrt_*.csv) in data/raw/, then
python data/clean_data.py
python data/verify_data.py

# 2. Harmonization model (about 2 minutes)
python ml/harmonize.py

# 3. Website data
python web/build_data.py
python haze/build_haze_risk.py
python haze/fetch_active_fires.py   # needs a free FIRMS MAP_KEY in a .env file (never commit it)

# 4. View the site locally
cd web && python -m http.server 8000   # then open http://localhost:8000
```

## Repository layout

| Folder | What | Main contributors |
|---|---|---|
| [`data/`](data/) | FIRMS cleaning and verification pipeline, shared data format ([SCHEMA.md](data/SCHEMA.md)) | Jasmine |
| [`ml/`](ml/) | MODIS ↔ VIIRS harmonization model, model search and evaluation | Shubhan |
| [`web/`](web/) | Dashboard website and haze outlook (auto-deployed on Vercel) | Luis, Nguyen, Ayska, David, Shubhan |
| [`haze/`](haze/) | Scripts that build the haze outlook data | David |
| [`docs/`](docs/) | Data quality filters, haze method, submission material | David, Luis |

Each folder has its own README with details.

## Team contributions

| Team member | Role |
|---|---|
| **Ayska** | Visual & Figma Lead |
| **David** | Backend & Haze exploration |
| **Jasmine** | Data Pipeline & Workflow |
| **Luis** | Management & Strategy |
| **Nguyen** | Front-end Optimization |
| **Shubhan** | AI/ML & Backend |

## Data sources and credits

| Source | Used for |
|---|---|
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) MODIS Collection 6.1 active fires (Terra and Aqua), standard archive and near real time | Historical record 2003 onward, harmonization model input |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) VIIRS 375 m active fires (Suomi NPP), standard archive and near real time | Observed record 2012 onward, harmonization model target |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) VIIRS 375 m near real time (NOAA-20, NOAA-21) | Haze outlook: active fires in the last 7 days only (not mixed into the historical calendar) |
| NASA Blue Marble shaded relief and bathymetry, via [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) | Dashboard map background |
| [Open-Meteo](https://open-meteo.com/) forecast API (850 hPa and 10 m wind) | Haze outlook: smoke transport direction |
| [Open-Meteo](https://open-meteo.com/) air quality API, from the Copernicus Atmosphere Monitoring Service ([CAMS](https://atmosphere.copernicus.eu/)) global forecast | Haze outlook: PM2.5 forecast |
| Esri map tiles | Haze outlook map background |
| Indonesia province boundaries (34 provinces, pre-2022), public GeoJSON | Province totals, province zoom, watchlist |

We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS).

## Tools and technologies

- **Languages:** Python, JavaScript, HTML, CSS
- **Data and machine learning:** pandas, NumPy, scikit-learn, LightGBM, matplotlib
- **Frontend:** plain JavaScript with hand-built SVG charts (no framework); Leaflet and Chart.js on the haze page
- **Design and planning:** Figma, Miro
- **Hosting and collaboration:** GitHub, Vercel (free static hosting with preview deployments)
- **AI assistance:** Claude Code was used for parts of the coding and analysis
- **Hardware:** team laptops only

## Limitations

- Counts are hotspot detections, not individual fires or burned area. One fire can produce many detections.
- 2003 to January 2012 are model estimates (typical annual error about 6%); 2012 onward is observed VIIRS.
- Grid cells are 0.25° (about 28 km), so custom area and province edges are approximate.
- The newest month is partial and is flagged as in progress. FIRMS reports no Suomi NPP data since 2 November 2026, so continuing the record will need a NOAA-20/21 handover, which the same overlap-based method can provide.
- The watchlist and haze outlook are screening indicators, not official warnings.
