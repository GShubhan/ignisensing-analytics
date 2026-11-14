"""
Shared data loading, feature engineering and metrics for the harmonization model.
Used by harmonize.py (final model) and experiments.py (feature + settings search).
"""
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, r2_score

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "processed" / "cell_monthly_counts.csv"
GRID = 0.25

# Overlap period, Standard (SP) archive months only.
#  - Jan 2012 excluded: VIIRS S-NPP data starts 20 Jan 2012 (partial month)
#  - after Jul 2026 excluded: VIIRS is NRT only from Aug 2026
TRAIN_START, TRAIN_END = 201202, 202607

# v1 = original feature set. v2 = v1 + Terra/Aqua separately, previous/next month, 5x5 neighbourhood.
FEATURES_V1 = ["log_modis", "modis_frp", "log_modis_3x3", "log_modis_region", "log_cell_mean",
               "month", "cell_lat", "cell_lon"]
FEATURES_V2 = FEATURES_V1 + ["log_A", "log_T", "log_modis_5x5",
                             "log_modis_prev", "log_modis_next", "log_modis_3x3_prev", "log_modis_3x3_next"]


def load_wide(path: Path = DATA) -> pd.DataFrame:
    """One row per cell-month, with count_/mean_frp_ columns per satellite (T, A, N)."""
    c = pd.read_csv(path)
    w = c.pivot_table(index=["cell_lat", "cell_lon", "year", "month"], columns="satellite",
                      values=["count", "mean_frp"], aggfunc="first")
    w.columns = [f"{v}_{s}" for v, s in w.columns]
    w = w.reset_index()
    w["ym"] = w.year * 100 + w.month
    w["t"] = w.year * 12 + w.month - 1          # month index, for shifting in time
    w["gi"] = np.round((w.cell_lat - GRID / 2) / GRID).astype(int)
    w["gj"] = np.round((w.cell_lon - GRID / 2) / GRID).astype(int)
    return w


def _shifted(w: pd.DataFrame, col: str, di=0, dj=0, dt=0) -> np.ndarray:
    """Value of `col` at the cell (gi+di, gj+dj) and month t+dt, aligned to w's rows (0 if absent)."""
    src = w[["gi", "gj", "t", col]].assign(gi=w.gi - di, gj=w.gj - dj, t=w.t - dt)
    m = w[["gi", "gj", "t"]].merge(src, on=["gi", "gj", "t"], how="left")[col].to_numpy()
    return np.nan_to_num(m)


def _block_sum(w: pd.DataFrame, col: str, radius: int, dt=0) -> np.ndarray:
    total = np.zeros(len(w))
    for di in range(-radius, radius + 1):
        for dj in range(-radius, radius + 1):
            total += _shifted(w, col, di, dj, dt)
    return total


def add_features(w: pd.DataFrame, sats=("T", "A"), extended=True) -> pd.DataFrame:
    w = w.copy()
    cnt = [f"count_{s}" for s in sats]
    frp = [f"mean_frp_{s}" for s in sats]

    w["modis"] = w[cnt].sum(axis=1)
    frp_sum = sum(w[f].fillna(0) * w[c] for f, c in zip(frp, cnt))
    w["modis_frp"] = (frp_sum / w["modis"]).where(w["modis"] > 0)
    w["log_modis"] = np.log1p(w["modis"])
    # VIIRS finds small fires near the larger ones MODIS sees
    w["log_modis_3x3"] = np.log1p(_block_sum(w, "modis", 1))
    # VIIRS/MODIS ratio is higher in big fire months
    w["log_modis_region"] = np.log1p(w.groupby("ym")["modis"].transform("sum"))
    # How fiery this cell usually is (MODIS only, so no VIIRS information leaks in)
    w["log_cell_mean"] = np.log1p(w.groupby(["gi", "gj"])["modis"].transform("mean"))

    if extended:
        w["log_A"] = np.log1p(w["count_A"])
        w["log_T"] = np.log1p(w["count_T"])
        w["log_modis_5x5"] = np.log1p(_block_sum(w, "modis", 2))
        # Fires persist across months; MODIS is known for every month, so both directions are allowed
        w["log_modis_prev"] = np.log1p(_shifted(w, "modis", dt=-1))
        w["log_modis_next"] = np.log1p(_shifted(w, "modis", dt=1))
        w["log_modis_3x3_prev"] = np.log1p(_block_sum(w, "modis", 1, dt=-1))
        w["log_modis_3x3_next"] = np.log1p(_block_sum(w, "modis", 1, dt=1))
    return w


def overlap(feat: pd.DataFrame) -> pd.DataFrame:
    return feat[(feat.ym >= TRAIN_START) & (feat.ym <= TRAIN_END)]


def score(df: pd.DataFrame, pred: np.ndarray) -> dict:
    """Metrics at cell level and on monthly totals (what the calendar shows)."""
    y = df["count_N"].to_numpy()
    actual_m = df.groupby("ym")["count_N"].sum()
    pred_m = pd.Series(pred, index=df.index).groupby(df.ym).sum()
    return {
        "Cell MAE": mean_absolute_error(y, pred),
        "Cell R2": r2_score(y, pred),
        "Monthly-total R2": r2_score(actual_m, pred_m),
        "Monthly-total MAPE %": 100 * np.mean(np.abs(pred_m - actual_m) / actual_m.clip(lower=1)),
        "Total bias %": 100 * (pred.sum() / y.sum() - 1),
    }
