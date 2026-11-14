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

⚠️ **NRT caveat:** the most recent months only exist as NRT data, and NRT files have **no `type` column**. Applying `type == 0` to NRT rows would drop every recent fire. Instead, non-vegetation rows are **flagged, not dropped**, using the columns below.

### Non-vegetation flags (fire type + static sources)

`hotspots.csv` keeps all rows that pass the satellite, year and confidence filters, and marks whether each one is a vegetation fire:

| Column | Values | How it is set |
|---|---|---|
| `fire_type` | `0`–`3` or blank | Original FIRMS archive `type` (0 = vegetation, 1 = volcano, 2 = other static land source, 3 = offshore). Blank for NRT rows. |
| `static_source_mask` | `1` / `0` | `1` if the detection falls inside a known static-source cell (see below), else `0`. Computed for **all** rows, SP and NRT. |
| `vegetation_flag` | `1` / `0`, **never blank** | **The one column everyone filters on.** SP rows: `1` if `fire_type == 0`, else `0`. NRT rows: `0` if `static_source_mask == 1`, else `1`. |

**Rules:**

- **Everyone filters `vegetation_flag == 1`**: the counts tables, the ML model and the dashboard map. Nobody re-implements the type/mask logic.
- **`cell_monthly_counts.csv` counts only `vegetation_flag == 1` rows**, so volcanoes and gas flares are never counted as fires.
- **Booleans are `1` / `0`** in every column (not `True` / `False`).

**Static-source cells:**

- Use a **fine grid of 0.01° (~1 km)**, **not** the 0.25° training grid. Volcanoes, flares and factories are small. A 0.25° (~28 km) mask would delete real fires across a large area of farmland around each one.
- A 0.01° cell is a static source if SP data tagged a detection there as `fire_type` 1 or 2 in **at least 3 different months**.
- Save the list as `processed/static_source_cells.csv` (`cell_lat`, `cell_lon` as cell centres) so the mask can be re-applied to new NRT data.

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
| `fire_type` | `0`–`3` or blank | `0` | See "Non-vegetation flags" above |
| `static_source_mask` | `1` / `0` | `0` | See "Non-vegetation flags" above |
| `vegetation_flag` | `1` / `0` | `1` | **Filter on this.** See "Non-vegetation flags" above |

## 2. `cell_monthly_counts.csv`: counts per grid cell per month per satellite (ML training data)

Built from `hotspots.csv` using **only `vegetation_flag == 1` rows**. Grid = **0.25° × 0.25°** cells (~28 km).

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
