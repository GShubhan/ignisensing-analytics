# ml/ — Harmonization model

**Owner: Shubhan**

Train a model that makes MODIS and VIIRS hotspot counts comparable, so the calendar shows one consistent series from 2000 to now.

## Plan

1. **Training data:** months between 2012 and now when both sensors were running → pairs of (MODIS count, VIIRS count) for the same region and month.
2. **Model:** predict VIIRS count from MODIS count + features (month, latitude, land cover, …). Start simple (linear/log regression), then try gradient boosting if time allows.
3. **Apply:** run the model on the MODIS-only years (2000–2011) to get VIIRS-equivalent counts.
4. **Output:** `HARMONIZED` rows in `monthly_counts.csv` (see [../data/SCHEMA.md](../data/SCHEMA.md)).
5. **Extra (early warning):** flag months whose count is far above the multi-year median.

## Input / output

- Input: `../data/processed/monthly_counts.csv` (from Jasmine's pipeline)
- Output: `outputs/monthly_counts_harmonized.csv` + a short note on accuracy (for the submission)
