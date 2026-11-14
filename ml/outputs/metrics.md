# Harmonization model: evaluation

Target: VIIRS S-NPP hotspot count per 0.25 deg cell per month, predicted from MODIS (Terra + Aqua). Features and settings were chosen by time-series cross-validation inside 2012-2020 (see experiments.md); the test sets below were not used for any decision.

## Held-out future years

Trained 201202 to 202012, tested 202101 to 202607.

| Model                          |   Cell MAE |   Cell R2 |   Monthly-total R2 |   Monthly-total MAPE % |   Total bias % |
|:-------------------------------|-----------:|----------:|-------------------:|-----------------------:|---------------:|
| Baseline (single ratio)        |      1.827 |     0.77  |              0.971 |                 18.157 |          4.587 |
| Log-linear regression          |      1.772 |     0.521 |              0.977 |                 23.811 |        -12.519 |
| LightGBM (Tweedie)             |      1.455 |     0.854 |              0.989 |                 15.472 |          0.253 |
| Blend 50/50 (ratio + LightGBM) |      1.556 |     0.834 |              0.984 |                 15.561 |          2.42  |

## Backcasting (unseen past years, like the real use)

Trained 201701 to 202607, tested 201202 to 201612.

| Model                          |   Cell MAE |   Cell R2 |   Monthly-total R2 |   Monthly-total MAPE % |   Total bias % |
|:-------------------------------|-----------:|----------:|-------------------:|-----------------------:|---------------:|
| Baseline (single ratio)        |      4.753 |     0.635 |              0.967 |                 10.34  |         -3.355 |
| LightGBM (Tweedie)             |      4.233 |     0.614 |              0.941 |                 13.821 |        -13.578 |
| Blend 50/50 (ratio + LightGBM) |      4.241 |     0.631 |              0.958 |                  9.449 |         -8.466 |

## Robustness: Aqua-only MODIS input (held-out future years)

| Model              |   Cell MAE |   Cell R2 |   Monthly-total R2 |   Monthly-total MAPE % |   Total bias % |
|:-------------------|-----------:|----------:|-------------------:|-----------------------:|---------------:|
| LightGBM (Tweedie) |      1.556 |      0.82 |              0.974 |                  18.65 |          2.947 |

## Leave-one-year-out (closest to the real use)

See [loyo.md](loyo.md). The final model was chosen there: it had the lowest typical annual error (6.2%) and monthly error.

Final model: **Blend 50/50 (ratio + LightGBM)**, refit on all overlap months (201202 to 202607).
