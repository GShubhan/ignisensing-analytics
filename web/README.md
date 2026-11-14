# web/ — Dashboard

**Owners: Ayska, Luis, Nguyen**

The website. Everything in this folder goes live on Vercel automatically after a `git push` to `main`.

## Base design

Match Jasmine's sketch.

## Placeholders to build now

- [ ] Map where the user picks an area of interest (or types lat/lon)
- [ ] Date range picker
- [ ] Burning calendar: month × year heatmap of hotspot counts (accessible color ramp)
- [ ] "This month vs historical median" comparison
- [ ] Download CSV button

The data the dashboard will read is described in [../data/SCHEMA.md](../data/SCHEMA.md).

## Testing changes without breaking the live site

Work on a branch. Vercel gives every branch its own preview link:

```
git checkout -b my-feature
git add web
git commit -m "describe your change"
git push -u origin my-feature
```
