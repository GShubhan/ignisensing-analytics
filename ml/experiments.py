"""
Feature and settings search for the harmonization model, using ONLY the training years.

Time-series cross-validation inside Feb 2012 - Dec 2020 (expanding window):
    fold 1: train 2012-02..2016-12, validate 2017
    fold 2: train 2012-02..2017-12, validate 2018
    fold 3: train 2012-02..2018-12, validate 2019
    fold 4: train 2012-02..2019-12, validate 2020
The 2021+ test set is never touched here, so the final test numbers stay honest.

Run: python ml/experiments.py      (results -> ml/outputs/experiments.md)
"""
# %% Setup
import itertools
import time

import lightgbm as lgb
import numpy as np
import pandas as pd

from features import FEATURES_V1, FEATURES_V2, ROOT, add_features, load_wide, overlap, score

OUT = ROOT / "ml" / "outputs"
OUT.mkdir(parents=True, exist_ok=True)
TEST_START = 202101
FOLDS = [(201701, 201712), (201801, 201812), (201901, 201912), (202001, 202012)]
SEED = 42

BASE = dict(objective="tweedie", tweedie_variance_power=1.3, n_estimators=600, learning_rate=0.05,
            num_leaves=63, min_child_samples=50, subsample=0.8, subsample_freq=1,
            colsample_bytree=0.9, random_state=SEED, verbose=-1)

t0 = time.time()
data = overlap(add_features(load_wide()))
dev = data[data.ym < TEST_START]          # training years only
print(f"features built in {time.time() - t0:.0f}s, {len(dev):,} dev rows")


def cv(features, params):
    """Mean metrics over the 4 time-series folds."""
    rows = []
    for vs, ve in FOLDS:
        tr, va = dev[dev.ym < vs], dev[(dev.ym >= vs) & (dev.ym <= ve)]
        m = lgb.LGBMRegressor(**params).fit(tr[features], tr["count_N"])
        rows.append(score(va, m.predict(va[features])))
    r = pd.DataFrame(rows)
    out = r.mean().to_dict()
    out["MAPE fold spread"] = f"{r['Monthly-total MAPE %'].min():.1f}-{r['Monthly-total MAPE %'].max():.1f}"
    return out


# %% Step 1: feature sets (fixed settings)
step1 = {}
for name, feats in [("v1 (original 8)", FEATURES_V1), ("v2 (15 features)", FEATURES_V2)]:
    t = time.time()
    step1[name] = cv(feats, BASE)
    print(f"{name}: {step1[name]['Monthly-total MAPE %']:.2f}% MAPE, cell R2 {step1[name]['Cell R2']:.3f}"
          f"  ({time.time() - t:.0f}s)")
step1 = pd.DataFrame(step1).T
best_feats_name = step1["Monthly-total MAPE %"].astype(float).idxmin()
FEATS = FEATURES_V2 if best_feats_name.startswith("v2") else FEATURES_V1
print("-> using", best_feats_name)

# %% Step 2: settings search on the chosen features
# Two stages to keep it fast: tree shape first, then the loss and step size on the best shape.
def run(changes):
    p = {**BASE, **changes}
    t = time.time()
    r = cv(FEATS, p)
    print(f"  {changes}: {r['Monthly-total MAPE %']:.2f}% MAPE, cell R2 {r['Cell R2']:.3f}  ({time.time() - t:.0f}s)")
    return {**{k: p[k] for k in ["num_leaves", "min_child_samples", "tweedie_variance_power",
                                 "learning_rate", "n_estimators"]}, **r}


print("Step 2a: tree shape")
step2 = [run({"num_leaves": nl, "min_child_samples": mc})
         for nl, mc in itertools.product([31, 63, 127], [20, 100])]
shape = min(step2, key=lambda r: r["Monthly-total MAPE %"])
shape = {"num_leaves": shape["num_leaves"], "min_child_samples": shape["min_child_samples"]}

print("Step 2b: Tweedie power and step size, with", shape)
for tp in [1.2, 1.5]:
    step2.append(run({**shape, "tweedie_variance_power": tp}))
step2.append(run({**shape, "learning_rate": 0.03, "n_estimators": 1000}))
step2 = pd.DataFrame(step2).sort_values("Monthly-total MAPE %")
best = step2.iloc[0]
print("\nbest settings:\n", best)

# %% Save
with open(OUT / "experiments.md", "w", encoding="utf-8") as f:
    f.write("# Model search (time-series CV inside 2012-2020, test years untouched)\n\n")
    f.write("Folds validate on 2017, 2018, 2019, 2020 (expanding training window). Numbers are fold means.\n\n")
    f.write("## Step 1: feature sets\n\n" + step1.round(3).to_markdown() + "\n\n")
    f.write(f"## Step 2: settings ({best_feats_name})\n\nTop 10 of {len(step2)}:\n\n")
    f.write(step2.head(10).round(3).to_markdown(index=False) + "\n")
print(f"\nWrote {OUT / 'experiments.md'}  (total {time.time() - t0:.0f}s)")
