# TODO: generate favicon.svg + apple-touch-icon.png

The travel app is a PWA (`kirklPlugins({ name: 'Travel' })` in vite.config.ts,
manifest declares `display: standalone`) but ships without any icon. iOS will
fall back to a gray screenshot tile when installed to the home screen.

Two missing files:

## 1. `favicon.svg`

No SVG exists. Design a Travel mark (suggested: airplane/luggage glyph on a
`#1677ff` circle, matching the app's theme color), 100×100 viewBox to match the
other apps' style. Save as `apps/travel/app/public/favicon.svg`. Also add a
`<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` line to
`apps/travel/app/index.html` once it exists.

## 2. `apple-touch-icon.png`

`index.html` already references `/apple-touch-icon.png`. Generate from the
new SVG above:

```
magick -background "#1677ff" -size 180x180 \
  apps/travel/app/public/favicon.svg \
  apps/travel/app/public/apple-touch-icon.png
```

Size: 180×180. Background: opaque `#1677ff`.

Delete this file once both assets are committed.
