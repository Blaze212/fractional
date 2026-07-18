# bh-systems

Marketing site for the fractional AI practice. Static HTML/CSS, no build step.

## Layout

- `public/` — the deployed site: `index.html` (AI Reliability & Scale, home), `creators.html` (Self-Serve AI for Creators), `styles.css`. **Only this folder is served.**
- `ui/` — the React component library (design system), synced to Claude Design via design-sync. Not part of the deployed site.

## Deploy (Cloudflare)

```bash
cd apps/bh-systems
npx wrangler deploy
```

Serves `public/` as a Cloudflare Worker named `bh-systems`; wrangler prints the public `*.workers.dev` URL. Add a custom domain later from the Cloudflare dashboard (Workers & Pages → bh-systems → Settings → Domains & Routes).

## Editing

- **Booking link.** All "Book a call" buttons point at `https://calendar.app.google/9HCGPEChEqgXxcAj8`. Search both files under `public/` for `calendar.app.google` to change it.
- **Copy / LinkedIn URL** — plain HTML in `public/*.html`.

## Preview locally

Open `public/index.html`, or run `npx serve public`.
