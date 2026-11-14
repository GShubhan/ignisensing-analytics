from pathlib import Path
from collections import defaultdict
import json
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'data/processed'
with (ROOT / 'data/fire_filter_config.json').open() as file:
    config = json.load(file)

HOTSPOT_COLUMNS = [
    'date', 'time', 'lat', 'lon', 'sensor', 'satellite',
    'confidence', 'confidence_raw', 'frp', 'daynight',
    'source', 'fire_type', 'static_source_mask', 'vegetation_flag'
]
CELL_COLUMNS = [
    'cell_lat', 'cell_lon', 'year', 'month', 'sensor',
    'satellite', 'count', 'mean_frp'
]


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def run():
    static = pd.read_csv(OUT / 'static_source_cells.csv')
    check(static.columns.tolist() == ['cell_lat', 'cell_lon'], 'Static-cell columns differ')
    check(not static.duplicated().any(), 'Duplicate static cells')
    mask_size = float(config['grid_size_degrees'])
    static_idx = set(zip(
        np.rint((static['cell_lat'].to_numpy() + 90) / mask_size - 0.5).astype(int),
        np.rint((static['cell_lon'].to_numpy() + 180) / mask_size - 0.5).astype(int)
    ))
    hotspot_counts = defaultdict(int)
    vegetation_counts = defaultdict(int)
    vegetation_frp = defaultdict(float)
    active_cells = set()
    missing_or_bad = 0
    masked = 0
    last_month = None

    for chunk in pd.read_csv(OUT / 'hotspots.csv', chunksize=100000,
                             dtype={'time': 'string', 'confidence_raw': 'string'}):
        check(chunk.columns.tolist() == HOTSPOT_COLUMNS, 'Hotspots columns differ')
        dates = pd.to_datetime(chunk['date'], errors='coerce')
        valid = (
            dates.notna()
            & chunk['time'].str.fullmatch(r'\d{4}').fillna(False)
            & chunk['lat'].between(-90, 90) & chunk['lon'].between(-180, 180)
            & chunk['frp'].notna()
            & chunk['sensor'].isin(['MODIS', 'VIIRS'])
            & chunk['satellite'].isin(['T', 'A', 'N'])
            & chunk['confidence'].isin(['nominal', 'high'])
            & chunk['source'].isin(['SP', 'NRT'])
            & chunk['static_source_mask'].isin([0, 1])
            & chunk['vegetation_flag'].isin([0, 1])
            & chunk['daynight'].isin(['D', 'N'])
        )
        missing_or_bad += int((~valid).sum())
        check((chunk.loc[chunk['satellite'].isin(['T', 'A']), 'sensor'] == 'MODIS').all(), 'MODIS mismatch')
        check((chunk.loc[chunk['satellite'] == 'N', 'sensor'] == 'VIIRS').all(), 'VIIRS mismatch')
        check((dates.dt.year >= np.where(chunk['satellite'] == 'N', 2012, 2003)).all(), 'Year mismatch')
        modis = chunk['sensor'] == 'MODIS'
        raw_modis = pd.to_numeric(chunk.loc[modis, 'confidence_raw'], errors='coerce')
        check(raw_modis.ge(30).all(), 'MODIS confidence filter failed')
        check(chunk.loc[~modis, 'confidence_raw'].isin(['n', 'h']).all(), 'VIIRS confidence filter failed')
        check((chunk.loc[modis, 'confidence'].to_numpy() == np.where(raw_modis >= 80, 'high', 'nominal')).all(), 'MODIS category mismatch')
        check((chunk.loc[~modis, 'confidence'].to_numpy() == chunk.loc[~modis, 'confidence_raw'].map({'n': 'nominal', 'h': 'high'}).to_numpy()).all(), 'VIIRS category mismatch')
        sp = chunk['source'] == 'SP'
        check(chunk.loc[sp, 'fire_type'].isin([0, 1, 2, 3]).all(), 'Archive fire types invalid')
        check(chunk.loc[~sp, 'fire_type'].isna().all(), 'NRT fire types must be empty')
        check((chunk.loc[sp, 'vegetation_flag'] == (chunk.loc[sp, 'fire_type'] == 0).astype(int)).all(), 'Archive vegetation flags wrong')
        check((chunk.loc[~sp, 'vegetation_flag'] == 1 - chunk.loc[~sp, 'static_source_mask']).all(), 'NRT vegetation flags wrong')
        lat_idx = np.floor((chunk['lat'].to_numpy() + 90) / mask_size).astype(int)
        lon_idx = np.floor((chunk['lon'].to_numpy() + 180) / mask_size).astype(int)
        expected_mask = np.fromiter(((a, b) in static_idx for a, b in zip(lat_idx, lon_idx)), dtype=int, count=len(chunk))
        if not config['apply_mask']:
            expected_mask[:] = 0
        check((chunk['static_source_mask'].to_numpy() == expected_mask).all(), 'Spatial mask mismatch')
        masked += int(chunk['static_source_mask'].sum())
        hotspot_counts['all'] += len(chunk)
        veg = chunk.loc[chunk['vegetation_flag'] == 1]
        if veg.empty:
            continue
        periods = pd.to_datetime(veg['date']).dt.to_period('M')
        latest = periods.max()
        if last_month is None or latest > last_month:
            last_month = latest
        ilat = np.floor((veg['lat'].to_numpy() + 90) / 0.25).astype(int)
        ilon = np.floor((veg['lon'].to_numpy() + 180) / 0.25).astype(int)
        frame = pd.DataFrame({
            'la': ilat, 'lo': ilon,
            'year': periods.dt.year.to_numpy(), 'month': periods.dt.month.to_numpy(),
            'sat': veg['satellite'].to_numpy(), 'frp': veg['frp'].to_numpy()
        })
        active_cells.update(zip(ilat.tolist(), ilon.tolist()))
        groups = frame.groupby(['la', 'lo', 'year', 'month', 'sat'])['frp'].agg(['size', 'sum'])
        for (la, lo, year, month, sat), row in groups.iterrows():
            key = (int(la), int(lo), int(year), int(month), sat)
            vegetation_counts[key] += int(row['size'])
            vegetation_frp[key] += float(row['sum'])

    check(missing_or_bad == 0, f'{missing_or_bad} invalid hotspot rows')
    check(last_month is not None, 'No vegetation detections')
    count_rows = 0
    nonzero_seen = set()
    zero_rows = 0
    for chunk in pd.read_csv(OUT / 'cell_monthly_counts.csv', chunksize=100000):
        check(chunk.columns.tolist() == CELL_COLUMNS, 'Cell count columns differ')
        check(chunk['count'].ge(0).all(), 'Negative monthly count')
        check(chunk['satellite'].isin(['T', 'A', 'N']).all(), 'Unknown satellite')
        check((chunk['sensor'] == chunk['satellite'].map({'T': 'MODIS', 'A': 'MODIS', 'N': 'VIIRS'})).all(), 'Sensor mismatch')
        check((chunk['year'] >= np.where(chunk['satellite'] == 'N', 2012, 2003)).all(), 'Period mismatch')
        check(chunk['month'].between(1, 12).all(), 'Invalid month')
        check(chunk.loc[chunk['count'] == 0, 'mean_frp'].isna().all(), 'Zero rows must have empty FRP')
        check(chunk.loc[chunk['count'] > 0, 'mean_frp'].notna().all(), 'Nonzero rows require FRP')
        ilat = np.rint((chunk['cell_lat'].to_numpy() + 90 - 0.125) / 0.25).astype(int)
        ilon = np.rint((chunk['cell_lon'].to_numpy() + 180 - 0.125) / 0.25).astype(int)
        # Check centres and eligible cell membership in vectorized batches.
        check(np.allclose(chunk['cell_lat'].to_numpy(), (ilat + 0.5) * 0.25 - 90), 'Invalid latitude centres')
        check(np.allclose(chunk['cell_lon'].to_numpy(), (ilon + 0.5) * 0.25 - 180), 'Invalid longitude centres')
        output_cells = pd.MultiIndex.from_arrays([ilat, ilon])
        eligible_cells = pd.MultiIndex.from_tuples(sorted(active_cells))
        check(output_cells.isin(eligible_cells).all(), 'Unknown output cell')
        positive = chunk['count'].to_numpy() > 0
        zero_rows += int((~positive).sum())
        nonzero = chunk.loc[positive]
        for la, lo, year, month, sat, count, avg in zip(
            ilat[positive], ilon[positive], nonzero['year'], nonzero['month'],
            nonzero['satellite'], nonzero['count'], nonzero['mean_frp']
        ):
            key = (int(la), int(lo), int(year), int(month), sat)
            expected = vegetation_counts.get(key, 0)
            check(int(count) == expected and expected > 0, f'Count mismatch: {key}')
            check(abs(float(avg) - vegetation_frp[key] / expected) < 1e-5, f'FRP mismatch: {key}')
            check(key not in nonzero_seen, f'Duplicate nonzero group: {key}')
            nonzero_seen.add(key)
        count_rows += len(chunk)

    expected_rows = len(active_cells) * (
        2 * len(pd.period_range('2003-01', last_month, freq='M'))
        + len(pd.period_range('2012-01', last_month, freq='M'))
    )
    check(count_rows == expected_rows, f'Expected {expected_rows:,} full-panel rows; got {count_rows:,}')
    check(len(nonzero_seen) == len(vegetation_counts), 'Missing nonzero cell-month groups')
    print('VERIFICATION PASSED')
    print(f'Hotspots after filters: {hotspot_counts["all"]:,}')
    print(f'Static-source cells: {len(static_idx):,}')
    print(f'Masked detections: {masked:,}')
    print(f'Cell-month rows: {count_rows:,} (zero rows: {zero_rows:,})')


if __name__ == '__main__':
    run()
