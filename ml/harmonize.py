"""
MODIS -> VIIRS harmonization model (Ignisensing Analytics, NASA Space Apps 2026)

Learns how many hotspots VIIRS (S-NPP) would detect in a 0.25 deg grid cell and month,
given what MODIS (Terra + Aqua) detected there. Trained on the overlap years (2012 onward),
then applied to the MODIS-only years (2003-2011) so the fire calendar is one consistent
VIIRS-equivalent series from 2003 to now.

Features and settings were chosen in experiments.py using validation years inside
2012-2020 only. The 2021+ test set below is used once, for the final numbers.

Run the whole thing:   python ml/harmonize.py
Or run cell by cell in VS Code ("Run Cell" above each # %%).

Input : data/processed/cell_monthly_counts.csv   (see data/SCHEMA.md, section 2)
Output: ml/outputs/monthly_counts.csv             (SCHEMA.md section 3, region = indonesia)
        ml/outputs/cell_monthly_harmonized.csv    (per-cell harmonized counts, non-zero rows only)
        ml/outputs/metrics.md                     (model comparison table for the submission)
        ml/outputs/validation.png, harmonized_series.png, feature_importance.png
"""

# %% Setup
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import lightgbm as lgb
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression

from features import FEATURES_V1, ROOT, TRAIN_END, TRAIN_START, add_features, load_wide, overlap, score

OUT = ROOT / "ml" / "outputs"
OUT.mkdir(parents=True, exist_ok=True)
REGION = "indonesia"
SEED = 42

# Held-out test years (time-based split, never random: neighbouring months are correlated)
TEST_START = 202101
# Backcasting check: train on later years, test on the earliest overlap years.
# This mimics the real use (applying the model to years BEFORE its training data).
BACKCAST_TEST_END = 201612

# Chosen in experiments.py (time-series CV inside 2012-2020). The 7 extra v2 features were a tie,
# so the simpler v1 set is kept. Smaller leaves (min_child_samples 20 instead of 50) helped slightly.
FEATURES = FEATURES_V1
PARAMS = dict(objective="tweedie", tweedie_variance_power=1.3, n_estimators=600, learning_rate=0.05,
              num_leaves=63, min_child_samples=20, subsample=0.8, subsample_freq=1,
              colsample_bytree=0.9, random_state=SEED, verbose=-1)


# %% Load data and build features
wide = load_wide()
feat = add_features(wide)
ov = overlap(feat)
train, test = ov[ov.ym < TEST_START], ov[ov.ym >= TEST_START]
print(f"{len(feat):,} cell-months, {feat[['gi', 'gj']].drop_duplicates().shape[0]:,} cells")
print(f"train {len(train):,} rows ({train.ym.min()}-{train.ym.max()}), "
      f"test {len(test):,} rows ({test.ym.min()}-{test.ym.max()})")


# %% Models
def fit_ratio(tr, feats=None):
    k = tr["count_N"].sum() / tr["modis"].sum()
    return lambda df: k * df["modis"].to_numpy()


def fit_loglinear(tr, feats=None):
    def X(df):
        months = pd.get_dummies(df["month"].astype("category").cat.set_categories(range(1, 13)))
        return np.column_stack([df["log_modis"], months.to_numpy(float)])
    lr = LinearRegression().fit(X(tr), np.log1p(tr["count_N"]))
    # No smearing correction: with ~85% zero cells it adds a constant to every empty cell
    # and inflates totals by ~30%. The plain back-transform is the fairer baseline here.
    return lambda df: np.clip(np.expm1(lr.predict(X(df))), 0, None)


def fit_lgbm(tr, feats=FEATURES):
    m = lgb.LGBMRegressor(**PARAMS).fit(tr[feats], tr["count_N"])
    predict = lambda df: m.predict(df[feats])
    predict.model = m
    return predict


def fit_blend(tr, feats=FEATURES):
    # LightGBM captures cell and seasonal detail; the ratio scales safely in giant fire years
    # (trees cannot extrapolate beyond the values seen in training). Chosen in loyo.py.
    r, g = fit_ratio(tr), fit_lgbm(tr, feats)
    predict = lambda df: 0.5 * (r(df) + g(df))
    predict.model = g.model
    return predict


FINAL = "Blend 50/50 (ratio + LightGBM)"
MODELS = {"Baseline (single ratio)": fit_ratio,
          "Log-linear regression": fit_loglinear,
          "LightGBM (Tweedie)": fit_lgbm,
          FINAL: fit_blend}

# Typical annual error of the final model from leave-one-year-out (loyo.py), for the uncertainty band
LOYO_ANNUAL_ERROR = 0.062


def evaluate(models, tr, te, feats=FEATURES):
    preds = {name: fit(tr, feats)(te) for name, fit in models.items()}
    table = pd.DataFrame({name: score(te, p) for name, p in preds.items()}).T
    table.index.name = "Model"
    return table, preds


# %% 1) Main test: train 2012-2020, test 2021-2026 (unseen future years)
results, test_preds = evaluate(MODELS, train, test)
pd.set_option("display.width", 160, "display.max_columns", 10)
print(f"\nHeld-out test {test.ym.min()}-{test.ym.max()}:")
print(results.round(3))


# %% 2) Backcasting: train 2017-2026, test 2012-2016 (unseen PAST years, like the real use)
bc_train = ov[ov.ym > BACKCAST_TEST_END]
bc_test = ov[ov.ym <= BACKCAST_TEST_END]
backcast, _ = evaluate({k: MODELS[k] for k in ["Baseline (single ratio)", "LightGBM (Tweedie)", FINAL]},
                       bc_train, bc_test)
print(f"\nBackcast test {bc_test.ym.min()}-{bc_test.ym.max()} (trained on {bc_train.ym.min()}-{bc_train.ym.max()}):")
print(backcast.round(3))


# %% 3) Robustness: Aqua-only MODIS input
feat_aqua = add_features(wide, sats=("A",))
ov_a = overlap(feat_aqua)
feats_aqua = [f for f in FEATURES if f != "log_T"]
res_aqua, _ = evaluate({"LightGBM (Tweedie)": fit_lgbm}, ov_a[ov_a.ym < TEST_START],
                       ov_a[ov_a.ym >= TEST_START], feats_aqua)
print("\nRobustness, Aqua-only MODIS input:")
print(res_aqua.round(3))


# %% Validation plot: real VIIRS vs VIIRS predicted from MODIS, monthly totals
best = FINAL
fig, ax = plt.subplots(figsize=(11, 4))
am = test.groupby("ym")["count_N"].sum()
x = pd.to_datetime(am.index.astype(str), format="%Y%m")
ax.plot(x, am.values, color="#222", lw=2, label="Real VIIRS (S-NPP)")
for name, color in zip(MODELS, ["#bbb", "#e69f00", "#56b4e9", "#d55e00"]):
    pm = pd.Series(test_preds[name], index=test.index).groupby(test.ym).sum()
    ax.plot(x, pm.values, color=color, lw=1.5, ls="--" if name != best else "-",
            label=f"Predicted from MODIS: {name}")
ax.set_title(f"Held-out test {x.min():%b %Y} to {x.max():%b %Y}: monthly VIIRS hotspots, Indonesia")
ax.set_ylabel("Hotspots per month")
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(OUT / "validation.png", dpi=150)
print(f"\nFinal model (chosen by leave-one-year-out, see loyo.py): {best}")


# %% Final model: refit on ALL overlap months, apply to MODIS-only years
predict_final = fit_blend(ov)
is_real = (feat.ym >= TRAIN_START) & feat["count_N"].notna()
feat["harmonized"] = np.where(is_real, feat["count_N"], predict_final(feat))
feat["harmonized_source"] = np.where(is_real, "VIIRS", "MODEL")

# Feature importance (total loss reduction from splits on each feature)
imp = pd.Series(predict_final.model.booster_.feature_importance("gain"), index=FEATURES)
imp = (100 * imp / imp.sum()).sort_values()
fig, ax = plt.subplots(figsize=(7, 5))
ax.barh(imp.index, imp.values, color="#d55e00")
ax.set_xlabel("Share of total gain (%)")
ax.set_title("What the LightGBM part of the model relies on")
fig.tight_layout()
fig.savefig(OUT / "feature_importance.png", dpi=150)


# %% Outputs
# 1) Region-level monthly series (SCHEMA.md section 3)
g = feat.groupby(["year", "month"])
viirs_m = feat[feat["count_N"].notna()].groupby(["year", "month"])["count_N"].sum()
out = pd.concat([
    g["modis"].sum().rename("count").reset_index().assign(sensor="MODIS"),
    viirs_m.rename("count").reset_index().assign(sensor="VIIRS"),
    g["harmonized"].sum().rename("count").reset_index().assign(sensor="HARMONIZED"),
])
out.insert(0, "region", REGION)
out["count"] = out["count"].round(1)
out = out[["region", "year", "month", "sensor", "count"]].sort_values(["sensor", "year", "month"])
out.to_csv(OUT / "monthly_counts.csv", index=False)

# 2) Per-cell harmonized counts, for any area the user draws on the map (non-zero rows only)
cell = feat.loc[feat.harmonized >= 0.05, ["cell_lat", "cell_lon", "year", "month", "harmonized", "harmonized_source"]]
cell = cell.rename(columns={"harmonized": "count", "harmonized_source": "source"})
cell["count"] = cell["count"].round(2)
cell.to_csv(OUT / "cell_monthly_harmonized.csv", index=False)

# 3) Metrics for the submission
with open(OUT / "metrics.md", "w", encoding="utf-8") as f:
    f.write("# Harmonization model: evaluation\n\n")
    f.write("Target: VIIRS S-NPP hotspot count per 0.25 deg cell per month, predicted from MODIS (Terra + Aqua). "
            "Features and settings were chosen by time-series cross-validation inside 2012-2020 "
            "(see experiments.md); the test sets below were not used for any decision.\n\n")
    f.write(f"## Held-out future years\n\nTrained {train.ym.min()} to {train.ym.max()}, "
            f"tested {test.ym.min()} to {test.ym.max()}.\n\n" + results.round(3).to_markdown() + "\n\n")
    f.write(f"## Backcasting (unseen past years, like the real use)\n\nTrained {bc_train.ym.min()} to "
            f"{bc_train.ym.max()}, tested {bc_test.ym.min()} to {bc_test.ym.max()}.\n\n"
            + backcast.round(3).to_markdown() + "\n\n")
    f.write("## Robustness: Aqua-only MODIS input (held-out future years)\n\n" + res_aqua.round(3).to_markdown() + "\n\n")
    f.write("## Leave-one-year-out (closest to the real use)\n\nSee [loyo.md](loyo.md). The final model was chosen "
            f"there: it had the lowest typical annual error ({100 * LOYO_ANNUAL_ERROR:.1f}%) and monthly error.\n\n")
    f.write(f"Final model: **{best}**, refit on all overlap months ({TRAIN_START} to {TRAIN_END}).\n")

# 4) Full harmonized series plot
fig, ax = plt.subplots(figsize=(11, 4))
yr = out.pivot_table(index="year", columns="sensor", values="count", aggfunc="sum")
yr = yr[yr.index < 2026]  # 2026 is still in progress
# What you get WITHOUT harmonization: MODIS before 2012, VIIRS after (fake 5x jump in 2012)
naive = yr["MODIS"].where(yr.index < 2012, yr["VIIRS"])
ax.plot(naive.index, naive.values, color="#cc79a7", ls="--", lw=1.8,
        label="Naive stitch (MODIS then VIIRS): fake jump")
ax.plot(yr.index, yr["MODIS"], color="#888", marker="o", ms=3, label="MODIS (raw)")
ax.plot(yr.index, yr["VIIRS"], color="#0072b2", marker="o", ms=3, label="VIIRS (raw)")
ax.plot(yr.index, yr["HARMONIZED"], color="#d55e00", lw=2.5, label="Harmonized (VIIRS-equivalent)")
est = yr.index < 2012
ax.fill_between(yr.index[est], yr["HARMONIZED"][est] * (1 - LOYO_ANNUAL_ERROR),
                yr["HARMONIZED"][est] * (1 + LOYO_ANNUAL_ERROR), color="#d55e00", alpha=0.2,
                label=f"Typical model error (±{100 * LOYO_ANNUAL_ERROR:.0f}%)")
ax.axvline(2011.5, color="#aaa", ls=":")
ax.text(2011.6, ax.get_ylim()[1] * 0.92, "VIIRS starts", color="#666", fontsize=9)
ax.set_title("Annual hotspots, Indonesia: raw sensors vs harmonized record")
ax.set_ylabel("Hotspots per year")
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(OUT / "harmonized_series.png", dpi=150)

print(f"\nWrote monthly_counts.csv ({len(out):,} rows), cell_monthly_harmonized.csv ({len(cell):,} rows),")
print("metrics.md, validation.png, harmonized_series.png, feature_importance.png")
