from pathlib import Path
import pandas as pd

raw_folder = Path(__file__).resolve().parent / "raw"

for file in sorted(raw_folder.rglob("*.csv")):
    print(f"\nFILE: {file.name}", flush=True)

    seen = set()
    duplicate_count = 0
    total_rows = 0
    confidence_values = set()
    invalid_dates = 0

    for chunk in pd.read_csv(file, chunksize=100000, low_memory=False):
        total_rows += len(chunk)

        hashes = pd.util.hash_pandas_object(chunk, index=False)

        for value in hashes:
            if value in seen:
                duplicate_count += 1
            else:
                seen.add(value)

        confidence_values.update(
            chunk["confidence"].dropna().astype(str).unique()
        )

        dates = pd.to_datetime(chunk["acq_date"], errors="coerce")
        invalid_dates += dates.isna().sum()

    print(f"Total rows: {total_rows:,}")
    print(f"Exact duplicate rows: {duplicate_count:,}")
    print(f"Invalid dates: {invalid_dates:,}")
    print(f"Confidence values: {sorted(confidence_values)}")
    print("-" * 50)
