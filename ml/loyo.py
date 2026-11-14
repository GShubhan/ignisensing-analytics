"""
Leave-one-year-out (LOYO) evaluation: the closest test to how the model is really used.

The final model is trained on ALL overlap years and applied to an unseen year (2003-2011).
LOYO mimics that: for each overlap year, train on every other year, predict the hidden year.
No direction in time is assumed, which is fine for harmonization (we are converting between
two sensors, not forecasting).

Run: python ml/loyo.py      (results -> ml/outputs/loyo.md)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import lightgbm as lgb
import numpy as np
import pandas as pd

from features import FEATURES_V1, ROOT, add_features, load_wide, overlap

PARAMS = dict(objective="tweedie", tweedie_variance_power=1.3, n_estimators=600, learning_rate=0.05,
              num_leaves=63, min_child_samples=20, subsample=0.8, subsample_freq=1,
              colsample_bytree=0.9, random_state=42, verbose=-1)
OUT = ROOT / "ml" / "outputs"

ov = overlap(add_features(load_wide()))
rows, monthly = [], []
for yr in sorted(ov.year.unique()):
    tr, te = ov[ov.year != yr], ov[ov.year == yr]
    k = tr.count_N.sum() / tr.modis.sum()
    p_ratio = k * te.modis.to_numpy()
    p_lgbm = lgb.LGBMRegressor(**PARAMS).fit(tr[FEATURES_V1], tr.count_N).predict(te[FEATURES_V1])
    preds = {"Ratio": p_ratio, "LightGBM": p_lgbm, "Blend 50/50": 0.5 * (p_ratio + p_lgbm)}
    real = te.count_N.sum()
    rows.append({"year": yr, "real VIIRS": real,
                 **{f"{m} bias %": 100 * (p.sum() / real - 1) for m, p in preds.items()}})
    m = te.assign(**preds).groupby("ym")[["count_N", *preds]].sum()
    monthly.append(m)
    print(f"{yr}: " + ", ".join(f"{k_} {v:+.1f}%" for k_, v in rows[-1].items() if k_.endswith("%")), flush=True)

res = pd.DataFrame(rows).set_index("year")
mon = pd.concat(monthly)
summary = {}
for mname in ["Ratio", "LightGBM", "Blend 50/50"]:
    b = res[f"{mname} bias %"]
    mape = 100 * (np.abs(mon[mname] - mon.count_N) / mon.count_N.clip(lower=1)).mean()
    summary[mname] = {"Mean |annual bias| %": b.abs().mean(), "Worst annual bias %": b.loc[b.abs().idxmax()],
                      "Monthly MAPE %": mape, "Overall bias %": 100 * (mon[mname].sum() / mon.count_N.sum() - 1)}
summary = pd.DataFrame(summary).T
print("\n", summary.round(2).to_string())

with open(OUT / "loyo.md", "w", encoding="utf-8") as f:
    f.write("# Leave-one-year-out evaluation\n\nEach overlap year is hidden in turn; models are trained on all "
            "other years and predict the hidden year. This matches the real use: the final model is trained on "
            "all overlap years and applied to unseen years (2003-2011).\n\n")
    f.write("## Summary\n\n" + summary.round(2).to_markdown() + "\n\n")
    f.write("## Annual bias per hidden year\n\n" + res.round(1).to_markdown() + "\n")
print(f"\nWrote {OUT / 'loyo.md'}")
