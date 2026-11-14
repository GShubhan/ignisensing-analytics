from pathlib import Path
import pandas as pd

processed_folder = Path("data/processed")
monthly_file = processed_folder / "monthly_counts.csv"

df = pd.read_csv(monthly_file)

for sensor in ["MODIS", "VIIRS"]:
    sensor_data = df[df["sensor"] == sensor].copy()

    sensor_data["date"] = pd.to_datetime(
        sensor_data[["year", "month"]].assign(day=1)
    )

    first_month = sensor_data["date"].min()
    last_month = sensor_data["date"].max()

    expected_months = pd.date_range(
        start=first_month,
        end=last_month,
        freq="MS"
    )

    recorded_months = pd.DatetimeIndex(sensor_data["date"])
    missing_months = expected_months.difference(recorded_months)

    print(f"\nSENSOR: {sensor}")
    print(f"First recorded month: {first_month:%Y-%m}")
    print(f"Last recorded month: {last_month:%Y-%m}")
    print(f"Expected months: {len(expected_months)}")
    print(f"Recorded months: {len(recorded_months)}")
    print(f"Missing months: {len(missing_months)}")

    for month in missing_months:
        print(f"  {month:%Y-%m}")

    print("-" * 50)