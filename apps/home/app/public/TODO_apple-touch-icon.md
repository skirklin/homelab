# TODO: generate apple-touch-icon.png

`index.html` references `/apple-touch-icon.png` for iOS home-screen installs
(`display: standalone` PWA — iOS ignores SVG favicons for the icon and falls
back to a gray screenshot tile if no PNG is available).

This is the home shell (kirkl.in), which also hosts /life/* and /tasks/*.

## Spec

- Source: `apps/home/app/public/favicon.svg`
- Output: `apps/home/app/public/apple-touch-icon.png`
- Size: 180×180
- Background: opaque `#7c3aed` (the SVG's circle fill)

## Generate

```
magick -background "#7c3aed" -size 180x180 \
  apps/home/app/public/favicon.svg \
  apps/home/app/public/apple-touch-icon.png
```

Delete this file once the PNG is committed.
