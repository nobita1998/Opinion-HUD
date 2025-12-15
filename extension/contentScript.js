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
    for (const [keyword, eventIds] of Object.entries(eventIndex)) {
      if (!keyword || !Array.isArray(eventIds) || eventIds.length === 0) continue;
      const keywordLower = String(keyword).toLowerCase().trim();
      const keywordPlain = normalizeForMatch(keywordLower).plain;
      const keywordTokens = keywordPlain ? keywordPlain.split(" ") : [];
      keywordToTargets.push({ keyword: keywordLower, keywordPlain, keywordTokens, eventIds });
    }
  } else {
    for (const [keyword, marketIds] of Object.entries(index)) {
      if (!keyword || !Array.isArray(marketIds) || marketIds.length === 0) continue;
      const keywordLower = String(keyword).toLowerCase().trim();
      const keywordPlain = normalizeForMatch(keywordLower).plain;
      const keywordTokens = keywordPlain ? keywordPlain.split(" ") : [];
      keywordToTargets.push({ keyword: keywordLower, keywordPlain, keywordTokens, marketIds });
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

function findActionBar(articleEl) {
  return articleEl.querySelector(SELECTORS.actionGroup);
}

function createIcon() {
  const icon = document.createElement("span");
  icon.setAttribute(ICON_ATTR, "1");
  icon.setAttribute("role", "button");
  icon.tabIndex = 0;
  icon.title = "Opinion HUD";
  icon.style.display = "inline-flex";
  icon.style.alignItems = "center";
  icon.style.justifyContent = "center";
  icon.style.width = "16px";
  icon.style.height = "16px";
  icon.style.marginLeft = "8px";
  icon.style.opacity = "0.5";
  icon.style.cursor = "pointer";
  icon.style.userSelect = "none";

  icon.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.9"></circle>' +
    '<text x="8" y="11" text-anchor="middle" font-size="9" font-family="system-ui, -apple-system, Segoe UI, Roboto" fill="#fff">O</text>' +
    "</svg>";

  icon.addEventListener("mouseenter", () => (icon.style.opacity = "1.0"));
  icon.addEventListener("mouseleave", () => (icon.style.opacity = "0.5"));
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
  const top = window.scrollY + rect.bottom + 8;
  const left = Math.min(window.scrollX + rect.left, window.scrollX + document.documentElement.clientWidth - 300);
  container.style.top = `${top}px`;
  container.style.left = `${left}px`;

  const shadow = container.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .hud {
      width: 280px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: #e7e9ea;
      background: rgba(15, 20, 25, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .title { font-weight: 700; font-size: 13px; line-height: 1.2; }
    .sub { opacity: 0.85; font-size: 12px; margin-top: 4px; line-height: 1.25; }
    .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.10); }
    .list { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
    .item { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
    .itemTitle { font-size: 12px; line-height: 1.25; }
    .labels { display: flex; gap: 6px; align-items: center; justify-content: flex-end; }
    .btn {
      border: 0;
      padding: 8px 10px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      background: #1d9bf0;
      color: #fff;
    }
    .btn:active { transform: translateY(1px); }
    .footer { margin-top: 10px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
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
  let score = 0;

  const keywordPlain = entry.keywordPlain || "";
  const keywordTokens = entry.keywordTokens || [];

  if (keywordPlain && plain.includes(keywordPlain)) {
    score += 0.85;
    score += Math.min(0.1, keywordPlain.length / 120);
  } else if (keywordTokens.length >= 2 && keywordTokens.length <= 3) {
    let present = 0;
    for (const t of keywordTokens) {
      if (tokens.has(t)) present += 1;
    }
    if (present === keywordTokens.length) {
      score += tokensNear(plain, keywordTokens) ? 0.7 : 0.45;
    } else if (present >= 2) {
      score += 0.35;
    }
  }

  for (const t of keywordTokens) {
    if (!t || t.length < 3) continue;
    if (raw.includes(`$${t}`) || raw.includes(`#${t}`)) {
      score += 0.05;
      break;
    }
  }

  return clamp01(score);
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

  const threshold = 0.6;
  const targetBest = new Map();

  for (const entry of candidates) {
    const keyword = entry.keyword;
    if (!keyword || keyword.length < 2) continue;
    const score = scoreEntry({ raw, plain, tokens }, entry);
    if (score < threshold) continue;

    if (state.matcher.mode === "event") {
      for (const id of entry.eventIds || []) {
        const eventId = String(id);
        const existing = targetBest.get(eventId);
        if (!existing || score > existing.score) {
          targetBest.set(eventId, {
            score,
            keyword: entry.keywordPlain || keyword,
            id: eventId,
          });
        }
      }
    } else {
      for (const id of entry.marketIds || []) {
        const marketId = String(id);
        const existing = targetBest.get(marketId);
        if (!existing || score > existing.score) {
          targetBest.set(marketId, {
            score,
            keyword: entry.keywordPlain || keyword,
            id: marketId,
          });
        }
      }
    }
  }

  if (targetBest.size === 0) return null;

  if (state.matcher.mode === "event") {
    const ranked = Array.from(targetBest.values()).sort((a, b) => b.score - a.score);
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

  const ranked = Array.from(targetBest.values()).sort((a, b) => b.score - a.score);
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

function attachIconToTweet(tweetTextEl, match) {
  const articleEl = tweetTextEl.closest(SELECTORS.article);
  if (!articleEl) return;

  const actionBar = findActionBar(articleEl);
  if (!actionBar) return;

  let icon = actionBar.querySelector(`span[${ICON_ATTR}]`);
  if (!icon) {
    icon = createIcon();
    actionBar.appendChild(icon);
  }

  icon.onmouseenter = () => {
    if (state.hoverTimer) window.clearTimeout(state.hoverTimer);
    state.hoverTimer = window.setTimeout(() => renderHud(icon, match), HOVER_DELAY_MS);
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
