# API Usage

This doc summarizes which Opinion APIs are used by the backend pipeline and the Chrome extension, and what fields are consumed from each response.

## Backend (`backend/build_index.py`)

### `GET http://opinion.api.predictscan.dev:10001/api/markets`

- Purpose: Fetch the full market list (including `childMarkets`) to build `backend/data.json` (events/markets + keyword/entity index).
- Consumed fields:
  - Filtering:
    - `statusEnum` (only keep `Activated`)
    - `resolvedAt` (skip resolved)
    - `cutoffAt` (skip expired; treat `0` as “no cutoff” for still-active markets)
  - IDs and grouping:
    - `marketId` (preferred) / `id` (fallback) → market identifier
    - `parentEvent.eventMarketId` / `parentEventId` → aggregate child markets into an “event” market
  - Titles and rules (also used as LLM input context):
    - `marketTitle` / `title`
    - `parentEvent.title`
    - `rules` / `description`
  - Display metadata:
    - `yesLabel`, `noLabel`
    - `volume` (and compatible variants such as `volumeUsd`, `volume24h`, etc.)

Notes:
- Backend does **not** fetch prices/probabilities. It only builds the local match index and the market/event metadata used by the extension.
- The output `backend/data.json` includes:
  - `events`: per-event keywords/entities/entityGroups (LLM-generated)
  - `markets`: per-event aggregated market title/url/labels/volume
  - `index` / `eventIndex`: inverted indices for matching

### `GET ${PREVIOUS_DATA_URL}` (optional)

- Purpose: Load previous `data.json` to support “add only new” behavior and reuse existing LLM outputs.
- Consumed fields:
  - `events[eventId].keywords`, `events[eventId].entities`, `events[eventId].entityGroups`
  - `events[eventId].sigCore` / `sigFull` (signature-based reuse)
  - `markets[eventId]` (seed output when `ADD_ONLY_NEW=1`)

## Extension (`extension/contentScript.js`)

The extension fetches live market structure + latest prices from `https://opinionanalytics.xyz/api` for display in the HUD.

### `GET https://opinionanalytics.xyz/api/markets`

- Purpose: Build an in-memory index `marketId -> { yesTokenId, noTokenId }` to map market IDs to tradable token IDs.
- Consumed fields:
  - `marketId`
  - `yesTokenId`
  - `noTokenId`
- Caching:
  - TTL: `MARKETS_INDEX_TTL_MS` (10 minutes)

### `GET https://opinionanalytics.xyz/api/markets/wrap-events`

- Purpose: Resolve “multi/event” markets into their child option markets.
- Consumed fields:
  - Wrap event:
    - `marketId` (wrap/event ID)
    - `markets[]` (children)
  - Child market fields used for display/pricing:
    - `marketId`
    - `title`
    - `yesTokenId` (YES price shown for each option row)
    - `noTokenId` (only used in the single-child/binary rendering path)
- Reliability:
  - Retries with backoff (max 3 retries, delayed) before showing “Failed to load options”.
- Caching:
  - TTL: `WRAP_EVENTS_INDEX_TTL_MS` (10 minutes)

### `GET https://opinionanalytics.xyz/api/orders/by-asset/:assetId?page=1&pageSize=1&filter=all`

- Purpose: Fetch the latest executed order for a token and display it as a probability/odds percentage.
- Consumed fields:
  - `data[0].price` (string → parsed as float in range `[0, 1]`, then rendered as percent with 1 decimal)
- Caching:
  - TTL: `PRICE_CACHE_TTL_MS` (60 seconds)
- Rate limiting:
  - Concurrency capped by `MAX_PRICE_FETCH_CONCURRENCY` (4).

### Not used (known issue)

- `GET /markets/asset-ids/:marketId` is intentionally **not used** due to server-side 500 errors (`operator does not exist: text = integer`).

