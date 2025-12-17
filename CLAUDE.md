# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Opinion HUD is a Chrome browser extension (Manifest V3) that creates a contextual trading layer for X (formerly Twitter), powered by the Opinion Analytics API. The extension uses a "local-first + AI preprocessing" architecture to match prediction markets with relevant tweets in real-time using semantic matching.

**Core Architecture Pattern:** Zero-Latency Local-First
- Backend (Python + GitHub Actions): Fetches markets from Opinion API, uses Zhipu GLM-4.6 AI to generate semantic keywords, builds inverted index, deploys JSON to CDN
- Frontend (Chrome Extension): Downloads index JSON, uses MutationObserver + local regex matching to detect relevant tweets, injects UI overlay

## Development Environment Setup

### Backend (Python)
```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1  # Windows PowerShell
# source .venv/bin/activate    # Linux/Mac
python -m pip install -r backend/requirements.txt
```

Dependencies: `requests`, `zhipuai`

### Chrome Extension
Load unpacked extension in Chrome:
1. Navigate to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select `extension/` directory

## Key Architecture Concepts

### Backend Data Pipeline (see prd.md sections 4.1-4.3)

**Market Fetching:**
- API endpoint: `https://proxy.opinion.trade:8443/openapi/market`
- Authentication: Requires `apikey` header with `OPINION_API_KEY`
- Pagination strategy: First fetch with `limit=1` to get total count, then fetch all with `limit=20` per page (API max limit)
- Query params: `status=activated`, `sortBy=5` (24h volume), `limit`, `offset`
- Response structure: `{ errno: 0, errmsg: "", result: { total: N, list: [...] } }`
- Must recursively flatten `childMarkets` - nested markets are treated as independent tradable entries
- Filter: `statusEnum == "Activated"` AND `cutoffAt` > current timestamp
- Field mapping: `marketId`, `title` (prefer `marketTitle` over `title`), `yesLabel`/`noLabel`, `volume`, construct URL as `https://opinion.trade/market/{marketId}`

**AI Keyword Generation:**
- Model: Zhipu GLM-4.6 (prefer `glm-4-flash` for cost)
- Input: market title + rules field (context)
- Output: 10-15 keywords including entities, aliases, slang (e.g., "Orange Man" for Trump, "Corn" for BTC)
- Critical: all keywords must be lowercase for matching

**Index Structure:**
- Inverted index format: `{ "keyword": ["market_id_1", "market_id_2"] }`
- Include metadata: version number for cache invalidation

### Frontend Extension Architecture (see prd.md section 5)

**Data Sync:**
- On startup + every 1 hour: fetch `data.json`
- Compare `meta.version`, update `chrome.storage.local` if changed

**DOM Scanning Engine:**
- Use `MutationObserver` on timeline container
- Target: `div[data-testid="tweetText"]`
- Performance optimizations:
  - Debounce: 100ms after scroll stops
  - Cache: mark scanned tweets with `data-opinion-scanned="true"`
  - Matching: text → lowercase → local regex → market IDs

**Matching Strategy:**
- Prefer longer/more specific keywords (e.g., "Trump wins PA" over "Trump")
- Dedup: max 3 instances of same market ID per screen

**UI Injection (see prd.md section 6):**
- Icon: 16x16px Opinion logo injected into tweet action bar (right side)
- HUD overlay: triggered on 300ms hover, 280px width, iOS-style backdrop blur
- Must adapt to X's Light/Dim/Lights Out themes
- Display: market title (2 line max), yes/no labels, "Trade Now" CTA

**Referral Tracking:**
- All URLs must include `?ref=opinion_hud`
- Optional UTM: `utm_source=twitter_extension`, `utm_medium=overlay`, `utm_term={matched_keyword}`

## Critical Constraints

**Privacy:** NEVER upload tweet content to servers - all NLP matching is local-only

**Performance:** Maintain 60fps scrolling, regex matching must complete in <10ms

**Error Handling:** If Opinion API fails, extension must fail silently (no user-facing errors)

**Browser Compatibility:** Chrome v100+, Edge, Brave

## File Organization

- `backend/`: Python scripts for market fetching, AI keyword generation, index building
- `extension/`: Chrome extension source (manifest, content scripts, background service worker, UI components)
- `extension/icons/`: Extension icon assets (16x16, 48x48, 128x128)
- `.github/workflows/`: GitHub Actions for automated data pipeline (runs every 30 minutes)
- `prd.md`: Complete technical specification and acceptance criteria
- `AGENTS.md`: Repository guidelines and development conventions

## Code Style

**Python (backend/):**
- 4-space indentation, PEP 8 compliance
- Type hints for public functions
- Keep modules small and single-purpose
- Future: use `ruff` or `black` for formatting

**Extension (JavaScript/TypeScript/CSS):**
- 2-space indentation
- `kebab-case` for asset filenames
- Centralize DOM selectors to avoid fragility with X's UI changes
- Future: use `eslint`/`prettier` for formatting

## Testing

Currently no automated tests. When adding:
- Python tests: `backend/tests/test_*.py` (pytest-compatible)
- Extension: include manual QA checklist in PRs (pages tested, hover behavior, performance impact)

## Important Implementation Notes

1. **Recursive Market Flattening:** The Opinion API returns nested `childMarkets` - these MUST be recursively extracted as separate entries, not ignored

2. **AI Prompt Engineering:** Keywords must include industry slang/jargon to catch informal references (users won't always use formal terms)

3. **DOM Observer Resilience:** X frequently changes their DOM structure - use `data-testid` attributes when available, prepare for selectors to break

4. **Zero-Latency Requirement:** All compute happens offline (GitHub Actions) - extension only does dumb pattern matching. Never introduce server-side matching that adds latency.

5. **Multi-keyword Priority:** When tweet matches multiple keywords, show the market with the most specific/longest keyword match first