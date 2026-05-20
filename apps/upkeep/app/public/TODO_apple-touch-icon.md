# TODO: generate apple-touch-icon.png

`index.html` references `/apple-touch-icon.png` for iOS home-screen installs
(`display: standalone` PWA — iOS ignores SVG favicons for the icon and falls
back to a gray screenshot tile if no PNG is available).

## Spec

- Source: `apps/upkeep/app/public/favicon.svg`
- Output: `apps/upkeep/app/public/apple-touch-icon.png`
- Size: 180×180
- Background: opaque `#5c7cfa` (the SVG's rounded-square fill)

## Generate

```
magick -background "#5c7cfa" -size 180x180 \
  apps/upkeep/app/public/favicon.svg \
  apps/upkeep/app/public/apple-touch-icon.png
```

Delete this file once the PNG is committed.
