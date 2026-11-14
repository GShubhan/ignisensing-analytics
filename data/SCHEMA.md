# Shared data format

This is the format everyone builds against. **Data**, **ML** and **web** all read and write these files. If you need to change a column, tell the team first.

| File | Made by | Used by |
|---|---|---|
| `processed/hotspots.csv` | Jasmine | Web (map dots, CSV download) |
| `processed/cell_monthly_counts.csv` | Jasmine | Shubhan (ML training) |
| `ml/outputs/monthly_counts.csv` | Shubhan | Web (calendar, charts, anomalies) |

---

## Filters (which detections are kept)

Defined in [../docs/data-quality-filters.md](../docs/data-quality-filters.md) (David). Short version:

| | MODIS | VIIRS |
|---|---|---|
| Satellites | Terra (`T`) + Aqua (`A`) | S-NPP (`N`) only. NOAA-20/21 not used |
| Years | 2003 → now | 2012 → now |
| Confidence | ≥ 30 (nominal + high) | `n` + `h` |
| Fire type | `type == 0` | `type == 0` |

⚠️ **NRT caveat:** the most recent months only exist as NRT data, and NRT files have **no `type` column**. Apply the `type == 0` filter to Standard (SP) rows only, or every recent fire is dropped.

---

## 1. `hotspots.csv`: one row per detected hotspot

| Column | Type | Example | Notes |
|---|---|---|---|
| `date` | YYYY-MM-DD | `2019-09-14` | FIRMS `acq_date` (UTC) |
| `time` | HHMM | `0618` | FIRMS `acq_time` (UTC) |
| `lat` | float | `-2.2135` | FIRMS `latitude` |
| `lon` | float | `113.9214` | FIRMS `longitude` |
| `sensor` | `MODIS` / `VIIRS` | `VIIRS` | |
| `satellite` | `T` / `A` / `N` | `N` | Terra / Aqua / S-NPP |
| `confidence` | `low` / `nominal` / `high` | `nominal` | MODIS 0–29 → low, 30–79 → nominal, 80–100 → high. VIIRS `l`/`n`/`h` map directly. |
| `confidence_raw` | int or text | `64` | Original FIRMS value (MODIS 0–100, VIIRS `l`/`n`/`h`). Needed for the ≥ 30 vs ≥ 50 robustness check. |
| `frp` | float | `12.4` | Fire radiative power (MW) |
| `daynight` | `D` / `N` | `D` | |
| `source` | `SP` / `NRT` | `SP` | Standard archive or Near Real-Time |

## 2. `cell_monthly_counts.csv`: counts per grid cell per month per satellite (ML training data)

Built from `hotspots.csv` after filtering. Grid = **0.25° × 0.25°** cells (~28 km).

| Column | Type | Example | Notes |
|---|---|---|---|
| `cell_lat` | float | `-2.125` | Cell **centre**: `floor(lat / 0.25) * 0.25 + 0.125` |
| `cell_lon` | float | `113.875` | Cell **centre**: `floor(lon / 0.25) * 0.25 + 0.125` |
| `year` | int | `2019` | |
| `month` | int 1–12 | `9` | |
| `sensor` | `MODIS` / `VIIRS` | `MODIS` | |
| `satellite` | `T` / `A` / `N` | `A` | One row per satellite, so MODIS can be used as Terra + Aqua **or** Aqua-only |
| `count` | int | `37` | Number of hotspots |
| `mean_frp` | float or empty | `18.6` | Mean FRP of those hotspots; empty when `count` is 0 |

- Include **zero rows**: every cell that has had at least one fire in any year must have a row for **every** month and satellite in its period, with `count = 0` when nothing was detected. Missing rows would look like missing data, not "no fire".
- Periods: `T` and `A` 2003 → now, `N` 2012 → now.

## 3. `monthly_counts.csv`: counts per region per month (what the dashboard shows)

| Column | Type | Example | Notes |
|---|---|---|---|
| `region` | text | `indonesia` | Short ID for the area |
| `year` | int | `2019` | |
| `month` | int 1–12 | `9` | |
| `sensor` | `MODIS` / `VIIRS` / `HARMONIZED` | `HARMONIZED` | |
| `count` | float | `5120` | `HARMONIZED` values are model estimates, so they can be non-integers |

- **MODIS** rows: 2003 → now (Terra + Aqua)
- **VIIRS** rows: 2012 → now (S-NPP)
- **HARMONIZED** rows: 2003 → now, in VIIRS-equivalent units. 2003–2011 come from the ML model; 2012 onward is real VIIRS. **This is the series the dashboard shows by default.**
