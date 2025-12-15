import json
import os
import time

import requests
import zhipuai


OPINION_API_URL = "http://opinionanalytics.xyz:10001/api/markets"
FRONTEND_BASE_URL = "https://opinion.trade"
MODEL_NAME = "glm-4-flash"
REF_PARAM = "opinion_hud"
DEBUG = os.environ.get("DEBUG", "").strip().lower() in ("1", "true", "yes", "y", "on")
SKIP_AI = os.environ.get("SKIP_AI", "").strip().lower() in ("1", "true", "yes", "y", "on")
ZHIPU_TIMEOUT_SECONDS = float(os.environ.get("ZHIPU_TIMEOUT_SECONDS", "30"))
ZHIPU_MAX_RETRIES = int(os.environ.get("ZHIPU_MAX_RETRIES", "2"))
DISABLE_INCREMENTAL = os.environ.get("DISABLE_INCREMENTAL", "").strip().lower() in ("1", "true", "yes", "y", "on")
PREVIOUS_DATA_URL = os.environ.get("PREVIOUS_DATA_URL", "").strip() or None
ALLOW_LEGACY_REUSE = os.environ.get("ALLOW_LEGACY_REUSE", "1").strip().lower() in ("1", "true", "yes", "y", "on")


def _now_epoch_seconds():
    return int(time.time())


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
    response = requests.get(OPINION_API_URL, timeout=30)
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        payload = payload["data"]
    return _flatten_markets(payload)


def _market_id(market):
    for key in ("id", "marketId", "market_id"):
        value = market.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _market_title(market):
    title = market.get("title") or market.get("marketTitle") or ""
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


def _normalize_keyword(keyword):
    kw = (keyword or "").strip().lower()
    kw = " ".join(kw.split())
    if kw.startswith('"') and kw.endswith('"') and len(kw) >= 2:
        kw = kw[1:-1].strip()
    return kw


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
    if DISABLE_INCREMENTAL:
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


def generate_keywords(api_key, title, rules):
    system = (
        "You generate high-quality matching keywords for a prediction market. "
        "Return ONLY a JSON array of strings (no prose). "
        "Include Entities, Synonyms, and Slang terms that might appear in tweets."
    )
    user = (
        f"Market title: {title}\n"
        f"Market rules: {_truncate(rules, 1200)}\n\n"
        "Rules:\n"
        "- Output must be a JSON array of strings.\n"
        "- 10 to 15 keywords.\n"
        "- Prefer short phrases over sentences.\n"
        "- Include common abbreviations and nicknames.\n"
        "- Do not include duplicates.\n"
    )

    attempt = 0
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
            keywords = _extract_json_array(content)
            if DEBUG:
                print(
                    f"[debug] keywords generated: {len(keywords)} for title={title!r} (attempt {attempt})",
                    flush=True,
                )
            return keywords
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            if attempt >= max(1, ZHIPU_MAX_RETRIES):
                print(f"[warn] keyword generation failed (final): {exc}", flush=True)
                return []
            sleep_for = min(2.0, 0.5 * attempt)
            print(f"[warn] keyword generation failed (retrying): {exc}", flush=True)
            time.sleep(sleep_for)


def build_data(markets, api_key, previous_data=None):
    now = _now_epoch_seconds()

    markets_out = {}
    events_out = {}
    inverted = {}
    event_inverted = {}

    processed = 0
    kept = 0
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
        "reused": 0,
        "legacyReused": 0,
        "calls": 0,
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
    if isinstance(previous_data, dict):
        prev_events = previous_data.get("events") or {}
        if not isinstance(prev_events, dict):
            prev_events = {}

    for market in markets:
        processed += 1
        if max_market_nodes is not None and processed > max_market_nodes:
            break
        if max_markets is not None and kept >= max_markets:
            break
        if scan_log_every > 0 and processed % scan_log_every == 0:
            print(f"[info] scanned {processed} market nodes (kept {kept})", flush=True)

        if market.get("statusEnum") != "Activated":
            skipped["statusEnum"] += 1
            continue

        resolved_at = _parse_cutoff_epoch_seconds(market.get("resolvedAt"))
        if resolved_at is not None and resolved_at > 0:
            skipped["resolved"] += 1
            continue

        cutoff = _parse_cutoff_epoch_seconds(market.get("cutoffAt"))
        if cutoff is None:
            raw_cutoff = market.get("cutoffAt")
            if raw_cutoff in (0, 0.0, "0", "0.0"):
                skipped["cutoff_zero_kept"] += 1
            else:
                skipped["cutoff_missing_or_invalid"] += 1
                continue
        elif cutoff <= now:
            skipped["cutoff_expired"] += 1
            continue

        market_id = _market_id(market)
        if not market_id:
            skipped["missing_id"] += 1
            continue

        title = _market_title(market)
        if not title:
            skipped["missing_title"] += 1
            continue

        kept += 1

        parent_event_title = _market_parent_event_title(market)
        parent_event_market_id = _market_parent_event_market_id(market)
        parent_event_id = market.get("parentEventId")

        event_id = parent_event_market_id or (str(parent_event_id).strip() if parent_event_id else None) or market_id
        event_title = parent_event_title or title

        if parent_event_title and parent_event_title != title and parent_event_title not in title:
            display_title = f"{parent_event_title} - {title}"
        else:
            display_title = title

        yes_label = market.get("yesLabel")
        no_label = market.get("noLabel")
        volume = _market_volume(market)
        url = f"{FRONTEND_BASE_URL}/market/{market_id}?ref={REF_PARAM}"

        rules_text = _market_rules(market)
        option_title = title if parent_event_title else None

        markets_out[market_id] = {
            "title": display_title,
            "url": url,
            "volume": volume,
            "labels": {"yesLabel": yes_label, "noLabel": no_label},
            "eventId": event_id,
            "eventTitle": event_title,
            "optionTitle": option_title,
            "parentEventId": (str(parent_event_id).strip() if parent_event_id else None),
            "parentEventMarketId": parent_event_market_id,
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
        prev = prev_events.get(event_id)
        if isinstance(prev, dict):
            prev_keywords = prev.get("keywords")
            if isinstance(prev_keywords, list) and prev_keywords:
                prev_sig_core = prev.get("sigCore")
                prev_sig_full = prev.get("sigFull") or prev.get("sig") or prev.get("signature")
                if (prev_sig_core and str(prev_sig_core) == sig_core) or (prev_sig_full and str(prev_sig_full) == sig_full):
                    reusable = True
                elif ALLOW_LEGACY_REUSE and (not prev_sig_core) and (not prev_sig_full):
                    if str(prev.get("title") or "").strip() == str(bucket.get("title") or "").strip():
                        reusable = True

        if reusable:
            planned_reuse += 1
        else:
            if SKIP_AI:
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
        prev = prev_events.get(event_id)
        if isinstance(prev, dict):
            prev_keywords = prev.get("keywords")
            prev_sig_core = prev.get("sigCore")
            prev_sig_full = prev.get("sigFull") or prev.get("sig") or prev.get("signature")
            if (
                isinstance(prev_keywords, list)
                and prev_keywords
                and ((prev_sig_core and str(prev_sig_core) == sig_core) or (prev_sig_full and str(prev_sig_full) == sig_full))
            ):
                keywords = [str(k) for k in prev_keywords if str(k).strip()]
                reused = True
            elif ALLOW_LEGACY_REUSE and isinstance(prev_keywords, list) and prev_keywords:
                if (not prev_sig_core) and (not prev_sig_full) and str(prev.get("title") or "").strip() == str(bucket.get("title") or "").strip():
                    keywords = [str(k) for k in prev_keywords if str(k).strip()]
                    reused = True
                    ai_stats["legacyReused"] += 1

        if reused:
            ai_stats["reused"] += 1
        else:
            if SKIP_AI:
                ai_stats["skipped"] += 1
                keywords = _fallback_keywords(bucket.get("title") or event_id, option_titles, rules_text)
            else:
                ai_stats["calls"] += 1
                try:
                    keywords = generate_keywords(api_key, title=bucket.get("title") or event_id, rules=rules_text)
                except Exception:
                    ai_stats["errors"] += 1
                    keywords = []
        if not keywords:
            ai_stats["empty"] += 1
        else:
            ai_stats["non_empty"] += 1

        normalized = []
        for kw in keywords:
            nkw = _normalize_keyword(kw)
            if nkw and nkw not in normalized:
                normalized.append(nkw)

        events_out[event_id] = {
            "title": bucket.get("title") or event_id,
            "marketIds": bucket.get("marketIds") or [],
            "bestMarketId": bucket.get("bestMarketId"),
            "keywords": normalized,
            "sig": sig_full,
            "sigFull": sig_full,
            "sigCore": sig_core,
            "reused": reused,
        }

        for market_id in events_out[event_id]["marketIds"]:
            if market_id in markets_out:
                markets_out[market_id]["keywords"] = normalized

        for nkw in normalized:
            event_inverted.setdefault(nkw, set()).add(event_id)
            for market_id in events_out[event_id]["marketIds"]:
                inverted.setdefault(nkw, set()).add(market_id)

        if sleep_seconds > 0 and (not reused) and (not SKIP_AI):
            time.sleep(sleep_seconds)

    index_out = {kw: sorted(list(ids)) for kw, ids in sorted(inverted.items(), key=lambda kv: kv[0])}
    event_index_out = {kw: sorted(list(ids)) for kw, ids in sorted(event_inverted.items(), key=lambda kv: kv[0])}

    return {
        "meta": {
            "generatedAt": now,
            "source": OPINION_API_URL,
            "frontendBaseUrl": FRONTEND_BASE_URL,
            "model": MODEL_NAME,
            "ref": REF_PARAM,
            "debug": DEBUG,
            "counts": {
                "seen": processed,
                "kept": kept,
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
    if not api_key:
        print("[error] Missing ZHIPU_KEY environment variable.", flush=True)
        raise ValueError("ZHIPU_KEY is not set")

    output_path = os.environ.get("OUTPUT_PATH") or os.path.join(os.path.dirname(__file__), "data.json")

    if SKIP_AI:
        print("[info] SKIP_AI enabled: using fallback keywords (no LLM calls)", flush=True)

    if DEBUG:
        print(
            "[debug] env MAX_MARKETS=%r SLEEP_SECONDS=%r OUTPUT_PATH=%r"
            % (os.environ.get("MAX_MARKETS"), os.environ.get("SLEEP_SECONDS"), os.environ.get("OUTPUT_PATH")),
            flush=True,
        )
        print(f"[debug] SKIP_AI={SKIP_AI}", flush=True)
        print(f"[debug] DISABLE_INCREMENTAL={DISABLE_INCREMENTAL}", flush=True)
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

    previous_data = _load_previous_data(output_path)
    if previous_data is not None:
        print("[info] incremental: loaded previous data.json for keyword reuse", flush=True)
    data = build_data(markets, api_key=api_key, previous_data=previous_data)

    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"[info] wrote {output_path}", flush=True)


if __name__ == "__main__":
    main()
