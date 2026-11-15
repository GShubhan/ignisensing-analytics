"""Build the transboundary haze risk dataset for the web app.

Reads the harmonized fire activity (0.25 degree cells, monthly) produced by the
ml/ folder, aggregates it for Sumatra and Kalimantan and computes a simple,
explainable monthly haze risk index (0-100) for Singapore and Kuala Lumpur.

Input:
    ml/outputs/cell_monthly_harmonized.csv   cell_lat, cell_lon, year, month, count, source
    ml/outputs/monthly_counts.csv            region, year, month, sensor, count (context only)

Output:
    web/haze/data/haze_risk.json

Run from anywhere (requires pandas and numpy):
    python haze/build_haze_risk.py

The index is a risk indicator based on fire activity and season. It is not a
forecast and it does not use wind or air quality data.
"""

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CELLS_CSV = ROOT / "ml" / "outputs" / "cell_monthly_harmonized.csv"
COUNTS_CSV = ROOT / "ml" / "outputs" / "monthly_counts.csv"
OUT_JSON = ROOT / "web" / "haze" / "data" / "haze_risk.json"

# Source regions as (west, south, east, north). Cells are kept when their centre
# falls strictly inside the box, so every kept cell is fully inside it.
REGIONS = {
    "sumatra": (95.0, -6.0, 106.0, 6.0),
    # east limit at 118.5 keeps the cells of west Sulawesi out
    "kalimantan": (108.0, -4.5, 118.5, 4.5),
}

# Proximity of each source region to Singapore and Kuala Lumpur.
REGION_WEIGHT = {"sumatra": 1.0, "kalimantan": 0.6}

# Southwest monsoon (Jun-Oct) carries smoke towards Singapore and Malaysia.
SEASON_WEIGHT = {
    1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2, 5: 0.2,
    6: 0.6, 7: 0.8, 8: 1.0, 9: 1.0, 10: 0.7,
    11: 0.2, 12: 0.2,
}
SEASON_MONTHS = range(6, 11)  # Jun-Oct

FIRST_YEAR = 2003
BASE_START, BASE_END = 2003, 2025   # reference period for percentiles and medians
LAST_MONTH = (2026, 10)             # Nov 2026 is incomplete and is excluded
NRT_MONTHS = {(2026, 8), (2026, 9), (2026, 10)}  # real VIIRS NRT, not modelled

# (name, minimum index) in ascending order
LEVELS = [("Low", 0), ("Moderate", 50), ("High", 75), ("Very high", 90)]

# Years used in the sanity check of the ranking (known haze years plus 2023)
REFERENCE_YEARS = [2006, 2009, 2015, 2019, 2023]
# Years with a major documented haze episode (badge in the ranking)
HAZE_YEARS = [2006, 2009, 2015, 2019]
# El Niño years marked on the chart
EL_NINO_YEARS = [2015, 2019, 2023]
SCOPES = ["both", "sumatra", "kalimantan"]


def load_region_months():
    """Return monthly counts per region as a DataFrame indexed by (year, month)."""
    cells = pd.read_csv(CELLS_CSV)
    needed = {"cell_lat", "cell_lon", "year", "month", "count", "source"}
    missing = needed - set(cells.columns)
    if missing:
        raise SystemExit(f"Missing columns in {CELLS_CSV.name}: {sorted(missing)}")

    # Drop the incomplete month(s) after the last complete one.
    last = LAST_MONTH[0] * 100 + LAST_MONTH[1]
    cells = cells[(cells["year"] * 100 + cells["month"]) <= last].copy()

    cells["region"] = None
    for name, (w, s, e, n) in REGIONS.items():
        inside = (
            (cells["cell_lon"] > w) & (cells["cell_lon"] < e)
            & (cells["cell_lat"] > s) & (cells["cell_lat"] < n)
        )
        cells.loc[inside, "region"] = name
    cells = cells[cells["region"].notna()]
    return cells


def monthly_table(cells):
    """Counts per region for every month 2003-01 to the last complete month."""
    idx = pd.MultiIndex.from_tuples(
        [(y, m) for y in range(FIRST_YEAR, LAST_MONTH[0] + 1) for m in range(1, 13)
         if (y, m) <= LAST_MONTH],
        names=["year", "month"],
    )
    counts = (
        cells.groupby(["year", "month", "region"])["count"].sum()
        .unstack("region").reindex(idx).fillna(0.0)
    )
    for name in REGIONS:
        if name not in counts:
            counts[name] = 0.0

    # Month source: modelled (MODIS-based) or real VIIRS; Aug-Oct 2026 are VIIRS NRT.
    model_share = (
        cells.assign(model=np.where(cells["source"] == "MODEL", cells["count"], 0.0))
        .groupby(["year", "month"])[["model", "count"]].sum()
        .reindex(idx).fillna(0.0)
    )
    share = model_share["model"] / model_share["count"].replace(0, np.nan)
    source = np.where(share.fillna(0) >= 0.5, "model", "viirs")
    counts["source"] = source
    counts["source"] = [
        "nrt" if (y, m) in NRT_MONTHS else s
        for (y, m), s in zip(counts.index, counts["source"])
    ]
    return counts


def percentile_rank(value, base):
    """Percentile (0-100) of value among base values; ties count half."""
    base = np.asarray(base, dtype=float)
    below = (base < value).sum()
    equal = (base == value).sum()
    return 100.0 * (below + 0.5 * equal) / len(base)


def level_index(score):
    """Map an index value to a level number (0 Low ... 3 Very high)."""
    lvl = 0
    for i, (_, minimum) in enumerate(LEVELS):
        if score >= minimum:
            lvl = i
    return lvl


def scope_counts(table, scope):
    """Unweighted hotspot count and weighted exposure terms for a scope."""
    if scope == "both":
        raw = table["sumatra"] + table["kalimantan"]
        weighted = (table["sumatra"] * REGION_WEIGHT["sumatra"]
                    + table["kalimantan"] * REGION_WEIGHT["kalimantan"])
    else:
        raw = table[scope]
        weighted = table[scope] * REGION_WEIGHT[scope]
    return raw, weighted


def compute_scope(table, scope):
    """Risk index and companions for one scope (both / sumatra / kalimantan)."""
    raw, weighted = scope_counts(table, scope)
    season = table.index.get_level_values("month").map(SEASON_WEIGHT).to_numpy()
    exposure = weighted.to_numpy() * season

    years = table.index.get_level_values("year").to_numpy()
    months = table.index.get_level_values("month").to_numpy()
    base_mask = (years >= BASE_START) & (years <= BASE_END)
    base_exposure = exposure[base_mask]

    index = np.array([percentile_rank(v, base_exposure) for v in exposure])

    # Percent versus the median of the same calendar month (base period).
    raw_arr = raw.to_numpy()
    pct_vs_median, month_pct = [], []
    for y, m, v in zip(years, months, raw_arr):
        same = raw_arr[base_mask & (months == m)]
        med = float(np.median(same))
        pct_vs_median.append(round((v - med) / med * 100, 1) if med > 0 else None)
        month_pct.append(round(percentile_rank(v, same), 1))

    return {
        "raw": raw_arr,
        "exposure": exposure,
        "index": np.round(index, 1),
        "level": [level_index(s) for s in index],
        "pct_vs_median": pct_vs_median,
        "month_percentile": month_pct,
    }


def yearly_ranking(table, scope_data):
    """Rank years by the peak monthly index over Jun-Oct (mean is kept as well)."""
    years = table.index.get_level_values("year").to_numpy()
    months = table.index.get_level_values("month").to_numpy()
    out = []
    for y in sorted(set(years)):
        sel = (years == y) & np.isin(months, list(SEASON_MONTHS))
        idx = scope_data["index"][sel]
        peak = int(np.argmax(idx))
        out.append({
            "year": int(y),
            "mean_index": round(float(idx.mean()), 1),
            "max_index": round(float(idx.max()), 1),
            "peak_month": int(months[sel][peak]),
            "season_count": round(float(scope_data["raw"][sel].sum()), 0),
            "nrt": bool(any((int(y), int(m)) in NRT_MONTHS for m in months[sel])),
        })
    # Haze episodes are driven by the worst month, so rank by the peak monthly
    # index; the Jun-Oct mean (which dilutes short, intense seasons) breaks ties.
    out.sort(key=lambda r: (r["max_index"], r["mean_index"]), reverse=True)
    for rank, row in enumerate(out, start=1):
        row["rank"] = rank
    by_mean = sorted(out, key=lambda r: (r["mean_index"], r["max_index"]), reverse=True)
    for rank, row in enumerate(by_mean, start=1):
        row["rank_by_mean"] = rank
    return out


def map_data(cells):
    """Jun-Oct total per cell and year, plus the base-period median per cell."""
    season = cells[cells["month"].isin(SEASON_MONTHS)]
    per_year = season.groupby(["cell_lat", "cell_lon", "year", "region"])["count"].sum()
    per_year = per_year.reset_index()

    # Only cells that had fire at some point in the two regions.
    cell_keys = (per_year[["cell_lat", "cell_lon", "region"]]
                 .drop_duplicates().sort_values(["region", "cell_lat", "cell_lon"])
                 .reset_index(drop=True))
    years = list(range(FIRST_YEAR, LAST_MONTH[0] + 1))

    wide = (per_year.pivot_table(index=["cell_lat", "cell_lon"], columns="year",
                                 values="count", aggfunc="sum")
            .reindex(columns=years).fillna(0.0))
    wide = wide.reindex(pd.MultiIndex.from_frame(cell_keys[["cell_lat", "cell_lon"]]))

    base_cols = [y for y in years if BASE_START <= y <= BASE_END]
    median = wide[base_cols].median(axis=1)

    return {
        "lat": [round(float(v), 3) for v in cell_keys["cell_lat"]],
        "lon": [round(float(v), 3) for v in cell_keys["cell_lon"]],
        "region": [0 if r == "sumatra" else 1 for r in cell_keys["region"]],
        "median": [round(float(v), 2) for v in median],
        "years": years,
        "values": {str(y): [round(float(v), 1) for v in wide[y]] for y in years},
    }


def main():
    cells = load_region_months()
    table = monthly_table(cells)

    # Context only: share of the national harmonized series covered by the two regions.
    national = pd.read_csv(COUNTS_CSV)
    nat = national[(national["sensor"] == "HARMONIZED")
                   & (national["year"] >= BASE_START) & (national["year"] <= BASE_END)]
    covered = (table.loc[table.index.get_level_values("year") <= BASE_END,
                         ["sumatra", "kalimantan"]].sum().sum() / nat["count"].sum())
    print(f"Sumatra + Kalimantan cover {covered:.0%} of Indonesia harmonized counts "
          f"({BASE_START}-{BASE_END})")

    scopes = {s: compute_scope(table, s) for s in SCOPES}
    rankings = {s: yearly_ranking(table, scopes[s]) for s in SCOPES}

    # Sanity check: known haze years should rank high.
    print("\nAnnual ranking, both regions (by peak Jun-Oct monthly index):")
    for row in rankings["both"]:
        mark = "  <- reference year" if row["year"] in REFERENCE_YEARS else ""
        print(f"  {row['rank']:>2}. {row['year']}  peak {row['max_index']:>5.1f}  "
              f"mean {row['mean_index']:>5.1f} (#{row['rank_by_mean']:>2} by mean)  "
              f"hotspots {row['season_count']:>9,.0f}{mark}")
    print("\nReference year ranks (of %d), by peak / by mean:" % len(rankings["both"]))
    for scope in SCOPES:
        rk = {r["year"]: r for r in rankings[scope]}
        print(f"  {scope:<10} " + ", ".join(
            f"{y} #{rk[y]['rank']}/#{rk[y]['rank_by_mean']}" for y in REFERENCE_YEARS))

    years = table.index.get_level_values("year").to_numpy()
    months = table.index.get_level_values("month").to_numpy()
    payload = {
        "meta": {
            "title": "Transboundary haze risk index",
            "generated": date.today().isoformat(),
            "description": ("Monthly risk indicator for haze reaching Singapore and Kuala Lumpur, "
                            "from harmonized fire activity in Sumatra and Kalimantan. "
                            "Not a forecast."),
            "formula": ("exposure = (Sumatra count x 1.0 + Kalimantan count x 0.6) x monsoon weight; "
                        "index = percentile of exposure among all months of 2003-2025"),
            "region_weights": REGION_WEIGHT,
            "season_weights": {str(m): w for m, w in SEASON_WEIGHT.items()},
            "base_period": [BASE_START, BASE_END],
            "season_months": [6, 10],
            "first_month": [int(years[0]), int(months[0])],
            "last_month": [int(years[-1]), int(months[-1])],
            "excluded": "2026-11 (incomplete month)",
            "levels": [{"name": n, "min": mn} for n, mn in LEVELS],
            "regions": {k: {"bbox": list(v), "weight": REGION_WEIGHT[k]} for k, v in REGIONS.items()},
            "haze_years": HAZE_YEARS,
            "el_nino_years": EL_NINO_YEARS,
            "source_codes": {
                "model": "MODIS-based estimate in VIIRS-equivalent units (harmonization model)",
                "viirs": "VIIRS S-NPP detections",
                "nrt": "VIIRS near real time, not passed through the model",
            },
            "sources": [
                "NASA FIRMS MODIS C6.1 and VIIRS 375 m active fire detections",
                "ml/outputs/cell_monthly_harmonized.csv",
                "ml/outputs/monthly_counts.csv (context)",
            ],
            "series_columns": "arrays aligned by position: year, month, source, counts, scopes",
        },
        "series": {
            "year": years.tolist(),
            "month": months.tolist(),
            "source": table["source"].tolist(),
            "counts": {k: [round(float(v), 1) for v in table[k]] for k in REGIONS},
            "scopes": {
                s: {
                    "count": [round(float(v), 1) for v in d["raw"]],
                    "index": d["index"].tolist(),
                    "level": d["level"],
                    "pct_vs_median": d["pct_vs_median"],
                    "month_percentile": d["month_percentile"],
                }
                for s, d in scopes.items()
            },
        },
        "ranking": rankings,
        "map": map_data(cells),
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    size = OUT_JSON.stat().st_size
    print(f"\nWrote {OUT_JSON.relative_to(ROOT)}  ({size / 1024:.0f} KB)")
    if size > 1_000_000:
        raise SystemExit("JSON is larger than 1 MB")


if __name__ == "__main__":
    main()
