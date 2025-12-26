import json
import os
import re
import time
from datetime import datetime, timezone, timedelta

import requests
import zhipuai


OPINION_API_URL = os.environ.get("OPINION_API_URL", "").strip() or "http://opinion.api.predictscan.dev:10001/api/markets"
OPINION_WRAP_EVENTS_URL = "https://opinionanalytics.xyz/api/markets/wrap-events"
FRONTEND_BASE_URL = "https://opinion.trade"
MODEL_NAME = "GLM-4.6"
REF_PARAM = "opinion_hud"
DEBUG = os.environ.get("DEBUG", "").strip().lower() in ("1", "true", "yes", "y", "on")
SKIP_AI = os.environ.get("SKIP_AI", "").strip().lower() in ("1", "true", "yes", "y", "on")
# When enabled, never re-run the LLM for existing events; reuse previous outputs when available,
# otherwise fall back to deterministic extraction.
# Default is disabled (0) so new/changed events will use the LLM when ZHIPU_KEY is set.
INCREMENTAL_ONLY = os.environ.get("INCREMENTAL_ONLY", "0").strip().lower() in ("1", "true", "yes", "y", "on")
ZHIPU_TIMEOUT_SECONDS = float(os.environ.get("ZHIPU_TIMEOUT_SECONDS", "30"))
ZHIPU_MAX_RETRIES = int(os.environ.get("ZHIPU_MAX_RETRIES", "2"))
DISABLE_INCREMENTAL = os.environ.get("DISABLE_INCREMENTAL", "").strip().lower() in ("1", "true", "yes", "y", "on")
PREVIOUS_DATA_URL = os.environ.get("PREVIOUS_DATA_URL", "").strip() or None
ALLOW_LEGACY_REUSE = os.environ.get("ALLOW_LEGACY_REUSE", "1").strip().lower() in ("1", "true", "yes", "y", "on")
# Full refresh switch: when enabled, ignore any previous data and rebuild everything.
ALL_REFRESH = os.environ.get("ALL_REFRESH", "0").strip().lower() in ("1", "true", "yes", "y", "on")
# When enabled, never modify existing events/markets from previous data.json.
# Only generate outputs (LLM) for new event IDs not present in previous data.
#
# Default is enabled (1). Use `ADD_ONLY_NEW=0` (and optionally `DISABLE_INCREMENTAL=1`)
# to regenerate everything.
ADD_ONLY_NEW = os.environ.get("ADD_ONLY_NEW", "1").strip().lower() in ("1", "true", "yes", "y", "on")


def _now_epoch_seconds():
    return int(time.time())


def _format_utc8_time(epoch_seconds):
    """Format Unix timestamp as UTC+8 time string (YYYY-MM-DD HH:MM:SS UTC+8)."""
    utc8 = timezone(timedelta(hours=8))
    dt = datetime.fromtimestamp(epoch_seconds, tz=utc8)
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC+8")


def _parse_cutoff_epoch_seconds(value):
    if value is None:
        return None

    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None

        # Try ISO-8601-ish strings using only `time`.
        # Examples: "2025-12-31T23:59:59Z", "2025-12-31 23:59:59", "2025-12-31T23:59:59.123Z"
        try:
            zulu = raw.endswith("Z")
            candidate = raw[:-1] if zulu else raw
            if "T" in candidate:
                candidate = candidate.replace("T", " ")
            if "." in candidate:
                candidate = candidate.split(".", 1)[0]

            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                try:
                    tm = time.strptime(candidate, fmt)
                    epoch_local = time.mktime(tm)
                    if zulu:
                        offset = time.altzone if time.localtime(epoch_local).tm_isdst else time.timezone
                        return int(epoch_local - offset)
                    return int(epoch_local)
                except ValueError:
                    pass
        except Exception:
            pass

    try:
        cutoff = int(float(value))
    except (TypeError, ValueError):
        return None

    if cutoff <= 0:
        return None

    if cutoff > 1_000_000_000_000:
        return int(cutoff / 1000)
    return cutoff


def _flatten_markets(node):
    flattened = []

    if isinstance(node, list):
        for item in node:
            flattened.extend(_flatten_markets(item))
        return flattened

    if not isinstance(node, dict):
        return flattened

    flattened.append(node)
    children = node.get("childMarkets")
    if isinstance(children, list) and children:
        for child in children:
            flattened.extend(_flatten_markets(child))
    return flattened


def fetch_all_markets():
    """Fetch all markets from Predictscan's Opinion markets API (full list, no auth)."""
    if DEBUG:
        print(f"[debug] fetching markets (full list) from {OPINION_API_URL}", flush=True)
    response = requests.get(OPINION_API_URL, timeout=30)
    response.raise_for_status()
    payload = response.json()

    # API variants: list | {data: [...]} | {list: [...]}.
    if isinstance(payload, dict):
        if isinstance(payload.get("data"), list):
            payload = payload["data"]
        elif isinstance(payload.get("list"), list):
            payload = payload["list"]

    if not isinstance(payload, list):
        raise ValueError("Predictscan market API error: Invalid response format (expected list)")
    return _flatten_markets(payload)


def fetch_parent_events():
    """Fetch parent event details from wrap-events API to check cutoffAt for multi-markets."""
    if DEBUG:
        print(f"[debug] fetching parent events from {OPINION_WRAP_EVENTS_URL}", flush=True)
    try:
        response = requests.get(OPINION_WRAP_EVENTS_URL, timeout=30)
        response.raise_for_status()
        payload = response.json()

        # Extract data array
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            events_list = payload["data"]
        elif isinstance(payload, list):
            events_list = payload
        else:
            if DEBUG:
                print("[debug] wrap-events: unexpected format, returning empty dict", flush=True)
            return {}

        # Build event_id -> event_details mapping
        parent_events = {}
        for event in events_list:
            if not isinstance(event, dict):
                continue
            event_id = event.get("eventId") or event.get("marketId")
            if event_id:
                parent_events[str(event_id)] = {
                    "cutoffAt": event.get("cutoffAt"),
                    "statusEnum": event.get("statusEnum"),
                    "resolvedAt": event.get("resolvedAt"),
                    "title": event.get("title"),
                }

        if DEBUG:
            print(f"[debug] fetched {len(parent_events)} parent events", flush=True)
        return parent_events
    except Exception as exc:
        print(f"[warn] failed to fetch parent events from wrap-events API: {exc}", flush=True)
        return {}


def _market_id(market):
    # Prefer the canonical market identifier fields first.
    #
    # The Opinion API response may include both `id` and `marketId`; in some
    # payloads `id` can refer to a parent/event grouping identifier, which is
    # not unique per tradable market. Using it first can collapse many markets
    # into only a handful of IDs (overwriting entries in `markets_out`).
    for key in ("marketId", "market_id", "id"):
        value = market.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _market_title(market):
    # Prefer `marketTitle` per PRD; fall back to `title`.
    title = market.get("marketTitle") or market.get("title") or ""
    return str(title).strip()

def _market_parent_event(market):
    parent = market.get("parentEvent")
    return parent if isinstance(parent, dict) else None


def _market_parent_event_market_id(market):
    parent = _market_parent_event(market)
    if not parent:
        return None
    value = parent.get("eventMarketId")
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _market_parent_event_title(market):
    parent = _market_parent_event(market)
    if not parent:
        return ""
    title = parent.get("title") or ""
    return str(title).strip()


def _market_rules(market):
    rules = market.get("rules") or market.get("rule") or market.get("description") or ""
    return str(rules).strip()

def _market_volume(market):
    for key in (
        "volume",
        "volumeUsd",
        "volumeUSD",
        "volume24h",
        "totalVolume",
        "liquidity",
    ):
        if key in market and market.get(key) is not None:
            try:
                return float(market.get(key))
            except (TypeError, ValueError):
                pass
    return 0.0


def _is_processable_market(market, now_epoch_seconds):
    if market.get("statusEnum") != "Activated":
        return False

    resolved_at = _parse_cutoff_epoch_seconds(market.get("resolvedAt"))
    if resolved_at is not None and resolved_at > 0:
        return False

    cutoff = _parse_cutoff_epoch_seconds(market.get("cutoffAt"))
    if cutoff is None:
        # The API frequently returns `cutoffAt: 0` for still-active markets
        # (often option markets that belong to a `parentEvent`). Treat this
        # as "no cutoff" as long as the market is not resolved.
        raw_cutoff = market.get("cutoffAt")
        if raw_cutoff in (0, 0.0, "0", "0.0"):
            return True
        return False
    return cutoff > now_epoch_seconds


def _truncate(text, max_chars):
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "..."


def _extract_json_array(text):
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    if "```" in cleaned:
        parts = cleaned.split("```")
        for part in parts:
            candidate = part.strip()
            if candidate.startswith("[") and candidate.endswith("]"):
                cleaned = candidate
                break
            if candidate.startswith("json") and "[" in candidate and "]" in candidate:
                cleaned = candidate[candidate.find("[") : candidate.rfind("]") + 1].strip()
                break

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        if DEBUG:
            preview = cleaned[:500].replace("\n", "\\n")
            print(f"[warn] LLM output was not valid JSON array; preview={preview}", flush=True)
        return []

    if not isinstance(data, list):
        return []

    keywords = []
    for item in data:
        if isinstance(item, str):
            kw = item.strip()
            if kw:
                keywords.append(kw)
    return keywords


def _extract_keywords_and_entities(text):
    """Extract keywords plus entity groups from AI response.

    Expected format:
    {
      "keywords": ["keyword1", "keyword2", ...],
      "entityGroups": [["entity_or_1", "entity_or_2"], ["another_entity"]]
    }

    Backwards compatibility:
    - Legacy object format with "entities": ["A", "B"] is treated as AND of singletons: [["A"], ["B"]]
    - Legacy array format is treated as keywords only.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return {"keywords": [], "entities": [], "entityGroups": []}

    # Try to extract JSON from markdown code blocks
    if "```" in cleaned:
        parts = cleaned.split("```")
        for part in parts:
            candidate = part.strip()
            # Try object format first
            if candidate.startswith("{") and candidate.endswith("}"):
                cleaned = candidate
                break
            # Try array format (legacy)
            if candidate.startswith("[") and candidate.endswith("]"):
                cleaned = candidate
                break
            # Handle json-prefixed code blocks
            if candidate.startswith("json"):
                if "{" in candidate and "}" in candidate:
                    cleaned = candidate[candidate.find("{") : candidate.rfind("}") + 1].strip()
                    break
                elif "[" in candidate and "]" in candidate:
                    cleaned = candidate[candidate.find("[") : candidate.rfind("]") + 1].strip()
                    break

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        if DEBUG:
            preview = cleaned[:500].replace("\n", "\\n")
            print(f"[warn] LLM output was not valid JSON; preview={preview}", flush=True)
        return {"keywords": [], "entities": [], "entityGroups": []}

    # Handle new object format
    if isinstance(data, dict):
        keywords_raw = data.get("keywords", [])
        entity_groups_raw = data.get("entityGroups") or data.get("entity_groups") or data.get("ENTITY_GROUPS")
        entities_raw = data.get("entities", [])

        keywords = []
        if isinstance(keywords_raw, list):
            for item in keywords_raw:
                if isinstance(item, str):
                    kw = item.strip()
                    if kw:
                        keywords.append(kw)

        entity_groups = []
        if isinstance(entity_groups_raw, list):
            for group in entity_groups_raw:
                if isinstance(group, list):
                    g = []
                    for item in group:
                        if isinstance(item, str):
                            term = item.strip()
                            if term:
                                g.append(term)
                    if g:
                        entity_groups.append(g)
                elif isinstance(group, str):
                    term = group.strip()
                    if term:
                        entity_groups.append([term])

        # Legacy: "entities": ["A", "B"] means AND of required entities.
        if not entity_groups and isinstance(entities_raw, list):
            for item in entities_raw:
                if isinstance(item, str):
                    ent = item.strip()
                    if ent:
                        entity_groups.append([ent])

        entities = []
        for group in entity_groups:
            head = (group[0] if group else "").strip()
            if head and head not in entities:
                entities.append(head)

        return {"keywords": keywords, "entities": entities, "entityGroups": entity_groups}

    # Handle legacy array format (backwards compatibility)
    if isinstance(data, list):
        keywords = []
        for item in data:
            if isinstance(item, str):
                kw = item.strip()
                if kw:
                    keywords.append(kw)
        return {"keywords": keywords, "entities": [], "entityGroups": []}

    return {"keywords": [], "entities": [], "entityGroups": []}


def _normalize_keyword(keyword):
    kw = (keyword or "").strip().lower()
    kw = " ".join(kw.split())
    if kw.startswith('"') and kw.endswith('"') and len(kw) >= 2:
        kw = kw[1:-1].strip()
    return kw


_ENTITY_STOP_TERMS = {
    "crypto",
    "web3",
    "market",
    "markets",
    "team",
    "human",
    "ai",
    "teamai",
    "teamhuman",
    "humanvsai",
    "price",
    "defi",
    "token",
    "airdrop",
    "launch",
    "ipo",
    "tge",
    "fdv",
    "ath",
    "all time high",
    "rate decision",
    "fed rate decision",
    "interest rate",
    "interest rates",
    "rate cut",
    "rate hike",
    "yes",
    "no",
    "other",
    "resolution",
    "settlement",
    "settled",
    "increase",
    "decrease",
    "no change",
    "nochange",
    "unchanged",
    "hold",
    "winner",
    "champion",
    "acquire",
    "acquired",
    "acquirer",
    "acquisition",
    "buyout",
    "takeover",
    "closing",
    "close",
    "deal",
    "announced",
    "announce",
    "official",
    "announcement",
    "officialannouncement",
    "developer",
    "company",
    "brand",
    "investor",
    "buyer",
    "seller",
    "market cap",
    "marketcap",
    "valuation",
    "ticker",
    "exchange",
    "nasdaq",
    "nyse",
    "sec",
}

_ENTITY_MONTHS = {
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
}

_ENTITY_TIME_WORDS = {
    "before",
    "after",
    "until",
    "till",
    "by",
    "within",
}

_ENTITY_ALLOW_SHORT = {
    # CZ is a common 2-letter identifier on X.
    "cz",
}

_GENERIC_ENTITY_TOKENS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "before",
    "after",
    "until",
    "till",
    "within",
    "end",
    "for",
    "from",
    "has",
    "have",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "will",
    "with",
    "who",
    "which",
    "what",
    "winner",
    "champion",
    "best",
    "released",
    "release",
    "launch",
    "launched",
    "announced",
    "announce",
    "acquire",
    "acquired",
    "acquisition",
    "buyout",
    "takeover",
    "decision",
    "rate",
    "rates",
    "human",
    "ai",
    "team",
    "vs",
}

_ENTITY_ALLOWED_CONNECTORS = {
    "a",
    "an",
    "and",
    "of",
    "the",
    "to",
    "in",
    "on",
    "for",
    "at",
}

_ENTITY_DISALLOWED_QUESTION_WORDS = {
    "will",
    "who",
    "what",
    "which",
    "when",
    "where",
    "why",
    "how",
}


def _is_valid_entity_term(normalized_term):
    term = _normalize_keyword(normalized_term)
    if not term:
        return False

    if term in _ENTITY_STOP_TERMS:
        return False

    # Disallow obvious outcome tokens like "teamai"/"teamhuman".
    if term.startswith("team") and len(term) <= 12:
        return False

    tokens = term.split()
    if len(tokens) > 4:
        return False

    # Disallow obvious question/auxiliary words anywhere in the entity phrase.
    if any(tok in _ENTITY_DISALLOWED_QUESTION_WORDS for tok in tokens):
        return False

    if any(tok in _ENTITY_MONTHS for tok in tokens):
        return False

    if any(tok in _ENTITY_TIME_WORDS for tok in tokens):
        return False

    if any(tok.isdigit() and len(tok) == 4 for tok in tokens):
        return False

    # Reject single-token generic words (e.g. "will", "company").
    if len(tokens) == 1 and tokens[0] in _GENERIC_ENTITY_TOKENS:
        return False

    # For multi-word entities, allow light connector words, but reject generic content words
    # that typically encode outcomes or mechanics (e.g. "launch", "acquire", "decision").
    if len(tokens) >= 2 and any(
        (tok in _GENERIC_ENTITY_TOKENS) and (tok not in _ENTITY_ALLOWED_CONNECTORS) for tok in tokens
    ):
        return False

    # Reject phrases that are composed entirely of generic glue words.
    if len(tokens) >= 2 and all((tok in _GENERIC_ENTITY_TOKENS) or tok.isdigit() for tok in tokens):
        return False

    # Reject basis-points tokens like "25bp"/"25bps".
    if any(re.match(r"^\d{1,3}(?:bp|bps|basispoints?)$", tok) for tok in tokens):
        return False

    if term.isdigit() and len(term) == 4:
        return False

    if len(term) < 3 and term not in _ENTITY_ALLOW_SHORT:
        return False

    # Drop month+day tokens like "dec31", "dec31st", etc.
    if any(re.match(r"^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\d{1,2}(?:st|nd|rd|th)?$", tok) for tok in tokens):
        return False

    # Drop date-like strings such as "2025-12-31" or "12/31/2025".
    if re.search(r"\b(19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b", term):
        return False
    if re.search(r"\b\d{1,2}[-/]\d{1,2}[-/](19|20)\d{2}\b", term):
        return False

    return True


def _compact_alnum(text):
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower())

def _allowed_entity_alias_terms_from_title(title):
    lower = str(title or "").lower()
    allow = set()

    if ("bitcoin" in lower) or re.search(r"\bbtc\b", lower):
        allow.update({"btc", "bitcoin"})

    if ("ethereum" in lower) or re.search(r"\beth\b", lower):
        allow.update({"eth", "ethereum"})

    if ("fomc" in lower) or ("federal reserve" in lower) or re.search(r"\bfed\b", lower):
        allow.update({"fed", "fomc", "federalreserve", "federal reserve"})

    if "binance" in lower:
        allow.update({"binance"})

    if re.search(r"\bcz\b", lower) or ("changpeng zhao" in lower) or ("changpengzhao" in lower):
        allow.update({"cz", "changpengzhao", "changpeng zhao"})

    return allow


def _term_is_from_title(term, title, allow_terms):
    nterm = _normalize_keyword(term)
    if not nterm:
        return False
    if nterm in (allow_terms or set()):
        return True
    t_compact = _compact_alnum(title)
    n_compact = _compact_alnum(nterm)
    return bool(n_compact and t_compact and n_compact in t_compact)


def _normalize_entity_groups(entity_groups, title, allow_terms, max_groups=2, max_terms=4):
    normalized = []
    if not isinstance(entity_groups, list) or not entity_groups:
        return normalized

    for group in entity_groups:
        if not isinstance(group, list):
            continue
        ng = []
        for term in group:
            if not isinstance(term, str):
                continue
            nterm = _normalize_keyword(term)
            if not nterm:
                continue
            if not _is_valid_entity_term(nterm):
                continue
            if not _term_is_from_title(nterm, title, allow_terms):
                continue
            if nterm not in ng:
                ng.append(nterm)
            if len(ng) >= max_terms:
                break
        if ng:
            normalized.append(ng)
        if len(normalized) >= max_groups:
            break
    return normalized


def _collect_invalid_entity_terms(entity_groups, entities, title, allow_terms):
    bad = []

    def add(term):
        nterm = _normalize_keyword(term)
        if not nterm:
            return
        if nterm not in bad:
            bad.append(nterm)

    if isinstance(entity_groups, list):
        for group in entity_groups:
            terms = group if isinstance(group, list) else ([group] if isinstance(group, str) else [])
            for term in terms:
                if not isinstance(term, str):
                    continue
                nterm = _normalize_keyword(term)
                if not nterm:
                    continue
                if not _is_valid_entity_term(nterm):
                    add(nterm)
                elif not _term_is_from_title(nterm, title, allow_terms):
                    add(nterm)

    if isinstance(entities, list):
        for term in entities:
            if isinstance(term, str):
                nterm = _normalize_keyword(term)
                if not nterm:
                    continue
                if not _is_valid_entity_term(nterm):
                    add(nterm)
                elif not _term_is_from_title(nterm, title, allow_terms):
                    add(nterm)

    return bad[:20]


def _fallback_entity_groups_from_title(title):
    raw = str(title or "").strip()
    if not raw:
        return []

    lower = raw.lower()
    groups = []

    if "tiktok" in lower:
        return [["tiktok"]]

    if "oscars" in lower or "academy awards" in lower:
        return [["oscars", "academy awards", "oscar"]]

    if "super bowl" in lower:
        return [["super bowl", "nfl", "super bowl champion"]]

    if "world cup" in lower:
        return [["world cup", "fifa world cup", "fifa"]]

    if "champions league" in lower:
        return [["champions league", "uefa champions league", "uefa"]]

    if "premier league" in lower or re.search(r"\bepl\b", lower):
        return [["premier league", "english premier league", "epl"]]

    if "la liga" in lower or "laliga" in lower:
        return [["la liga", "laliga"]]

    if ("fomc" in lower) or ("federal reserve" in lower) or re.search(r"\bfed\b", lower):
        groups.append(["fed", "fomc", "federal reserve", "federalreserve"])
    if ("bitcoin" in lower) or re.search(r"\bbtc\b", lower):
        groups.append(["btc", "bitcoin"])
    if ("ethereum" in lower) or re.search(r"\beth\b", lower):
        groups.append(["eth", "ethereum"])
    if "binance" in lower:
        groups.append(["binance"])
    if re.search(r"\bcz\b", lower) or ("changpeng zhao" in lower):
        groups.append(["cz", "changpengzhao"])

    seen = set()
    for g in groups:
        for t in g:
            seen.add(t)

    candidates = []
    for token in _simple_tokenize(raw):
        token = str(token or "").lstrip("$#")
        term = _normalize_keyword(token)
        if not term:
            continue
        candidates.append(term)

    candidates.extend(_title_ngram_keywords(raw, max_phrases=24))

    scored = []
    for cand in candidates:
        cand = _normalize_keyword(cand)
        if not cand or cand in seen:
            continue
        if not _is_valid_entity_term(cand):
            continue
        if not _term_is_from_title(cand, raw, allow_terms=set()):
            continue
        toks = cand.split()
        specificity = sum(1 for t in toks if (t not in _GENERIC_ENTITY_TOKENS) and (not t.isdigit()))
        scored.append((specificity, len(toks), len(cand), cand))

    if scored and len(groups) < 2:
        scored.sort(
            key=lambda x: (
                -x[0],
                (x[1] if x[0] > 0 else -x[1]),
                (x[2] if x[0] > 0 else -x[2]),
            )
        )
        best = scored[0][3]
        groups.append([best])

    return groups


def _simple_tokenize(text):
    if not text:
        return []
    s = str(text)
    out = []
    cur = []
    for i in range(len(s)):
        ch = s[i]
        o = ord(ch)
        is_ascii_alnum = (48 <= o <= 57) or (65 <= o <= 90) or (97 <= o <= 122)
        if is_ascii_alnum:
            cur.append(ch.lower())
            continue

        # Keep simple pairs like "btc/usdt" together.
        if ch == "/" and cur:
            if i + 1 < len(s):
                nxt = s[i + 1]
                no = ord(nxt)
                nxt_is_ascii_alnum = (48 <= no <= 57) or (65 <= no <= 90) or (97 <= no <= 122)
                if nxt_is_ascii_alnum:
                    cur.append("/")
                    continue

        # Keep simple pairs like "gpt-6" together.
        if ch == "-" and cur:
            if i + 1 < len(s):
                nxt = s[i + 1]
                no = ord(nxt)
                nxt_is_ascii_alnum = (48 <= no <= 57) or (65 <= no <= 90) or (97 <= no <= 122)
                if nxt_is_ascii_alnum:
                    cur.append("-")
                    continue

        # Keep "$btc" together.
        if ch == "$":
            if cur:
                out.append("".join(cur))
                cur = []
            cur.append("$")
            continue

        if cur:
            out.append("".join(cur))
            cur = []

    if cur:
        out.append("".join(cur))
    return out


def _fallback_keywords(event_title, option_titles, rules_text, max_keywords=25):
    stop = {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "before",
        "by",
        "end",
        "for",
        "from",
        "has",
        "have",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "the",
        "to",
        "will",
        "with",
    }
    text = (event_title or "") + " " + " ".join(option_titles or []) + "\n" + (rules_text or "")
    words = _simple_tokenize(text)
    keywords = []
    for w in words:
        if len(w) < 3 and not (w.startswith("$") and len(w) >= 3):
            continue
        if w in stop:
            continue
        if len(w) > 40:
            continue
        if w not in keywords:
            keywords.append(w)
        if len(keywords) >= max_keywords:
            break
    if event_title:
        normalized_title = _normalize_keyword(event_title)
        if normalized_title and normalized_title not in keywords and len(normalized_title) <= 80:
            keywords.insert(0, normalized_title)
    return keywords


def _title_ngram_keywords(title, max_phrases=12):
    stop = {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "before",
        "by",
        "end",
        "for",
        "from",
        "has",
        "have",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "the",
        "to",
        "will",
        "with",
    }

    words = [w for w in _simple_tokenize(title or "") if w and w not in stop]
    # Drop extremely short tokens except year-like numbers.
    filtered = []
    for w in words:
        if w.isdigit() and len(w) == 4:
            filtered.append(w)
            continue
        if w.startswith("$") and len(w) >= 3:
            filtered.append(w)
            continue
        if len(w) >= 3:
            filtered.append(w)

    phrases = []
    # bigrams
    for i in range(len(filtered) - 1):
        a = filtered[i]
        b = filtered[i + 1]
        if a == b:
            continue
        phrases.append(f"{a} {b}")
    # trigrams
    for i in range(len(filtered) - 2):
        a = filtered[i]
        b = filtered[i + 1]
        c = filtered[i + 2]
        phrases.append(f"{a} {b} {c}")

    out = []
    for p in phrases:
        p = _normalize_keyword(p)
        if not p:
            continue
        if len(p) > 60:
            continue
        if p not in out:
            out.append(p)
        if len(out) >= max_phrases:
            break
    return out


def _djb2_32(text):
    h = 5381
    for ch in text:
        h = ((h << 5) + h + ord(ch)) & 0xFFFFFFFF
    return h


def _event_signature_core(event_title, rules_best):
    title = str(event_title or "").strip()
    rules_preview = str(rules_best or "").strip()[:1200]
    payload = {
        "title": title,
        "rules": rules_preview,
    }
    stable = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"{_djb2_32(stable):08x}"


def _event_signature_full(event_title, market_ids, option_titles_all, rules_best):
    title = str(event_title or "").strip()
    options = [str(x).strip() for x in (option_titles_all or []) if str(x).strip()]
    unique_options = sorted(set(options))[:80]
    rules_preview = str(rules_best or "").strip()[:1200]
    payload = {
        "title": title,
        "optionCount": len(market_ids or []),
        "options": unique_options,
        "rules": rules_preview,
    }
    stable = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"{_djb2_32(stable):08x}"


def _load_previous_data(output_path):
    if DISABLE_INCREMENTAL or ALL_REFRESH:
        return None

    if PREVIOUS_DATA_URL:
        try:
            resp = requests.get(PREVIOUS_DATA_URL, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict):
                return data
        except Exception as exc:
            if DEBUG:
                print(f"[warn] failed to load PREVIOUS_DATA_URL: {exc}", flush=True)
            return None

    try:
        if output_path and os.path.exists(output_path):
            with open(output_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception as exc:
        if DEBUG:
            print(f"[warn] failed to load previous data.json: {exc}", flush=True)
    return None


def _zhipu_chat_completion(api_key, messages):
    if hasattr(zhipuai, "ZhipuAI"):
        try:
            client = zhipuai.ZhipuAI(api_key=api_key, timeout=ZHIPU_TIMEOUT_SECONDS)
        except TypeError:
            client = zhipuai.ZhipuAI(api_key=api_key)

        try:
            resp = client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages,
                temperature=0.2,
                top_p=0.7,
                timeout=ZHIPU_TIMEOUT_SECONDS,
            )
        except TypeError:
            resp = client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages,
                temperature=0.2,
                top_p=0.7,
            )
        return resp.choices[0].message.content

    zhipuai.api_key = api_key
    resp = zhipuai.model_api.invoke(
        model=MODEL_NAME,
        prompt=messages,
        temperature=0.2,
        top_p=0.7,
    )

    if isinstance(resp, dict):
        for path in (
            ("data", "choices", 0, "content"),
            ("data", "choices", 0, "message", "content"),
            ("choices", 0, "message", "content"),
            ("choices", 0, "content"),
        ):
            cur = resp
            ok = True
            for key in path:
                if isinstance(key, int) and isinstance(cur, list) and len(cur) > key:
                    cur = cur[key]
                elif isinstance(cur, dict) and key in cur:
                    cur = cur[key]
                else:
                    ok = False
                    break
            if ok and isinstance(cur, str):
                return cur

    return str(resp)


def generate_keywords(api_key, title, rules, context=None):
    """Generate keywords and entities for a prediction market.

    Returns:
        dict with keys:
        - "keywords": list of keyword strings
        - "entities": list of 1-3 canonical entity strings (for display/debug)
        - "entityGroups": list of OR-groups; all groups required (AND)
    """
    system = (
        "You generate high-quality matching keywords and strict subject-identifying entity requirements for a prediction market. "
        "Return ONLY a JSON object (no prose). "
        "Include keywords (general terms, synonyms, slang) and entityGroups (high-precision identifiers)."
    )
    avoid_terms = None
    if isinstance(context, dict):
        avoid_terms = context.get("avoidEntityTerms")
    avoid_terms_list = []
    if isinstance(avoid_terms, (list, tuple)):
        for t in avoid_terms:
            nt = _normalize_keyword(t)
            if nt and nt not in avoid_terms_list:
                avoid_terms_list.append(nt)
            if len(avoid_terms_list) >= 20:
                break

    avoid_block = ""
    if avoid_terms_list:
        avoid_joined = ", ".join(avoid_terms_list)
        avoid_block = (
            "\n"
            "Previous attempt produced invalid entity terms. DO NOT use any of these in entityGroups:\n"
            f"- Avoid: {avoid_joined}\n"
        )

    user = (
        f"Market title: {title}\n"
        f"Market rules: {_truncate(rules, 1200)}\n\n"
        "Rules:\n"
        "- Output must be a JSON object with 'keywords' and 'entityGroups' fields (no extra fields).\n"
        "- keywords: 10-15 search terms (entities, synonyms, abbreviations, slang)\n"
        "- entityGroups: STRICT subject-identifying requirements as an AND-of-ORs (CNF)\n"
        "  * entityGroups is a list of groups; ALL groups are required (AND)\n"
        "  * each group is a list of synonyms; ANY term in the group can satisfy it (OR)\n"
        "  * Put the CANONICAL form FIRST in each group\n"
        "  * Use 1-2 groups total; keep each group to 1-4 terms\n"
        "  * Each term should be a short identifier (1-3 words) or a ticker\n"
        "  * entityGroups terms MUST identify the market's SUBJECT, not its outcomes/options\n"
        "  * entityGroups terms MUST come from the market title (you may add common aliases like BTC/ETH/Fed for those title entities)\n"
        "  * NEVER use question/aux words as entities: will, who, what, which, when, where, why, how\n"
        "  * NEVER use generic/outcome/mechanics terms as entities: yes, no, other, winner, champion, increase, decrease, nochange, hold, resolution, settlement,\n"
        "    market cap, valuation, launch, ipo, tge, fdv, ath, exchange, nasdaq, nyse, sec\n"
        "  * DO NOT put candidate options, answer labels, or alternative outcomes into entityGroups\n"
        "    - Bad: listing teams/nominees/companies as separate required groups for 'Winner' markets\n"
        "    - Bad: yes/no/other, increase/decrease/nochange, dates, months, times, price thresholds, marketcap/valuation, exchanges, tickers like ETHUSDT\n"
        "  * If the title is a 'winner/which ...' style multi-option market, use only the overarching subject in the title\n"
        "    (e.g., Oscars/NBA/Super Bowl/World Cup/TikTok), NOT the candidate list.\n"
        "  * If the market is about two key subjects that must both be mentioned (e.g., 'X vs Y', 'X acquires Y'), use 2 groups.\n"
        f"{avoid_block}"
        "- Prefer short phrases over sentences.\n"
        "- Do not include duplicates.\n"
        "\n"
        "Entity examples:\n"
        '- Title: "Will ETH all time high by 2025-12-31?" -> entityGroups: [["ETH", "Ethereum"]]\n'
        '- Title: "Will CZ return to Binance before 2025?" -> entityGroups: [["CZ", "Changpeng Zhao"], ["Binance"]]\n'
        '- Title: "US Fed Rate Decision in January?" -> entityGroups: [["Fed", "FOMC", "Federal Reserve"]]\n'
        '- Title: "Oscars 2026: Best Actor Winner" -> entityGroups: [["Oscars", "Academy Awards", "Oscar"]]\n'
        '- Title: "Who will acquire TikTok?" -> entityGroups: [["TikTok"]]\n'
        "\n"
        "Example output format:\n"
        '{\n'
        '  "keywords": ["lighter", "fdv", "market cap", "launch", "tge"],\n'
        '  "entityGroups": [["Lighter"]]\n'
        "}\n"
    )

    attempt = 0
    ctx = context if isinstance(context, dict) else {}
    ctx_event_id = str(ctx.get("eventId") or "").strip() or None
    ctx_best_market_id = str(ctx.get("bestMarketId") or "").strip() or None
    ctx_best_market_url = str(ctx.get("bestMarketUrl") or "").strip() or None
    ctx_label_parts = []
    if ctx_event_id:
        ctx_label_parts.append(f"eventId={ctx_event_id}")
    if ctx_best_market_id:
        ctx_label_parts.append(f"bestMarketId={ctx_best_market_id}")
    if ctx_best_market_url:
        ctx_label_parts.append(f"url={ctx_best_market_url}")
    ctx_label = (" " + " ".join(ctx_label_parts)) if ctx_label_parts else ""

    while True:
        attempt += 1
        try:
            content = _zhipu_chat_completion(
                api_key=api_key,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            result = _extract_keywords_and_entities(content)
            if DEBUG:
                print(
                    f"[debug] generated for title={title!r}: "
                    f"keywords={len(result['keywords'])} entities={len(result['entities'])} (attempt {attempt})",
                    flush=True,
                )
            return result
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            if attempt >= max(1, ZHIPU_MAX_RETRIES):
                safe_title = _truncate(str(title or "").strip(), 160)
                print(
                    f"[warn] keyword generation failed (final){ctx_label} title={safe_title!r}: {exc}",
                    flush=True,
                )
                return {"keywords": [], "entities": [], "entityGroups": []}
            sleep_for = min(2.0, 0.5 * attempt)
            if DEBUG:
                safe_title = _truncate(str(title or "").strip(), 160)
                print(
                    f"[warn] keyword generation failed (retrying){ctx_label} title={safe_title!r}: {exc}",
                    flush=True,
                )
            time.sleep(sleep_for)


def build_data(markets, api_key, previous_data=None, parent_events=None):
    now = _now_epoch_seconds()
    parent_events = parent_events or {}

    markets_out = {}
    events_out = {}
    inverted = {}
    event_inverted = {}

    processed = 0
    kept = 0
    duplicate_event_market_ids = 0
    skipped = {
        "statusEnum": 0,
        "cutoff_missing_or_invalid": 0,
        "cutoff_expired": 0,
        "cutoff_zero_kept": 0,
        "resolved": 0,
        "missing_id": 0,
        "missing_title": 0,
    }
    ai_stats = {
        "incremental": (previous_data is not None) and (not DISABLE_INCREMENTAL),
        "incrementalOnly": INCREMENTAL_ONLY,
        "reused": 0,
        "legacyReused": 0,
        "calls": 0,
        "retries": 0,
        "skipped": 0,
        "empty": 0,
        "non_empty": 0,
        "errors": 0,
    }
    event_stats = {
        "events": 0,
    }

    max_markets_env = os.environ.get("MAX_MARKETS")
    max_markets = int(max_markets_env) if (max_markets_env and max_markets_env.isdigit()) else None
    max_market_nodes_env = os.environ.get("MAX_MARKET_NODES")
    max_market_nodes = int(max_market_nodes_env) if (max_market_nodes_env and max_market_nodes_env.isdigit()) else None
    max_events_env = os.environ.get("MAX_EVENTS")
    max_events = int(max_events_env) if (max_events_env and max_events_env.isdigit()) else None
    sleep_seconds = float(os.environ.get("SLEEP_SECONDS", "0.2"))
    scan_log_every = int(os.environ.get("SCAN_LOG_EVERY", "100"))

    event_accumulator = {}
    prev_events = {}
    prev_markets = {}
    if (not DISABLE_INCREMENTAL) and isinstance(previous_data, dict):
        prev_events = previous_data.get("events") or {}
        if not isinstance(prev_events, dict):
            prev_events = {}
        prev_markets = previous_data.get("markets") or {}
        if not isinstance(prev_markets, dict):
            prev_markets = {}

    add_only_new = (not DISABLE_INCREMENTAL) and (not ALL_REFRESH) and bool(ADD_ONLY_NEW) and bool(prev_events) and bool(prev_markets)
    existing_event_ids = set(prev_events.keys()) if add_only_new else set()
    existing_market_ids = set(prev_markets.keys()) if add_only_new else set()
    if add_only_new:
        # Seed outputs with previous data. We will only add new event IDs.
        markets_out = dict(prev_markets)
        events_out = dict(prev_events)

    # Track resolved event IDs to remove them from output later
    resolved_event_ids = set()
    # Track all event IDs seen in current API response (to detect missing events in incremental mode)
    current_api_event_ids = set()

    for market in markets:
        processed += 1
        if max_market_nodes is not None and processed > max_market_nodes:
            break
        if max_markets is not None and kept >= max_markets:
            break
        if scan_log_every > 0 and processed % scan_log_every == 0:
            print(f"[info] scanned {processed} market nodes (kept {kept})", flush=True)

        market_id = _market_id(market)
        parent_event_title = _market_parent_event_title(market)
        parent_event_market_id = _market_parent_event_market_id(market)
        parent_event_id = market.get("parentEventId")
        event_id = parent_event_market_id or (str(parent_event_id).strip() if parent_event_id else None) or market_id

        # Record this event_id as seen in current API (regardless of status)
        if event_id and add_only_new:
            current_api_event_ids.add(event_id)

        if market.get("statusEnum") != "Activated":
            skipped["statusEnum"] += 1
            # Track resolved/inactive events to remove from previous data
            if event_id and add_only_new:
                resolved_event_ids.add(event_id)
            continue

        resolved_at = _parse_cutoff_epoch_seconds(market.get("resolvedAt"))
        if resolved_at is not None and resolved_at > 0:
            skipped["resolved"] += 1
            # Track resolved events to remove from previous data
            if event_id and add_only_new:
                resolved_event_ids.add(event_id)
            continue

        cutoff = _parse_cutoff_epoch_seconds(market.get("cutoffAt"))
        # If child market has cutoffAt=0, check parent event's cutoffAt
        if cutoff is None or cutoff == 0:
            raw_cutoff = market.get("cutoffAt")
            if raw_cutoff in (0, 0.0, "0", "0.0") and event_id and event_id in parent_events:
                parent_cutoff = _parse_cutoff_epoch_seconds(parent_events[event_id].get("cutoffAt"))
                if parent_cutoff is not None and parent_cutoff > 0:
                    cutoff = parent_cutoff
                    if DEBUG:
                        print(f"[debug] using parent event {event_id} cutoffAt: {cutoff}", flush=True)

        if cutoff is None:
            raw_cutoff = market.get("cutoffAt")
            if raw_cutoff in (0, 0.0, "0", "0.0"):
                skipped["cutoff_zero_kept"] += 1
            else:
                skipped["cutoff_missing_or_invalid"] += 1
                continue
        elif cutoff <= now:
            skipped["cutoff_expired"] += 1
            # Track expired events to remove from previous data
            if event_id and add_only_new:
                resolved_event_ids.add(event_id)
            continue

        if not market_id:
            skipped["missing_id"] += 1
            continue

        title = _market_title(market)
        if not title:
            skipped["missing_title"] += 1
            continue

        kept += 1

        event_title = parent_event_title or title
        event_market_id = event_id

        yes_label = market.get("yesLabel")
        no_label = market.get("noLabel")
        volume = _market_volume(market)
        # Treat events as the primary "market" for the extension.
        # Child option markets (e.g. "Team AI") should not become standalone
        # entries in `markets_out`; instead we aggregate to `event_market_id`.
        url = f"{FRONTEND_BASE_URL}/market/{event_market_id}?ref={REF_PARAM}"

        rules_text = _market_rules(market)
        option_title = title if parent_event_title else None

        if event_market_id in markets_out:
            duplicate_event_market_ids += 1
        else:
            markets_out[event_market_id] = {
                "title": event_title,
                "url": url,
                "volume": 0.0,
                "labels": {"yesLabel": None, "noLabel": None},
            }

        event_bucket = event_accumulator.get(event_id)
        if not event_bucket:
            event_bucket = {
                "eventId": event_id,
                "title": event_title,
                "marketIds": [],
                "optionTitles": [],
                "optionTitlesAll": [],
                "optionTitleSeen": set(),
                "rulesBest": "",
                "bestMarketId": market_id,
                "bestMarketVolume": volume,
                "sigCore": None,
                "sigFull": None,
            }
            event_accumulator[event_id] = event_bucket

        event_bucket["marketIds"].append(market_id)
        if option_title:
            if option_title not in event_bucket["optionTitleSeen"]:
                event_bucket["optionTitleSeen"].add(option_title)
                if len(event_bucket["optionTitles"]) < 20:
                    event_bucket["optionTitles"].append(option_title)
                if len(event_bucket["optionTitlesAll"]) < 500:
                    event_bucket["optionTitlesAll"].append(option_title)
        if rules_text and len(rules_text) > len(event_bucket["rulesBest"]):
            event_bucket["rulesBest"] = rules_text
        if volume > event_bucket["bestMarketVolume"]:
            event_bucket["bestMarketId"] = market_id
            event_bucket["bestMarketVolume"] = volume
            event_bucket["bestLabels"] = {"yesLabel": yes_label, "noLabel": no_label}

        # Update aggregated event-level market output.
        if event_market_id in markets_out:
            if not (add_only_new and event_market_id in existing_market_ids):
                markets_out[event_market_id]["volume"] = max(markets_out[event_market_id].get("volume") or 0.0, volume)
                # Prefer labels from the current best-volume option.
                if event_bucket.get("bestMarketId") == market_id:
                    markets_out[event_market_id]["labels"] = {"yesLabel": yes_label, "noLabel": no_label}

    if duplicate_event_market_ids and DEBUG:
        print(
            f"[debug] encountered {duplicate_event_market_ids} repeated event market IDs while building output; "
            f"kept_market_nodes={kept} unique_event_markets={len(markets_out)}",
            flush=True,
        )

    total_events = len(event_accumulator)
    planned_reuse = 0
    planned_llm = 0
    planned_skip = 0
    for event_id, bucket in event_accumulator.items():
        sig_core = _event_signature_core(bucket.get("title") or event_id, bucket.get("rulesBest") or "")
        sig_full = _event_signature_full(
            event_title=bucket.get("title") or event_id,
            market_ids=bucket.get("marketIds") or [],
            option_titles_all=bucket.get("optionTitlesAll") or bucket.get("optionTitles") or [],
            rules_best=bucket.get("rulesBest") or "",
        )
        bucket["sigCore"] = sig_core
        bucket["sigFull"] = sig_full

        reusable = False
        if add_only_new and event_id in existing_event_ids:
            reusable = True
        else:
            prev = prev_events.get(event_id)
            if isinstance(prev, dict):
                prev_keywords = prev.get("keywords")
                prev_entity_groups = prev.get("entityGroups") or prev.get("entity_groups")
                has_entity_groups = isinstance(prev_entity_groups, list) and any(isinstance(g, list) and g for g in prev_entity_groups)
                if isinstance(prev_keywords, list) and prev_keywords:
                    prev_sig_core = prev.get("sigCore")
                    prev_sig_full = prev.get("sigFull") or prev.get("sig") or prev.get("signature")
                    if INCREMENTAL_ONLY and has_entity_groups:
                        if str(prev.get("title") or "").strip() == str(bucket.get("title") or "").strip():
                            reusable = True
                    elif has_entity_groups and (
                        (prev_sig_core and str(prev_sig_core) == sig_core)
                        or (prev_sig_full and str(prev_sig_full) == sig_full)
                    ):
                        reusable = True
                    elif has_entity_groups and ALLOW_LEGACY_REUSE and (not prev_sig_core) and (not prev_sig_full):
                        if str(prev.get("title") or "").strip() == str(bucket.get("title") or "").strip():
                            reusable = True

        if reusable:
            planned_reuse += 1
        else:
            if SKIP_AI or INCREMENTAL_ONLY:
                planned_skip += 1
            else:
                planned_llm += 1

    if total_events:
        print(
            f"[info] events: total={total_events} reuse={planned_reuse} llm={planned_llm} skip_ai={planned_skip}",
            flush=True,
        )

    for event_id, bucket in event_accumulator.items():
        if max_events is not None and event_stats["events"] >= max_events:
            break
        event_stats["events"] += 1
        if event_stats["events"] == 1:
            to_run = min(total_events, max_events) if max_events is not None else total_events
            print(f"[info] resolving keywords for {to_run} events (from {kept} markets)", flush=True)
        if event_stats["events"] % 10 == 0:
            print(f"[info] events keyworded: {event_stats['events']}", flush=True)

        rules_text = bucket.get("rulesBest") or ""
        option_titles = bucket.get("optionTitles") or []
        if option_titles:
            options_preview = ", ".join(option_titles[:20])
            rules_text = (rules_text + "\n\nOptions: " + options_preview).strip()

        sig_core = bucket.get("sigCore") or _event_signature_core(bucket.get("title") or event_id, bucket.get("rulesBest") or "")
        sig_full = bucket.get("sigFull") or _event_signature_full(
            event_title=bucket.get("title") or event_id,
            market_ids=bucket.get("marketIds") or [],
            option_titles_all=bucket.get("optionTitlesAll") or option_titles,
            rules_best=bucket.get("rulesBest") or "",
        )

        reused = False
        keywords = []
        entities = []
        entity_groups = []

        if add_only_new and event_id in existing_event_ids:
            # Strict add-only mode: keep previous outputs untouched for existing event IDs.
            ai_stats["reused"] += 1
            continue

        prev = prev_events.get(event_id)
        if isinstance(prev, dict):
            prev_keywords = prev.get("keywords")
            prev_entities = prev.get("entities")
            prev_entity_groups = prev.get("entityGroups") or prev.get("entity_groups")
            has_entity_groups = isinstance(prev_entity_groups, list) and any(isinstance(g, list) and g for g in prev_entity_groups)
            prev_sig_core = prev.get("sigCore")
            prev_sig_full = prev.get("sigFull") or prev.get("sig") or prev.get("signature")
            if (
                isinstance(prev_keywords, list)
                and prev_keywords
                and ((prev_sig_core and str(prev_sig_core) == sig_core) or (prev_sig_full and str(prev_sig_full) == sig_full))
            ):
                if has_entity_groups:
                    keywords = [str(k) for k in prev_keywords if str(k).strip()]
                    entity_groups = prev_entity_groups
                    if isinstance(prev_entities, list):
                        entities = [str(e) for e in prev_entities if str(e).strip()]
                    reused = True
            elif INCREMENTAL_ONLY and has_entity_groups and isinstance(prev_keywords, list) and prev_keywords:
                if str(prev.get("title") or "").strip() == str(bucket.get("title") or "").strip():
                    keywords = [str(k) for k in prev_keywords if str(k).strip()]
                    entity_groups = prev_entity_groups
                    if isinstance(prev_entities, list):
                        entities = [str(e) for e in prev_entities if str(e).strip()]
                    reused = True
            elif ALLOW_LEGACY_REUSE and isinstance(prev_keywords, list) and prev_keywords:
                if (not prev_sig_core) and (not prev_sig_full) and str(prev.get("title") or "").strip() == str(bucket.get("title") or "").strip():
                    if has_entity_groups:
                        keywords = [str(k) for k in prev_keywords if str(k).strip()]
                        entity_groups = prev_entity_groups
                        if isinstance(prev_entities, list):
                            entities = [str(e) for e in prev_entities if str(e).strip()]
                        reused = True
                        ai_stats["legacyReused"] += 1

        if reused:
            ai_stats["reused"] += 1
        else:
            if SKIP_AI or INCREMENTAL_ONLY or not api_key:
                ai_stats["skipped"] += 1
                keywords = _fallback_keywords(bucket.get("title") or event_id, option_titles, rules_text)
                entity_groups = []
                entities = []
            else:
                ai_stats["calls"] += 1
                try:
                    title_for_ai = bucket.get("title") or event_id
                    best_market_id = bucket.get("bestMarketId")
                    best_market_url = (
                        f"{FRONTEND_BASE_URL}/market/{best_market_id}?ref={REF_PARAM}"
                        if best_market_id
                        else None
                    )
                    allow_terms = {_normalize_keyword(t) for t in _allowed_entity_alias_terms_from_title(title_for_ai)}

                    safe_title = _truncate(str(title_for_ai or "").strip(), 160)
                    print(f"[info] llm: generating entities/keywords for event={event_id} title={safe_title!r}", flush=True)
                    result = generate_keywords(
                        api_key,
                        title=title_for_ai,
                        rules=rules_text,
                        context={
                            "eventId": event_id,
                            "bestMarketId": best_market_id,
                            "bestMarketUrl": best_market_url,
                        },
                    )
                    if isinstance(result, dict):
                        keywords = result.get("keywords", [])
                        entities = result.get("entities", [])
                        entity_groups = result.get("entityGroups", []) or result.get("entity_groups", [])
                        normalized_try = _normalize_entity_groups(entity_groups, title_for_ai, allow_terms)

                        if not normalized_try:
                            bad_terms = _collect_invalid_entity_terms(entity_groups, entities, title_for_ai, allow_terms)
                            ai_stats["retries"] += 1
                            if bad_terms:
                                print(
                                    f"[warn] llm: retrying once for event={event_id} due to invalid entityGroups; avoid={bad_terms}",
                                    flush=True,
                                )
                            else:
                                print(
                                    f"[warn] llm: retrying once for event={event_id} due to empty/invalid entityGroups",
                                    flush=True,
                                )
                            retry_ctx = {
                                "eventId": event_id,
                                "bestMarketId": best_market_id,
                                "bestMarketUrl": best_market_url,
                            }
                            if bad_terms:
                                retry_ctx["avoidEntityTerms"] = bad_terms
                            retry = generate_keywords(
                                api_key,
                                title=title_for_ai,
                                rules=rules_text,
                                context=retry_ctx,
                            )
                            if isinstance(retry, dict):
                                keywords = retry.get("keywords", keywords)
                                entities = retry.get("entities", entities)
                                entity_groups = retry.get("entityGroups", []) or retry.get("entity_groups", [])
                    elif isinstance(result, list):
                        # Backwards compatibility with old array format
                        keywords = result
                        entities = []
                        entity_groups = []
                except Exception:
                    ai_stats["errors"] += 1
                    keywords = []
                    entities = []
                    entity_groups = []
        if not keywords:
            ai_stats["empty"] += 1
        else:
            ai_stats["non_empty"] += 1

        # Always supplement with deterministic title n-grams so short tweets
        # like "Kraken IPO..." still match even if the LLM returns only longer phrases.
        supplement = _title_ngram_keywords(bucket.get("title") or event_id)
        for s in supplement:
            if s not in keywords:
                keywords.append(s)

        normalized = []
        for kw in keywords:
            nkw = _normalize_keyword(kw)
            if nkw and nkw not in normalized:
                normalized.append(nkw)

        normalized_entities = []
        normalized_entity_groups = []
        allow_terms = {_normalize_keyword(t) for t in _allowed_entity_alias_terms_from_title(bucket.get("title") or event_id)}

        if isinstance(entity_groups, list) and entity_groups:
            for group in entity_groups:
                if not isinstance(group, list):
                    continue
                ng = []
                for term in group:
                    if not isinstance(term, str):
                        continue
                    nterm = _normalize_keyword(term)
                    if not nterm:
                        continue
                    if not _is_valid_entity_term(nterm):
                        continue
                    if not _term_is_from_title(nterm, bucket.get("title") or event_id, allow_terms):
                        continue
                    if nterm not in ng:
                        ng.append(nterm)
                    if len(ng) >= 4:
                        break
                if ng:
                    normalized_entity_groups.append(ng)
                if len(normalized_entity_groups) >= 2:
                    break

        # Backwards compatibility: treat legacy `entities` as AND of singletons.
        if not normalized_entity_groups and isinstance(entities, list) and entities:
            for ent in entities:
                nent = _normalize_keyword(ent)
                if not nent:
                    continue
                if not _is_valid_entity_term(nent):
                    continue
                if not _term_is_from_title(nent, bucket.get("title") or event_id, allow_terms):
                    continue
                normalized_entity_groups.append([nent])
                if len(normalized_entity_groups) >= 2:
                    break

        # Canonical entities (for display/debug): first term of each OR-group.
        seen_entities = set()
        for group in normalized_entity_groups:
            head = group[0] if group else ""
            if head and head not in seen_entities:
                seen_entities.add(head)
                normalized_entities.append(head)

        events_out[event_id] = {
            "title": bucket.get("title") or event_id,
            "marketIds": [event_id],
            "bestMarketId": event_id,
            "bestLabels": bucket.get("bestLabels") or None,
            "keywords": normalized,
            "entities": normalized_entities,
            "entityGroups": normalized_entity_groups,
            "sig": sig_full,
            "sigFull": sig_full,
            "sigCore": sig_core,
            "reused": reused,
        }

        if event_id in markets_out:
            markets_out[event_id]["keywords"] = normalized
            markets_out[event_id]["entities"] = normalized_entities
            markets_out[event_id]["entityGroups"] = normalized_entity_groups
            if events_out[event_id].get("bestLabels"):
                markets_out[event_id]["labels"] = events_out[event_id]["bestLabels"]

        # Add both keywords and entities to index
        for nkw in normalized:
            event_inverted.setdefault(nkw, set()).add(event_id)
            inverted.setdefault(nkw, set()).add(event_id)

        # Also add entity terms (AND/OR groups) to index so entity-only matching works.
        entity_terms = set()
        for group in normalized_entity_groups:
            for term in group:
                if term:
                    entity_terms.add(term)
        for term in entity_terms:
            event_inverted.setdefault(term, set()).add(event_id)
            inverted.setdefault(term, set()).add(event_id)

        if sleep_seconds > 0 and (not reused) and (not SKIP_AI):
            time.sleep(sleep_seconds)

    # Remove resolved/expired events from output
    if resolved_event_ids:
        removed_count = 0
        for event_id in resolved_event_ids:
            if event_id in events_out:
                del events_out[event_id]
                removed_count += 1
            if event_id in markets_out:
                del markets_out[event_id]
        if removed_count > 0:
            print(f"[info] removed {removed_count} resolved/expired events from output", flush=True)

    # In incremental mode, also remove events that are no longer in current API response
    if add_only_new and current_api_event_ids:
        missing_event_ids = set(events_out.keys()) - current_api_event_ids
        if DEBUG:
            print(f"[debug] current_api_event_ids count: {len(current_api_event_ids)}", flush=True)
            print(f"[debug] events_out count: {len(events_out)}", flush=True)
            print(f"[debug] missing_event_ids count: {len(missing_event_ids)}", flush=True)
            if missing_event_ids:
                print(f"[debug] missing_event_ids sample: {sorted(list(missing_event_ids))[:10]}", flush=True)
        if missing_event_ids:
            missing_count = 0
            for event_id in missing_event_ids:
                if event_id in events_out:
                    del events_out[event_id]
                    missing_count += 1
                if event_id in markets_out:
                    del markets_out[event_id]
            if missing_count > 0:
                print(f"[info] removed {missing_count} events no longer in API response", flush=True)

    index_out = {kw: sorted(list(ids)) for kw, ids in sorted(inverted.items(), key=lambda kv: kv[0])}
    event_index_out = {kw: sorted(list(ids)) for kw, ids in sorted(event_inverted.items(), key=lambda kv: kv[0])}

    if add_only_new:
        rebuilt = {}
        for eid, e in events_out.items():
            if not isinstance(e, dict):
                continue
            kws = e.get("keywords")
            if isinstance(kws, list):
                for kw in kws:
                    nkw = _normalize_keyword(kw)
                    if nkw:
                        rebuilt.setdefault(nkw, set()).add(eid)
            groups = e.get("entityGroups") or e.get("entity_groups")
            if isinstance(groups, list):
                for group in groups:
                    if not isinstance(group, list):
                        continue
                    for term in group:
                        nterm = _normalize_keyword(term)
                        if nterm:
                            rebuilt.setdefault(nterm, set()).add(eid)
        index_out = {kw: sorted(list(ids)) for kw, ids in sorted(rebuilt.items(), key=lambda kv: kv[0])}
        event_index_out = index_out

    return {
        "meta": {
            "generatedAt": _format_utc8_time(now),
            "source": OPINION_API_URL,
            "frontendBaseUrl": FRONTEND_BASE_URL,
            "model": MODEL_NAME,
            "ref": REF_PARAM,
            "debug": DEBUG,
                "counts": {
                    "seen": processed,
                    "kept": kept,
                    "markets": len(markets_out),
                    "keywords": len(index_out),
                    "events": event_stats,
                    "skipped": skipped,
                    "ai": ai_stats,
            },
        },
        "events": events_out,
        "markets": markets_out,
        "index": index_out,
        "eventIndex": event_index_out,
    }


def main():
    print("[info] starting build_index", flush=True)
    api_key = os.environ.get("ZHIPU_KEY")
    if not api_key and not (SKIP_AI or INCREMENTAL_ONLY):
        print("[error] Missing ZHIPU_KEY environment variable.", flush=True)
        raise ValueError("ZHIPU_KEY is not set")

    # Default output path: project root directory (one level up from backend/)
    output_path = os.environ.get("OUTPUT_PATH") or os.path.join(os.path.dirname(os.path.dirname(__file__)), "data.json")

    if SKIP_AI:
        print("[info] SKIP_AI enabled: using fallback keywords (no LLM calls)", flush=True)
    if INCREMENTAL_ONLY:
        print("[info] INCREMENTAL_ONLY enabled: reuse previous outputs; no LLM calls", flush=True)

    if ALL_REFRESH:
        print("[info] ALL_REFRESH enabled: rebuilding everything (ignore previous data.json)", flush=True)

    if DEBUG:
        print(
            "[debug] env MAX_MARKETS=%r SLEEP_SECONDS=%r OUTPUT_PATH=%r"
            % (os.environ.get("MAX_MARKETS"), os.environ.get("SLEEP_SECONDS"), os.environ.get("OUTPUT_PATH")),
            flush=True,
        )
        print(f"[debug] SKIP_AI={SKIP_AI}", flush=True)
        print(f"[debug] DISABLE_INCREMENTAL={DISABLE_INCREMENTAL}", flush=True)
        print(f"[debug] ALL_REFRESH={ALL_REFRESH}", flush=True)
        if PREVIOUS_DATA_URL:
            print("[debug] PREVIOUS_DATA_URL is set", flush=True)
        print(
            "[debug] ZHIPU_TIMEOUT_SECONDS=%s ZHIPU_MAX_RETRIES=%s"
            % (ZHIPU_TIMEOUT_SECONDS, ZHIPU_MAX_RETRIES),
            flush=True,
        )

    print("[info] fetching markets...", flush=True)
    markets = fetch_all_markets()
    print(f"[info] fetched {len(markets)} market nodes (including parents)", flush=True)

    print("[info] fetching parent events for cutoff validation...", flush=True)
    parent_events = fetch_parent_events()

    previous_data = None
    if DISABLE_INCREMENTAL or ALL_REFRESH:
        print("[info] DISABLE_INCREMENTAL enabled: ignoring previous data.json", flush=True)
    else:
        previous_data = _load_previous_data(output_path)
        if previous_data is not None:
            print("[info] incremental: loaded previous data.json for keyword reuse", flush=True)
    data = build_data(markets, api_key=api_key, previous_data=previous_data, parent_events=parent_events)

    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"[info] wrote {output_path}", flush=True)


if __name__ == "__main__":
    main()
