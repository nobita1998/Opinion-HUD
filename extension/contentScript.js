const STORAGE_KEYS = {
  cachedData: "opinionHudData",
};

const SELECTORS = {
  tweetText: 'div[data-testid="tweetText"]',
  article: "article",
  actionGroup: 'div[role="group"]',
};

const SCANNED_ATTR = "data-opinion-scanned";
const ICON_ATTR = "data-opinion-hud-icon";

const HOVER_DELAY_MS = 300;
const MAX_MATCHES_ON_SCREEN = 3;

// These tokens appear in many crypto markets and are too generic to drive ranking.
// Keep them matchable, but downweight them so more specific entities win.
const LOW_SIGNAL_TOKENS = new Set(["binance", "btc", "eth"]);
const LOW_SIGNAL_ENTITY_SCORE = 0.18;
const LOW_SIGNAL_SCORE_MULTIPLIER = 0.55;
const DEFAULT_ENTITY_SCORE = 0.5;

const state = {
  data: null,
  matcher: null,
  observer: null,
  hoverTimer: null,
  activeHud: null,
};

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

const OPINION_TRADE_DETAIL_URL = "https://app.opinion.trade/detail";

function buildOpinionTradeUrl({ topicId, isMulti }) {
  const u = new URL(OPINION_TRADE_DETAIL_URL);
  u.searchParams.set("topicId", String(topicId));
  if (isMulti) u.searchParams.set("type", "multi");
  return u.toString();
}

function isMultiMarket(marketId, market) {
  const eventId = market?.eventId ?? null;
  if (!eventId) return false;
  return String(eventId) !== String(marketId);
}

function stripMentions(text) {
  const keep = state.matcher?.mentionKeepSet || null;
  return String(text || "").replace(
    /(^|\s)@([a-z0-9_]{1,20})\b/gi,
    (full, lead, handle) => {
      const h = String(handle || "").toLowerCase();
      if (keep && keep.has(h)) return full;
      return `${lead} `;
    }
  );
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

function buildMatcher(data) {
  const eventIndex = data.eventIndex || null;
  const index = data.index || {};

  const keywordToTargets = [];
  const entityRequiredMaskById = new Map(); // id -> bitmask of required groups (AND)
  const entityTermMaskById = new Map(); // id -> Map(term -> bitmask of groups it satisfies)
  const mentionKeepSet = new Set(); // single-token entity terms to preserve from @mention stripping

  function ingestEntityGroups(id, groupsRaw, entitiesRaw) {
    let groups = [];

    if (Array.isArray(groupsRaw)) {
      for (const group of groupsRaw) {
        if (Array.isArray(group)) {
          const g = group
            .map((t) => String(t || "").toLowerCase().trim())
            .filter(Boolean);
          if (g.length) groups.push(g);
        } else if (typeof group === "string") {
          const t = String(group).toLowerCase().trim();
          if (t) groups.push([t]);
        }
      }
    } else if (Array.isArray(entitiesRaw)) {
      // Backwards compatibility: entities: ["CZ","Binance"] means AND of required entities.
      for (const e of entitiesRaw) {
        const t = String(e || "").toLowerCase().trim();
        if (t) groups.push([t]);
      }
    }

    groups = groups.filter((g) => Array.isArray(g) && g.length);
    if (!groups.length) return;

    const groupCount = Math.min(groups.length, 20);
    const requiredMask = (1 << groupCount) - 1;
    entityRequiredMaskById.set(String(id), requiredMask);

    const termToMask = new Map();
    for (let i = 0; i < groupCount; i++) {
      const bit = 1 << i;
      const group = groups[i];
      for (const term of group) {
        if (!term) continue;
        termToMask.set(term, (termToMask.get(term) || 0) | bit);

        // Keep common entity handles from being stripped as @mentions.
        // Allow short special cases like "cz".
        if (!term.includes(" ") && (term.length >= 3 || term === "cz")) {
          mentionKeepSet.add(term);
        }
      }
    }
    entityTermMaskById.set(String(id), termToMask);
  }

  if (eventIndex && typeof eventIndex === "object") {
    const events = data.events || {};
    for (const [eventId, event] of Object.entries(events)) {
      ingestEntityGroups(eventId, event.entityGroups, event.entities);
    }

    for (const [keyword, eventIds] of Object.entries(eventIndex)) {
      if (!keyword || !Array.isArray(eventIds) || eventIds.length === 0) continue;
      const keywordLower = String(keyword).toLowerCase().trim();
      const keywordPlain = normalizeForMatch(keywordLower).plain;
      const keywordTokens = keywordPlain ? keywordPlain.split(" ") : [];

      keywordToTargets.push({
        keyword: keywordLower,
        keywordPlain,
        keywordTokens,
        eventIds,
      });
    }
  } else {
    const markets = data.markets || {};
    for (const [marketId, market] of Object.entries(markets)) {
      ingestEntityGroups(marketId, market.entityGroups, market.entities);
    }

    for (const [keyword, marketIds] of Object.entries(index)) {
      if (!keyword || !Array.isArray(marketIds) || marketIds.length === 0) continue;
      const keywordLower = String(keyword).toLowerCase().trim();
      const keywordPlain = normalizeForMatch(keywordLower).plain;
      const keywordTokens = keywordPlain ? keywordPlain.split(" ") : [];

      keywordToTargets.push({
        keyword: keywordLower,
        keywordPlain,
        keywordTokens,
        marketIds,
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
    entityRequiredMaskById,
    entityTermMaskById,
    mentionKeepSet,
  };
}

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function countBits32(n) {
  let v = n >>> 0;
  let c = 0;
  while (v) {
    v &= v - 1;
    c += 1;
  }
  return c;
}

function createIcon() {
  const icon = document.createElement("div");
  icon.setAttribute(ICON_ATTR, "1");
  icon.setAttribute("role", "button");
  icon.tabIndex = 0;
  icon.title = "Opinion HUD - Click to see markets";

  // Inline button in action bar (like other action buttons)
  icon.style.display = "inline-flex";
  icon.style.alignItems = "center";
  icon.style.justifyContent = "center";
  icon.style.width = "34px";
  icon.style.height = "34px";
  icon.style.borderRadius = "9999px";
  icon.style.cursor = "pointer";
  icon.style.userSelect = "none";
  icon.style.transition = "background-color 0.2s";
  icon.style.marginLeft = "auto"; // Push to the right end

  icon.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">' +
    '<circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" stroke-width="1.8" opacity="0.7"></circle>' +
    '<text x="10" y="14" text-anchor="middle" font-size="12" font-weight="700" font-family="system-ui, -apple-system, Segoe UI, Roboto" fill="currentColor">O</text>' +
    "</svg>";

  icon.addEventListener("mouseenter", () => {
    icon.style.backgroundColor = "rgba(15, 20, 25, 0.1)";
  });
  icon.addEventListener("mouseleave", () => {
    icon.style.backgroundColor = "transparent";
  });
  return icon;
}

function removeHud() {
  if (state.activeHud) {
    state.activeHud.remove();
    state.activeHud = null;
  }
}

function renderHud(anchorEl, match) {
  removeHud();

  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.zIndex = "2147483647";

  const rect = anchorEl.getBoundingClientRect();
  const hudWidth = 320;
  const hudHeight = 300; // Approximate height

  // Position HUD above the icon (icon is now in bottom action bar)
  const top = window.scrollY + rect.top - hudHeight - 8;
  const left = window.scrollX + rect.right - hudWidth;

  container.style.top = `${top}px`;
  container.style.left = `${left}px`;

  const shadow = container.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .hud {
      width: 320px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: #e7e9ea;
      background: rgba(15, 20, 25, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .title { font-weight: 700; font-size: 14px; line-height: 1.2; }
    .pill { font-size: 11px; padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,0.10); }
    .list { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
    .item { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; }
    .itemTitle { font-size: 13px; line-height: 1.25; }
    .tradeBtn {
      border: 0;
      padding: 7px 10px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      background: rgba(29, 155, 240, 0.95);
      color: #fff;
      transition: background 0.2s;
    }
    .tradeBtn:hover { background: #1a8cd8; }
    .tradeBtn:active { transform: translateY(1px); }
    .footer { margin-top: 12px; display: flex; justify-content: flex-start; align-items: center; gap: 10px; }
    .term { opacity: 0.75; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;

  const hud = document.createElement("div");
  hud.className = "hud";

  const header = document.createElement("div");
  header.className = "row";
  const headerTitle = (match.markets?.length || 0) > 1 ? "Markets Found" : "Market Found";
  header.innerHTML = `<div class="title">${headerTitle}</div><div class="pill">${match.mode === "event" ? "Event" : "Market"}</div>`;

  const list = document.createElement("div");
  list.className = "list";

  for (const m of match.markets.slice(0, MAX_MATCHES_ON_SCREEN)) {
    const item = document.createElement("div");
    item.className = "item";

    const leftCell = document.createElement("div");
    leftCell.className = "itemTitle";
    leftCell.textContent = m.title;

    const rightCell = document.createElement("button");
    rightCell.className = "tradeBtn";
    rightCell.type = "button";
    rightCell.textContent = "Trade";
    rightCell.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!m.url) return;
      window.open(m.url, "_blank", "noopener,noreferrer");
    });

    item.appendChild(leftCell);
    item.appendChild(rightCell);
    list.appendChild(item);
  }

  const footer = document.createElement("div");
  footer.className = "footer";

  const term = document.createElement("div");
  term.className = "term";
  term.textContent = match.keyword ? `Matched: ${match.keyword}` : "";

  footer.appendChild(term);

  hud.appendChild(header);
  hud.appendChild(list);
  hud.appendChild(footer);

  shadow.appendChild(style);
  shadow.appendChild(hud);

  document.documentElement.appendChild(container);
  state.activeHud = container;

  const onDocClick = (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(container) || path.includes(anchorEl)) return;
    removeHud();
    document.removeEventListener("click", onDocClick, true);
  };
  document.addEventListener("click", onDocClick, true);
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

function scoreEntry({ raw, plain, tokens }, entry) {
  const reasons = [];
  let score = 0;

  const keywordPlain = entry.keywordPlain || "";
  const keywordTokens = entry.keywordTokens || [];
  const hasLowSignalToken = keywordTokens.some((t) => LOW_SIGNAL_TOKENS.has(t));

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

  if (hasLowSignalToken && score > 0) {
    score *= LOW_SIGNAL_SCORE_MULTIPLIER;
    reasons.push("low_signal");
  }

  return { score: clamp01(score), reasons };
}

function isEntryMentioned({ plain, tokens }, entry) {
  const keywordPlain = entry.keywordPlain || "";
  const keywordTokens = (entry.keywordTokens || []).filter(Boolean);
  if (!keywordTokens.length) return false;

  if (keywordTokens.length === 1) {
    return tokens.has(keywordTokens[0]);
  }

  if (keywordPlain && plain.includes(keywordPlain)) return true;

  let present = 0;
  for (const t of keywordTokens) {
    if (tokens.has(t)) present += 1;
  }
  return present === keywordTokens.length && tokensNear(plain, keywordTokens);
}

function computeMatchForTweetText(tweetText) {
  if (!state.data || !state.matcher) return null;

  const tokenized = tokenize(stripMentions(tweetText));
  const { raw, plain, tokens } = tokenized;

  const candidates = [];
  for (const t of tokens) {
    const list = state.matcher.firstTokenMap.get(t);
    if (list) candidates.push(...list);
  }

  // No threshold - entity matches go to pool, score is for sorting only
  const targetBest = new Map();
  const matchedEntityMaskById = new Map(); // id -> bitmask of satisfied groups
  const requiredEntityMaskById = state.matcher.entityRequiredMaskById || new Map();
  const entityTermMaskById = state.matcher.entityTermMaskById || new Map();

  for (const entry of candidates) {
    const keyword = entry.keyword;
    if (!keyword || keyword.length < 2) continue;

    const { score, reasons } = scoreEntry({ raw, plain, tokens }, entry);
    const mentioned = isEntryMentioned({ plain, tokens }, entry);
    const hasLowSignalToken = (entry.keywordTokens || []).some((t) => LOW_SIGNAL_TOKENS.has(t));
    const entityScore = hasLowSignalToken ? LOW_SIGNAL_ENTITY_SCORE : DEFAULT_ENTITY_SCORE;

    if (state.matcher.mode === "event") {
      for (const id of entry.eventIds || []) {
        const eventId = String(id);
        let entityAddCount = 0;
        if (mentioned) {
          const termMask = entityTermMaskById.get(eventId)?.get(keyword) || 0;
          if (termMask) {
            const prevMask = matchedEntityMaskById.get(eventId) || 0;
            const newBits = termMask & ~prevMask;
            if (newBits) {
              const nextMask = prevMask | newBits;
              matchedEntityMaskById.set(eventId, nextMask);
              entityAddCount = countBits32(newBits);
            }
          }
        }
        const entityAddScore = entityAddCount ? entityScore * entityAddCount : 0;

        const existing = targetBest.get(eventId);
        if (!existing) {
          // First keyword match for this event
          const contributed = score > 0 || entityAddCount > 0;
          targetBest.set(eventId, {
            score: score + entityAddScore,
            keyword: entry.keywordPlain || keyword,
            reasons: entityAddCount
              ? [...reasons, hasLowSignalToken ? `entity_low:${keyword}` : `entity:${keyword}`]
              : [...reasons],
            entry,
            id: eventId,
            matchCount: 1,
            baseScore: Math.max(score, entityAddCount ? entityScore : 0),
            matchedKeywords: new Set([keyword]),
            matchedSignals: new Set(contributed ? [keyword] : []),
          });
        } else {
          if (entityAddCount) {
            existing.score += entityAddScore;
            existing.reasons.push(hasLowSignalToken ? `+entity_low:${keyword}` : `+entity:${keyword}`);
            if (entityScore > existing.baseScore) {
              existing.baseScore = entityScore;
              existing.keyword = entry.keywordPlain || keyword;
            }
          }

          // Only add bonus if this is a NEW keyword (not already matched)
          if (!existing.matchedKeywords.has(keyword)) {
            const MULTI_KEYWORD_BONUS = 0.12;
            if (score > 0) {
              existing.score += score * MULTI_KEYWORD_BONUS;
              existing.reasons.push(...reasons.map(r => `+${r}`));
            }
            existing.matchCount += 1;
            existing.matchedKeywords.add(keyword);
            if (score > 0 || entityAddCount > 0) existing.matchedSignals.add(keyword);

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
        let entityAddCount = 0;
        if (mentioned) {
          const termMask = entityTermMaskById.get(marketId)?.get(keyword) || 0;
          if (termMask) {
            const prevMask = matchedEntityMaskById.get(marketId) || 0;
            const newBits = termMask & ~prevMask;
            if (newBits) {
              const nextMask = prevMask | newBits;
              matchedEntityMaskById.set(marketId, nextMask);
              entityAddCount = countBits32(newBits);
            }
          }
        }
        const entityAddScore = entityAddCount ? entityScore * entityAddCount : 0;

        const existing = targetBest.get(marketId);
        if (!existing) {
          // First keyword match for this market
          const contributed = score > 0 || entityAddCount > 0;
          targetBest.set(marketId, {
            score: score + entityAddScore,
            keyword: entry.keywordPlain || keyword,
            reasons: entityAddCount
              ? [...reasons, hasLowSignalToken ? `entity_low:${keyword}` : `entity:${keyword}`]
              : [...reasons],
            entry,
            id: marketId,
            matchCount: 1,
            baseScore: Math.max(score, entityAddCount ? entityScore : 0),
            matchedKeywords: new Set([keyword]),
            matchedSignals: new Set(contributed ? [keyword] : []),
          });
        } else {
          if (entityAddCount) {
            existing.score += entityAddScore;
            existing.reasons.push(hasLowSignalToken ? `+entity_low:${keyword}` : `+entity:${keyword}`);
            if (entityScore > existing.baseScore) {
              existing.baseScore = entityScore;
              existing.keyword = entry.keywordPlain || keyword;
            }
          }

          // Only add bonus if this is a NEW keyword (not already matched)
          if (!existing.matchedKeywords.has(keyword)) {
            const MULTI_KEYWORD_BONUS = 0.12;
            if (score > 0) {
              existing.score += score * MULTI_KEYWORD_BONUS;
              existing.reasons.push(...reasons.map(r => `+${r}`));
            }
            existing.matchCount += 1;
            existing.matchedKeywords.add(keyword);
            if (score > 0 || entityAddCount > 0) existing.matchedSignals.add(keyword);

            if (score > existing.baseScore) {
              existing.baseScore = score;
              existing.keyword = entry.keywordPlain || keyword;
            }
          }
        }
      }
    }
  }

  if (targetBest.size === 0) return null;

  // Filter: only keep targets that satisfied all required entity groups:
  // (a OR b) AND (c OR d) ...
  const entityMatches = Array.from(targetBest.values()).filter((item) => {
    const requiredMask = requiredEntityMaskById.get(item.id) || 0;
    if (!requiredMask) return false;
    const matchedMask = matchedEntityMaskById.get(item.id) || 0;
    return (matchedMask & requiredMask) === requiredMask;
  });

  if (entityMatches.length === 0) return null;

  // Sort by score (confidence), return top match
  if (state.matcher.mode === "event") {
    const ranked = entityMatches.sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const eventId = best.id;
    const event = state.data.events?.[eventId];
    if (!event) return null;

    const markets = ranked
      .map((item) => {
        const e = state.data.events?.[item.id];
        if (!e) return null;
        const bestMarketId = e.bestMarketId || (e.marketIds || [])[0] || null;
        const bestMarket = bestMarketId ? state.data.markets?.[bestMarketId] : null;
        const url = buildOpinionTradeUrl({ topicId: item.id, isMulti: true });
        return {
          title: e.title || "Event",
          labels: bestMarket?.labels || null,
          topicId: item.id,
          isMulti: true,
          url,
          matchedKeywords: Array.from(item.matchedSignals || item.matchedKeywords || []).sort(),
        };
      })
      .filter(Boolean)
      .slice(0, MAX_MATCHES_ON_SCREEN);

    const primaryUrl = buildOpinionTradeUrl({ topicId: eventId, isMulti: true });

    return {
      mode: "event",
      keyword: best.keyword || null,
      matchedKeywords: Array.from(best.matchedSignals || best.matchedKeywords || []).sort(),
      title: event.title || "Event",
      markets,
      primaryUrl,
    };
  }

  const ranked = entityMatches.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const primaryMarketId = best.id;

  const seenTopicIds = new Set();
  const markets = [];
  let primaryTopicId = null;
  let primaryIsMulti = false;
  let primaryTitle = null;

  for (const item of ranked) {
    const m = state.data.markets?.[item.id];
    if (!m) continue;

    const isMulti = isMultiMarket(item.id, m);
    const topicId = isMulti ? m.eventId : item.id;
    const topicKey = String(topicId);
    if (seenTopicIds.has(topicKey)) continue;
    seenTopicIds.add(topicKey);

    const title = isMulti
      ? (state.data.events?.[topicId]?.title || m.eventTitle || m.title || "Event")
      : (m.title || "Market");

    markets.push({
      title,
      labels: m.labels || null,
      topicId,
      isMulti,
      url: buildOpinionTradeUrl({ topicId, isMulti }),
      matchedKeywords: Array.from(item.matchedSignals || item.matchedKeywords || []).sort(),
    });

    if (primaryTopicId == null && String(item.id) === String(primaryMarketId)) {
      primaryTopicId = topicId;
      primaryIsMulti = isMulti;
      primaryTitle = title;
    }

    if (markets.length >= MAX_MATCHES_ON_SCREEN) break;
  }

  if (!markets.length) return null;
  if (primaryTopicId == null) {
    const first = markets[0];
    primaryTopicId = first.topicId;
    primaryIsMulti = !!first.isMulti;
    primaryTitle = first.title;
  }

  const primaryUrl = buildOpinionTradeUrl({ topicId: primaryTopicId, isMulti: primaryIsMulti });
  return {
    mode: "market",
    keyword: best.keyword || null,
    matchedKeywords: Array.from(best.matchedSignals || best.matchedKeywords || []).sort(),
    title: primaryTitle || "Market",
    markets,
    primaryUrl,
  };
}

function findActionBar(articleEl) {
  return articleEl.querySelector(SELECTORS.actionGroup);
}

function attachIconToTweet(tweetTextEl, match) {
  const articleEl = tweetTextEl.closest(SELECTORS.article);
  if (!articleEl) return;

  const actionBar = findActionBar(articleEl);
  if (!actionBar) return;

  // Check if icon already exists
  let icon = actionBar.querySelector(`div[${ICON_ATTR}]`);
  if (!icon) {
    icon = createIcon();
    actionBar.appendChild(icon);
  }

  // Click to toggle HUD
  icon.onclick = (e) => {
    e.stopPropagation();
    if (state.activeHud) {
      removeHud();
    } else {
      renderHud(icon, match);
    }
  };

  // Also support hover
  icon.onmouseenter = () => {
    if (state.hoverTimer) window.clearTimeout(state.hoverTimer);
    if (!state.activeHud) {
      state.hoverTimer = window.setTimeout(() => renderHud(icon, match), HOVER_DELAY_MS);
    }
  };
  icon.onmouseleave = () => {
    if (state.hoverTimer) window.clearTimeout(state.hoverTimer);
    state.hoverTimer = null;
  };
}

function scanTweetTextNode(tweetTextEl) {
  if (!(tweetTextEl instanceof HTMLElement)) return;
  if (tweetTextEl.getAttribute(SCANNED_ATTR) === "true") return;
  tweetTextEl.setAttribute(SCANNED_ATTR, "true");

  const text = tweetTextEl.innerText || tweetTextEl.textContent || "";
  const match = computeMatchForTweetText(text);
  if (!match) return;

  attachIconToTweet(tweetTextEl, match);
}

function scanAll() {
  const nodes = document.querySelectorAll(SELECTORS.tweetText);
  for (const node of nodes) scanTweetTextNode(node);
}

async function loadDataFromStorage() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.cachedData);
  const data = result[STORAGE_KEYS.cachedData];
  if (!data) return null;
  return data;
}

async function ensureData() {
  const data = await loadDataFromStorage();
  if (data) return data;

  try {
    const resp = await chrome.runtime.sendMessage({ type: "opinionHud.refresh" });
    if (resp?.ok) return await loadDataFromStorage();
  } catch {
    // ignore
  }
  return null;
}

function startObserver() {
  if (state.observer) state.observer.disconnect();
  state.observer = new MutationObserver(() => scanAll());
  state.observer.observe(document.body, { childList: true, subtree: true });
}

async function main() {
  state.data = await ensureData();
  if (!state.data) return;
  state.matcher = buildMatcher(state.data);
  startObserver();
  scanAll();
}

main();
