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

function appendUtm(url, term) {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", "twitter_extension");
    u.searchParams.set("utm_medium", "overlay");
    if (term) u.searchParams.set("utm_term", term);
    return u.toString();
  } catch {
    return url;
  }
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

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
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
    .sub { opacity: 0.85; font-size: 13px; margin-top: 4px; line-height: 1.25; }
    .pill { font-size: 11px; padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,0.10); }
    .list { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
    .item { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
    .itemTitle { font-size: 13px; line-height: 1.25; }
    .labels { display: flex; gap: 6px; align-items: center; justify-content: flex-end; }
    .btn {
      border: 0;
      padding: 10px 18px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      background: #1d9bf0;
      color: #fff;
      transition: background 0.2s;
    }
    .btn:hover { background: #1a8cd8; }
    .btn:active { transform: translateY(1px); }
    .footer { margin-top: 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .term { opacity: 0.75; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;

  const hud = document.createElement("div");
  hud.className = "hud";

  const header = document.createElement("div");
  header.className = "row";
  header.innerHTML = `<div class="title">Market Found</div><div class="pill">${match.mode === "event" ? "Event" : "Market"}</div>`;

  const subtitle = document.createElement("div");
  subtitle.className = "sub";
  subtitle.textContent = match.title;

  const list = document.createElement("div");
  list.className = "list";

  for (const m of match.markets.slice(0, MAX_MATCHES_ON_SCREEN)) {
    const item = document.createElement("div");
    item.className = "item";

    const leftCell = document.createElement("div");
    leftCell.className = "itemTitle";
    leftCell.textContent = m.title;

    const rightCell = document.createElement("div");
    rightCell.className = "labels";

    const yes = document.createElement("span");
    yes.className = "pill";
    yes.textContent = m.labels?.yesLabel || "YES";

    const no = document.createElement("span");
    no.className = "pill";
    no.textContent = m.labels?.noLabel || "NO";

    rightCell.appendChild(yes);
    rightCell.appendChild(no);

    item.appendChild(leftCell);
    item.appendChild(rightCell);
    list.appendChild(item);
  }

  const footer = document.createElement("div");
  footer.className = "footer";

  const term = document.createElement("div");
  term.className = "term";
  term.textContent = match.keyword ? `Matched: ${match.keyword}` : "";

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "Trade Now";
  btn.addEventListener("click", () => {
    const url = match.primaryUrl;
    if (!url) return;
    window.open(appendUtm(url, match.keyword), "_blank", "noopener,noreferrer");
  });

  footer.appendChild(term);
  footer.appendChild(btn);

  hud.appendChild(header);
  hud.appendChild(subtitle);
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

function computeMatchForTweetText(tweetText) {
  if (!state.data || !state.matcher) return null;

  const tokenized = tokenize(tweetText);
  const { raw, plain, tokens } = tokenized;

  const candidates = [];
  for (const t of tokens) {
    const list = state.matcher.firstTokenMap.get(t);
    if (list) candidates.push(...list);
  }

  // No threshold - entity matches go to pool, score is for sorting only
  const targetBest = new Map();
  const targetHasEntity = new Map(); // Track which targets matched an entity

  for (const entry of candidates) {
    const keyword = entry.keyword;
    if (!keyword || keyword.length < 2) continue;

    const { score, reasons } = scoreEntry({ raw, plain, tokens }, entry);
    const isEntityMatch = entry.isEntity || false;

    if (state.matcher.mode === "event") {
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
            id: eventId,
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
            id: marketId,
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

  if (targetBest.size === 0) return null;

  // Filter: only keep targets that matched at least one entity
  const entityMatches = Array.from(targetBest.values()).filter(item =>
    targetHasEntity.get(item.id)
  );

  if (entityMatches.length === 0) return null;

  // Sort by score (confidence), return top match
  if (state.matcher.mode === "event") {
    const ranked = entityMatches.sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const eventId = best.id;
    const event = state.data.events?.[eventId];
    if (!event) return null;

    const markets = (event.marketIds || [])
      .map((id) => state.data.markets?.[id])
      .filter(Boolean)
      .slice(0, MAX_MATCHES_ON_SCREEN);

    const primaryMarketId = event.bestMarketId || (event.marketIds || [])[0];
    const primaryUrl = primaryMarketId ? state.data.markets?.[primaryMarketId]?.url : null;

    return {
      mode: "event",
      keyword: best.keyword || null,
      title: event.title || "Event",
      markets,
      primaryUrl,
    };
  }

  const ranked = entityMatches.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const marketId = best.id;
  const market = state.data.markets?.[marketId];
  if (!market) return null;
  return {
    mode: "market",
    keyword: best.keyword || null,
    title: market.title || "Market",
    markets: [market],
    primaryUrl: market.url || null,
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
