# Opinion-HUD
Contextual Trading Layer for X, powered by Opinion API

## Chrome Extension (Frontend)

1. Open `chrome://extensions` and enable Developer mode.
2. Click “Load unpacked” and select `extension/`.
3. Open the extension Options page and set the generated `data.json` URL (from your pipeline/CDN), then click “Refresh Now”.

## Manual QA (X Web)

- Home timeline, profile, and single-tweet pages all show the Opinion HUD icon (left of the “...” menu) when a match exists.
- Clicking the icon opens the “Market(s) Found” popover to the right of the icon (same horizontal line) without covering tweet text.
- Quote-retweets match both the main tweet and the quoted tweet content, and only render one icon/popover per tweet.

## Backend (Data Pipeline)

See `backend/build_index.py` and `prd.md`.
