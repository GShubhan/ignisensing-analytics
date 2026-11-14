# Ignisensing Analytics

**2026 NASA Space Apps Challenge**: Harmonized burning activity calendar from MODIS and VIIRS active fire hotspots.

## The challenge

Satellites have tracked active fire hotspots for more than 20 years. The record is split between MODIS (Terra/Aqua, 2000 onward) and VIIRS (Suomi NPP, NOAA-20/21, 2012 onward), and the two can't be compared directly because they differ in resolution, sensitivity and overpass times. This project:

1. **Harmonizes** MODIS and VIIRS hotspots from [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) into one consistent time series.
2. **Serves a web app** where users pick an area of interest and a date range, then explore:
   - a burning activity calendar (month × year heatmap of hotspot counts)
   - anomalies against the multi-year median
   - downloadable CSV and visualizations

## Repository layout

| Folder | What | Owner |
|---|---|---|
| [`data/`](data/) | FIRMS download, cleaning, shared data format ([SCHEMA.md](data/SCHEMA.md)) | Jasmine |
| [`ml/`](ml/) | MODIS ↔ VIIRS harmonization model | Shubhan |
| [`web/`](web/) | Dashboard website (auto-deployed on Vercel) | Ayska, Luis, Nguyen |
| [`docs/`](docs/) | Submission write-up, screenshots, demo video | Luis |

Each folder has its own README with tasks. Work mostly inside your own folder to avoid merge conflicts.

## Team

- **Jasmine**: data pipeline + cleaning, dashboard design sketch
- **Shubhan**: harmonization ML model
- **Ayska, Luis, Nguyen**: dashboard
- **Luis**: communication lead + submission
- **Data visualisation**: _owner TBD_

## Data sources

- NASA FIRMS (Fire Information for Resource Management System): MODIS C6.1 and VIIRS 375 m active fire products
