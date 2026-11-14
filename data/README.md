# data/  Data pipeline + cleaning

**Owner: Jasmine**

Download MODIS and VIIRS active fire hotspots from [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/), clean them, and output files in the shared format described in [SCHEMA.md](SCHEMA.md).

## Folders

| Folder | What goes here | In git? |
|---|---|---|
| `raw/` | Original FIRMS downloads (large CSVs/zips) | ❌ No - ignored, too big |
| `processed/` | Cleaned outputs that follow SCHEMA.md | ✅ Yes, if small (< 50 MB) |

## Tasks

- [ ] Get a FIRMS MAP_KEY (free): https://firms.modaps.eosdis.nasa.gov/api/map_key/
- [ ] Pick the test region(s) with the team
- [ ] Request archive downloads: MODIS C6.1 (2000→now) and VIIRS 375 m (2012→now)
- [ ] Clean: unify columns, map confidence to low/nominal/high, drop non-vegetation fires (`type` ≠ 0) if wanted
- [ ] Output `processed/hotspots.csv` and `processed/monthly_counts.csv` matching SCHEMA.md

Keep your MAP_KEY in a `.env` file. Never commit it.
