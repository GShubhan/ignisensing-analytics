# Data quality filters: MODIS & VIIRS

Filters applied to the FIRMS hotspot data before harmonization, so the fire calendar reflects real fire activity and not sensor artifacts or satellite changes.

## Summary

| Filter | MODIS | VIIRS | Why |
|---|---|---|---|
| Satellites | Terra + Aqua | Suomi NPP only | Counts must not jump when a satellite is added |
| Years | 2003 to today | 2012 to today | 2003 is the first full year with both MODIS satellites; S-NPP starts Jan 2012 |
| Confidence | >= 30 (nominal + high) | nominal + high (`n`, `h`) | Low confidence detections are mostly sun glint, cloud edges and hot bare ground |
| Fire type | `type == 0` | `type == 0` | Removes volcanoes and static industrial heat sources |
| Product | Standard archive (SP) for history, NRT for the most recent months | Standard archive (SP) for history, NRT for the most recent months | SP is reprocessed and consistent over time; NRT is the only source for the latest months |
| Day / night | keep both | keep both | Keep the `daynight` column so we can split later if needed |

**Note on NRT and the static-source mask:** NRT files have no `type` column, so `type == 0` cannot be applied to them. The pipeline keeps all detections that pass the other filters and sets `vegetation_flag`: archive rows get `1` when `type == 0`; NRT rows get `0` when they fall in a static-source cell (0.01 degree cells where the archive tagged a volcano or other static source in at least 3 different months), otherwise `1`. Everyone filters on `vegetation_flag == 1`. Details in `data/README.md`.

## Details

**Satellite availability (from the FIRMS download page)**
- MODIS Terra: Nov 2000 to present
- MODIS Aqua: Jul 2002 to present
- VIIRS S-NPP: Jan 2012 to present
- VIIRS NOAA-20: Apr 2018 to present (not used)
- VIIRS NOAA-21: Mar 2023 to present (not used)

**Why not NOAA-20 / NOAA-21:** adding them would double or triple VIIRS detections from 2018 and 2023 only because more satellites are observing, not because there is more fire. S-NPP alone gives one homogeneous VIIRS record.

**Why start MODIS in 2003:** Aqua only joins in mid-2002. Including 2000-2002 would show an artificial increase when the second satellite starts.

**Confidence classes**
- MODIS: numeric 0-100. Low < 30, nominal 30-79, high >= 80.
- VIIRS 375 m: categorical `l` (low), `n` (nominal), `h` (high).

**Why `type == 0` matters for Indonesia:** Indonesia has more active volcanoes than any other country. Without this filter they appear as fires burning all year and distort the monthly calendar during the haze season.

**Overlap window:** 2012 to today is the period where both sensors observe the same fires. This is where we compare MODIS and VIIRS monthly counts to learn the conversion between them.

## Robustness check

Run the harmonization twice, with MODIS confidence >= 30 and >= 50. If the result barely changes, the method is robust.

## To check in the downloaded files

- [ ] The CSV includes the `confidence` and `type` columns
- [ ] Archive (SP) for history, NRT only for recent months (masked with static source cells)
- [ ] Area: Indonesia; MODIS 2003 to today, VIIRS S-NPP 2012 to today

## Reference implementation (pandas)

```python
import pandas as pd

def filter_modis(df: pd.DataFrame, min_conf: int = 30) -> pd.DataFrame:
    df = df.copy()
    df["acq_date"] = pd.to_datetime(df["acq_date"])
    mask = (
        (df["confidence"] >= min_conf)
        & (df["type"] == 0)
        & (df["acq_date"].dt.year >= 2003)
    )
    return df[mask]

def filter_viirs(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["acq_date"] = pd.to_datetime(df["acq_date"])
    mask = (
        df["confidence"].isin(["n", "h"])
        & (df["type"] == 0)
        & (df["acq_date"].dt.year >= 2012)
    )
    return df[mask]
```
