# Geography Club: daily quiz demo

A self-contained, single-page demo of a daily geography quiz. Three rounds,
roughly two minutes, ending in a Wordle-style emoji grid the player copies and
pastes back into a community thread.

Built as a sample to show what a daily geography puzzle could look like as a
link shared into a Skool community.

Lives at **https://bh-systems.com/demos/geography-club/**, served as part of the
bh-systems site rather than as its own Worker. Anything added under
`apps/bh-systems/**` on `main` is deployed by `.github/workflows/deploy-bh-systems.yml`.

## Running it

No build step, no dependencies, no backend. Open `index.html` in a browser, or
serve the folder:

```bash
npx serve apps/bh-systems/public
```

Then visit `http://localhost:3000/demos/geography-club/`.

The clipboard API needs a secure context, so on `http://` the share button falls
back to a selectable textarea. Over `https://` (or `localhost`) it copies
directly.

## Editing the puzzle

All content lives in the `PUZZLE` object at the top of the `<script>` block in
`index.html`. Change the questions, options, `answer` index and `fact` text and
nothing else needs to be touched. The number of rounds is derived from the
array, so adding a fourth round works without any other edit.

## Structure

```
public/demos/geography-club/
  index.html     markup, styles and logic, all inline
  assets/
    japan.svg    country outline for round 3
    jp.svg       Japanese flag
    og.png       1200x630 link-preview card
```

The Open Graph tags use absolute `https://bh-systems.com/...` URLs. Link-preview
crawlers do not resolve relative `og:image` paths, and the preview card is what
makes the link look intentional in a Skool comment. Update them if the path moves.

## Asset provenance

- `japan.svg` is derived from a matplotlib rendering of Natural Earth Admin 0
  country geometry. Natural Earth is public domain. The source file was
  reframed for display: the white background rect, metadata and axes clipPath
  were stripped, the viewBox cropped to the main islands (Japan's remote
  Pacific territories otherwise dominate the bounding box), and a transparent
  background with an ink stroke applied. Path coordinates are unmodified.
- `jp.svg` is from [flag-icons](https://github.com/lipis/flag-icons) by
  Panayiotis Lipiridis, MIT licensed.
- `og.png` is generated from `japan.svg` plus text.

## Known limitations

- Score is not persisted; refreshing restarts the quiz. There is no backend, no
  account and no leaderboard by design. The community thread is the leaderboard.
- Countries whose territory crosses the 180th meridian (New Zealand, Fiji,
  Russia, the USA with the Aleutians) render with a badly distorted bounding box
  from this dataset. Check any new country outline visually before using it.
