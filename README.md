# Contraction Timer

A tiny shared contraction timer for two phones. One big button, rolling averages,
and a colored banner that tells you when the 5-1-1 (or 4-1-1) rule has held for an hour.

Both phones talk to the same Netlify Function, which keeps the single source of truth in
Netlify Blobs. Each phone polls every 3 seconds (and whenever it comes back to the
foreground), so whoever taps, the other sees it within a few seconds.

## How to use

- **Tap the big button when a contraction starts.** It turns blue and shows a running timer.
- **Tap it again when the contraction ends.** The entry is saved with its duration.
- The two cards show the **average time between** contractions (start to start) and the
  **average duration**, each over the last five.
- The banner color is the hospital indicator:
  - gray: nothing yet, or no contraction in 30+ minutes
  - green: early labor, not yet at the pattern
  - yellow: the last few contractions fit the rule
  - orange: the rule has held for 30+ minutes
  - red (pulsing): the rule has held for a full hour, time to go
- **Undo last** removes the most recent entry. **Edit** on any entry opens sliders to nudge the start time (5-second steps) and the duration (1-second steps), or delete it.
- The **Rule** dropdown switches between 5-1-1 and 4-1-1 for everyone.
- The **Trend & forecast** chart at the bottom plots minutes-between and duration over time,
  with a least-squares trend line, a ±1σ band, the rule's targets, and a shaded forecast window
  for when the trend reaches the pattern (plus an hour for the hospital rule). Hover or drag
  across it for values.

Follow your provider's instructions over the app, and go in regardless if water breaks,
there is bleeding, or anything feels wrong.

## Layout

```
public/            static site (index.html, style.css, app.js)
public/state.mjs   shared reducer + stats, used by the browser AND the function
public/zmanim.mjs  Crown Heights sunset/tzeis and the 20 Cheshvan countdown
public/chart.mjs   regression, forecast, and the SVG trend chart
netlify/functions/state.mts   GET/POST /api/state, backed by Netlify Blobs
test/              unit tests for the reducer and a local dev server
```

## Local development

```sh
npm install
npm test        # reducer and stats tests
npm run dev     # http://localhost:8788 with an in-memory stand-in for the function
```

`netlify dev` also works if you have the Netlify CLI and a linked site.

## Deploying

The site is a plain static publish of `public/` plus one function. Deploy with the Netlify CLI
(`netlify deploy --prod`) or connect the repo for continuous deployment.
