# bh-systems-ui — design-sync notes

Bootstrapped from the static bh-systems marketing site (`apps/bh-systems/`). This package is the compiled React source of truth for that design; the two share the same tokens and look.

## Build / sync facts

- Shape: `package`. Build: `npm run build` (tsc → `dist/` + copies `src/styles.css` → `dist/styles.css`). Converter entry: `./dist/index.js`.
- `--node-modules ./node_modules` (react resolves there).
- Provider: `Surface` (`cfg.provider`) — every preview renders inside it for the navy canvas + blueprint. It's a visual wrapper, not a React context provider.
- CSS: single `dist/styles.css` carries tokens (`--bh-*`) + component classes; `cfg.cssEntry` points at it.
- Project: "bh-systems Design System" — `402e44f3-7214-4ab5-9c79-3a1c44d14a83`.

## Known render warns (triaged, expected)

- `[FONT_REMOTE]` for Newsreader / IBM Plex Sans / IBM Plex Mono — fonts load via a Google Fonts `@import` at the top of `styles.css`. Intentional; they load at runtime, nothing to ship.
- `Button` `AsLink` cell renders identically to `Primary` by design (same visual, different element). Not a variant-identical defect.

## Re-sync risks

- **Fonts are remote.** If Google Fonts is blocked in the render environment, previews fall back to system fonts. To make the DS fully self-contained, download the woff2s and switch the `@import` to local `@font-face` (then drop `[FONT_REMOTE]`).
- **This is a hand-built library, not an upstream package.** The static site (`apps/bh-systems/*.html` + `styles.css`) and this library can drift. If the site's theme changes, update `src/styles.css` here too (they were forked from the same tokens, but there's no automated link).
- Previews live in `.design-sync/previews/*.tsx` (committed, user-owned). Grades are carried forward via the uploaded `_ds_sync.json`.
