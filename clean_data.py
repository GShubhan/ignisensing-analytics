from pathlib import Path
from collections import defaultdict
import json
import os
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
RAW = ROOT / 'data/raw'
OUT = ROOT / 'data/processed'
OUT.mkdir(parents=True, exist_ok=True)
with (ROOT / 'data/fire_filter_config.json').open() as f:
    config = json.load(f)

MASK_GRID = float(config['grid_size_degrees'])
MIN_MONTHS = int(config['minimum_archive_months'])
STATIC_TYPES = set(config['static_source_types'])
APPLY_MASK = config['apply_mask']
TRAIN_GRID = 0.25
CHUNK_SIZE = 100000
if MASK_GRID <= 0 or MIN_MONTHS < 1 or not STATIC_TYPES.issubset({1, 2}):
    raise ValueError('Invalid spatial mask settings')

HOTSPOT_COLUMNS = [
    'date', 'time', 'lat', 'lon', 'sensor', 'satellite',
    'confidence', 'confidence_raw', 'frp', 'daynight',
    'source', 'fire_type', 'static_source_mask', 'vegetation_flag'
]
SATELLITES = {'Terra': 'T', 'Aqua': 'A', 'SNPP': 'N'}
VIIRS_CONFIDENCE = {'l': 'low', 'n': 'nominal', 'h': 'high'}
START_MONTH = {'T': '2003-01', 'A': '2003-01', 'N': '2012-01'}


def selected_files():
    files = sorted(RAW.rglob('*.csv'))
    if not files:
        raise FileNotFoundError(f'No CSV files under {RAW}')
    return [f for f in files if 'M-C61' in f.name or 'SV-C2' in f.name]


def filtered_chunks(file):
    sensor = 'MODIS' if 'M-C61' in file.name else 'VIIRS'
    source = 'SP' if file.name.startswith('fire_archive_') else 'NRT'
    if not file.name.startswith(('fire_archive_', 'fire_nrt_')):
        raise ValueError(f'Unexpected filename: {file.name}')

    for chunk in pd.read_csv(file, chunksize=CHUNK_SIZE, low_memory=False):
        dates = pd.to_datetime(chunk['acq_date'], errors='coerce')
        year_ok = dates.dt.year.ge(2003 if sensor == 'MODIS' else 2012)
        sat_ok = chunk['satellite'].isin(['Terra', 'Aqua'] if sensor == 'MODIS' else ['SNPP'])
        if sensor == 'MODIS':
            confidence = pd.to_numeric(chunk['confidence'], errors='coerce')
            conf_ok = confidence.ge(30)
        else:
            conf_ok = chunk['confidence'].astype(str).str.strip().isin(['n', 'h'])
        chunk = chunk.loc[year_ok & sat_ok & conf_ok].copy()
        if not chunk.empty:
            yield chunk, sensor, source


def cell_indices(lat, lon, size):
    # Floor from a fixed geographic origin. Same grid for mask creation and lookup.
    return (
        np.floor((lat.to_numpy(dtype=float) + 90) / size).astype(np.int32),
        np.floor((lon.to_numpy(dtype=float) + 180) / size).astype(np.int32)
    )


def create_static_cells(files):
    # Count DISTINCT calendar months, not number of detections or days.
    cell_months = defaultdict(set)
    print('Building static-source mask...', flush=True)
    for file in files:
        if not file.name.startswith('fire_archive_'):
            continue
        for chunk, _, _ in filtered_chunks(file):
            if 'type' not in chunk.columns:
                raise ValueError(f'Archive missing type column: {file}')
            static = chunk.loc[chunk['type'].isin(STATIC_TYPES)]
            if static.empty:
                continue
            ys = pd.to_datetime(static['acq_date']).dt.to_period('M').astype(str).to_numpy()
            lat_idx, lon_idx = cell_indices(static['latitude'], static['longitude'], MASK_GRID)
            for la, lo, month in zip(lat_idx, lon_idx, ys):
                cell_months[(int(la), int(lo))].add(month)
    cells = {cell for cell, months in cell_months.items() if len(months) >= MIN_MONTHS}
    mask_df = pd.DataFrame([
        {'cell_lat': round((la + 0.5) * MASK_GRID - 90, 6),
         'cell_lon': round((lo + 0.5) * MASK_GRID - 180, 6)}
        for la, lo in sorted(cells)
    ], columns=['cell_lat', 'cell_lon'])
    return cells, mask_df


def process():
    files = selected_files()
    print('Selected:', ', '.join(f.name for f in files), flush=True)
    static_cells, mask_df = create_static_cells(files)
    print(f'Static-source cells: {len(static_cells):,}', flush=True)

    # Accumulate only nonzero cell/month/satellite groups; fill zeros at export.
    cell_stats = defaultdict(lambda: [0, 0.0])
    active_cells = set()
    latest_month = None
    total = 0
    vegetated = 0
    masked_total = 0
    hotspots_tmp = OUT / 'hotspots.tmp.csv'
    cells_tmp = OUT / 'static_source_cells.tmp.csv'
    counts_tmp = OUT / 'cell_monthly_counts.tmp.csv'
    header = True
    try:
        for file in files:
            file_rows = 0
            print(f'Processing {file.name}...', flush=True)
            for chunk, sensor, source in filtered_chunks(file):
                chunk = chunk.rename(columns={
                    'acq_date': 'date', 'acq_time': 'time',
                    'latitude': 'lat', 'longitude': 'lon'
                })
                chunk['satellite'] = chunk['satellite'].map(SATELLITES)
                chunk['sensor'] = sensor
                chunk['source'] = source
                chunk['time'] = chunk['time'].astype(str).str.zfill(4)
                chunk['confidence_raw'] = chunk['confidence'].astype(str).str.strip()
                if sensor == 'MODIS':
                    numeric = pd.to_numeric(chunk['confidence_raw'], errors='coerce')
                    chunk['confidence'] = pd.cut(
                        numeric, bins=[-1, 29, 79, 100],
                        labels=['low', 'nominal', 'high']
                    ).astype('string')
                else:
                    chunk['confidence'] = chunk['confidence_raw'].map(VIIRS_CONFIDENCE)
                chunk['lat'] = pd.to_numeric(chunk['lat'], errors='coerce')
                chunk['lon'] = pd.to_numeric(chunk['lon'], errors='coerce')
                chunk['frp'] = pd.to_numeric(chunk['frp'], errors='coerce')
                dates = pd.to_datetime(chunk['date'], errors='coerce')
                valid_time = chunk['time'].str.fullmatch(r'\d{4}').fillna(False)
                hours = pd.to_numeric(chunk['time'].str[:2], errors='coerce')
                minutes = pd.to_numeric(chunk['time'].str[2:], errors='coerce')
                bad = (
                    dates.isna() | chunk[['lat', 'lon', 'frp', 'satellite', 'confidence']].isna().any(axis=1)
                    | ~chunk['lat'].between(-90, 90) | ~chunk['lon'].between(-180, 180)
                    | ~chunk['daynight'].isin(['D', 'N']) | ~valid_time
                    | ~hours.between(0, 23) | ~minutes.between(0, 59)
                )
                if bad.any():
                    raise ValueError(f'{file.name}: {int(bad.sum())} invalid selected rows')

                if source == 'SP':
                    if 'type' not in chunk:
                        raise ValueError(f'Missing archive type: {file}')
                    chunk['fire_type'] = pd.to_numeric(chunk['type'], errors='coerce').astype('Int64')
                    if not chunk['fire_type'].isin([0, 1, 2, 3]).all():
                        raise ValueError(f'Unexpected type in {file}')
                else:
                    chunk['fire_type'] = pd.Series(pd.NA, index=chunk.index, dtype='Int64')

                mask_lat, mask_lon = cell_indices(chunk['lat'], chunk['lon'], MASK_GRID)
                if APPLY_MASK:
                    flags = np.fromiter(
                        ((int(a), int(b)) in static_cells for a, b in zip(mask_lat, mask_lon)),
                        dtype=np.int8, count=len(chunk)
                    )
                else:
                    flags = np.zeros(len(chunk), dtype=np.int8)
                chunk['static_source_mask'] = flags
                if source == 'SP':
                    chunk['vegetation_flag'] = (chunk['fire_type'] == 0).astype('int8')
                else:
                    chunk['vegetation_flag'] = 1 - flags

                chunk[HOTSPOT_COLUMNS].to_csv(
                    hotspots_tmp, mode='w' if header else 'a', header=header, index=False
                )
                header = False
                file_rows += len(chunk)
                total += len(chunk)
                masked_total += int(flags.sum())

                veg = chunk.loc[chunk['vegetation_flag'] == 1]
                vegetated += len(veg)
                if veg.empty:
                    continue
                lat_idx, lon_idx = cell_indices(veg['lat'], veg['lon'], TRAIN_GRID)
                periods = pd.to_datetime(veg['date']).dt.to_period('M')
                last = periods.max()
                if latest_month is None or last > latest_month:
                    latest_month = last
                grouped = pd.DataFrame({
                    'la': lat_idx, 'lo': lon_idx,
                    'year': periods.dt.year.to_numpy(),
                    'month': periods.dt.month.to_numpy(),
                    'sat': veg['satellite'].to_numpy(),
                    'frp': veg['frp'].to_numpy()
                }).groupby(['la', 'lo', 'year', 'month', 'sat'])['frp'].agg(['size', 'sum'])
                for (la, lo, year, month, sat), row in grouped.iterrows():
                    la, lo, year, month = int(la), int(lo), int(year), int(month)
                    key = (la, lo, year, month, sat)
                    cell_stats[key][0] += int(row['size'])
                    cell_stats[key][1] += float(row['sum'])
                    active_cells.add((la, lo))
            print(f'Kept {file_rows:,} rows', flush=True)

        if header:
            raise ValueError('No detections passed filters')
        if not active_cells:
            raise ValueError('No vegetation detections to aggregate')
        mask_df.to_csv(cells_tmp, index=False)
        print(f'Writing zero-filled cell/month table for {len(active_cells):,} cells...', flush=True)
        # A cell with any vegetation detection is represented for EVERY satellite/month.
        # Use small batches to avoid materializing a very large rectangular panel.
        sorted_cells = sorted(active_cells)
        write_header = True
        row_total = 0
        for sat in ['T', 'A', 'N']:
            start = pd.Period(START_MONTH[sat], freq='M')
            for period in pd.period_range(start, latest_month, freq='M'):
                year, month = int(period.year), int(period.month)
                records = []
                for la, lo in sorted_cells:
                    count, sum_frp = cell_stats.get((la, lo, year, month, sat), (0, 0.0))
                    records.append((
                        round((la + 0.5) * TRAIN_GRID - 90, 6),
                        round((lo + 0.5) * TRAIN_GRID - 180, 6),
                        year, month, 'MODIS' if sat in ('T', 'A') else 'VIIRS', sat,
                        count, sum_frp / count if count else None
                    ))
                pd.DataFrame(records, columns=[
                    'cell_lat', 'cell_lon', 'year', 'month', 'sensor', 'satellite',
                    'count', 'mean_frp'
                ]).to_csv(counts_tmp, mode='w' if write_header else 'a',
                          header=write_header, index=False)
                row_total += len(records)
                write_header = False
        os.replace(hotspots_tmp, OUT / 'hotspots.csv')
        os.replace(cells_tmp, OUT / 'static_source_cells.csv')
        os.replace(counts_tmp, OUT / 'cell_monthly_counts.csv')
        print('\nPROCESSING COMPLETE')
        print(f'Hotspots (after filters): {total:,}')
        print(f'Vegetation-flagged hotspots: {vegetated:,}')
        print(f'Masked detections (SP + NRT): {masked_total:,}')
        print(f'Static-source cells: {len(static_cells):,}')
        print(f'Cell-month rows (including zeros): {row_total:,}')
    finally:
        for path in [hotspots_tmp, cells_tmp, counts_tmp]:
            if path.exists():
                path.unlink()


if __name__ == '__main__':
    process()
