
from pathlib import Path
import pandas as pd

raw_folder = Path(__file__).resolve().parent / "raw"

for file in sorted(raw_folder.rglob("*.csv")):
    print(f"\nFILE: {file.name}")

    total_rows = 0
    missing_values = None
    invalid_coordinates = 0
    invalid_times = 0

    for chunk in pd.read_csv(file, chunksize=100000, low_memory=False):
        total_rows += len(chunk)

        missing = chunk.isna().sum()
        if missing_values is None:
            missing_values = missing
        else:
            missing_values = missing_values.add(missing, fill_value=0)

        invalid_coordinates += (
            ~chunk["latitude"].between(-90, 90)
            | ~chunk["longitude"].between(-180, 180)
        ).sum()

        times = chunk["acq_time"].astype(str).str.zfill(4)
        valid_times = (
            times.str.fullmatch(r"\d{4}")
            & times.str[:2].astype(int).between(0, 23)
            & times.str[2:].astype(int).between(0, 59)
        )
        invalid_times += (~valid_times).sum()

    print(f"Total rows: {total_rows:,}")
    print("Missing values:")
    print(missing_values[missing_values > 0].to_string())
    print(f"Invalid coordinates: {invalid_coordinates:,}")
    print(f"Invalid acquisition times: {invalid_times:,}")
    print("-" * 50)