# web/ - Dashboard

**Owners: Ayska, Luis, Nguyen**

The website. Everything in this folder goes live on Vercel automatically after a `git push` to `main`. It is a static site with no build step: plain HTML, CSS and one JavaScript module, no libraries.

## Views

| View | What it shows | Reads |
|---|---|---|
| Overview | Headline figures for the selected area and period, detections by year, computed insights, top provinces | `dashboard.json` |
| Activity calendar | Month by year heatmap (detections, or compared with the monthly median) and the seasonal cycle | `dashboard.json` |
| Fire map | Harmonized detections per 0.25° cell over a NASA Blue Marble basemap, province zoom, masked static heat sources, most active cells | `provinces.json`, `cells.json`, `cells/<year>.json`, `static_sources.json` |
| Historical analysis | Monthly MODIS, VIIRS and harmonized series with the model error band, each year against the median, the VIIRS to MODIS ratio | `dashboard.json` |
| Priority watchlist | All 34 provinces ranked against their own median for the same months | `dashboard.json` |
| About and methodology | Filters, harmonization accuracy (leave-one-year-out), definitions, downloads, credits | `dashboard.json` |

The Area, Year and Month filters are shared by every view and kept in the URL (for example `?view=calendar&area=riau&year=2019&month=9`), so any view can be linked. Every chart has a tooltip, arrow-key reading, and PNG and CSV downloads.

## Rules the numbers follow

- **One median.** Every comparison uses the median of the same months across the complete years 2003 to 2025.
- **Partial months are flagged.** The newest month (still being collected) shows hatched on the calendar and map, and is left out of totals, ranks and the watchlist.
- **Model years are labelled.** 2003 to January 2012 are model estimates from MODIS, shown hatched or banded with the ±6.2% typical annual error from `ml/outputs/loyo.md`.
- **No invented figures.** Everything on screen is computed in the browser from the files in `data/`, which come from the pipeline outputs. When something cannot be computed, the view says so.

## Refreshing the data

The files in `web/data/` are built from committed pipeline outputs (`ml/outputs/monthly_counts.csv`, `ml/outputs/cell_monthly_harmonized.csv`, `ml/outputs/loyo.md`, `data/processed/static_source_cells.csv`) and the province outlines in `data/source/provinces.geojson`. After the ML outputs change:

```bash
pip install pandas numpy
python web/build_data.py                         # last month counts as partial if it is the current calendar month
python web/build_data.py --complete-last-month   # once the final month is complete
```

The script checks that the province totals add up to the national harmonized series and stops if they do not.

Province totals come from assigning each 0.25° cell to the province containing its centre. The outlines are coarse, so coastal cells whose centre falls just offshore (8.2% of detections) are given the nearest province. The outlines are the 34 provinces in place before 2022.

## Running it locally

Any static server works (the page fetches JSON, so opening the file directly does not):

```bash
cd web
python -m http.server 8000
# open http://localhost:8000
```

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell: sidebar, filters, the six views with loading placeholders |
| `app.js` | Data model, charts (inline SVG), filters, tooltips, exports |
| `tokens.css`, `base.css`, `style.css` | Design tokens (colours, type, spacing), base rules, layout and components |
| `build_data.py` | Builds `data/` from the pipeline outputs |
| `assets/` | Team mark, favicon, NASA Blue Marble image cropped to the map frame (lon 94.5 to 141.5, lat -11.5 to 6.5) |

## Testing changes without breaking the live site

Work on a branch. Vercel gives every branch its own preview link:

```
git checkout -b my-feature
git add web
git commit -m "describe your change"
git push -u origin my-feature
```
