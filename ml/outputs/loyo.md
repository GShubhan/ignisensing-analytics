# Leave-one-year-out evaluation

Each overlap year is hidden in turn; models are trained on all other years and predict the hidden year. This matches the real use: the final model is trained on all overlap years and applied to unseen years (2003-2011).

## Summary

|             |   Mean |annual bias| % |   Worst annual bias % |   Monthly MAPE % |   Overall bias % |
|:------------|-----------------------:|----------------------:|-----------------:|-----------------:|
| Ratio       |                   7.38 |                -16.92 |            13.8  |            -0.42 |
| LightGBM    |                   6.47 |                -17.99 |            13.08 |            -5.28 |
| Blend 50/50 |                   6.24 |                -15.73 |            11.97 |            -2.85 |

## Annual bias per hidden year

|   year |   real VIIRS |   Ratio bias % |   LightGBM bias % |   Blend 50/50 bias % |
|-------:|-------------:|---------------:|------------------:|---------------------:|
|   2012 |       286623 |           13.9 |               1.8 |                  7.8 |
|   2013 |       235397 |            6.3 |              -2.3 |                  2   |
|   2014 |       506915 |           -1.5 |              -4.1 |                 -2.8 |
|   2015 |       812329 |          -11.2 |             -18   |                -14.6 |
|   2016 |       101899 |            0.7 |              -8   |                 -3.6 |
|   2017 |        77006 |           -3.7 |              -7.5 |                 -5.6 |
|   2018 |       166835 |            1.9 |              -2.2 |                 -0.1 |
|   2019 |       395044 |            5.3 |               6.4 |                  5.9 |
|   2020 |        74844 |          -16.9 |             -14.5 |                -15.7 |
|   2021 |        55062 |           -0.2 |               7.5 |                  3.7 |
|   2022 |        44811 |           -6.9 |               1.7 |                 -2.6 |
|   2023 |       217583 |            6.6 |               0.9 |                  3.8 |
|   2024 |        83282 |           12.6 |               7.1 |                  9.9 |
|   2025 |        79412 |           -8.6 |             -11.7 |                -10.2 |
|   2026 |        43760 |           14.3 |              -3.5 |                  5.4 |
