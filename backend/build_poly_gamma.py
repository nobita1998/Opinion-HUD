import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests

import build_index as opinion_build


GAMMA_API_BASE = os.environ.get("POLY_GAMMA_API_BASE", "").strip() or "https://gamma-api.polymarket.com"
POLY_FRONTEND_BASE_URL = os.environ.get("POLY_FRONTEND_BASE_URL", "").strip() or "https://polymarket.com"

DEBUG = os.environ.get("DEBUG", "").strip().lower() in ("1", "true", "yes", "y", "on")
SKIP_AI = os.environ.get("SKIP_AI", "").strip().lower() in ("1", "true", "yes", "y", "on")
INCREMENTAL_ONLY = os.environ.get("INCREMENTAL_ONLY", "0").strip().lower() in ("1", "true", "yes", "y", "on")
SCAN_LOG_EVERY = int(os.environ.get("POLY_SCAN_LOG_EVERY", "200"))
FETCH_LOG_EVERY_PAGES = int(os.environ.get("POLY_FETCH_LOG_EVERY_PAGES", "5"))

MODEL_NAME = getattr(opinion_build, "MODEL_NAME", "GLM-4.6")


def _now_epoch_seconds() -> int:
    return int(time.time())


def _parse_float(value: Any) -> float:
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _parse_iso_epoch_seconds(value: Any) -> Optional[int]:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return None


def _safe_str(value: Any) -> str:
    return str(value or "").strip()


def _event_url(event_slug: str) -> str:
    return f"{POLY_FRONTEND_BASE_URL.rstrip('/')}/event/{event_slug}"


def _event_is_sports(event: Dict[str, Any]) -> bool:
    tags = event.get("tags")
    if not isinstance(tags, list):
        return False
    for tag in tags:
        if not isinstance(tag, dict):
            continue
        if str(tag.get("id")) == "1":
            return True
        if str(tag.get("slug") or "").strip().lower() == "sports":
            return True
    return False


def _extract_option_titles(event: Dict[str, Any], now_epoch_seconds: int, max_items: int = 24) -> List[str]:
    markets = event.get("markets")
    if not isinstance(markets, list):
        return []

    titles: List[str] = []
    for m in markets:
        if not isinstance(m, dict):
            continue
        if m.get("closed") is True:
            continue
        end_epoch = _parse_iso_epoch_seconds(m.get("endDate"))
        if end_epoch is not None and end_epoch <= now_epoch_seconds:
            continue
        q = _safe_str(m.get("question"))
        if q and q not in titles:
            titles.append(q)
        if len(titles) >= max_items:
            break
    return titles


def _extract_best_outcomes(event: Dict[str, Any], now_epoch_seconds: int) -> Optional[List[str]]:
    markets = event.get("markets")
    if not isinstance(markets, list) or not markets:
        return None

    best: Optional[Dict[str, Any]] = None
    best_volume = -1.0
    for m in markets:
        if not isinstance(m, dict):
            continue
        if m.get("closed") is True:
            continue
        end_epoch = _parse_iso_epoch_seconds(m.get("endDate"))
        if end_epoch is not None and end_epoch <= now_epoch_seconds:
            continue
        vol = _parse_float(m.get("volumeNum") or m.get("volume"))
        if vol > best_volume:
            best = m
            best_volume = vol

    if not best:
        return None

    raw_outcomes = best.get("outcomes")
    if isinstance(raw_outcomes, list):
        outcomes = [str(x).strip() for x in raw_outcomes if str(x).strip()]
        return outcomes or None

    if isinstance(raw_outcomes, str):
        try:
            parsed = json.loads(raw_outcomes)
            if isinstance(parsed, list):
                outcomes = [str(x).strip() for x in parsed if str(x).strip()]
                return outcomes or None
        except Exception:
            return None

    return None


def fetch_events_page(limit: int, offset: int) -> List[Dict[str, Any]]:
    """Fetch one page of active Polymarket events from Gamma API."""
    params = {
        "closed": "false",
        "order": "id",
        "ascending": "false",
        "limit": str(limit),
        "offset": str(offset),
    }
    url = f"{GAMMA_API_BASE.rstrip('/')}/events"
    resp = requests.get(url, params=params, timeout=30)
    resp.raise_for_status()
    payload = resp.json()
    return payload if isinstance(payload, list) else []


def fetch_all_events(limit: int, max_events: Optional[int] = None) -> List[Dict[str, Any]]:
    offset = 0
    out: List[Dict[str, Any]] = []
    pages = 0
    while True:
        pages += 1
        if FETCH_LOG_EVERY_PAGES > 0 and pages % FETCH_LOG_EVERY_PAGES == 1:
            print(f"[info] fetching gamma events page offset={offset} limit={limit}", flush=True)
        page = fetch_events_page(limit=limit, offset=offset)
        if not page:
            break
        for item in page:
            if isinstance(item, dict):
                out.append(item)
                if max_events is not None and len(out) >= max_events:
                    return out
        offset += limit
    return out


def _build_event_rules_text(title: str, description: str, option_titles: List[str]) -> str:
    rules = (description or "").strip()
    if option_titles:
        joined = "\n".join(f"- {t}" for t in option_titles[:24])
        rules = (rules + "\n\nOptions:\n" + joined).strip()
    if not rules:
        rules = title
    return rules


def _normalize_keywords(raw_keywords: Any) -> List[str]:
    normalized: List[str] = []
    if not isinstance(raw_keywords, list):
        return normalized
    for kw in raw_keywords:
        nkw = opinion_build._normalize_keyword(kw)
        if not nkw:
            continue
        if nkw not in normalized:
            normalized.append(nkw)
        if len(normalized) >= 18:
            break
    return normalized


def _build_keywords_and_entities(
    api_key: Optional[str],
    event_id: str,
    title: str,
    rules_text: str,
    option_titles: List[str],
    previous: Optional[Dict[str, Any]],
    sig_core: str,
    sig_full: str,
) -> Tuple[List[str], List[str], List[List[str]], bool]:
    prev = previous or {}
    prev_sig_core = str(prev.get("sigCore") or "").strip()
    prev_sig_full = str(prev.get("sigFull") or prev.get("sig") or "").strip()
    if (prev_sig_core and prev_sig_core == sig_core) or (prev_sig_full and prev_sig_full == sig_full):
        kws = prev.get("keywords") if isinstance(prev.get("keywords"), list) else []
        entities = prev.get("entities") if isinstance(prev.get("entities"), list) else []
        groups = prev.get("entityGroups") if isinstance(prev.get("entityGroups"), list) else []
        return list(kws), list(entities), list(groups), True

    if INCREMENTAL_ONLY:
        kws = prev.get("keywords") if isinstance(prev.get("keywords"), list) else []
        entities = prev.get("entities") if isinstance(prev.get("entities"), list) else []
        groups = prev.get("entityGroups") if isinstance(prev.get("entityGroups"), list) else []
        if kws and groups:
            return list(kws), list(entities), list(groups), True

    if SKIP_AI:
        keywords = opinion_build._fallback_keywords(title, option_titles, rules_text, max_keywords=25)
        entity_groups = opinion_build._fallback_entity_groups_from_title(title)
        entities = [g[0] for g in entity_groups if g]
        return keywords[:18], entities[:3], entity_groups, False

    if not api_key:
        raise ValueError("Missing ZHIPU_KEY environment variable (required unless SKIP_AI/INCREMENTAL_ONLY).")

    context = {"eventId": event_id}
    started = time.time()
    safe_title = (title or "").strip().replace("\n", " ")
    if len(safe_title) > 160:
        safe_title = safe_title[:160].rstrip() + "..."
    print(f"[info] llm: generate_keywords start event={event_id} title={safe_title!r}", flush=True)
    result = opinion_build.generate_keywords(api_key, title, rules_text, context=context)
    elapsed_ms = int((time.time() - started) * 1000)
    print(f"[info] llm: generate_keywords done event={event_id} elapsedMs={elapsed_ms}", flush=True)
    keywords = _normalize_keywords(result.get("keywords"))
    allow_terms = opinion_build._allowed_entity_alias_terms_from_title(title)
    entity_groups = opinion_build._normalize_entity_groups(result.get("entityGroups"), title, allow_terms)
    if not entity_groups:
        entity_groups = opinion_build._fallback_entity_groups_from_title(title)
    entities = [g[0] for g in entity_groups if g]
    return keywords[:18], entities[:3], entity_groups, False


def build_poly_data(events: Iterable[Dict[str, Any]], api_key: Optional[str], previous_data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    now = _now_epoch_seconds()

    min_volume = float(os.environ.get("POLY_MIN_VOLUME_NUM", "10000"))
    min_minutes_to_expiry = int(os.environ.get("POLY_MIN_MINUTES_TO_EXPIRY", "60"))
    min_expiry_epoch = now + (min_minutes_to_expiry * 60)

    events_out: Dict[str, Any] = {}
    markets_out: Dict[str, Any] = {}
    inverted: Dict[str, set] = {}
    skipped = {
        "missing_id": 0,
        "missing_title": 0,
        "closed": 0,
        "archived": 0,
        "expired_or_too_soon": 0,
        "event_ended": 0,
        "no_active_markets": 0,
        "low_volume": 0,
    }

    prev_events = (previous_data or {}).get("events")
    prev_events = prev_events if isinstance(prev_events, dict) else {}

    seen = 0
    kept = 0

    for event in events:
        if not isinstance(event, dict):
            continue
        seen += 1
        if SCAN_LOG_EVERY > 0 and seen % SCAN_LOG_EVERY == 0:
            print(f"[info] scanned {seen} events (kept {kept})", flush=True)

        if event.get("closed") is True:
            skipped["closed"] += 1
            continue
        if event.get("archived") is True:
            skipped["archived"] += 1
            continue

        event_id = _safe_str(event.get("slug") or event.get("id"))
        if not event_id:
            skipped["missing_id"] += 1
            continue

        title = _safe_str(event.get("title"))
        if not title:
            skipped["missing_title"] += 1
            continue

        end_epoch = _parse_iso_epoch_seconds(event.get("endDate"))
        if end_epoch is not None and end_epoch <= now:
            skipped["event_ended"] += 1
            continue
        if end_epoch is not None and end_epoch <= min_expiry_epoch:
            skipped["expired_or_too_soon"] += 1
            continue

        volume = _parse_float(event.get("volume") or event.get("volumeNum"))
        if volume < min_volume:
            skipped["low_volume"] += 1
            continue

        option_titles = _extract_option_titles(event, now_epoch_seconds=now)
        rules_text = _build_event_rules_text(title, _safe_str(event.get("description")), option_titles)

        market_ids = []
        active_market_count = 0
        markets = event.get("markets")
        if isinstance(markets, list):
            for m in markets:
                if not isinstance(m, dict):
                    continue
                if m.get("closed") is True:
                    continue
                m_end_epoch = _parse_iso_epoch_seconds(m.get("endDate"))
                if m_end_epoch is not None and m_end_epoch <= now:
                    continue
                active_market_count += 1
                mid = _safe_str(m.get("id") or m.get("slug"))
                if mid:
                    market_ids.append(mid)
                if len(market_ids) >= 200:
                    break
        if active_market_count <= 0:
            skipped["no_active_markets"] += 1
            continue

        sig_core = opinion_build._event_signature_core(title, rules_text)
        sig_full = opinion_build._event_signature_full(title, market_ids, option_titles, rules_text)

        prev = prev_events.get(event_id) if isinstance(prev_events, dict) else None
        keywords, entities, entity_groups, reused = _build_keywords_and_entities(
            api_key=api_key,
            event_id=event_id,
            title=title,
            rules_text=rules_text,
            option_titles=option_titles,
            previous=prev if isinstance(prev, dict) else None,
            sig_core=sig_core,
            sig_full=sig_full,
        )
        if DEBUG:
            print(
                f"[debug] event={event_id} reused={reused} keywords={len(keywords)} entityGroups={len(entity_groups)}",
                flush=True,
            )

        outcomes = _extract_best_outcomes(event, now_epoch_seconds=now)
        best_labels = {"outcomes": outcomes} if outcomes else None
        is_sports = _event_is_sports(event)
        tags = event.get("tags") if isinstance(event.get("tags"), list) else []
        tag_slugs = [
            str(t.get("slug")).strip()
            for t in tags
            if isinstance(t, dict) and str(t.get("slug") or "").strip()
        ]

        events_out[event_id] = {
            "title": title,
            "marketIds": [event_id],
            "bestMarketId": event_id,
            "bestLabels": best_labels,
            "keywords": keywords,
            "entities": entities,
            "entityGroups": entity_groups,
            "sig": sig_full,
            "sigFull": sig_full,
            "sigCore": sig_core,
            "reused": reused,
            "provider": "polymarket",
        }

        markets_out[event_id] = {
            "title": title,
            "url": _event_url(event_id),
            "volume": volume,
            "labels": best_labels,
            "keywords": keywords,
            "entities": entities,
            "entityGroups": entity_groups,
            "endDate": _safe_str(event.get("endDate")),
            "isSports": is_sports,
            "tags": tag_slugs,
            "provider": "polymarket",
        }

        for term in keywords:
            inverted.setdefault(term, set()).add(event_id)
        for group in entity_groups or []:
            if not isinstance(group, list):
                continue
            for term in group:
                nterm = opinion_build._normalize_keyword(term)
                if nterm:
                    inverted.setdefault(nterm, set()).add(event_id)

        kept += 1
        if DEBUG and kept % 50 == 0:
            print(f"[debug] kept {kept} events (scanned {seen})", flush=True)

    index_out = {kw: sorted(list(ids)) for kw, ids in sorted(inverted.items(), key=lambda kv: kv[0])}

    return {
        "meta": {
            "generatedAt": now,
            "source": f"{GAMMA_API_BASE.rstrip('/')}/events",
            "frontendBaseUrl": POLY_FRONTEND_BASE_URL,
            "model": MODEL_NAME,
            "provider": "polymarket",
            "filters": {
                "minVolumeNum": min_volume,
                "minMinutesToExpiry": min_minutes_to_expiry,
            },
            "debug": DEBUG,
            "counts": {
                "seen": seen,
                "kept": kept,
                "events": len(events_out),
                "markets": len(markets_out),
                "keywords": len(index_out),
                "skipped": skipped,
            },
        },
        "events": events_out,
        "markets": markets_out,
        "index": index_out,
        "eventIndex": index_out,
    }


def main() -> None:
    output_path = os.environ.get("OUTPUT_PATH") or os.path.join(os.path.dirname(__file__), "polymarket-data.json")
    print("[info] starting build_poly_gamma", flush=True)
    print(f"[info] output_path={output_path}", flush=True)
    print(f"[info] gamma_base={GAMMA_API_BASE} frontend_base={POLY_FRONTEND_BASE_URL}", flush=True)

    api_key = os.environ.get("ZHIPU_KEY")
    if not api_key and not (SKIP_AI or INCREMENTAL_ONLY):
        raise ValueError("ZHIPU_KEY is not set (required unless SKIP_AI or INCREMENTAL_ONLY is enabled).")

    previous = opinion_build._load_previous_data(output_path)

    page_limit = int(os.environ.get("POLY_EVENTS_PAGE_LIMIT", "100"))
    max_events_env = os.environ.get("POLY_MAX_EVENTS", "").strip()
    max_events = int(max_events_env) if max_events_env.isdigit() else None

    print(f"[info] fetch: limit={page_limit} max_events={max_events}", flush=True)
    print(
        f"[info] filters: POLY_MIN_VOLUME_NUM={os.environ.get('POLY_MIN_VOLUME_NUM', '10000')} "
        f"POLY_MIN_MINUTES_TO_EXPIRY={os.environ.get('POLY_MIN_MINUTES_TO_EXPIRY', '60')}",
        flush=True,
    )

    events = fetch_all_events(limit=page_limit, max_events=max_events)
    print(f"[info] fetched {len(events)} events", flush=True)

    data = build_poly_data(events=events, api_key=api_key, previous_data=previous)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"[info] wrote {output_path} events={len(data.get('events') or {})} keywords={len(data.get('index') or {})}", flush=True)


if __name__ == "__main__":
    main()
