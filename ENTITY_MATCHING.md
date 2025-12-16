# Entity-Based Matching System

## Overview

The Opinion HUD extension now uses **entity-based matching** to dramatically reduce false positives when matching tweets to prediction markets.

## Problem Solved

**Before:** Generic terms like "FDV", "market cap", "2026", "crypto" would match multiple markets, causing high false positive rates (50%+ on negative test samples).

**After:** Only match on **core entities** (brand names, project names) that uniquely identify markets. Generic descriptors are downweighted.

## How It Works

### Backend (AI-Powered Entity Extraction)

The backend AI (Zhipu GLM-4.6) now identifies 1-2 **core entities** per market in addition to keywords:

**AI Prompt Structure:**
```json
{
  "keywords": ["lighter", "fdv", "market cap", "launch", "tge"],
  "entities": ["Lighter"]
}
```

**Examples:**
- Market: "Lighter market cap (FDV) one day after launch?"
  - **Entity:** `Lighter` (specific project name)
  - Keywords: `lighter`, `fdv`, `market cap`, `launch`, `tge`

- Market: "Will Kraken IPO in 2025?"
  - **Entity:** `Kraken` (exchange name)
  - Keywords: `kraken`, `ipo`, `2025`, `exchange`

- Market: "Will Blackpink reunite with 2NE1?"
  - **Entities:** `Blackpink`, `2NE1` (band names)
  - Keywords: `blackpink`, `2ne1`, `reunion`, `comeback`

### Frontend (Entity-Prioritized Matching)

The extension gives **highest priority** to entity matches:

**Scoring System:**
1. **Entity match** → Score: 0.95 (highest confidence)
2. Multi-word phrase → Score: 0.85+
3. Single-word brand name → Score: 0.40-0.65
4. Generic terms → **Rejected** (score: 0)

**Example Tweet Matching:**

✅ **Good Match:**
- Tweet: "随着 @Lighter_xyz 基本确认今年内tge ，FDV 1B这个市场存在被低估可能性"
- Contains entity: `Lighter` → Match Lighter market (score: 0.95)

❌ **Rejected Match:**
- Tweet: "2025 摩尔线程2026 摩小满2027 摩尔理财2028 摩尔足球2029 摩尔恒大2030 摩尔债券"
- Contains: `2026` (generic year, no entity) → No match

## Data Structure

### Backend Output (data.json)

```json
{
  "events": {
    "88": {
      "title": "Lighter market cap (FDV) one day after launch?",
      "keywords": ["lighter", "fdv", "market cap", "launch", "tge"],
      "entities": ["lighter"],
      "marketIds": [1535, 1536, 1537, 1538]
    }
  },
  "markets": {
    "1535": {
      "title": "Lighter - Above $1B",
      "keywords": ["lighter", "fdv", "market cap"],
      "entities": ["lighter"],
      "eventId": "88"
    }
  }
}
```

### Frontend Processing

1. **buildMatcher()** creates entity lookup maps
2. **scoreEntry()** checks `entry.isEntity` flag
3. Entity matches bypass all generic term filtering

## Benefits

1. **Reduced False Positives:** Generic terms no longer trigger matches
2. **Higher Precision:** Only match on unique identifiers
3. **Better UX:** Users see relevant markets, not noise
4. **Scalable:** No need to manually maintain generic term blacklists

## Testing

Run backend tests:
```bash
cd backend
python3 test_entity_extraction.py
```

Test with real data:
```bash
# Build index with entity extraction
ZHIPU_KEY=your_key python3 build_index.py

# Or skip AI for quick test
SKIP_AI=1 python3 build_index.py
```

Frontend testing in extension options page:
1. Load extension in Chrome
2. Navigate to options page
3. Use "Batch Test" feature with negative.txt samples
4. Verify 0% false positive rate

## Migration

**Backwards Compatible:** The system handles both:
- New format: `{"keywords": [...], "entities": [...]}`
- Legacy format: `["keyword1", "keyword2", ...]`

Existing data.json files work without entities field (entities default to empty array).
