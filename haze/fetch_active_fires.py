"""Download recent VIIRS active fire detections and aggregate them for the Haze Outlook page.

Reads the last N days (default 7) of near real time VIIRS detections from the NASA
FIRMS area API for Sumatra and Kalimantan, keeps nominal and high confidence
detections, removes known static heat sources (volcanoes, flares, factories) and
aggregates the rest to a 0.25 degree grid.

Output:
    web/haze/data/active_fires.json

Usage (needs pandas and numpy):
    python haze/fetch_active_fires.py
    python haze/fetch_active_fires.py --days 5
    python haze/fetch_active_fires.py --from-dir some/folder   # reprocess saved CSVs, no download

The FIRMS map key is read from the FIRMS_MAP_KEY environment variable, or from a
line FIRMS_MAP_KEY=... in a .env file in the repository root or in haze/ (both are
ignored by git). The key is never written to the output or printed.

The detections are a snapshot of the moment the script is run. Run it again to refresh.
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
STATIC_CELLS_CSV = ROOT / "data" / "processed" / "static_source_cells.csv"
RISK_JSON = ROOT / "web" / "haze" / "data" / "haze_risk.json"
OUT_JSON = ROOT / "web" / "haze" / "data" / "active_fires.json"

API_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
AREA = (95.0, -6.0, 118.5, 6.0)        # west, south, east, north
MAX_DAYS_PER_REQUEST = 5               # the API accepts 1 to 5 days per request

# For the current state all VIIRS satellites are used (this is not a time series)
SOURCES = {
    "VIIRS_SNPP_NRT": "S-NPP",
    "VIIRS_NOAA20_NRT": "NOAA-20",
    "VIIRS_NOAA21_NRT": "NOAA-21",
}
KEEP_CONFIDENCE = {"n", "h"}           # nominal and high

# Satellite used for the comparison with the usual activity, in order of preference.
# The monthly series is S-NPP-equivalent. S-NPP has no FIRMS data since 2 Nov 2026,
# so NOAA-20 (same 375 m VIIRS instrument) is used when S-NPP has no detections.
REFERENCE_ORDER = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT"]

STATIC_GRID = 0.01                     # degrees, same grid as data/clean_data.py
CELL = 0.25                            # output grid, degrees
MAX_JSON_BYTES = 290_000               # keep the file under 300 KB

# Approximate source regions as (west, south, east, north). They are drawn by hand,
# do not follow administrative borders and are checked in this order.
REGION_BOXES = [
    ("North Sumatra", (95.0, 0.9, 100.4, 6.0)),
    ("Riau", (100.4, -1.0, 104.6, 2.6)),
    ("Jambi", (101.0, -2.7, 104.8, -1.0)),
    ("South Sumatra", (102.0, -4.9, 106.0, -2.7)),
    ("West Kalimantan", (108.0, -3.3, 111.2, 2.3)),
    ("Central Kalimantan", (111.2, -3.8, 114.2, 0.8)),
    ("South/East Kalimantan", (114.2, -4.5, 118.5, 4.5)),
]
OTHER_REGION = "Other areas"
REGION_NAMES = [name for name, _ in REGION_BOXES] + [OTHER_REGION]


def load_key():
    """FIRMS map key from the environment or from a git-ignored .env file."""
    key = os.environ.get("FIRMS_MAP_KEY")
    if key:
        return key.strip()
    for path in (ROOT / ".env", ROOT / "haze" / ".env"):
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("FIRMS_MAP_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def date_windows(end_date, days):
    """Split the last `days` days into (start_date, n_days) windows of at most 5 days."""
    start = end_date - timedelta(days=days - 1)
    windows, remaining = [], days
    while remaining > 0:
        n = min(MAX_DAYS_PER_REQUEST, remaining)
        windows.append((start, n))
        start += timedelta(days=n)
        remaining -= n
    return windows


def fetch_source(key, source, windows):
    """Download one source over all windows and return a DataFrame."""
    area = ",".join(str(v) for v in AREA)
    parts = []
    for start, n in windows:
        url = f"{API_URL}/{key}/{source}/{area}/{n}/{start.isoformat()}"
        body = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=120) as resp:
                    body = resp.read().decode("utf-8", errors="replace")
                break
            except urllib.error.HTTPError as err:
                detail = err.read().decode("utf-8", errors="replace")[:200]
                raise RuntimeError(f"HTTP {err.code}: {detail}".replace(key, "***"))
            except (urllib.error.URLError, TimeoutError) as err:
                if attempt == 2:
                    raise RuntimeError(f"network error: {err}".replace(key, "***"))
                time.sleep(3)
        body = body.strip()
        if not body:
            continue
        if not body.lower().startswith("latitude"):
            raise RuntimeError(f"unexpected response: {body[:200]}".replace(key, "***"))
        parts.append(pd.read_csv(io.StringIO(body)))
    if not parts:
        return pd.DataFrame()
    return pd.concat(parts, ignore_index=True)


def load_from_dir(folder):
    """Reprocess CSV files saved as <SOURCE>.csv in a folder (no download)."""
    frames = {}
    for source in SOURCES:
        path = Path(folder) / f"{source}.csv"
        if path.is_file():
            frames[source] = pd.read_csv(path)
    return frames


def load_static_mask():
    """Set of (lat index, lon index) of the 0.01 degree static source cells."""
    cells = pd.read_csv(STATIC_CELLS_CSV)
    ilat = np.round((cells["cell_lat"] - STATIC_GRID / 2) / STATIC_GRID).astype(int)
    ilon = np.round((cells["cell_lon"] - STATIC_GRID / 2) / STATIC_GRID).astype(int)
    return set(zip(ilat, ilon))


def assign_regions(lat, lon):
    """Index into REGION_NAMES for each cell centre (last index = other areas)."""
    out = np.full(len(lat), len(REGION_BOXES), dtype=int)
    for i in range(len(REGION_BOXES) - 1, -1, -1):
        w, s, e, n = REGION_BOXES[i][1]
        inside = (lon >= w) & (lon < e) & (lat >= s) & (lat < n)
        out[inside] = i
    return out


def prepare(frames):
    """Combine sources, keep nominal and high confidence, drop static sources."""
    stats = {"downloaded": {}, "after_confidence": 0, "static_removed": 0}
    parts = []
    for source, df in frames.items():
        stats["downloaded"][source] = int(len(df))
        if df.empty:
            continue
        df = df.copy()
        df["source"] = source
        parts.append(df)
    if not parts:
        return pd.DataFrame(), stats
    df = pd.concat(parts, ignore_index=True)
    df = df.drop_duplicates(subset=["source", "latitude", "longitude", "acq_date", "acq_time"])

    conf = df["confidence"].astype(str).str.strip().str.lower().str[0]
    df = df[conf.isin(KEEP_CONFIDENCE)].copy()
    stats["after_confidence"] = int(len(df))

    # static heat sources (volcanoes, flares, factories)
    mask = load_static_mask()
    ilat = np.floor(df["latitude"].to_numpy() / STATIC_GRID + 1e-6).astype(int)
    ilon = np.floor(df["longitude"].to_numpy() / STATIC_GRID + 1e-6).astype(int)
    is_static = np.array([(a, b) in mask for a, b in zip(ilat, ilon)], dtype=bool)
    stats["static_removed"] = int(is_static.sum())
    df = df[~is_static].copy()

    time_str = df["acq_time"].astype(int).astype(str).str.zfill(4)
    df["dt"] = pd.to_datetime(df["acq_date"].astype(str) + " " + time_str, format="%Y-%m-%d %H%M")
    df["cell_lat"] = np.round(np.floor(df["latitude"] / CELL) * CELL + CELL / 2, 3)
    df["cell_lon"] = np.round(np.floor(df["longitude"] / CELL) * CELL + CELL / 2, 3)
    return df, stats


def usual_detections(dates, in_boxes_count):
    """Compare a recent single-satellite count with the usual one for the same days of the year.

    Simple approximation: the median monthly count of 2003-2025 (both source regions,
    from web/haze/data/haze_risk.json) is spread evenly over the days of the month and
    added up over the days of the window. Returns (usual, pct_vs_usual) or (None, None).
    """
    if not RISK_JSON.is_file():
        return None, None
    risk = json.loads(RISK_JSON.read_text(encoding="utf-8"))
    series = risk["series"]
    base_start, base_end = risk["meta"]["base_period"]
    counts = pd.DataFrame({
        "year": series["year"],
        "month": series["month"],
        "count": series["scopes"]["both"]["count"],
    })
    counts = counts[(counts["year"] >= base_start) & (counts["year"] <= base_end)]
    median_by_month = counts.groupby("month")["count"].median().to_dict()
    usual = 0.0
    for d in dates:
        days_in_month = pd.Timestamp(d.year, d.month, 1).days_in_month
        usual += median_by_month.get(d.month, 0.0) / days_in_month
    if usual <= 0:
        return round(usual, 1), None
    return round(usual, 1), round((in_boxes_count - usual) / usual * 100, 1)


def main_box_bounds():
    """Bounding boxes of Sumatra and Kalimantan used by the monthly index."""
    if RISK_JSON.is_file():
        regions = json.loads(RISK_JSON.read_text(encoding="utf-8"))["meta"]["regions"]
        return [tuple(r["bbox"]) for r in regions.values()]
    return [(95.0, -6.0, 106.0, 6.0), (108.0, -4.5, 118.5, 4.5)]


def build(df, stats, period_start, period_end):
    """Aggregate to the grid and build the output dictionary."""
    dates = [d.date() for d in pd.date_range(period_start, period_end)]
    total = int(len(df))

    # like-for-like count for the comparison: one satellite only, inside the two index boxes.
    # S-NPP if it has data in the window, otherwise NOAA-20.
    reference = next((s for s in REFERENCE_ORDER if (df["source"] == s).any()), None)
    if reference is None:
        ref_in_boxes, usual, pct = None, None, None
    else:
        ref = df[df["source"] == reference]
        inside = np.zeros(len(ref), dtype=bool)
        for w, s, e, n in main_box_bounds():
            inside |= ((ref["longitude"] > w) & (ref["longitude"] < e)
                       & (ref["latitude"] > s) & (ref["latitude"] < n)).to_numpy()
        ref_in_boxes = int(inside.sum())
        usual, pct = usual_detections(dates, ref_in_boxes)

    cells = (df.groupby(["cell_lat", "cell_lon"])
             .agg(count=("frp", "size"), frp=("frp", "sum"), last=("dt", "max"))
             .reset_index())
    cells["region"] = assign_regions(cells["cell_lat"].to_numpy(), cells["cell_lon"].to_numpy())
    cells["last_day"] = [(t.date() - period_start).days for t in cells["last"]]
    cells = cells.sort_values("frp", ascending=False).reset_index(drop=True)

    # region summary
    regions = []
    for i, name in enumerate(REGION_NAMES):
        sub_cells = cells[cells["region"] == i]
        if sub_cells.empty:
            regions.append({"name": name, "detections": 0, "frp_total": 0.0, "cells": 0, "last_detection": None})
            continue
        regions.append({
            "name": name,
            "detections": int(sub_cells["count"].sum()),
            "frp_total": round(float(sub_cells["frp"].sum()), 1),
            "cells": int(len(sub_cells)),
            "last_detection": sub_cells["last"].max().strftime("%Y-%m-%d %H:%M"),
        })

    by_satellite = {SOURCES[s]: int((df["source"] == s).sum()) for s in SOURCES}

    def pack(frame):
        return {
            "lat": [float(v) for v in frame["cell_lat"]],
            "lon": [float(v) for v in frame["cell_lon"]],
            "count": [int(v) for v in frame["count"]],
            "frp": [round(float(v), 1) for v in frame["frp"]],
            "last_day": [int(v) for v in frame["last_day"]],
            "region": [int(v) for v in frame["region"]],
        }

    def assemble(frame, dropped):
        return {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "period": {
                "start": period_start.isoformat(),
                "end": period_end.isoformat(),
                "days": len(dates),
                "note": "UTC acquisition dates. The last day may be incomplete (near real time latency).",
            },
            "source": "NASA FIRMS near real time, " + ", ".join(SOURCES),
            "filters": {
                "confidence": "nominal and high",
                "static_sources_removed": "cells of data/processed/static_source_cells.csv",
                "grid_degrees": CELL,
                "area": list(AREA),
            },
            "downloaded_rows": stats["downloaded"],
            "summary": {
                "total_detections": total,
                "total_frp_mw": round(float(df["frp"].sum()), 1),
                "by_satellite": by_satellite,
                "latest_detection": df["dt"].max().strftime("%Y-%m-%d %H:%M"),
                "static_removed": stats["static_removed"],
                "reference_satellite": SOURCES[reference] if reference else None,
                "reference_in_index_boxes": ref_in_boxes,
                "usual_in_index_boxes": usual,
                "pct_vs_usual": pct,
                "usual_note": ("Approximate: median monthly S-NPP-equivalent count 2003-2025 (Sumatra + "
                               "Kalimantan, web/haze/data/haze_risk.json) spread evenly over the days of the "
                               "window, compared with the detections of the reference satellite only "
                               "(S-NPP, or NOAA-20 when S-NPP has no data)."),
            },
            "regions_note": "Region boxes are approximate and do not follow administrative borders.",
            "region_boxes": {name: list(box) for name, box in REGION_BOXES},
            "regions": regions,
            "region_names": REGION_NAMES,
            "truncated_cells": dropped,
            "cells": pack(frame),
        }

    out, dropped = assemble(cells, 0), 0
    while len(json.dumps(out, separators=(",", ":"))) > MAX_JSON_BYTES and len(cells) > 100:
        keep = int(len(cells) * 0.9)          # cells are sorted by FRP, drop the weakest 10%
        dropped += len(cells) - keep
        cells = cells.iloc[:keep]
        out = assemble(cells, dropped)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--days", type=int, default=7, help="days to cover, ending today (UTC)")
    parser.add_argument("--out", default=str(OUT_JSON), help="output JSON path")
    parser.add_argument("--from-dir", help="folder with <SOURCE>.csv files to reprocess instead of downloading")
    args = parser.parse_args()

    today = datetime.now(timezone.utc).date()
    if args.from_dir:
        frames = load_from_dir(args.from_dir)
        if not frames:
            sys.exit(f"No <SOURCE>.csv files found in {args.from_dir}")
    else:
        key = load_key()
        if not key:
            sys.exit("FIRMS_MAP_KEY not found. Set it as an environment variable or in a .env file "
                     "in the repository root or in haze/.")
        windows = date_windows(today, args.days)
        frames, failed = {}, []
        for source in SOURCES:
            try:
                frames[source] = fetch_source(key, source, windows)
                print(f"{source}: {len(frames[source]):,} rows downloaded")
            except RuntimeError as err:
                failed.append(source)
                print(f"{source}: FAILED ({err})", file=sys.stderr)
        if len(failed) == len(SOURCES):
            sys.exit("All downloads failed, nothing written.")

    df, stats = prepare(frames)
    if df.empty:
        sys.exit("No detections left after filtering, nothing written.")

    if args.from_dir:
        period_start, period_end = df["dt"].min().date(), df["dt"].max().date()
    else:
        period_start, period_end = today - timedelta(days=args.days - 1), today

    out = build(df, stats, period_start, period_end)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))

    s = out["summary"]
    print(f"\nPeriod {out['period']['start']} to {out['period']['end']} (UTC)")
    print(f"Detections kept: {s['total_detections']:,} (static sources removed: {s['static_removed']:,})")
    print(f"By satellite: {s['by_satellite']}")
    print(f"Reference satellite: {s['reference_satellite']}  in index boxes: {s['reference_in_index_boxes']}  "
          f"usual: {s['usual_in_index_boxes']}  vs usual: {s['pct_vs_usual']}%")
    for r in sorted(out["regions"], key=lambda r: r["frp_total"], reverse=True):
        print(f"  {r['name']:<24} {r['detections']:>7,} detections  FRP {r['frp_total']:>10,.0f} MW")
    size = out_path.stat().st_size
    print(f"\nWrote {out_path}  ({size / 1024:.0f} KB, {len(out['cells']['lat']):,} cells)")


if __name__ == "__main__":
    main()
