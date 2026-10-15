# SkinnyVideo brand assets

For the promo video and press use. Not shipped in the app: the bundle only
includes `src/**/*` and `package.json` (`build.files` in `package.json`). The
Dock icon comes from `build/skinnyvideo.icns`.

| File | What it is |
|---|---|
| `skinnyvideo-icon-1024.png`, `-512.png`, `-256.png` | **The Dock icon**: a dark tile with a mint glyph. Exported from `build/skinnyvideo.icns` at its native sizes (no resampling), sRGB, transparent corners. |
| `skinnyvideo-mark.svg` | **The in-app mark** (the inverse): a mint tile with a dark glyph. This is the window header logo and the site favicon, copied from `site/favicon.svg`. |

## Colours

| Name | Hex | Used for |
|---|---|---|
| Mint | `#5EE39B` | The glyph on the Dock icon, the tile of the in-app mark, and the app's only UI accent |
| Cyan | `#43C7EF` | Secondary accent on the website (`--cyan` in `site/index.html`) |
| Ink | `#141414` | The glyph on the in-app mark (`--ink` in the app) |

To regenerate the PNGs after the icon changes:

```sh
iconutil -c iconset build/skinnyvideo.icns -o /tmp/sv.iconset
cp /tmp/sv.iconset/icon_512x512@2x.png brand/skinnyvideo-icon-1024.png
cp /tmp/sv.iconset/icon_512x512.png    brand/skinnyvideo-icon-512.png
cp /tmp/sv.iconset/icon_256x256.png    brand/skinnyvideo-icon-256.png
```
