from pathlib import Path
import pandas as pd

raw_folder = Path("data/raw")

for file in sorted(raw_folder.rglob("*.csv")):
    print(f"\nFILE: {file.name}")

    total_rows = 0
    first_chunk = True
    earliest = None
    latest = None

    for chunk in pd.read_csv(file, chunksize=100000, low_memory=False):
        total_rows += len(chunk)

        if first_chunk:
            print("Columns:", chunk.columns.tolist())
            first_chunk = False

        if "acq_date" in chunk.columns:
            dates = pd.to_datetime(chunk["acq_date"], errors="coerce")
            if dates.notna().any():
                chunk_min = dates.min()
                chunk_max = dates.max()
                earliest = chunk_min if earliest is None else min(earliest, chunk_min)
                latest = chunk_max if latest is None else max(latest, chunk_max)

    print("Rows:", f"{total_rows:,}")
    print("Date range:", earliest, "to", latest)
    print("-" * 50)