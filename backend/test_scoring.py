#!/usr/bin/env python3
"""
Test the new multi-keyword scoring logic
"""
import json
import re
from collections import defaultdict
from typing import Dict, List, Set, Tuple, Optional


def normalize_text(text: str) -> str:
    """Normalize text to lowercase and collapse whitespace"""
    return ' '.join(str(text or '').lower().split())


def normalize_for_match(text: str) -> Tuple[str, str]:
    """Return (raw, plain) where plain removes non-alphanumeric"""
    raw = normalize_text(text)
    plain = re.sub(r'[^a-z0-9]+', ' ', raw)
    plain = ' '.join(plain.split())
    return raw, plain


def tokenize(text: str) -> Tuple[str, str, Set[str]]:
    """Return (raw, plain, tokens)"""
    raw, plain = normalize_for_match(text)
    tokens = set(plain.split())
    return raw, plain, tokens


def find_token_boundary_index(haystack: str, needle: str) -> int:
    """Find needle in haystack at token boundaries"""
    if not haystack or not needle:
        return -1

    pos = 0
    while True:
        idx = haystack.find(needle, pos)
        if idx == -1:
            return -1

        before_ok = idx == 0 or haystack[idx - 1] == ' '
        after_idx = idx + len(needle)
        after_ok = after_idx == len(haystack) or haystack[after_idx] == ' '

        if before_ok and after_ok:
            return idx
        pos = idx + 1


def tokens_near(plain: str, keyword_tokens: List[str]) -> bool:
    """Check if tokens are near each other in text"""
    tokens = [t for t in keyword_tokens if t]
    if len(tokens) < 2 or len(tokens) > 3:
        return False

    positions = []
    for t in tokens:
        pos = find_token_boundary_index(plain, t)
        if pos == -1:
            return False
        positions.append(pos)

    min_pos = min(positions)
    max_pos = max(positions)
    span = max_pos - min_pos

    return span <= 50 if len(tokens) == 2 else span <= 80


def clamp01(x: float) -> float:
    """Clamp value to [0, 1]"""
    return max(0.0, min(1.0, x))


def score_entry(tokenized: dict, entry: dict) -> dict:
    """Score a single keyword entry against tokenized text"""
    raw = tokenized['raw']
    plain = tokenized['plain']
    tokens = tokenized['tokens']

    keyword_plain = entry.get('keywordPlain', '')
    keyword_tokens = entry.get('keywordTokens', [])
    is_entity = entry.get('isEntity', False)

    reasons = []
    score = 0.0

    # ENTITY MATCH - guarantees display, sorted by additional keywords
    # Entity match ensures market is shown (score >= threshold)
    # Multi-keyword bonus helps rank when multiple markets match
    if is_entity and keyword_plain and keyword_plain in plain:
        score = 0.50  # Exactly at threshold - guarantees display
        reasons.append(f'entity:{keyword_plain}')
        return {'score': clamp01(score), 'reasons': reasons}

    # 1. Exact phrase match
    if keyword_plain and keyword_plain in plain:
        is_single_word = ' ' not in keyword_plain

        if is_single_word:
            is_year = bool(re.match(r'^\d{4}$', keyword_plain))
            is_short = len(keyword_plain) <= 3
            common_terms = ['crypto', 'web3', 'trade', 'market', 'price', 'defi',
                          'token', 'wallet', 'chain', 'coin', 'yield', 'stake',
                          'swap', 'pool', 'mint', 'airdrop']
            is_common = len(keyword_plain) <= 6 and keyword_plain in common_terms

            if is_year or is_short or is_common:
                reasons.append(f'rejected:{keyword_plain}')
            else:
                score += min(0.65, len(keyword_plain) * 0.1)
                reasons.append(f'phrase:{keyword_plain}')
        else:
            score += 0.85 + min(0.1, len(keyword_plain) / 120)
            reasons.append(f'phrase:{keyword_plain}')

    # 2. Multi-token keyword matching
    elif len(keyword_tokens) >= 2:
        present = 0
        matched_tokens = []
        for t in keyword_tokens:
            if t in tokens:
                present += 1
                matched_tokens.append(t)

        if present == len(keyword_tokens):
            near = tokens_near(plain, keyword_tokens)
            score += 0.7 if near else 0.45
            reasons.append('tokens:all')
            if near:
                reasons.append('near')
        elif present >= 2:
            score += 0.35 + (present - 2) * 0.05
            reasons.append(f'tokens:{present}/{len(keyword_tokens)}')
        # REMOVED: Single token match is too weak for multi-token keywords
        # Requiring at least 2 tokens reduces false positives from generic terms

    # 3. Single-token keyword matching
    elif len(keyword_tokens) == 1:
        token = keyword_tokens[0]
        if token in tokens:
            is_year = bool(re.match(r'^\d{4}$', token))
            is_short = len(token) <= 3
            common_terms = ['crypto', 'web3', 'trade', 'market', 'price', 'defi',
                          'token', 'wallet', 'chain', 'coin', 'yield', 'stake',
                          'swap', 'pool', 'mint', 'airdrop']
            is_common = len(token) <= 6 and token in common_terms

            if is_year or is_short or is_common:
                reasons.append(f'rejected:{token}')
            elif len(token) <= 6:
                score += min(0.48, len(token) * 0.09)
                reasons.append(f'single:{token}')
            else:
                score += min(0.70, len(token) * 0.09)
                reasons.append(f'single:{token}')

    # Bonus for cashtags/hashtags
    for t in keyword_tokens:
        if t and len(t) >= 3:
            if f'${t}' in raw or f'#{t}' in raw:
                score += 0.05
                reasons.append(f'tag:{t}')
                break

    return {'score': clamp01(score), 'reasons': reasons}


def build_matcher(data: dict) -> dict:
    """Build matcher with entity lookup"""
    event_index = data.get('eventIndex')
    index = data.get('index', {})

    keyword_to_targets = []
    mode = 'event' if event_index else 'market'

    if event_index and isinstance(event_index, dict):
        # Build entity lookup for event mode
        event_entity_map = defaultdict(set)
        events = data.get('events', {})
        for event_id, event in events.items():
            entities = event.get('entities', [])
            for entity in entities:
                entity_norm = str(entity).lower().strip()
                if entity_norm:
                    event_entity_map[entity_norm].add(str(event_id))

        for keyword, event_ids in event_index.items():
            if not keyword or not isinstance(event_ids, list) or len(event_ids) == 0:
                continue

            keyword_lower = str(keyword).lower().strip()
            _, keyword_plain = normalize_for_match(keyword_lower)
            keyword_tokens = keyword_plain.split() if keyword_plain else []

            entity_event_ids = event_entity_map.get(keyword_lower, set())
            is_entity = bool(entity_event_ids and any(str(eid) in entity_event_ids for eid in event_ids))

            keyword_to_targets.append({
                'keyword': keyword_lower,
                'keywordPlain': keyword_plain,
                'keywordTokens': keyword_tokens,
                'eventIds': event_ids,
                'isEntity': is_entity
            })
    else:
        # Build entity lookup for market mode
        market_entity_map = defaultdict(set)
        markets = data.get('markets', {})
        for market_id, market in markets.items():
            entities = market.get('entities', [])
            for entity in entities:
                entity_norm = str(entity).lower().strip()
                if entity_norm:
                    market_entity_map[entity_norm].add(str(market_id))

        for keyword, market_ids in index.items():
            if not keyword or not isinstance(market_ids, list) or len(market_ids) == 0:
                continue

            keyword_lower = str(keyword).lower().strip()
            _, keyword_plain = normalize_for_match(keyword_lower)
            keyword_tokens = keyword_plain.split() if keyword_plain else []

            entity_market_ids = market_entity_map.get(keyword_lower, set())
            is_entity = bool(entity_market_ids and any(str(mid) in entity_market_ids for mid in market_ids))

            keyword_to_targets.append({
                'keyword': keyword_lower,
                'keywordPlain': keyword_plain,
                'keywordTokens': keyword_tokens,
                'marketIds': market_ids,
                'isEntity': is_entity
            })

    # Build first token map
    first_token_map = defaultdict(list)
    for entry in keyword_to_targets:
        first_token = entry['keywordTokens'][0] if entry['keywordTokens'] else entry['keyword'].split()[0]
        if first_token:
            first_token_map[first_token].append(entry)

    return {
        'mode': mode,
        'firstTokenMap': dict(first_token_map),
        'keywordToTargetsCount': len(keyword_to_targets)
    }


def compute_top_matches(data: dict, matcher: dict, text: str, top_n: int = 5, threshold: float = 0.5) -> dict:
    """Compute top N matches for text with NEW multi-keyword scoring"""
    raw, plain, tokens = tokenize(text)
    if not plain:
        return {'ok': True, 'matched': False, 'reason': 'empty_text', 'results': []}

    # Find candidate keywords
    candidates = []
    first_token_map = matcher['firstTokenMap']
    for t in tokens:
        if t in first_token_map:
            candidates.extend(first_token_map[t])

    # Score each target (event/market) and accumulate scores for multiple keyword matches
    target_best = {}
    target_has_entity = {}  # Track which targets matched an entity
    tokenized = {'raw': raw, 'plain': plain, 'tokens': tokens}

    MULTI_KEYWORD_BONUS = 0.12  # Each additional keyword adds 12% bonus

    for entry in candidates:
        keyword = entry.get('keyword')
        if not keyword or len(keyword) < 2:
            continue

        result = score_entry(tokenized, entry)
        score = result['score']
        reasons = result['reasons']
        is_entity_match = entry.get('isEntity', False)

        if matcher['mode'] == 'event':
            for event_id in entry.get('eventIds', []):
                event_id = str(event_id)

                # Track entity matches
                if is_entity_match and score > 0:
                    target_has_entity[event_id] = True

                if event_id not in target_best:
                    # First keyword match for this event
                    target_best[event_id] = {
                        'score': score,
                        'keyword': entry.get('keywordPlain', keyword),
                        'reasons': reasons.copy(),
                        'id': event_id,
                        'matchCount': 1,
                        'baseScore': score,
                        'matchedKeywords': {keyword}
                    }
                else:
                    # Only add bonus if this is a NEW keyword (not already matched)
                    existing = target_best[event_id]
                    if keyword not in existing['matchedKeywords']:
                        existing['score'] += score * MULTI_KEYWORD_BONUS
                        existing['matchCount'] += 1
                        existing['reasons'].extend([f'+{r}' for r in reasons])
                        existing['matchedKeywords'].add(keyword)
                        if score > existing['baseScore']:
                            existing['baseScore'] = score
                            existing['keyword'] = entry.get('keywordPlain', keyword)
        else:
            for market_id in entry.get('marketIds', []):
                market_id = str(market_id)

                # Track entity matches
                if is_entity_match and score > 0:
                    target_has_entity[market_id] = True

                if market_id not in target_best:
                    # First keyword match for this market
                    target_best[market_id] = {
                        'score': score,
                        'keyword': entry.get('keywordPlain', keyword),
                        'reasons': reasons.copy(),
                        'id': market_id,
                        'matchCount': 1,
                        'baseScore': score,
                        'matchedKeywords': {keyword}
                    }
                else:
                    # Only add bonus if this is a NEW keyword (not already matched)
                    existing = target_best[market_id]
                    if keyword not in existing['matchedKeywords']:
                        existing['score'] += score * MULTI_KEYWORD_BONUS
                        existing['matchCount'] += 1
                        existing['reasons'].extend([f'+{r}' for r in reasons])
                        existing['matchedKeywords'].add(keyword)
                        if score > existing['baseScore']:
                            existing['baseScore'] = score
                            existing['keyword'] = entry.get('keywordPlain', keyword)

    if not target_best:
        return {'ok': True, 'matched': False, 'reason': 'no_candidates', 'results': []}

    # Filter: only keep targets that matched at least one entity
    entity_matches = [item for item in target_best.values() if target_has_entity.get(item['id'])]

    if not entity_matches:
        return {'ok': True, 'matched': False, 'reason': 'no_entity_match', 'results': []}

    # Rank entity matches by score (confidence)
    ranked = sorted(entity_matches, key=lambda x: x['score'], reverse=True)[:top_n]

    # Build results
    results = []
    for r in ranked:
        if matcher['mode'] == 'event':
            event = data.get('events', {}).get(r['id'])
            if not event:
                continue
            results.append({
                'score': r['score'],
                'keyword': r['keyword'],
                'reasons': r['reasons'],
                'matchCount': r['matchCount'],
                'mode': 'event',
                'id': r['id'],
                'title': event.get('title', '')
            })
        else:
            market = data.get('markets', {}).get(r['id'])
            if not market:
                continue
            results.append({
                'score': r['score'],
                'keyword': r['keyword'],
                'reasons': r['reasons'],
                'matchCount': r['matchCount'],
                'mode': 'market',
                'id': r['id'],
                'title': market.get('title', '')
            })

    passed = [r for r in results if r['score'] >= threshold]
    return {
        'ok': True,
        'matched': len(passed) > 0,
        'mode': matcher['mode'],
        'threshold': threshold,
        'results': results
    }


def main():
    # Load data (handle both running from project root and backend dir)
    import os
    if os.path.exists('backend/data.json'):
        data_path = 'backend/data.json'
        positive_path = 'backend/test-tweets/positive.txt'
        negative_path = 'backend/test-tweets/negative.txt'
    else:
        data_path = 'data.json'
        positive_path = 'test-tweets/positive.txt'
        negative_path = 'test-tweets/negative.txt'

    with open(data_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    with open(positive_path, 'r', encoding='utf-8') as f:
        positive_tests = [line.strip() for line in f if line.strip() and not line.startswith('#')]

    with open(negative_path, 'r', encoding='utf-8') as f:
        negative_tests = [line.strip() for line in f if line.strip() and not line.startswith('#')]

    # Build matcher
    matcher = build_matcher(data)
    threshold = 0.50

    print('=' * 80)
    print('TESTING NEW MULTI-KEYWORD SCORING LOGIC')
    print('=' * 80)
    print()
    print(f"Mode: {matcher['mode']}")
    print(f"Keyword entries: {matcher['keywordToTargetsCount']}")
    print(f"Threshold: {threshold}")
    print()

    # Test positive samples
    print('POSITIVE TESTS (should match)')
    print('-' * 80)
    positive_matched = 0
    for i, tweet in enumerate(positive_tests, 1):
        result = compute_top_matches(data, matcher, tweet, top_n=3, threshold=threshold)
        print(f"[{i}/{len(positive_tests)}] {tweet[:70]}{'...' if len(tweet) > 70 else ''}")

        if result['matched'] and result['results']:
            positive_matched += 1
            for idx, r in enumerate(result['results'][:3], 1):
                pass_tag = '✓' if r['score'] >= threshold else '✗'
                print(f"  {pass_tag} [{idx}] Score: {r['score']:.3f} | Matches: {r['matchCount']} | {r['title']}")
                print(f"      Keyword: \"{r['keyword']}\" | Reasons: {', '.join(r['reasons'])}")
        else:
            print('  ✗ NO MATCH')
            if result['results']:
                r = result['results'][0]
                print(f"      Best candidate ({r['score']:.3f}): {r['title']}")
        print()

    print()
    print('NEGATIVE TESTS (should NOT match)')
    print('-' * 80)
    negative_matched = 0
    for i, tweet in enumerate(negative_tests, 1):
        result = compute_top_matches(data, matcher, tweet, top_n=1, threshold=threshold)
        print(f"[{i}/{len(negative_tests)}] {tweet[:70]}{'...' if len(tweet) > 70 else ''}")

        if result['matched'] and result['results']:
            negative_matched += 1
            r = result['results'][0]
            print(f"  ✗ FALSE POSITIVE (score: {r['score']:.3f}) | Matches: {r['matchCount']}")
            print(f"      {r['title']}")
            print(f"      Keyword: \"{r['keyword']}\" | Reasons: {', '.join(r['reasons'])}")
        else:
            print('  ✓ CORRECTLY REJECTED')
        print()

    # Summary
    print('=' * 80)
    print('SUMMARY')
    print('=' * 80)
    pos_rate = positive_matched / len(positive_tests) * 100 if positive_tests else 0
    neg_rate = (len(negative_tests) - negative_matched) / len(negative_tests) * 100 if negative_tests else 0
    fp_rate = negative_matched / len(negative_tests) * 100 if negative_tests else 0

    print(f"Positive samples: {positive_matched}/{len(positive_tests)} matched ({pos_rate:.1f}%)")
    print(f"Negative samples: {len(negative_tests) - negative_matched}/{len(negative_tests)} correctly rejected ({neg_rate:.1f}%)")
    print(f"False positives: {negative_matched}/{len(negative_tests)} ({fp_rate:.1f}%)")
    print(f"Threshold: {threshold}")


if __name__ == '__main__':
    main()
