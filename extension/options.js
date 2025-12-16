const STORAGE_KEYS = {
  cachedData: "opinionHudData",
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  $("status").textContent = text || "";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeForMatch(text) {
  const raw = normalizeText(text);
  const plain = raw.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return { raw, plain };
}

function tokenize(text) {
  const tokens = new Set();
  const { raw, plain } = normalizeForMatch(text);
  let cur = "";
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    const code = ch.charCodeAt(0);
    const isAlnum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (isAlnum) {
      cur += ch;
      continue;
    }
    if (cur) {
      tokens.add(cur);
      cur = "";
    }
  }
  if (cur) tokens.add(cur);
  return { raw, plain, tokens };
}

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function findTokenBoundaryIndex(haystack, needle) {
  if (!haystack || !needle) return -1;
  const n = String(needle);
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(n, from);
    if (idx === -1) return -1;
    const beforeOk = idx === 0 || haystack[idx - 1] === " ";
    const afterIdx = idx + n.length;
    const afterOk = afterIdx === haystack.length || haystack[afterIdx] === " ";
    if (beforeOk && afterOk) return idx;
    from = idx + 1;
  }
}

function tokensNear(plain, keywordTokens) {
  const tokens = (keywordTokens || []).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return false;

  const positions = [];
  for (const t of tokens) {
    const pos = findTokenBoundaryIndex(plain, t);
    if (pos === -1) return false;
    positions.push(pos);
  }
  const min = Math.min(...positions);
  const max = Math.max(...positions);
  const span = max - min;
  return tokens.length === 2 ? span <= 50 : span <= 80;
}

function buildMatcher(data) {
  const eventIndex = data.eventIndex || null;
  const index = data.index || {};

  const keywordToTargets = [];
  if (eventIndex && typeof eventIndex === "object") {
    // Build entity lookup for event mode
    const eventEntityMap = new Map(); // keyword -> Set of eventIds where it's an entity
    const events = data.events || {};
    for (const [eventId, event] of Object.entries(events)) {
      const entities = event.entities || [];
      for (const entity of entities) {
        const entityNorm = String(entity).toLowerCase().trim();
        if (!entityNorm) continue;
        if (!eventEntityMap.has(entityNorm)) {
          eventEntityMap.set(entityNorm, new Set());
        }
        eventEntityMap.get(entityNorm).add(String(eventId));
      }
    }

    for (const [keyword, eventIds] of Object.entries(eventIndex)) {
      if (!keyword || !Array.isArray(eventIds) || eventIds.length === 0) continue;
      const keywordLower = String(keyword).toLowerCase().trim();
      const keywordPlain = normalizeForMatch(keywordLower).plain;
      const keywordTokens = keywordPlain ? keywordPlain.split(" ") : [];

      // Check if this keyword is an entity for any of these events
      const entityEventIds = eventEntityMap.get(keywordLower);
      const isEntity = entityEventIds && eventIds.some(id => entityEventIds.has(String(id)));

      keywordToTargets.push({
        keyword: keywordLower,
        keywordPlain,
        keywordTokens,
        eventIds,
        isEntity: !!isEntity
      });
    }
  } else {
    // Build entity lookup for market mode
    const marketEntityMap = new Map(); // keyword -> Set of marketIds where it's an entity
    const markets = data.markets || {};
    for (const [marketId, market] of Object.entries(markets)) {
      const entities = market.entities || [];
      for (const entity of entities) {
        const entityNorm = String(entity).toLowerCase().trim();
        if (!entityNorm) continue;
        if (!marketEntityMap.has(entityNorm)) {
          marketEntityMap.set(entityNorm, new Set());
        }
        marketEntityMap.get(entityNorm).add(String(marketId));
      }
    }

    for (const [keyword, marketIds] of Object.entries(index)) {
      if (!keyword || !Array.isArray(marketIds) || marketIds.length === 0) continue;
      const keywordLower = String(keyword).toLowerCase().trim();
      const keywordPlain = normalizeForMatch(keywordLower).plain;
      const keywordTokens = keywordPlain ? keywordPlain.split(" ") : [];

      // Check if this keyword is an entity for any of these markets
      const entityMarketIds = marketEntityMap.get(keywordLower);
      const isEntity = entityMarketIds && marketIds.some(id => entityMarketIds.has(String(id)));

      keywordToTargets.push({
        keyword: keywordLower,
        keywordPlain,
        keywordTokens,
        marketIds,
        isEntity: !!isEntity
      });
    }
  }

  const firstTokenMap = new Map();
  for (const entry of keywordToTargets) {
    const firstToken = entry.keywordTokens?.[0] || entry.keyword.split(/\s+/)[0];
    if (!firstToken) continue;
    const list = firstTokenMap.get(firstToken) || [];
    list.push(entry);
    firstTokenMap.set(firstToken, list);
  }

  return {
    mode: eventIndex ? "event" : "market",
    firstTokenMap,
    keywordToTargetsCount: keywordToTargets.length,
  };
}

function scoreEntry({ raw, plain, tokens }, entry) {
  const reasons = [];
  let score = 0;

  const keywordPlain = entry.keywordPlain || "";
  const keywordTokens = entry.keywordTokens || [];
  const isEntity = entry.isEntity || false;

  // ENTITY MATCH - guarantees display, sorted by additional keywords
  // Entity match ensures market is shown (score >= threshold)
  // Multi-keyword bonus helps rank when multiple markets match
  if (isEntity && keywordPlain && plain.includes(keywordPlain)) {
    score = 0.50; // Exactly at threshold - guarantees display
    reasons.push(`entity:${keywordPlain}`);
    return { score: clamp01(score), reasons };
  }

  // 1. Exact phrase match (highest score) - but filter generic phrases
  if (keywordPlain && plain.includes(keywordPlain)) {
    const isSingleWord = !keywordPlain.includes(' ');

    // Reject generic single-word phrases
    if (isSingleWord) {
      const isYear = /^\d{4}$/.test(keywordPlain);
      const isShort = keywordPlain.length <= 3;
      const commonTerms = [
        'crypto', 'web3', 'trade', 'market', 'price', 'defi',
        'token', 'wallet', 'chain', 'coin', 'yield', 'stake',
        'swap', 'pool', 'mint', 'airdrop'
      ];
      const isCommon = keywordPlain.length <= 6 && commonTerms.includes(keywordPlain);

      if (isYear || isShort || isCommon) {
        // Don't score - it's too generic
        reasons.push(`rejected:${keywordPlain}`);
      } else {
        // Valid single-word brand name - moderate score
        score += Math.min(0.65, keywordPlain.length * 0.1);
        reasons.push(`phrase:${keywordPlain}`);
      }
    } else {
      // Multi-word phrases get high score - they're very specific
      score += 0.85 + Math.min(0.1, keywordPlain.length / 120);
      reasons.push(`phrase:${keywordPlain}`);
    }
  }
  // 2. Multi-token keyword matching
  else if (keywordTokens.length >= 2) {
    let present = 0;
    const matchedTokens = [];
    for (const t of keywordTokens) {
      if (tokens.has(t)) {
        present += 1;
        matchedTokens.push(t);
      }
    }

    if (present === keywordTokens.length) {
      // All tokens present
      const near = tokensNear(plain, keywordTokens);
      score += near ? 0.7 : 0.45;
      reasons.push("tokens:all");
      if (near) reasons.push("near");
    } else if (present >= 2) {
      // At least 2 tokens present
      score += 0.35 + (present - 2) * 0.05;
      reasons.push(`tokens:${present}/${keywordTokens.length}`);
    }
    // REMOVED: Single token match is too weak for multi-token keywords
    // Requiring at least 2 tokens reduces false positives from generic terms
  }
  // 3. Single-token keyword matching with smart filtering
  else if (keywordTokens.length === 1) {
    const token = keywordTokens[0];
    if (tokens.has(token)) {
      const isYear = /^\d{4}$/.test(token);
      const isShort = token.length <= 3;
      const commonTerms = [
        'crypto', 'web3', 'trade', 'market', 'price', 'defi',
        'token', 'wallet', 'chain', 'coin', 'yield', 'stake',
        'swap', 'pool', 'mint', 'airdrop'
      ];
      const isCommon = token.length <= 6 && commonTerms.includes(token);

      if (isYear || isShort || isCommon) {
        // Reject generic tokens
        reasons.push(`rejected:${token}`);
      } else if (token.length <= 6) {
        // Medium-length brand names
        score += Math.min(0.48, token.length * 0.09);
        reasons.push(`single:${token}`);
      } else {
        // Long brand names (7+ chars)
        score += Math.min(0.70, token.length * 0.09);
        reasons.push(`single:${token}`);
      }
    }
  }

  // Bonus for cashtags/hashtags present in raw text.
  for (const t of keywordTokens) {
    if (!t || t.length < 3) continue;
    if (raw.includes(`$${t}`) || raw.includes(`#${t}`)) {
      score += 0.05;
      reasons.push(`tag:${t}`);
      break;
    }
  }

  return { score: clamp01(score), reasons };
}

function computeTopMatchesForText(data, matcher, text, { topN = 5, threshold = 0.6 } = {}) {
  const { plain, tokens } = tokenize(text);
  if (!plain) return { ok: true, matched: false, reason: "empty_text", results: [] };

  const candidates = [];
  for (const t of tokens) {
    const list = matcher.firstTokenMap.get(t);
    if (list) candidates.push(...list);
  }

  const targetBest = new Map();
  const targetHasEntity = new Map(); // Track which targets matched an entity
  const tokenized = { raw: normalizeText(text), plain, tokens };

  for (const entry of candidates) {
    const keyword = entry.keyword;
    if (!keyword || keyword.length < 2) continue;

    const { score, reasons } = scoreEntry(tokenized, entry);
    const isEntityMatch = entry.isEntity || false;

    if (matcher.mode === "event") {
      for (const id of entry.eventIds || []) {
        const eventId = String(id);

        // Track entity matches
        if (isEntityMatch && score > 0) {
          targetHasEntity.set(eventId, true);
        }

        const existing = targetBest.get(eventId);
        if (!existing) {
          // First keyword match for this event
          targetBest.set(eventId, {
            score,
            keyword: entry.keywordPlain || keyword,
            reasons: [...reasons],
            entry,
            eventId,
            matchCount: 1,
            baseScore: score,
            matchedKeywords: new Set([keyword]),
          });
        } else {
          // Only add bonus if this is a NEW keyword (not already matched)
          if (!existing.matchedKeywords.has(keyword)) {
            const MULTI_KEYWORD_BONUS = 0.12;
            existing.score += score * MULTI_KEYWORD_BONUS;
            existing.matchCount += 1;
            existing.reasons.push(...reasons.map(r => `+${r}`));
            existing.matchedKeywords.add(keyword);

            if (score > existing.baseScore) {
              existing.baseScore = score;
              existing.keyword = entry.keywordPlain || keyword;
            }
          }
        }
      }
    } else {
      for (const id of entry.marketIds || []) {
        const marketId = String(id);

        // Track entity matches
        if (isEntityMatch && score > 0) {
          targetHasEntity.set(marketId, true);
        }

        const existing = targetBest.get(marketId);
        if (!existing) {
          // First keyword match for this market
          targetBest.set(marketId, {
            score,
            keyword: entry.keywordPlain || keyword,
            reasons: [...reasons],
            entry,
            marketId,
            matchCount: 1,
            baseScore: score,
            matchedKeywords: new Set([keyword]),
          });
        } else {
          // Only add bonus if this is a NEW keyword (not already matched)
          if (!existing.matchedKeywords.has(keyword)) {
            const MULTI_KEYWORD_BONUS = 0.12;
            existing.score += score * MULTI_KEYWORD_BONUS;
            existing.matchCount += 1;
            existing.reasons.push(...reasons.map(r => `+${r}`));
            existing.matchedKeywords.add(keyword);

            if (score > existing.baseScore) {
              existing.baseScore = score;
              existing.keyword = entry.keywordPlain || keyword;
            }
          }
        }
      }
    }
  }

  if (targetBest.size === 0) return { ok: true, matched: false, reason: "no_candidates", results: [] };

  // Filter: only keep targets that matched at least one entity
  const entityMatches = Array.from(targetBest.values()).filter(item => {
    const id = item.eventId || item.marketId;
    return targetHasEntity.get(id);
  });

  if (entityMatches.length === 0) return { ok: true, matched: false, reason: "no_entity_match", results: [] };

  const ranked = entityMatches.sort((a, b) => b.score - a.score).slice(0, topN);

  const results = ranked
    .map((r) => {
      if (matcher.mode === "event") {
        const event = data.events?.[r.eventId];
        if (!event) return null;
        const marketIds = event.marketIds || [];
        const markets = marketIds
          .slice(0, 5)
          .map((id) => ({ id, ...data.markets?.[id] }))
          .filter((m) => m && m.title);
        const primaryId = event.bestMarketId || marketIds[0] || null;
        const primaryUrl = primaryId ? data.markets?.[primaryId]?.url : null;
        return {
          score: r.score,
          keyword: r.keyword,
          reasons: r.reasons,
          mode: "event",
          id: r.eventId,
          title: event.title,
          primaryUrl,
          markets,
        };
      }

      const market = data.markets?.[r.marketId];
      if (!market) return null;
      return {
        score: r.score,
        keyword: r.keyword,
        reasons: r.reasons,
        mode: "market",
        id: r.marketId,
        title: market.title,
        primaryUrl: market.url,
        markets: [{ id: r.marketId, ...market }],
      };
    })
    .filter(Boolean);

  const passed = results.filter((r) => r.score >= threshold);
  return {
    ok: true,
    matched: passed.length > 0,
    mode: matcher.mode,
    threshold,
    candidates: candidates.length,
    results,
  };
}

function computeMatchForText(data, matcher, text) {
  const top = computeTopMatchesForText(data, matcher, text, { topN: 1, threshold: 0.50 });
  if (!top.matched) return top;
  const m = top.results[0];

  if (matcher.mode === "event") {
    return {
      ok: true,
      matched: true,
      mode: "event",
      keyword: m.keyword,
      eventId: m.id,
      title: m.title,
      primaryUrl: m.primaryUrl,
      markets: m.markets,
    };
  }

  return {
    ok: true,
    matched: true,
    mode: "market",
    keyword: m.keyword,
    marketId: m.id,
    title: m.title,
    primaryUrl: m.primaryUrl,
    markets: m.markets,
  };
}

async function refreshNow() {
  setStatus("Refreshing...");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "opinionHud.refresh" });
    if (!resp?.ok) {
      setStatus(`Refresh failed: ${resp?.error || "unknown error"}`);
      return;
    }
    const result = resp.result;
    setStatus(result.updated ? `Data updated (version ${result.version})` : `Already up to date (version ${result.version})`);
  } catch (err) {
    setStatus(`Refresh failed: ${String(err?.message || err)}`);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // Check if data is already loaded
  const result = await chrome.storage.local.get(STORAGE_KEYS.cachedData);
  const data = result[STORAGE_KEYS.cachedData];
  if (data?.meta?.version) {
    setStatus(`Data loaded (version ${data.meta.version})`);
  } else {
    setStatus("Waiting for initial data refresh...");
  }

  $("refresh").addEventListener("click", async () => {
    await refreshNow();
  });

  $("test").addEventListener("click", async () => {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.cachedData);
      const data = result[STORAGE_KEYS.cachedData];
      if (!data) {
        $("testResult").textContent = "No cached data. Click \"Refresh Now\" first.";
        return;
      }

      const matcher = buildMatcher(data);
      const text = $("testText").value || "";
      const topN = Math.max(1, Math.min(20, Number($("topN")?.value || 5)));
      const threshold = clamp01(Number($("threshold")?.value || 0.6));

      const top = computeTopMatchesForText(data, matcher, text, { topN, threshold });
      if (!top.matched) {
        // Still print top candidates below threshold for debugging.
      }

      const lines = [];
      lines.push(`Mode: ${top.mode}`);
      lines.push(`TopN: ${topN}  Threshold: ${threshold}`);
      if (typeof top.candidates === "number") lines.push(`Candidates scanned: ${top.candidates}`);
      lines.push("");

      for (const r of top.results) {
        const pass = r.score >= threshold ? "PASS" : "----";
        lines.push(`${pass}  Score: ${r.score.toFixed(2)}  Keyword: ${r.keyword}`);
        lines.push(`Reason: ${r.reasons.join(", ")}`);
        lines.push(`ID: ${r.id}`);
        lines.push(`Title: ${r.title}`);
        if (r.primaryUrl) lines.push(`Trade URL: ${r.primaryUrl}`);
        lines.push("Markets:");
        for (const m of r.markets || []) {
          const yes = m.labels?.yesLabel || "YES";
          const no = m.labels?.noLabel || "NO";
          lines.push(`- ${m.id}: ${m.title} [${yes}/${no}]`);
        }
        lines.push("");
      }

      if (!top.matched) {
        lines.unshift(`No match above threshold (${top.reason || "no_keyword_match"}). Showing top candidates:\n`);
      }

      $("testResult").textContent = lines.join("\n").trim();
    } catch (err) {
      $("testResult").textContent = `Test failed: ${String(err?.message || err)}`;
    }
  });

  $("batchTest").addEventListener("click", async () => {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.cachedData);
      const data = result[STORAGE_KEYS.cachedData];
      if (!data) {
        $("batchResult").textContent = "No cached data. Click \"Refresh Now\" first.";
        return;
      }

      const matcher = buildMatcher(data);
      const batchInput = $("batchInput").value || "";
      const threshold = clamp01(Number($("batchThreshold")?.value || 0.50));

      // Parse input: one tweet per line, ignore empty lines and comments
      const tweets = batchInput
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));

      if (tweets.length === 0) {
        $("batchResult").textContent = "No tweets to test. Please enter tweets (one per line).";
        return;
      }

      const lines = [];
      lines.push(`=== BATCH TEST RESULTS ===`);
      lines.push(`Total tweets: ${tweets.length}`);
      lines.push(`Threshold: ${threshold}`);
      lines.push("");

      let matched = 0;
      let notMatched = 0;

      for (let i = 0; i < tweets.length; i++) {
        const tweet = tweets[i];
        const top = computeTopMatchesForText(data, matcher, tweet, { topN: 1, threshold });

        lines.push(`[${i + 1}/${tweets.length}] ${tweet.substring(0, 60)}${tweet.length > 60 ? "..." : ""}`);

        if (top.matched && top.results && top.results.length > 0) {
          matched++;
          const r = top.results[0];
          lines.push(`  ✓ MATCHED (score: ${r.score.toFixed(2)})`);
          lines.push(`    ${r.title}`);
          lines.push(`    Keyword: ${r.keyword} | Reason: ${r.reasons.join(", ")}`);
        } else {
          notMatched++;
          lines.push(`  ✗ NO MATCH`);
          if (top.results && top.results.length > 0) {
            const r = top.results[0];
            lines.push(`    Best candidate (${r.score.toFixed(2)}): ${r.title}`);
            lines.push(`    Keyword: ${r.keyword} | Reason: ${r.reasons.join(", ")}`);
          } else if (top.reason) {
            lines.push(`    Reason: ${top.reason}`);
          }
        }
        lines.push("");
      }

      lines.push("=== SUMMARY ===");
      lines.push(`Matched: ${matched}/${tweets.length} (${((matched / tweets.length) * 100).toFixed(1)}%)`);
      lines.push(`Not matched: ${notMatched}/${tweets.length} (${((notMatched / tweets.length) * 100).toFixed(1)}%)`);

      $("batchResult").textContent = lines.join("\n");
    } catch (err) {
      $("batchResult").textContent = `Batch test failed: ${String(err?.message || err)}`;
    }
  });
});
