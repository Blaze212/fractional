# bh-systems

Marketing site for the fractional AI practice. Static HTML, no build step, no dependencies.

## Pages

- `index.html` — AI Reliability & Scale (the home / primary buyer).
- `creators.html` — Self-Serve AI for coaches, course creators, and community founders.
- `styles.css` — shared theme for both pages (edit once, applies everywhere).

The two pages cross-link in the header and footer.

## Deploy (Cloudflare, same as apps/portal)

```bash
cd apps/bh-systems
npx wrangler deploy
```

That serves this folder as a Cloudflare Workers static site named `bh-systems`. Point a custom domain at it in the Cloudflare dashboard when ready.

## Editing

- **Booking link.** All "Book a call" buttons point at `https://calendar.app.google/9HCGPEChEqgXxcAj8`. To change it, search both HTML files for `calendar.app.google` and replace.
- **Theme.** Colors, fonts, and spacing live in `styles.css`.
- **Anything else** (copy, LinkedIn URL) is plain HTML text, edit in place.

## Preview locally

Open `index.html` in a browser, or run any static server (e.g. `npx serve .`).
