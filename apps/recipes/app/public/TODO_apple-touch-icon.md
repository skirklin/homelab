# TODO: generate apple-touch-icon.png

`index.html` references `/apple-touch-icon.png` for iOS home-screen installs
(`display: standalone` PWA — iOS ignores SVG favicons for the icon and falls
back to a gray screenshot tile if no PNG is available).

## Spec

- Source: `apps/recipes/app/public/favicon.svg`
- Output: `apps/recipes/app/public/apple-touch-icon.png`
- Size: 180×180 (Apple's current recommendation; iOS will downscale as needed)
- Background: opaque (iOS masks transparency to white, which can clash with
  the SVG's dark teal `#2ca6a4` circle — render onto an opaque canvas of
  the same color, or let the existing circle fill the full bleed)

## Generate

With ImageMagick:

```
magick -background "#2ca6a4" -size 180x180 \
  apps/recipes/app/public/favicon.svg \
  apps/recipes/app/public/apple-touch-icon.png
```

Or with `rsvg-convert`:

```
rsvg-convert -w 180 -h 180 -b "#2ca6a4" \
  apps/recipes/app/public/favicon.svg \
  > apps/recipes/app/public/apple-touch-icon.png
```

Or with node `sharp`:

```
import sharp from "sharp";
await sharp("apps/recipes/app/public/favicon.svg")
  .resize(180, 180)
  .flatten({ background: "#2ca6a4" })
  .png()
  .toFile("apps/recipes/app/public/apple-touch-icon.png");
```

Delete this file once the PNG is committed.
