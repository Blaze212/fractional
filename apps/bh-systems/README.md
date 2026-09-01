# bh-systems

Marketing site for the fractional AI practice. Static HTML/CSS, no build step.

## Layout

- `public/` — the deployed site: `index.html` (AI Reliability & Scale, home), `creators.html` (Self-Serve AI for Creators), `styles.css`. **Only this folder is served.**
- `public/demos/geography-club/` — a standalone daily geography quiz demo, live at `/demos/geography-club/`. See [docs/geography-club.md](docs/geography-club.md).
- `ui/` — the React component library (design system), synced to Claude Design via design-sync. Not part of the deployed site.
- `docs/` — notes on individual pages. Not served.

## Deploy (Cloudflare)

```bash
cd apps/bh-systems
npm run deploy
```

`GAS_EXEC_URL` (the live Apps Script deployment's `/exec` URL, which
`src/worker.js`'s `/texml/gas` proxy forwards Dograh/Retell webhooks to)
is a Worker secret — `wrangler secret put GAS_EXEC_URL` — not something
this repo's deploy script substitutes.

Serves `public/` as a Cloudflare Worker named `bh-systems`; wrangler prints the public `*.workers.dev` URL. Add a custom domain later from the Cloudflare dashboard (Workers & Pages → bh-systems → Settings → Domains & Routes).

## Editing

- **Booking link.** All "Book a call" buttons point at `https://calendar.app.google/9HCGPEChEqgXxcAj8`. Search both files under `public/` for `calendar.app.google` to change it.
- **Copy / LinkedIn URL** — plain HTML in `public/*.html`.

## Preview locally

Open `public/index.html`, or run `npx serve public`.
