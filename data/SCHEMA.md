# Shared data format

This is the format everyone builds against. **Data**, **ML** and **web** all read and write these two files. If you need to change a column, tell the team first.

---

## 1. `hotspots.csv` — one row per detected hotspot

| Column | Type | Example | Notes |
|---|---|---|---|
| `date` | YYYY-MM-DD | `2019-08-21` | FIRMS `acq_date` (UTC) |
| `time` | HHMM | `1435` | FIRMS `acq_time` (UTC) |
| `lat` | float | `-31.4201` | FIRMS `latitude` |
| `lon` | float | `-64.1888` | FIRMS `longitude` |
| `sensor` | `MODIS` / `VIIRS` | `VIIRS` | |
| `satellite` | text | `N` | FIRMS code: `T`/`A` (Terra/Aqua), `N`/`J1`/`J2` (S-NPP/NOAA-20/NOAA-21) |
| `confidence` | `low` / `nominal` / `high` | `nominal` | MODIS 0–29 → low, 30–79 → nominal, 80–100 → high. VIIRS `l`/`n`/`h` map directly. |
| `frp` | float | `12.4` | Fire radiative power (MW) |
| `daynight` | `D` / `N` | `D` | |

## 2. `monthly_counts.csv` — hotspot counts per region per month

This is what the calendar heatmap and the ML model use.

| Column | Type | Example | Notes |
|---|---|---|---|
| `region` | text | `cordoba_ar` | Short ID for the area |
| `year` | int | `2019` | |
| `month` | int 1–12 | `8` | |
| `sensor` | `MODIS` / `VIIRS` / `HARMONIZED` | `MODIS` | `HARMONIZED` rows come from the ML model |
| `count` | int | `412` | Number of hotspots |

- **MODIS** rows: 2000 → now
- **VIIRS** rows: 2012 → now
- **HARMONIZED** rows: 2000 → now, in "VIIRS-equivalent" units. This is the series the dashboard should show by default.
