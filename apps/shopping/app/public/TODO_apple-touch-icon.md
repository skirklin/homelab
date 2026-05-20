# TODO: generate apple-touch-icon.png

`index.html` references `/apple-touch-icon.png` for iOS home-screen installs
(`display: standalone` PWA — iOS ignores SVG favicons for the icon and falls
back to a gray screenshot tile if no PNG is available).

## Spec

- Source: `apps/shopping/app/public/favicon.svg`
- Output: `apps/shopping/app/public/apple-touch-icon.png`
- Size: 180×180
- Background: opaque `#2ca6a4` (the SVG's circle fill)

## Generate

```
magick -background "#2ca6a4" -size 180x180 \
  apps/shopping/app/public/favicon.svg \
  apps/shopping/app/public/apple-touch-icon.png
```

Or with `rsvg-convert`:

```
rsvg-convert -w 180 -h 180 -b "#2ca6a4" \
  apps/shopping/app/public/favicon.svg \
  > apps/shopping/app/public/apple-touch-icon.png
```

Delete this file once the PNG is committed.
