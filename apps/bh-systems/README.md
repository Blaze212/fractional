# bh-systems

Marketing site for the fractional AI practice. Static HTML/CSS, no build step.

## Layout

- `public/` — the deployed site: `index.html` (AI Reliability & Scale, home), `creators.html` (Self-Serve AI for Creators), `styles.css`. **Only this folder is served.**
- `public/demos/geography-club/` — a standalone daily geography quiz demo, live at `/demos/geography-club/`. See [docs/geography-club.md](docs/geography-club.md).
- `ui/` — the React component library (design system), synced to Claude Design via design-sync. Not part of the deployed site.
- `docs/` — notes on individual pages. Not served.

## Deploy (Cloudflare)

`public/texml/*.xml` carry `DEPLOY_ID`/`SECRET` placeholders, not real
values — the Apps Script deployment ID and webhook secret never get
committed. `npm run deploy` (or `bash scripts/deploy.sh`) substitutes
them from the environment, runs `wrangler deploy`, then restores the
placeholders in the working tree regardless of whether the deploy
succeeded. Set `GAS_DEPLOY_ID` and `WEBHOOK_SECRET` (matching the
adjuster Apps Script's own `WEBHOOK_SECRET` config) either as shell env
vars or in a `.env` file in this folder (gitignored):

```bash
cd apps/bh-systems
npm run deploy
```

Deploying with plain `npx wrangler deploy` still works but ships the
literal `DEPLOY_ID`/`SECRET` placeholder text instead of working
credentials — only use the npm script for a real deploy.

Serves `public/` as a Cloudflare Worker named `bh-systems`; wrangler prints the public `*.workers.dev` URL. Add a custom domain later from the Cloudflare dashboard (Workers & Pages → bh-systems → Settings → Domains & Routes).

## Editing

- **Booking link.** All "Book a call" buttons point at `https://calendar.app.google/9HCGPEChEqgXxcAj8`. Search both files under `public/` for `calendar.app.google` to change it.
- **Copy / LinkedIn URL** — plain HTML in `public/*.html`.

## Preview locally

Open `public/index.html`, or run `npx serve public`.
