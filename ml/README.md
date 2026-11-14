# ml/ - Harmonization model

**Owner: Shubhan**

Train a model that makes MODIS and VIIRS hotspot counts comparable, so the calendar shows one consistent series from 2003 to now.

## Plan

1. **Training data:** grid-cell months between 2012 and now when both sensors were running → pairs of (MODIS count, VIIRS S-NPP count) for the same cell and month.
2. **Models, in order:**
   - Baseline: one ratio, VIIRS ≈ k × MODIS
   - Log-linear regression: `log(1+VIIRS) ~ log(1+MODIS) + month + …`
   - LightGBM / XGBoost with MODIS count, mean FRP, month, lat, lon (+ land cover if available)
3. **Validate** with a time split (e.g. train 2012–2020, test 2021+). Report MAE and R² for all three models.
4. **Apply:** run the best model on the MODIS-only years (2003–2011) to get VIIRS-equivalent counts.
5. **Output:** `HARMONIZED` rows in `monthly_counts.csv` (see [../data/SCHEMA.md](../data/SCHEMA.md)).
6. **Extra (early warning):** flag months whose count is far above the multi-year median.

## Robustness checks

- MODIS confidence ≥ 30 vs ≥ 50 (from [../docs/data-quality-filters.md](../docs/data-quality-filters.md))
- MODIS Terra + Aqua vs Aqua-only (Aqua passes over at the same time of day as VIIRS S-NPP)
- Does the MODIS/VIIRS ratio drift after ~2020 (MODIS orbit drift)? If yes, train on 2012–2020 only.

## Input / output

- Input: `../data/processed/cell_monthly_counts.csv` (from Jasmine's pipeline)
- Output: `outputs/monthly_counts.csv` + a short note on accuracy (for the submission)
