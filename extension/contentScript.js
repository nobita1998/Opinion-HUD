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
  const s = normalizeText(text);
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
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
  return { s, tokens };
}

function buildMatcher(data) {
  const eventIndex = data.eventIndex || null;
  const index = data.index || {};

  const keywordToTargets = [];
  if (eventIndex && typeof eventIndex === "object") {
    for (const [keyword, eventIds] of Object.entries(eventIndex)) {
      if (!keyword || !Array.isArray(eventIds) || eventIds.length === 0) continue;
      keywordToTargets.push({ keyword: String(keyword).toLowerCase(), eventIds });
    }
  } else {
    for (const [keyword, marketIds] of Object.entries(index)) {
      if (!keyword || !Array.isArray(marketIds) || marketIds.length === 0) continue;
      keywordToTargets.push({ keyword: String(keyword).toLowerCase(), marketIds });
    }
  }

  const firstTokenMap = new Map();
  for (const entry of keywordToTargets) {
    const firstToken = entry.keyword.split(/\s+/)[0];
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

function computeMatchForTweetText(tweetText) {
  if (!state.data || !state.matcher) return null;

  const { s, tokens } = tokenize(tweetText);

  const candidates = [];
  for (const t of tokens) {
    const list = state.matcher.firstTokenMap.get(t);
    if (list) candidates.push(...list);
  }

  let best = null;
  const seenTargets = new Set();

  for (const entry of candidates) {
    const keyword = entry.keyword;
    if (!keyword || keyword.length < 2) continue;
    if (!s.includes(keyword)) continue;

    const score = keyword.length;
    if (!best || score > best.score) {
      best = { score, keyword, entry };
    }

    if (state.matcher.mode === "event") {
      for (const eventId of entry.eventIds) {
        seenTargets.add(String(eventId));
      }
    } else {
      for (const marketId of entry.marketIds) {
        seenTargets.add(String(marketId));
      }
    }
  }

  if (seenTargets.size === 0) return null;

  if (state.matcher.mode === "event") {
    const preferredEventId = best?.entry?.eventIds?.[0] ? String(best.entry.eventIds[0]) : null;
    const eventIds = Array.from(seenTargets);
    const eventId = preferredEventId && seenTargets.has(preferredEventId) ? preferredEventId : eventIds[0];
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
      keyword: best?.keyword || null,
      title: event.title || "Event",
      markets,
      primaryUrl,
    };
  }

  const marketIds = Array.from(seenTargets);
  const marketId = marketIds[0];
  const market = state.data.markets?.[marketId];
  if (!market) return null;
  return {
    mode: "market",
    keyword: best?.keyword || null,
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
