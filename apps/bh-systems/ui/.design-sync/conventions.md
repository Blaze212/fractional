# bh-systems design system

The fractional-practice brand for Barton Holdridge: a dark navy canvas, an editorial serif paired with IBM Plex, royal-blue structure with icy light-blue accents, and a faint blueprint texture. Build on-brand by composing the components below and styling your own layout glue with the `--bh-*` tokens.

## Wrapping and setup

Wrap every screen or section in `Surface`. It paints the navy background (`--bh-bg`), sets the base font and text color, and draws the blueprint grid. Components rendered outside a `Surface` sit on a bare background and lose the canvas.

```tsx
import { Surface, SectionHeading, Button } from 'bh-systems-ui'
;<Surface>
  <SectionHeading
    eyebrow="What I do"
    title="Start with one workflow. Own the whole system."
    description="I make AI systems survive production and scale."
  />
  <div style={{ marginTop: 28 }}>
    <Button variant="primary" arrow>
      Book a call
    </Button>
  </div>
</Surface>
```

Fonts load automatically from a `@font-face` `@import` at the top of `styles.css`: **Newsreader** (serif display, used for headings), **IBM Plex Sans** (body), **IBM Plex Mono** (eyebrows, buttons, figures). Ensure `styles.css` is loaded once at the app root.

## Styling idiom — compose components, style layout with tokens

Components carry their own styling; you do **not** pass CSS classes to them. Control them through their documented props (`variant`, `kicker`, `items`, `outcome`, …). For the layout _around_ components (spacing, grids, one-off type), use the design tokens as `var(--*)` — never hard-code hexes or fonts:

- Color: `--bh-bg`, `--bh-bg-2`, `--bh-panel`, `--bh-panel-2`, `--bh-text`, `--bh-muted`, `--bh-dim`, `--bh-royal`, `--bh-ice`, `--bh-on-royal`
- Lines/edges: `--bh-line`, `--bh-line-2`, `--bh-radius` (6px)
- Type: `--bh-serif`, `--bh-sans`, `--bh-mono`

The **ice** blue (`--bh-ice`) is the accent: highlighted figures, links, eyebrow rules. Royal (`--bh-royal`) is structural: primary buttons, card top/left rules. Headings are serif; eyebrows, buttons, and numbers are mono.

## Components

- **Surface** — the themed canvas + blueprint. Wrap everything in it.
- **SectionHeading** — eyebrow + serif title + optional description; `centered` for CTAs.
- **Eyebrow** — uppercase mono label with a leading rule.
- **Button** — `variant="primary"` (royal fill) or `"ghost"` (outlined); `arrow`, `href`, `external`.
- **Stat** / **StatBand** — a serif figure over a label; `StatBand` grids Stats (pass `items`).
- **OfferCard** — service card: `kicker`, serif `title`, `who` cadence, `items` deliverables.
- **CaseCard** — portfolio work: `company`, `kind` tag, narrative children, `outcome` (wrap figures in `<b>` for the ice highlight).
- **LogPanel** / **LogLine** — terminal-style panel with a royal left rule; `LogLine` rows take a `tag`.
- **CrossLink** — full-width banner linking to another page: `lead`, `headline`, `cta`, `href`.

## Where the truth lives

Read `styles.css` (tokens + component styles) before writing any layout CSS, and each component's `<Name>.d.ts` (its prop contract) and `<Name>.prompt.md` (usage) before composing it.
