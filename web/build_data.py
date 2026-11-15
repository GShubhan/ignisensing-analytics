"""Build the small JSON files the dashboard reads, from the committed pipeline outputs.

Inputs (all committed to the repo):
  ml/outputs/monthly_counts.csv            national MODIS / VIIRS / HARMONIZED series (SCHEMA.md section 3)
  ml/outputs/cell_monthly_harmonized.csv   harmonized count per 0.25 deg cell per month
  ml/outputs/loyo.md                       leave-one-year-out evaluation of the harmonization model
  data/processed/static_source_cells.csv   0.01 deg static heat-source cells (masked from all counts)
  web/data/source/provinces.geojson        34 province boundaries (pre-2022)

Outputs (web/data/):
  dashboard.json      national series, province series, model evaluation, metadata
  provinces.json      province outlines as SVG paths in map coordinates
  cells.json          0.25 deg cell centres and their province
  cells/<year>.json   monthly harmonized count per active cell for one year
  static_sources.json static heat-source cell centres
  monthly_counts.csv  copy of the national series, for download
  province_monthly_harmonized.csv  province series, for download

Run from anywhere:  python web/build_data.py
Add --complete-last-month if the final month in the data is a full month.
"""

import csv
import json
import math
import re
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

WEB = Path(__file__).resolve().parent
ROOT = WEB.parent
OUT = WEB / "data"

# Map frame, shared with web/app.js and the NASA GIBS Blue Marble image in web/assets.
LON0, LON1, LAT0, LAT1 = 94.5, 141.5, -11.5, 6.5
SCALE = 50  # map units per degree: the frame is 2350 x 900
MODEL_LAST = 201201  # harmonized months up to and including Jan 2012 are model estimates


def mx(lon):
    return (lon - LON0) * SCALE


def my(lat):
    return (LAT1 - lat) * SCALE


def ring_area(ring):
    a = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi:
            inside = not inside
        j = i
    return inside


def load_provinces():
    geo = json.loads((OUT / "source" / "provinces.geojson").read_text(encoding="utf-8"))
    provinces = []
    for f in geo["features"]:
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        name = f["properties"]["state"]
        if name == "Jakarta Raya":
            name = "DKI Jakarta"
        rings = [poly[0] for poly in polys]  # outer rings; no province has holes that matter here
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        provinces.append({
            "name": name,
            "slug": f["properties"]["slug"].replace("indonesia-", ""),
            "rings": rings,
            "bbox": [min(xs), min(ys), max(xs), max(ys)],
        })
    provinces.sort(key=lambda p: p["name"])
    return provinces


def province_paths(provinces):
    out = []
    for p in provinces:
        parts = []
        for ring in p["rings"]:
            pts = []
            for lon, lat in ring:
                pt = (round(mx(lon), 1), round(my(lat), 1))
                if not pts or pts[-1] != pt:
                    pts.append(pt)
            if len(pts) < 4 or ring_area(pts) < 0.5:  # drop specks under ~0.0002 sq deg
                continue
            parts.append("M" + "L".join(f"{x:g},{y:g}" for x, y in pts) + "Z")
        b = p["bbox"]
        out.append({
            "name": p["name"],
            "slug": p["slug"],
            "path": "".join(parts),
            "box": [round(mx(b[0]), 1), round(my(b[3]), 1), round(mx(b[2]), 1), round(my(b[1]), 1)],
        })
    return out


def assign_cells(cells, provinces):
    """Province index for each cell centre: the polygon that contains it, else the nearest vertex."""
    verts = np.array([(i, lon, lat) for i, p in enumerate(provinces) for r in p["rings"] for lon, lat in r])
    result, outside = [], []
    for lat, lon in cells:
        hit = None
        for i, p in enumerate(provinces):
            b = p["bbox"]
            if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
                continue
            if any(point_in_ring(lon, lat, r) for r in p["rings"]):
                hit = i
                break
        if hit is None:
            outside.append(len(result))
            hit = int(verts[np.argmin((verts[:, 1] - lon) ** 2 + (verts[:, 2] - lat) ** 2), 0])
        result.append(hit)
    return result, outside


def parse_md_table(text, heading):
    """Rows of the first markdown table after a '## heading' line, as lists of cell strings."""
    block = text.split(f"## {heading}", 1)[1]
    rows = []
    for line in block.splitlines():
        line = line.strip()
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if not all(re.fullmatch(r":?-+:?", c) for c in cells):
                rows.append(cells)
        elif rows:
            break
    return rows


def main():
    complete_last = "--complete-last-month" in sys.argv
    (OUT / "cells").mkdir(parents=True, exist_ok=True)

    # National series ---------------------------------------------------------
    nat = pd.read_csv(ROOT / "ml" / "outputs" / "monthly_counts.csv")
    nat = nat[nat.region == "indonesia"]
    nat["ym"] = nat.year * 100 + nat.month
    first = int(nat.ym.min())
    last = int(nat.ym.max())
    y0, m0, y1, m1 = first // 100, first % 100, last // 100, last % 100
    n = (y1 - y0) * 12 + (m1 - m0) + 1

    def idx(year, month):
        return (year - y0) * 12 + (month - m0)

    series = {}
    for sensor, g in nat.groupby("sensor"):
        values = [None] * n
        for r in g.itertuples():
            values[idx(r.year, r.month)] = round(float(r.count), 1)
        series[sensor] = values

    today = date.today()
    partial = (not complete_last) and (y1, m1) == (today.year, today.month)

    # Province series from cells ---------------------------------------------
    provinces = load_provinces()
    cells_df = pd.read_csv(ROOT / "ml" / "outputs" / "cell_monthly_harmonized.csv")
    cell_keys = cells_df[["cell_lat", "cell_lon"]].drop_duplicates().sort_values(["cell_lat", "cell_lon"])
    cell_list = [(float(a), float(b)) for a, b in cell_keys.itertuples(index=False)]
    cell_index = {c: i for i, c in enumerate(cell_list)}
    cell_prov, outside = assign_cells(cell_list, provinces)

    cells_df["cell"] = [cell_index[(a, b)] for a, b in zip(cells_df.cell_lat, cells_df.cell_lon)]
    cells_df["prov"] = [cell_prov[c] for c in cells_df.cell]
    cells_df["i"] = (cells_df.year - y0) * 12 + (cells_df.month - m0)
    outside_set = set(outside)
    outside_share = cells_df[cells_df.cell.isin(outside_set)]["count"].sum() / cells_df["count"].sum()

    prov_series = [[0.0] * n for _ in provinces]
    for (p, i), v in cells_df.groupby(["prov", "i"])["count"].sum().items():
        prov_series[p][i] = v
    prov_series = [[round(v, 1) for v in s] for s in prov_series]

    # Per-year cell files: [cell, m1 .. m12] for cells with any detection that year.
    for year, g in cells_df.groupby("year"):
        table = {}
        for r in g.itertuples():
            row = table.setdefault(int(r.cell), [0] * 12)
            v = float(r.count)
            row[r.month - 1] = round(v) if v >= 10 else round(v, 2)
        rows = [[c] + table[c] for c in sorted(table)]
        (OUT / "cells" / f"{year}.json").write_text(
            json.dumps({"year": int(year), "rows": rows}, separators=(",", ":")), encoding="utf-8")

    (OUT / "cells.json").write_text(json.dumps(
        {"size": 0.25, "cells": [[lat, lon, p] for (lat, lon), p in zip(cell_list, cell_prov)]},
        separators=(",", ":")), encoding="utf-8")

    (OUT / "provinces.json").write_text(json.dumps(
        {"frame": {"lon0": LON0, "lon1": LON1, "lat0": LAT0, "lat1": LAT1, "scale": SCALE},
         "provinces": province_paths(provinces)}, separators=(",", ":")), encoding="utf-8")

    # Static heat sources ------------------------------------------------------
    static = pd.read_csv(ROOT / "data" / "processed" / "static_source_cells.csv")
    (OUT / "static_sources.json").write_text(json.dumps(
        {"grid": 0.01, "cells": [[round(a, 3), round(b, 3)] for a, b in static.itertuples(index=False)]},
        separators=(",", ":")), encoding="utf-8")

    # Model evaluation (leave-one-year-out) -----------------------------------
    loyo_text = (ROOT / "ml" / "outputs" / "loyo.md").read_text(encoding="utf-8")
    # The header row holds "|annual bias|", so its pipes cannot be split; the columns are fixed.
    keys = ["meanAbsAnnualBiasPct", "worstAnnualBiasPct", "monthlyMapePct", "overallBiasPct"]
    summary = parse_md_table(loyo_text, "Summary")[1:]
    loyo_summary = [{"model": r[0], **{k: float(v) for k, v in zip(keys, r[1:])}} for r in summary]
    annual = parse_md_table(loyo_text, "Annual bias per hidden year")
    loyo_years = [{"year": int(r[0]), "viirs": int(r[1]), "ratio": float(r[2]),
                   "lightgbm": float(r[3]), "blend": float(r[4])} for r in annual[1:]]
    blend = next(s for s in loyo_summary if s["model"].startswith("Blend"))
    typical_error = blend["meanAbsAnnualBiasPct"]

    meta = {
        "built": today.isoformat(),
        "start": [y0, m0],
        "end": [y1, m1],
        "months": n,
        "lastPartial": partial,
        "modelLastIndex": idx(MODEL_LAST // 100, MODEL_LAST % 100),
        "typicalAnnualErrorPct": typical_error,
        "cells": len(cell_list),
        "cellsOutsideProvinces": len(outside),
        "outsideDetectionSharePct": round(100 * outside_share, 1),
        "staticSourceCells": len(static),
    }
    dashboard = {
        "meta": meta,
        "national": series,
        "provinces": [{"name": p["name"], "slug": p["slug"], "series": s} for p, s in zip(provinces, prov_series)],
        "loyo": {"summary": loyo_summary, "years": loyo_years},
    }
    (OUT / "dashboard.json").write_text(json.dumps(dashboard, separators=(",", ":")), encoding="utf-8")

    # Downloads ---------------------------------------------------------------
    nat.drop(columns="ym").to_csv(OUT / "monthly_counts.csv", index=False)
    with open(OUT / "province_monthly_harmonized.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["province", "year", "month", "harmonized_count", "source"])
        for p, s in zip(provinces, prov_series):
            for i, v in enumerate(s):
                y, m = y0 + (m0 - 1 + i) // 12, (m0 - 1 + i) % 12 + 1
                w.writerow([p["name"], y, m, v, "MODEL" if i <= meta["modelLastIndex"] else "VIIRS"])

    # Consistency check: provinces add up to the national harmonized series.
    worst = max(abs(sum(s[i] for s in prov_series) - (series["HARMONIZED"][i] or 0)) for i in range(n))
    print(f"months {n} ({y0}-{m0:02d} to {y1}-{m1:02d}), last month partial: {partial}")
    print(f"cells {len(cell_list)}, centre outside every outline, given the nearest province: {len(outside)}"
          f" ({100 * outside_share:.1f}% of detections)")
    print(f"largest monthly gap between province sum and national harmonized: {worst:.1f}")
    if worst > 50:
        raise SystemExit("province totals do not match the national series")


if __name__ == "__main__":
    main()
