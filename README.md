# Ignisensing Analytics

**2026 NASA Space Apps Challenge**: Harmonized burning activity calendar from MODIS and VIIRS active fire hotspots.

## The challenge

Satellites have tracked active fire hotspots for more than 20 years. The record is split between MODIS (Terra/Aqua, 2000 onward) and VIIRS (Suomi NPP, NOAA-20/21, 2012 onward), and the two can't be compared directly because they differ in resolution, sensitivity and overpass times. This project:

1. **Harmonizes** MODIS and VIIRS hotspots from [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) into one consistent time series.
2. **Serves a web app** where users pick an area of interest and a date range, then explore:
   - a burning activity calendar (month × year heatmap of hotspot counts)
   - anomalies against the multi-year median
   - downloadable CSV and visualizations

**Live site:** https://ignisensing-analytics-web.vercel.app/

## Repository layout

| Folder | What | Main contributors |
|---|---|---|
| [`data/`](data/) | FIRMS download, cleaning pipeline, shared data format ([SCHEMA.md](data/SCHEMA.md)) | Jasmine |
| [`ml/`](ml/) | MODIS ↔ VIIRS harmonization model and its evaluation | Shubhan |
| [`web/`](web/) | Dashboard website and haze outlook (auto-deployed on Vercel) | Luis, Nguyen, Ayska, David, Shubhan |
| [`haze/`](haze/) | Scripts that build the haze outlook data | David |
| [`docs/`](docs/) | Data quality filters, haze method, submission material | David, Luis |

Each folder has its own README.

## Team contributions

| Team member | Contributions |
|---|---|
| **Jasmine** | FIRMS data pipeline: download, cleaning and verification scripts; vegetation flag and static heat-source mask; dashboard design sketch; presentation slides and demo video (with Ayska) |
| **Shubhan** | Repository, Vercel and shared data schema setup; MODIS ↔ VIIRS harmonization model (feature search, leave-one-year-out validation, ratio + LightGBM blend); raw vs harmonized calendar comparison; custom area of interest (coordinates or drawn on the map) |
| **Luis** | Dashboard frontend (with Nguyen and Ayska); communication lead: team coordination, mentor contact and project submission |
| **Nguyen** | Dashboard frontend (with Luis and Ayska) |
| **Ayska** | Dashboard frontend (with Luis and Nguyen); presentation slides and demo video (with Jasmine) |
| **David** | Haze outlook for Singapore and Kuala Lumpur; MODIS/VIIRS data quality filters; uploaded the team's frontend to GitHub |

## Data sources

- NASA FIRMS (Fire Information for Resource Management System): MODIS C6.1 and VIIRS 375 m active fire products
