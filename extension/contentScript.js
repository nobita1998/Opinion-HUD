// Import shared matcher functions from matcher.js (loaded before this script)
if (!window.OpinionMatcher) {
  console.error('[OpinionHUD] matcher.js not loaded - OpinionMatcher is undefined');
}
const {
  normalizeText,
  normalizeForMatch,
  stripMentions,
  tokenize,
  clamp01,
  countBits32,
  findTokenBoundaryIndex,
  tokensNear,
  buildMatcher,
  scoreEntry,
  isEntryMentioned,
  LOW_SIGNAL_TOKENS,
  LOW_SIGNAL_ENTITY_SCORE,
  LOW_SIGNAL_SCORE_MULTIPLIER,
  DEFAULT_ENTITY_SCORE,
} = window.OpinionMatcher || {};

const STORAGE_KEYS = {
  cachedData: "opinionHudData",
};

const SELECTORS = {
  tweetText: 'div[data-testid="tweetText"]',
  article: "article",
  moreMenuButton: [
    'button[data-testid="caret"]',
    'div[data-testid="caret"]',
    // Seen in some X layouts/experiments.
    'button[data-testid="tweetActionOverflow"]',
    'div[data-testid="tweetActionOverflow"]',
    'button[data-testid="overflow"]',
    'div[data-testid="overflow"]',
  ].join(", "),
  moreMenuIcon: ['svg[data-testid="icon-Overflow"]', 'svg[data-testid="icon-More"]'].join(", "),
  moreMenuAriaButton: [
    'button[aria-haspopup="menu"][aria-label]',
    'div[role="button"][aria-haspopup="menu"][aria-label]',
  ].join(", "),
};

const SCANNED_ATTR = "data-opinion-scanned";
const ARTICLE_SCANNED_ATTR = "data-opinion-article-scanned";
const ICON_ATTR = "data-opinion-hud-icon";

const HOVER_DELAY_MS = 300;
const MAX_MATCHES_ON_SCREEN = 3;
const SCAN_DEBOUNCE_MS = 150;

const state = {
  data: null,
  matcher: null,
  observer: null,
  hoverTimer: null,
  scanDebounceTimer: null,
  activeHud: null,
  activeHudAbort: null,
  activeHudDocClick: null,
  invalidated: false,
};

function isExtensionContextInvalidated(err) {
  const msg = err?.message ? String(err.message) : String(err || "");
  return /Extension context invalidated/i.test(msg);
}

function handleInvalidation(err) {
  if (!isExtensionContextInvalidated(err)) return false;
  state.invalidated = true;
  try {
    state.observer?.disconnect();
  } catch {
    // ignore
  }
  try {
    removeHud();
  } catch {
    // ignore
  }
  return true;
}

window.addEventListener(
  "error",
  (e) => {
    const err = e?.error || e?.message;
    if (!isExtensionContextInvalidated(err)) return;
    handleInvalidation(err);
    e.preventDefault?.();
  },
  true
);

window.addEventListener(
  "unhandledrejection",
  (e) => {
    const err = e?.reason;
    if (!isExtensionContextInvalidated(err)) return;
    handleInvalidation(err);
    e.preventDefault?.();
  },
  true
);

const OPINION_TRADE_DETAIL_URL = "https://app.opinion.trade/detail";
// Use our own Vercel serverless API (proxies to Opinion.Trade OpenAPI)
const OPINION_API_BASE = "https://api.opinionhud.xyz/api";

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").startsWith("/") ? String(path || "") : `/${path || ""}`;
  return `${b}${p}`;
}

function isOpinionApiUrl(url) {
  const u = String(url || "");
  return u.startsWith(`${OPINION_API_BASE}/`);
}

async function fetchOpinionApiJson(path, signal) {
  const url = joinUrl(OPINION_API_BASE, path);
  return await fetchJson(url, signal);
}

async function fetchOpinionApiJsonWithRetry(path, signal) {
  const url = joinUrl(OPINION_API_BASE, path);
  return await fetchJsonWithRetry(url, signal);
}

const PRICE_CACHE_TTL_MS = 60_000;
const MARKET_ASSET_CACHE_TTL_MS = 10 * 60_000;
const PRICE_HISTORY_CACHE_TTL_MS = 5 * 60_000; // 5 minutes for price history
const MAX_PRICE_FETCH_CONCURRENCY = 4;

const assetPriceCache = new Map(); // assetId -> { ts, price }
const marketAssetCache = new Map(); // marketId -> { ts, yesTokenId, noTokenId }
const priceHistoryCache = new Map(); // tokenId -> { ts, data }

function nowMs() {
  return Date.now();
}

function getCached(map, key, ttlMs) {
  const v = map.get(key);
  if (!v) return null;
  if (nowMs() - v.ts > ttlMs) return null;
  return v;
}

function formatProbPercent(price01) {
  const p = Number(price01);
  if (!Number.isFinite(p)) return null;
  const clamped = Math.max(0, Math.min(1, p));
  const percent = (clamped * 100).toFixed(1);
  return `${percent}%`;
}

function createLimiter(max) {
  let active = 0;
  const queue = [];

  function runNext() {
    if (active >= max) return;
    const item = queue.shift();
    if (!item) return;
    active += 1;
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  }

  return (fn, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const wrapped = () => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return fn();
      };
      queue.push({ fn: wrapped, resolve, reject });
      runNext();
    });
}

const priceFetchLimiter = createLimiter(MAX_PRICE_FETCH_CONCURRENCY);

function isAbortError(err) {
  return err?.name === "AbortError" || /aborted/i.test(String(err?.message || ""));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let done = false;
    let id = null;
    const onAbort = () => {
      if (done) return;
      clearTimeout(id);
      done = true;
      reject(new DOMException("Aborted", "AbortError"));
    };
    id = setTimeout(() => {
      if (done) return;
      done = true;
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function fetchJsonWithRetry(url, signal, { maxRetries = 3, delaysMs = [450, 900, 1800] } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fetchJson(url, signal);
    } catch (err) {
      if (handleInvalidation(err)) throw err;
      if (isAbortError(err)) throw err;
      lastErr = err;
      const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 900;
      if (attempt >= maxRetries) break;
      await sleep(delay, signal);
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

function sendMessageAsync(message, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          const err = new Error(String(lastErr.message || lastErr));
          if (handleInvalidation(err)) {
            reject(err);
            return;
          }
          reject(err);
          return;
        }
        resolve(response);
      });
    } catch (err) {
      if (handleInvalidation(err)) {
        reject(err);
        return;
      }
      reject(err);
    }
  });
}

function shouldProxyOpinionAnalytics(url) {
  return typeof url === "string" && isOpinionApiUrl(url);
}

async function fetchJson(url, signal) {
  if (shouldProxyOpinionAnalytics(url) && typeof chrome?.runtime?.sendMessage === "function") {
    const res = await sendMessageAsync({ type: "opinionHud.fetchJson", url }, signal);
    if (!res || typeof res !== "object") throw new Error(`Invalid response for ${url}`);
    if (!res.ok) throw new Error(res.error || `Failed to fetch ${url}`);
    return res.data;
  }

  const res = await fetch(url, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal,
    headers: {
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getMarketAssetIds(marketId, signal) {
  const key = String(marketId);
  const cached = getCached(marketAssetCache, key, MARKET_ASSET_CACHE_TTL_MS);
  if (cached) return cached;

  // Read tokenIds directly from data.json (already loaded in state.data)
  const market = state.data?.markets?.[key];
  const yesTokenId = String(market?.yesTokenId || "");
  const noTokenId = String(market?.noTokenId || "");
  const entry = { ts: nowMs(), yesTokenId, noTokenId };
  marketAssetCache.set(key, entry);
  return entry;
}

async function getLatestAssetPrice(assetId, signal) {
  const key = String(assetId);
  const cached = getCached(assetPriceCache, key, PRICE_CACHE_TTL_MS);
  if (cached) {
    return cached.price;
  }

  try {
    const path = `/token/${encodeURIComponent(key)}`;
    const data = await priceFetchLimiter(() => fetchOpinionApiJsonWithRetry(path, signal), signal);
    if (data?.success === false) {
      assetPriceCache.set(key, { ts: nowMs(), price: null });
      return null;
    }
    const first = Array.isArray(data?.data) ? data.data[0] : null;
    const price = first?.price != null ? Number.parseFloat(String(first.price)) : null;
    const normalized = Number.isFinite(price) ? price : null;
    assetPriceCache.set(key, { ts: nowMs(), price: normalized });
    return normalized;
  } catch (err) {
    // Silently handle errors (e.g., 502) and cache null to avoid repeated failed requests
    if (!isAbortError(err)) {
      assetPriceCache.set(key, { ts: nowMs(), price: null });
    }
    return null;
  }
}

/**
 * Extract tweet posting time from article element
 * @param {HTMLElement} articleEl - The article element containing the tweet
 * @returns {number|null} - Unix timestamp in milliseconds, or null if not found
 */
function extractTweetTime(articleEl) {
  if (!articleEl) return null;
  const timeEl = articleEl.querySelector('time[datetime]');
  if (!timeEl) return null;
  const datetime = timeEl.getAttribute('datetime');
  if (!datetime) return null;
  const date = new Date(datetime);
  if (isNaN(date.getTime())) return null;
  return date.getTime();
}

/**
 * Extract tweet author handle and avatar from article element
 * @param {HTMLElement} articleEl - The article element containing the tweet
 * @returns {{handle: string|null, avatarUrl: string|null}}
 */
function extractTweetAuthor(articleEl) {
  if (!articleEl) return { handle: null, avatarUrl: null };

  let handle = null;
  let avatarUrl = null;

  // Look for the author link in tweet header (e.g., href="/elonmusk")
  const authorLink = articleEl.querySelector('a[role="link"][href^="/"]');
  if (authorLink) {
    const href = authorLink.getAttribute('href');
    const match = href.match(/^\/([a-zA-Z0-9_]+)/);
    if (match && match[1] && !['home', 'explore', 'search', 'notifications', 'messages', 'i'].includes(match[1])) {
      handle = match[1];
    }
  }

  // Look for avatar image
  const avatarImg = articleEl.querySelector('img[src*="profile_images"]');
  if (avatarImg) {
    avatarUrl = avatarImg.src;
  }

  return { handle, avatarUrl };
}

/**
 * Extract tweet URL from article element
 * @param {HTMLElement} articleEl - The article element containing the tweet
 * @returns {string|null}
 */
function extractTweetUrl(articleEl) {
  if (!articleEl) return null;
  // Tweet URL is in the time element's parent link: /username/status/123456
  const timeEl = articleEl.querySelector('time[datetime]');
  if (!timeEl) return null;
  const linkEl = timeEl.closest('a[href*="/status/"]');
  if (!linkEl) return null;
  const href = linkEl.getAttribute('href');
  if (!href) return null;
  // Return full URL
  return `https://x.com${href}`;
}

/**
 * Fetch price history for a token
 * @param {string} tokenId - ERC-1155 token ID
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<Array|null>} - Array of { price, timestamp } or null
 */
async function getPriceHistory(tokenId, signal) {
  const key = String(tokenId);
  const cached = getCached(priceHistoryCache, key, PRICE_HISTORY_CACHE_TTL_MS);
  // Only use cache if it has data (not null)
  if (cached && cached.data && cached.data.length > 0) {
    return cached.data;
  }

  // Try intervals in order: 1h (reliable) -> max (fallback) -> 1m (might be empty)
  const intervals = ['1h', 'max', '1m'];

  for (const interval of intervals) {
    try {
      const path = `/token/price-history/${encodeURIComponent(key)}?interval=${interval}`;
      const response = await priceFetchLimiter(
        () => fetchOpinionApiJsonWithRetry(path, signal),
        signal
      );
      if (response?.success && Array.isArray(response?.data) && response.data.length > 0) {
        priceHistoryCache.set(key, { ts: nowMs(), data: response.data });
        return response.data;
      }
    } catch (err) {
      if (isAbortError(err)) return null;
      // Continue to next interval
    }
  }

  // All intervals failed - don't cache null, try again next time
  return null;
}

/**
 * Find the price at tweet time (CALL price)
 * Returns the price closest to the tweet timestamp, using tweet time as the timestamp
 * @param {Array} priceHistory - Array of { price, timestamp }
 * @param {number} tweetTimestamp - Tweet time in milliseconds
 * @returns {{ price: number, timestamp: number }|null}
 */
function findCallPrice(priceHistory, tweetTimestamp) {
  if (!priceHistory || !priceHistory.length || !tweetTimestamp) return null;

  // Sort by timestamp ascending (oldest first)
  const sorted = [...priceHistory].sort((a, b) => a.timestamp - b.timestamp);

  // Find price point closest to tweet timestamp
  let closestPoint = null;
  let closestDiff = Infinity;

  for (const point of sorted) {
    const diff = Math.abs(point.timestamp - tweetTimestamp);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestPoint = point;
    }
  }

  if (closestPoint) {
    // Return with tweet timestamp (not data point timestamp) for display
    return { price: closestPoint.price, timestamp: tweetTimestamp };
  }

  return null;
}

/**
 * Calculate price change between call price and current price
 * @param {number} callPrice - Price at call time (0-1)
 * @param {number} currentPrice - Current price (0-1)
 * @returns {{ callPrice: number, currentPrice: number, changePercent: number, changeDisplay: string }|null}
 */
function calculatePriceChange(callPrice, currentPrice) {
  if (callPrice == null || currentPrice == null) return null;
  if (!Number.isFinite(callPrice) || !Number.isFinite(currentPrice)) return null;
  if (callPrice === 0) return null;

  const changePercent = ((currentPrice - callPrice) / callPrice) * 100;
  return {
    callPrice,
    currentPrice,
    changePercent,
    changeDisplay: changePercent >= 0
      ? `+${changePercent.toFixed(1)}%`
      : `${changePercent.toFixed(1)}%`
  };
}

/**
 * Format price change display string
 * @param {number} callPrice - Price at call time (0-1)
 * @param {number} currentPrice - Current price (0-1)
 * @returns {{ text: string, isProfit: boolean, changePercent: number }|null}
 */
function formatPriceChangeDisplay(callPrice, currentPrice) {
  const change = calculatePriceChange(callPrice, currentPrice);
  if (!change) return null;

  const callPercent = (change.callPrice * 100).toFixed(1);
  const nowPercent = (change.currentPrice * 100).toFixed(1);

  return {
    text: `call @${callPercent}%, now @${nowPercent}%, ${change.changeDisplay}`,
    isProfit: change.changePercent > 0,
    changePercent: change.changePercent
  };
}

function buildOpinionTradeUrl({ topicId, isMulti }) {
  const u = new URL(OPINION_TRADE_DETAIL_URL);
  u.searchParams.set("topicId", String(topicId));
  if (isMulti) u.searchParams.set("type", "multi");
  return u.toString();
}

// ============================================
// Share Chart - Canvas Drawing Functions
// ============================================

const CHART_CONFIG = {
  width: 632,   // Logical width (2528/4)
  height: 424,  // Logical height (1696/4)
  scale: 4,     // 4x for retina
  textColor: '#ffffff',
  textMuted: 'rgba(255, 255, 255, 0.5)',
  profitColor: '#00d26a',
  lossColor: '#ff4d4d',
  brandColor: '#f97316',
};

// Background image cache
let bgImageCache = null;

/**
 * Load background image from extension assets
 */
async function loadBackgroundImage() {
  if (bgImageCache) return bgImageCache;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      bgImageCache = img;
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = chrome.runtime.getURL('assets/background.jpg');
  });
}

/**
 * Wrap text to fit within maxWidth, returning array of lines
 */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Generate interpretation text based on price movement
 */
function getInterpretationText(changePercent) {
  const absChange = Math.abs(changePercent);
  const isProfit = changePercent >= 0;

  if (absChange < 3) {
    return 'Minimal movement — market holding steady.';
  } else if (absChange < 10) {
    return isProfit
      ? 'Not a breakout — steady accumulation on the YES side.'
      : 'Gradual repricing — sentiment cooling slightly.';
  } else if (absChange < 20) {
    return isProfit
      ? 'Market moving gradually, not impulsively.'
      : 'Notable shift — traders reconsidering positions.';
  } else {
    return isProfit
      ? 'Significant momentum — conviction building.'
      : 'Sharp correction — sentiment reversing.';
  }
}

/**
 * Draw share card with background image and text overlay
 */
function drawShareChart(ctx, data, bgImage) {
  const { width, height } = CHART_CONFIG;
  const isProfit = data.changePercent >= 0;
  const accentColor = isProfit ? CHART_CONFIG.profitColor : CHART_CONFIG.lossColor;

  // === DRAW BACKGROUND IMAGE ===
  if (bgImage) {
    ctx.drawImage(bgImage, 0, 0, width, height);
  } else {
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, width, height);
  }

  let currentY = 42;

  // === TOP: Market Title (with word wrap) ===
  ctx.fillStyle = CHART_CONFIG.textColor;
  ctx.font = 'bold 24px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';

  const maxTitleWidth = width - 80;
  const titleLines = wrapText(ctx, data.title, maxTitleWidth);
  const titleLineHeight = 30;

  for (const line of titleLines) {
    ctx.fillText(line, width / 2, currentY);
    currentY += titleLineHeight;
  }

  // === Direction: YES or NO ===
  currentY += 16;
  ctx.fillStyle = accentColor;
  ctx.font = 'bold 20px system-ui';
  ctx.fillText(data.direction || 'YES', width / 2, currentY);

  // === CENTER: Price Cards (Vertical) ===
  currentY += 45;
  const callPrice = data.callPrice != null ? (data.callPrice * 100).toFixed(1) : '—';
  const nowPrice = data.currentPrice != null ? (data.currentPrice * 100).toFixed(1) : '—';

  const cardWidth = 200;
  const cardHeight = 70;
  const cardX = (width - cardWidth) / 2;
  const cardRadius = 12;

  // CALL card (top)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  ctx.roundRect(cardX, currentY, cardWidth, cardHeight, cardRadius);
  ctx.fill();

  ctx.fillStyle = CHART_CONFIG.textMuted;
  ctx.font = 'bold 14px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('CALL', width / 2, currentY + 22);

  ctx.fillStyle = CHART_CONFIG.textColor;
  ctx.font = 'bold 36px system-ui';
  ctx.fillText(`${callPrice}%`, width / 2, currentY + 56);

  // NOW card (bottom)
  currentY += cardHeight + 14;

  ctx.fillStyle = isProfit ? 'rgba(0, 210, 106, 0.15)' : 'rgba(255, 77, 77, 0.15)';
  ctx.beginPath();
  ctx.roundRect(cardX, currentY, cardWidth, cardHeight, cardRadius);
  ctx.fill();

  ctx.fillStyle = CHART_CONFIG.textMuted;
  ctx.font = 'bold 14px system-ui';
  ctx.fillText('NOW', width / 2, currentY + 22);

  ctx.fillStyle = accentColor;
  ctx.font = 'bold 36px system-ui';
  ctx.fillText(`${nowPrice}%`, width / 2, currentY + 56);

  currentY += cardHeight;

  // === AUTHOR with Avatar (below price change) ===
  if (data.tweetAuthor) {
    currentY += 55;
    const avatarSize = 36;
    const authorText = `@${data.tweetAuthor}`;

    ctx.font = 'bold 18px system-ui';
    const textWidth = ctx.measureText(authorText).width;
    const totalWidth = data.avatarImage ? avatarSize + 10 + textWidth : textWidth;
    const startX = (width - totalWidth) / 2;

    // Draw avatar (circular, vertically centered with text)
    if (data.avatarImage) {
      // Text vertical center is approximately baseline - fontSize * 0.35
      const textCenterY = currentY - 18 * 0.35;
      const avatarCenterY = textCenterY;
      const avatarY = avatarCenterY - avatarSize / 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(startX + avatarSize / 2, avatarCenterY, avatarSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(data.avatarImage, startX, avatarY, avatarSize, avatarSize);
      ctx.restore();

      // Draw author text
      ctx.fillStyle = CHART_CONFIG.textColor;
      ctx.font = 'bold 18px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(authorText, startX + avatarSize + 10, currentY);
    } else {
      // No avatar, just text centered
      ctx.fillStyle = CHART_CONFIG.textColor;
      ctx.font = 'bold 18px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(authorText, width / 2, currentY);
    }
  }

  // === FOOTER: Brand ===
  ctx.textAlign = 'left';
  ctx.fillStyle = CHART_CONFIG.brandColor;
  ctx.font = 'bold 16px system-ui';
  ctx.fillText('Opinion HUD', 24, height - 24);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.font = '13px system-ui';
  ctx.fillText('opinionhud.xyz', width - 24, height - 24);
}

/**
 * Load an image from URL
 */
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Generate share image and return dataURL
 */
async function generateShareImage(title, direction, callPrice, currentPrice, changePercent, tweetAuthor, avatarUrl) {
  const [bgImage, avatarImage] = await Promise.all([
    loadBackgroundImage(),
    avatarUrl ? loadImage(avatarUrl) : Promise.resolve(null)
  ]);

  const scale = CHART_CONFIG.scale;
  const canvas = document.createElement('canvas');
  canvas.width = CHART_CONFIG.width * scale;
  canvas.height = CHART_CONFIG.height * scale;
  const ctx = canvas.getContext('2d');

  ctx.scale(scale, scale);

  drawShareChart(ctx, {
    title,
    direction,
    callPrice,
    currentPrice,
    changePercent,
    tweetAuthor,
    avatarImage
  }, bgImage);

  try {
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.error('[OpinionHUD] Canvas toDataURL failed:', e);
    return null;
  }
}

/**
 * Copy image to clipboard
 */
async function copyImageToClipboard(dataUrl) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);
    return true;
  } catch (err) {
    console.error('[OpinionHUD] Failed to copy image:', err);
    return false;
  }
}

/**
 * Download image as file
 */
function downloadImage(dataUrl, filename) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename || 'opinion-hud-chart.png';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Show image preview popup in shadow DOM
 * @param {string} dataUrl - Image data URL
 * @param {string} title - Market title
 * @param {object} shadowRoot - Shadow DOM root
 * @param {object} priceData - Price data for sharing { thenPrice, nowPrice, changePercent }
 * @param {string} tweetUrl - Original tweet URL
 */
function showImagePreview(dataUrl, title, shadowRoot, priceData = null, tweetAuthor = null, tweetTime = null, tweetUrl = null) {
  // Remove existing preview if any
  const existing = shadowRoot.querySelector('.imagePreview');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'imagePreview';
  overlay.innerHTML = `
    <div class="previewBackdrop"></div>
    <div class="previewContent">
      <button class="previewClose" type="button">×</button>
      <img src="${dataUrl}" alt="Share Chart" class="previewImage" />
      <div class="previewActions">
        <button class="previewBtn downloadBtn" type="button">Download</button>
        <button class="previewBtn shareXBtn" type="button">Share to X</button>
      </div>
      <div class="shareXHint" style="display:none;">Image copied! Paste it in the X compose window (Ctrl+V / ⌘V)</div>
    </div>
  `;

  // Add styles for preview
  const previewStyle = shadowRoot.querySelector('.previewStyle');
  if (!previewStyle) {
    const style = document.createElement('style');
    style.className = 'previewStyle';
    style.textContent = `
      .imagePreview {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .previewBackdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(4px);
      }
      .previewContent {
        position: relative;
        background: #141414;
        border-radius: 16px;
        padding: 20px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
        border: 1px solid rgba(249, 115, 22, 0.3);
        max-width: 90vw;
        max-height: 90vh;
      }
      .previewClose {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 32px;
        height: 32px;
        border: none;
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
        font-size: 20px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }
      .previewClose:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      .previewImage {
        display: block;
        width: 600px;
        max-width: 100%;
        border-radius: 8px;
      }
      .previewActions {
        display: flex;
        gap: 12px;
        margin-top: 16px;
        justify-content: center;
      }
      .previewBtn {
        padding: 10px 24px;
        border: none;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }
      .downloadBtn {
        background: rgba(251, 146, 60, 0.15);
        color: #fff;
        border: 1px solid rgba(251, 146, 60, 0.3);
      }
      .downloadBtn:hover {
        background: rgba(251, 146, 60, 0.3);
      }
      .shareXBtn {
        background: rgba(29, 155, 240, 0.2);
        color: #fff;
        border: 1px solid rgba(29, 155, 240, 0.4);
      }
      .shareXBtn:hover {
        background: rgba(29, 155, 240, 0.4);
      }
      .shareXHint {
        margin-top: 12px;
        padding: 10px 16px;
        background: rgba(34, 197, 94, 0.15);
        border: 1px solid rgba(34, 197, 94, 0.3);
        border-radius: 8px;
        color: #86efac;
        font-size: 13px;
        text-align: center;
      }
    `;
    shadowRoot.appendChild(style);
  }

  shadowRoot.appendChild(overlay);

  // Event handlers
  const backdrop = overlay.querySelector('.previewBackdrop');
  const closeBtn = overlay.querySelector('.previewClose');
  const downloadBtn = overlay.querySelector('.downloadBtn');

  const close = () => overlay.remove();
  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  downloadBtn.addEventListener('click', () => {
    const filename = `opinion-hud-${title.replace(/[^a-z0-9]/gi, '-').substring(0, 30)}.png`;
    downloadImage(dataUrl, filename);
  });

  // Share to X button
  const shareXBtn = overlay.querySelector('.shareXBtn');
  const shareXHint = overlay.querySelector('.shareXHint');

  shareXBtn.addEventListener('click', () => {
    // Build tweet text with clear structure
    let tweetText = '';
    if (priceData) {
      const { thenPrice, nowPrice, changePercent } = priceData;
      const sign = changePercent >= 0 ? '+' : '';

      // Calculate time elapsed
      let timeStr = '';
      if (tweetTime) {
        const elapsed = Date.now() - tweetTime;
        const hours = Math.floor(elapsed / (1000 * 60 * 60));
        const days = Math.floor(hours / 24);
        if (days >= 1) {
          timeStr = days === 1 ? '1d' : `${days}d`;
        } else if (hours >= 1) {
          timeStr = hours === 1 ? '1h' : `${hours}h`;
        } else {
          const mins = Math.max(1, Math.floor(elapsed / (1000 * 60)));
          timeStr = `${mins}m`;
        }
      }

      // Simple format: price change with time
      tweetText = `${(thenPrice * 100).toFixed(1)}% → ${(nowPrice * 100).toFixed(1)}%`;
      tweetText += ` (${sign}${Math.abs(changePercent).toFixed(1)}%`;
      if (timeStr) tweetText += ` in ${timeStr}`;
      tweetText += `)`;
    }

    // Add original tweet link
    if (tweetUrl) {
      tweetText += `\n\n${tweetUrl}`;
    }

    tweetText += '\n\nopinionhud.xyz';

    const shareUrl = `https://x.com/intent/post?text=${encodeURIComponent(tweetText)}`;

    // Copy image to clipboard BEFORE opening new tab (clipboard API requires focus)
    copyImageToClipboard(dataUrl).then(success => {
      if (success) {
        shareXHint.style.display = 'block';
      }
    });

    // Small delay to ensure clipboard write starts before losing focus
    setTimeout(() => {
      window.open(shareUrl, '_blank', 'noopener,noreferrer');
    }, 100);
  });
}

function isMultiMarket(marketId, market) {
  // Check type field first (new data.json format)
  if (market?.type === "multi") return true;

  // Fallback to eventId-based detection (legacy format)
  const eventId = market?.eventId ?? null;
  if (eventId && String(eventId) !== String(marketId)) return true;

  return false;
}

function createIcon() {
  const icon = document.createElement("div");
  icon.setAttribute(ICON_ATTR, "1");
  icon.setAttribute("role", "button");
  icon.setAttribute("aria-label", "Opinion HUD");
  icon.tabIndex = 0;
  icon.title = "Opinion HUD - Click to see markets";

  // Inline button (styled similar to X's icon buttons)
  icon.style.display = "inline-flex";
  icon.style.alignItems = "center";
  icon.style.justifyContent = "center";
  icon.style.width = "34px";
  icon.style.height = "34px";
  icon.style.borderRadius = "9999px";
  icon.style.cursor = "pointer";
  icon.style.userSelect = "none";
  icon.style.transition = "background-color 0.2s";
  icon.style.flex = "0 0 auto";
  icon.style.marginRight = "2px";

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
  if (state.activeHudDocClick) {
    try {
      document.removeEventListener("click", state.activeHudDocClick, true);
    } catch {
      // ignore
    }
    state.activeHudDocClick = null;
  }
  if (state.activeHudAbort) {
    try {
      state.activeHudAbort.abort();
    } catch {
      // ignore
    }
    state.activeHudAbort = null;
  }
  if (state.activeHud) {
    state.activeHud.remove();
    state.activeHud = null;
  }
}

function renderHud(anchorEl, match, articleEl = null) {
  removeHud();

  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.zIndex = "2147483647";
  const abortController = new AbortController();
  state.activeHudAbort = abortController;

  // Extract tweet time, author and URL for price tracking and sharing
  const tweetTime = articleEl ? extractTweetTime(articleEl) : null;
  const { handle: tweetAuthor, avatarUrl: tweetAvatarUrl } = articleEl
    ? extractTweetAuthor(articleEl)
    : { handle: null, avatarUrl: null };
  const originalTweetUrl = articleEl ? extractTweetUrl(articleEl) : null;

  const rect = anchorEl.getBoundingClientRect();
  const hudWidth = 380;
  const margin = 8;
  const hudHeightVp = Math.min(600, Math.max(280, window.innerHeight - margin * 2));

  // Prefer placing to the right of the icon (same horizontal line) so it doesn't
  // cover tweet content; fall back to the left if needed.
  let leftVp = rect.right + margin;
  if (leftVp + hudWidth > window.innerWidth - margin) {
    leftVp = rect.left - hudWidth - margin;
  }
  leftVp = Math.max(margin, Math.min(leftVp, window.innerWidth - hudWidth - margin));

  // Keep the HUD aligned with the icon vertically (clamped to viewport).
  let topVp = rect.top;
  topVp = Math.max(margin, Math.min(topVp, window.innerHeight - hudHeightVp - margin));

  const top = window.scrollY + topVp;
  const left = window.scrollX + leftVp;

  container.style.top = `${top}px`;
  container.style.left = `${left}px`;

  const shadow = container.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .hud {
      position: relative;
      width: 380px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: #fff;
      background:
        linear-gradient(180deg, rgba(33, 33, 46, 0.94) 0%, rgba(14, 14, 28, 0.94) 100%) padding-box,
        linear-gradient(135deg, rgba(135, 91, 247, 0.95) 0%, rgba(204, 250, 21, 0.9) 100%) border-box;
      border: 1px solid transparent;
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 16px 56px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06) inset;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      max-height: ${hudHeightVp}px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .title { font-weight: 800; font-size: 14px; line-height: 1.2; letter-spacing: 0.2px; }
    .pill {
      font-size: 11px;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(135, 91, 247, 0.18);
      border: 1px solid rgba(135, 91, 247, 0.28);
      color: rgba(255,255,255,0.92);
    }
    .context {
      margin-top: 8px;
      font-size: 12px;
      line-height: 1.25;
      font-weight: 700;
      color: rgba(255,255,255,0.92);
      opacity: 0.95;
    }
    .list {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow-y: auto;
      flex: 1 1 auto;
      padding-right: 2px;
    }
    .item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 10px;
      border-radius: 12px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      transition: background 0.18s, border-color 0.18s;
    }
    .item:hover {
      background: rgba(204, 250, 21, 0.06);
      border-color: rgba(204, 250, 21, 0.20);
    }
    .item.binaryItem {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }
    .item.binaryItem .itemTitle {
      margin-bottom: 2px;
    }
    .item.binaryItem .meta {
      justify-content: flex-end;
    }
    .itemTitle { font-size: 13px; line-height: 1.25; color: rgba(255,255,255,0.92); }
    .meta { display: inline-flex; gap: 8px; align-items: center; justify-content: flex-end; }
    .pricePill {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.10);
      color: rgba(255,255,255,0.92);
      white-space: nowrap;
    }
    .pricePill.loading {
      color: rgba(255,255,255,0.75);
      background: rgba(255,255,255,0.06);
      border-color: rgba(255,255,255,0.10);
      animation: opinionHudPulse 1.1s ease-in-out infinite;
    }
    .pricePill.clickable,
    .pricePill.clickable * {
      cursor: pointer !important;
      user-select: none;
      -webkit-user-select: none;
    }
    .pricePill.clickable {
      transition: all 0.15s ease;
    }
    .pricePill.clickable:hover {
      background: rgba(249, 115, 22, 0.35) !important;
      border-color: rgba(249, 115, 22, 0.7) !important;
      color: #fff !important;
      transform: scale(1.05);
      box-shadow: 0 0 8px rgba(249, 115, 22, 0.4);
    }
    .pricePill.sharing {
      background: rgba(249, 115, 22, 0.25) !important;
      border-color: rgba(249, 115, 22, 0.5) !important;
      animation: opinionHudSharePulse 0.8s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes opinionHudSharePulse {
      0%, 100% { opacity: 0.6; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.02); }
    }
    @keyframes opinionHudPulse {
      0%, 100% { opacity: 0.55; }
      50% { opacity: 0.95; }
    }
    .tradeBtn {
      border: 0;
      padding: 7px 10px;
      border-radius: 10px;
      font-weight: 800;
      font-size: 12px;
      cursor: pointer;
      background: linear-gradient(135deg, rgba(135, 91, 247, 0.98) 0%, rgba(120, 57, 238, 0.98) 55%, rgba(105, 39, 218, 0.98) 100%);
      color: #fff;
      box-shadow: 0 10px 24px rgba(120, 57, 238, 0.25);
      transition: transform 0.12s, filter 0.2s;
    }
    .tradeBtn:hover { filter: brightness(1.06); }
    .tradeBtn:active { transform: translateY(1px); }
    .group {
      padding: 8px;
      border-radius: 12px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .groupHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 6px;
    }
    .groupTitle {
      font-size: 12px;
      line-height: 1.25;
      font-weight: 800;
      color: rgba(255,255,255,0.92);
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .optionList { display: flex; flex-direction: column; gap: 8px; }
    .optionList .item {
      padding: 7px 8px;
      border-radius: 10px;
    }
    .optionList .itemTitle { font-size: 12px; }
    .optionList .tradeBtn { padding: 6px 9px; font-size: 11px; border-radius: 9px; }
    .optionList .pricePill { font-size: 10.5px; padding: 2px 7px; }
    .binaryLine {
      display: flex;
      justify-content: flex-end;
      padding: 2px 0 0;
    }
    .moreBtn {
      border: 0;
      padding: 7px 10px;
      border-radius: 10px;
      font-weight: 800;
      font-size: 12px;
      cursor: pointer;
      background: rgba(204, 250, 21, 0.12);
      border: 1px solid rgba(204, 250, 21, 0.22);
      color: rgba(255,255,255,0.92);
      transition: filter 0.2s, transform 0.12s;
    }
    .moreBtn:hover { filter: brightness(1.06); }
    .moreBtn:active { transform: translateY(1px); }
    .footer { margin-top: 10px; display: flex; justify-content: flex-start; align-items: center; gap: 10px; flex: 0 0 auto; }
    .term { opacity: 0.85; color: #a2aebe; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .priceChange {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 6px;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 11px;
      line-height: 1.3;
    }
    .priceChange.profit {
      background: rgba(34, 197, 94, 0.12);
      border: 1px solid rgba(34, 197, 94, 0.25);
      color: #22c55e;
    }
    .priceChange.loss {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.25);
      color: #ef4444;
    }
    .priceChange.neutral {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.8);
    }
    .priceChange.loading {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.10);
      color: rgba(255, 255, 255, 0.6);
      animation: opinionHudPulse 1.1s ease-in-out infinite;
    }
    .priceChangeLabel {
      font-weight: 700;
      flex: 1;
    }
    .copyBtn {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      background: rgba(135, 91, 247, 0.25);
      border: none;
      color: rgba(255, 255, 255, 0.9);
      transition: all 0.15s;
    }
    .copyBtn:hover {
      background: rgba(135, 91, 247, 0.4);
    }
    .copyBtn.copied {
      background: rgba(34, 197, 94, 0.4);
    }
  `;

  const hud = document.createElement("div");
  hud.className = "hud";

  const header = document.createElement("div");
  header.className = "row";
  const headerTitle = (match.markets?.length || 0) > 1 ? "Markets Found" : "Market Found";
  header.innerHTML = `<div class="title">${headerTitle}</div><div class="pill">${match.mode === "event" ? "Event" : "Market"}</div>`;

  const context = document.createElement("div");
  context.className = "context";
  context.textContent = match.mode === "market" ? (match.title || "") : "";

  const list = document.createElement("div");
  list.className = "list";

  const hudContainer = container;
  state.activeHud = container;

  function setPillLoading(pillEl, label) {
    pillEl.classList.add("pricePill", "loading");
    pillEl.textContent = `${label} …`;
  }

  function setPillValue(pillEl, label, value) {
    pillEl.classList.remove("loading");
    pillEl.classList.add("pricePill");
    pillEl.textContent = value ? `${label} ${value}` : `${label} —`;
  }

  function isHudAlive() {
    return !abortController.signal.aborted && state.activeHud === hudContainer;
  }

  async function hydrateBinaryMarketPrices(marketId, yesPill, noPill) {
    try {
      const { yesTokenId, noTokenId } = await getMarketAssetIds(marketId, abortController.signal);
      if (!isHudAlive()) return;
      const [yesPrice, noPrice] = await Promise.all([
        yesTokenId ? getLatestAssetPrice(yesTokenId, abortController.signal) : Promise.resolve(null),
        noTokenId ? getLatestAssetPrice(noTokenId, abortController.signal) : Promise.resolve(null),
      ]);
      if (!isHudAlive()) return;
      setPillValue(yesPill, "YES", formatProbPercent(yesPrice));
      setPillValue(noPill, "NO", formatProbPercent(noPrice));
    } catch (err) {
      if (!isHudAlive()) return;
      setPillValue(yesPill, "YES", null);
      setPillValue(noPill, "NO", null);
    }
  }

  async function hydrateYesOnlyPrice(marketId, yesPill) {
    try {
      const { yesTokenId } = await getMarketAssetIds(marketId, abortController.signal);
      if (!isHudAlive()) return;
      const yesPrice = yesTokenId ? await getLatestAssetPrice(yesTokenId, abortController.signal) : null;
      if (!isHudAlive()) return;
      setPillValue(yesPill, "YES", formatProbPercent(yesPrice));
    } catch (err) {
      if (!isHudAlive()) return;
      setPillValue(yesPill, "YES", null);
    }
  }

  async function hydrateYesOnlyFromAssetId(assetId, yesPill) {
    try {
      const yesPrice = assetId ? await getLatestAssetPrice(assetId, abortController.signal) : null;
      if (!isHudAlive()) return;
      setPillValue(yesPill, "YES", formatProbPercent(yesPrice));
    } catch (err) {
      if (!isHudAlive()) return;
      setPillValue(yesPill, "YES", null);
    }
  }

  async function hydrateBinaryFromAssetIds(yesAssetId, noAssetId, yesPill, noPill) {
    try {
      const [yesPrice, noPrice] = await Promise.all([
        yesAssetId ? getLatestAssetPrice(yesAssetId, abortController.signal) : Promise.resolve(null),
        noAssetId ? getLatestAssetPrice(noAssetId, abortController.signal) : Promise.resolve(null),
      ]);
      if (!isHudAlive()) return;
      setPillValue(yesPill, "YES", formatProbPercent(yesPrice));
      setPillValue(noPill, "NO", formatProbPercent(noPrice));
    } catch {
      if (!isHudAlive()) return;
      setPillValue(yesPill, "YES", null);
      setPillValue(noPill, "NO", null);
    }
  }

  function createTradeButton(url) {
    const btn = document.createElement("button");
    btn.className = "tradeBtn";
    btn.type = "button";
    btn.textContent = "Trade";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!url) return;
      window.open(url, "_blank", "noopener,noreferrer");
    });
    return btn;
  }

  /**
   * Generate share text for clipboard
   */
  function generateShareText(title, callPrice, currentPrice, tweetTimeMs) {
    const display = formatPriceChangeDisplay(callPrice, currentPrice);
    if (!display) return null;
    const tweetDate = tweetTimeMs ? new Date(tweetTimeMs).toLocaleString() : 'Unknown';
    return `Opinion HUD - Call Tracker
${title}
${display.text}
Tweet: ${tweetDate}
https://opinionhud.xyz`;
  }

  /**
   * Handle click on a price pill to generate share image
   */
  // Minimum tweet age for sharing (10 minutes)
  const MIN_TWEET_AGE_MS = 10 * 60 * 1000;

  // Check if tweet is old enough for sharing
  function canShare() {
    if (!tweetTime) return false;
    return (Date.now() - tweetTime) >= MIN_TWEET_AGE_MS;
  }

  async function handlePillShareClick(title, tokenId, pillEl) {
    if (!tweetTime || !tokenId) return;

    if (pillEl) {
      pillEl.classList.add("sharing");
    }

    try {
      const [history, currentPrice] = await Promise.all([
        getPriceHistory(tokenId, abortController.signal),
        getLatestAssetPrice(tokenId, abortController.signal)
      ]);

      if (!isHudAlive()) return;

      const callPoint = findCallPrice(history, tweetTime);

      if (callPoint && currentPrice != null) {
        const display = formatPriceChangeDisplay(callPoint.price, currentPrice);
        if (display) {
          // Parse title to extract market name and direction
          let marketTitle = title;
          let direction = 'YES';
          const dirMatch = title.match(/\s*\((YES|NO)\)\s*$/i);
          if (dirMatch) {
            marketTitle = title.replace(dirMatch[0], '').trim();
            direction = dirMatch[1].toUpperCase();
          }

          const dataUrl = await generateShareImage(
            marketTitle,
            direction,
            callPoint.price,
            currentPrice,
            display.changePercent,
            tweetAuthor,
            tweetAvatarUrl
          );
          if (dataUrl) {
            showImagePreview(dataUrl, title, shadow, {
              thenPrice: callPoint.price,
              nowPrice: currentPrice,
              changePercent: display.changePercent
            }, tweetAuthor, tweetTime, originalTweetUrl);
            return;
          }
        }
      }

      alert('No price data available for this market');
    } catch (err) {
      if (!isHudAlive()) return;
      console.error('[OpinionHUD] Share error:', err);
    } finally {
      if (pillEl) {
        pillEl.classList.remove("sharing");
      }
    }
  }

  function renderBinaryRow({ title, tradeUrl, marketId }) {
    const item = document.createElement("div");
    item.className = "item binaryItem";

    const leftCell = document.createElement("div");
    leftCell.className = "itemTitle";
    leftCell.textContent = title;

    const meta = document.createElement("div");
    meta.className = "meta";

    const market = state.data?.markets?.[String(marketId)];
    const yesTokenId = String(market?.yesTokenId || "");
    const noTokenId = String(market?.noTokenId || "");

    // Create clickable YES pill
    const yesPill = document.createElement("div");
    setPillLoading(yesPill, "YES");
    if (canShare() && yesTokenId) {
      yesPill.classList.add("clickable");
      yesPill.title = "Click to share YES";
      yesPill.addEventListener("click", (e) => {
        e.stopPropagation();
        handlePillShareClick(title + " (YES)", yesTokenId, yesPill);
      });
    }
    meta.appendChild(yesPill);

    // Create clickable NO pill
    const noPill = document.createElement("div");
    setPillLoading(noPill, "NO");
    if (canShare() && noTokenId) {
      noPill.classList.add("clickable");
      noPill.title = "Click to share NO";
      noPill.addEventListener("click", (e) => {
        e.stopPropagation();
        handlePillShareClick(title + " (NO)", noTokenId, noPill);
      });
    }
    meta.appendChild(noPill);

    meta.appendChild(createTradeButton(tradeUrl));

    item.appendChild(leftCell);
    item.appendChild(meta);
    list.appendChild(item);

    hydrateBinaryMarketPrices(marketId, yesPill, noPill);
  }

  function renderWrapEventGroup(eventTitle, eventTradeUrl, wrapId) {
    const group = document.createElement("div");
    group.className = "group";

    const groupHeader = document.createElement("div");
    groupHeader.className = "groupHeader";

    const groupTitle = document.createElement("div");
    groupTitle.className = "groupTitle";
    groupTitle.textContent = eventTitle || "Event";

    groupHeader.appendChild(groupTitle);
    const multiTradeUrl = buildOpinionTradeUrl({ topicId: wrapId, isMulti: true });
    const tradeBtn = createTradeButton(eventTradeUrl || multiTradeUrl);
    groupHeader.appendChild(tradeBtn);
    group.appendChild(groupHeader);

    const optionList = document.createElement("div");
    optionList.className = "optionList";

    const placeholder = document.createElement("div");
    placeholder.className = "item";
    const placeholderTitle = document.createElement("div");
    placeholderTitle.className = "itemTitle";
    placeholderTitle.textContent = "Loading…";
    const placeholderMeta = document.createElement("div");
    placeholderMeta.className = "meta";
    const placeholderPill = document.createElement("div");
    setPillLoading(placeholderPill, "YES");
    placeholderMeta.appendChild(placeholderPill);
    placeholder.appendChild(placeholderTitle);
    placeholder.appendChild(placeholderMeta);
    optionList.appendChild(placeholder);

    group.appendChild(optionList);
    list.appendChild(group);

    (async () => {
      try {
        // Read subMarkets directly from data.json (already loaded in state.data)
        if (!isHudAlive()) return;
        const market = state.data?.markets?.[String(wrapId)];
        const childrenRaw = market?.subMarkets;
        const children = Array.isArray(childrenRaw) ? childrenRaw : [];

        optionList.innerHTML = "";

        const renderYesOptionRow = (child) => {
          const optionItem = document.createElement("div");
          optionItem.className = "item";

          const leftCell = document.createElement("div");
          leftCell.className = "itemTitle";
          leftCell.textContent = String(child?.title || child?.marketId || "Option");

          const meta = document.createElement("div");
          meta.className = "meta";

          const yesTokenId = String(child?.yesTokenId || "");
          const noTokenId = String(child?.noTokenId || "");
          const childTitle = child?.title || "Option";
          // Include event title for context: "Event - Child (YES)"
          const shareTitle = eventTitle ? `${eventTitle} - ${childTitle}` : childTitle;

          // Create clickable YES pill
          const yesPill = document.createElement("div");
          setPillLoading(yesPill, "YES");
          if (canShare() && yesTokenId) {
            yesPill.classList.add("clickable");
            yesPill.title = "Click to share YES";
            yesPill.addEventListener("click", (e) => {
              e.stopPropagation();
              handlePillShareClick(shareTitle + " (YES)", yesTokenId, yesPill);
            });
          }
          meta.appendChild(yesPill);

          // Create clickable NO pill
          const noPill = document.createElement("div");
          setPillLoading(noPill, "NO");
          if (canShare() && noTokenId) {
            noPill.classList.add("clickable");
            noPill.title = "Click to share NO";
            noPill.addEventListener("click", (e) => {
              e.stopPropagation();
              handlePillShareClick(shareTitle + " (NO)", noTokenId, noPill);
            });
          }
          meta.appendChild(noPill);

          optionItem.appendChild(leftCell);
          optionItem.appendChild(meta);

          // Hydrate both YES and NO prices
          hydrateBinaryFromAssetIds(yesTokenId, noTokenId, yesPill, noPill);

          return optionItem;
        };

        if (children.length === 0) {
          const row = document.createElement("div");
          row.className = "item";
          const t = document.createElement("div");
          t.className = "itemTitle";
          t.textContent = "No options available";
          const meta = document.createElement("div");
          meta.className = "meta";
          meta.appendChild(createTradeButton(eventTradeUrl || multiTradeUrl));
          row.appendChild(t);
          row.appendChild(meta);
          optionList.appendChild(row);
          return;
        }

        if (children.length === 1) {
          const only = children[0] || {};
          const marketId = String(only.marketId || "");
          const tradeUrl = buildOpinionTradeUrl({ topicId: marketId, isMulti: false });

          // For single-child events, treat it like a single binary market:
          // keep the header title, but don't repeat the same title again below.
          tradeBtn.replaceWith(createTradeButton(tradeUrl));

          const line = document.createElement("div");
          line.className = "binaryLine";

          const meta = document.createElement("div");
          meta.className = "meta";

          const yesTokenId = String(only.yesTokenId || "");
          const noTokenId = String(only.noTokenId || "");
          // Include child title if different from event title
          const childTitle = only.title || "";
          const shareTitle = (childTitle && childTitle !== eventTitle)
            ? `${eventTitle} - ${childTitle}`
            : eventTitle;

          // Create clickable YES pill
          const yesPill = document.createElement("div");
          setPillLoading(yesPill, "YES");
          if (canShare() && yesTokenId) {
            yesPill.classList.add("clickable");
            yesPill.title = "Click to share YES";
            yesPill.addEventListener("click", (e) => {
              e.stopPropagation();
              handlePillShareClick(shareTitle + " (YES)", yesTokenId, yesPill);
            });
          }
          meta.appendChild(yesPill);

          // Create clickable NO pill
          const noPill = document.createElement("div");
          setPillLoading(noPill, "NO");
          if (canShare() && noTokenId) {
            noPill.classList.add("clickable");
            noPill.title = "Click to share NO";
            noPill.addEventListener("click", (e) => {
              e.stopPropagation();
              handlePillShareClick(shareTitle + " (NO)", noTokenId, noPill);
            });
          }
          meta.appendChild(noPill);

          line.appendChild(meta);
          optionList.appendChild(line);

          hydrateBinaryFromAssetIds(yesTokenId, noTokenId, yesPill, noPill);
          return;
        }

        const top = children.slice(0, MAX_MATCHES_ON_SCREEN);
        for (const c of top) {
          optionList.appendChild(renderYesOptionRow(c));
        }

        if (children.length > top.length) {
          const more = document.createElement("button");
          more.className = "moreBtn";
          more.type = "button";
          more.textContent = `View all (${children.length})`;
          more.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!isHudAlive()) return;
            more.disabled = true;
            more.textContent = "Loading…";
            for (const c of children.slice(top.length)) {
              optionList.appendChild(renderYesOptionRow(c));
            }
            more.remove();
          });
          optionList.appendChild(more);
        }
      } catch (err) {
        if (!isHudAlive()) return;
        optionList.innerHTML = "";
        const row = document.createElement("div");
        row.className = "item";
        const t = document.createElement("div");
        t.className = "itemTitle";
        t.textContent = "Failed to load options";
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.appendChild(createTradeButton(eventTradeUrl || multiTradeUrl));
        row.appendChild(t);
        row.appendChild(meta);
        optionList.appendChild(row);
      }
    })();
  }

  for (const m of match.markets.slice(0, MAX_MATCHES_ON_SCREEN)) {
    if (m.isMulti) {
      renderWrapEventGroup(m.title, m.url, m.topicId);
      continue;
    }

    renderBinaryRow({ title: m.title, tradeUrl: m.url, marketId: m.topicId });
  }

  const footer = document.createElement("div");
  footer.className = "footer";

  const term = document.createElement("div");
  term.className = "term";
  term.textContent = match.keyword ? `Matched: ${match.keyword}` : "";

  footer.appendChild(term);

  hud.appendChild(header);
  if (context.textContent) hud.appendChild(context);
  hud.appendChild(list);
  hud.appendChild(footer);

  shadow.appendChild(style);
  shadow.appendChild(hud);

  document.documentElement.appendChild(container);

  const onDocClick = (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(container) || path.includes(anchorEl)) return;
    removeHud();
  };
  state.activeHudDocClick = onDocClick;
  document.addEventListener("click", onDocClick, true);
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

    // Process both eventIds and marketIds from the entry
    const idsToProcess = [
      ...(entry.eventIds || []).map(id => ({ id: String(id), type: 'event' })),
      ...(entry.marketIds || []).map(id => ({ id: String(id), type: 'market' }))
    ];

    for (const { id, type } of idsToProcess) {
      let entityAddCount = 0;
      if (mentioned) {
        const termMask = entityTermMaskById.get(id)?.get(keyword) || 0;
        if (termMask) {
          const prevMask = matchedEntityMaskById.get(id) || 0;
          const newBits = termMask & ~prevMask;
          if (newBits) {
            const nextMask = prevMask | newBits;
            matchedEntityMaskById.set(id, nextMask);
            entityAddCount = countBits32(newBits);
          }
        }
      }
      const entityAddScore = entityAddCount ? entityScore * entityAddCount : 0;

      const existing = targetBest.get(id);
      if (!existing) {
        // First keyword match for this event/market
        const contributed = score > 0 || entityAddCount > 0;
        targetBest.set(id, {
          score: score + entityAddScore,
          keyword: entry.keywordPlain || keyword,
          reasons: entityAddCount
            ? [...reasons, hasLowSignalToken ? `entity_low:${keyword}` : `entity:${keyword}`]
            : [...reasons],
          entry,
          id,
          type,
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

  // Sort by score and build market list (handles both events and markets)
  const ranked = entityMatches.sort((a, b) => b.score - a.score);
  const best = ranked[0];

  const seenTopicIds = new Set();
  const markets = [];
  let primaryTopicId = null;
  let primaryIsMulti = false;
  let primaryTitle = null;

  for (const item of ranked) {
    let topicId, isMulti, title, labels, marketIds, bestMarketId;

    // Handle both event-type and market-type matches
    if (item.type === 'event') {
      // This is a multi-choice event
      const e = state.data.events?.[item.id];
      if (!e) continue;

      topicId = item.id;
      isMulti = true;
      title = e.title || "Event";
      bestMarketId = e.bestMarketId || (e.marketIds || [])[0] || null;
      const bestMarket = bestMarketId ? state.data.markets?.[bestMarketId] : null;
      labels = bestMarket?.labels || null;
      marketIds = Array.isArray(e.marketIds) ? e.marketIds : null;
    } else {
      // This is a market (could be binary or multi-choice)
      const m = state.data.markets?.[item.id];
      if (!m) continue;

      isMulti = isMultiMarket(item.id, m);
      topicId = isMulti ? (m.eventId || item.id) : item.id;
      title = isMulti
        ? (state.data.events?.[topicId]?.title || m.eventTitle || m.title || "Event")
        : (m.title || "Market");
      labels = m.labels || null;
      marketIds = isMulti ? (state.data.events?.[topicId]?.marketIds || null) : null;
      bestMarketId = isMulti ? (state.data.events?.[topicId]?.bestMarketId || null) : null;
    }

    const topicKey = String(topicId);
    if (seenTopicIds.has(topicKey)) continue;
    seenTopicIds.add(topicKey);

    markets.push({
      title,
      labels,
      marketIds,
      bestMarketId,
      topicId,
      isMulti,
      url: buildOpinionTradeUrl({ topicId, isMulti }),
      matchedKeywords: Array.from(item.matchedSignals || item.matchedKeywords || []).sort(),
    });

    if (primaryTopicId == null && String(item.id) === String(best.id)) {
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
    mode: primaryIsMulti ? "event" : "market",
    keyword: best.keyword || null,
    matchedKeywords: Array.from(best.matchedSignals || best.matchedKeywords || []).sort(),
    title: primaryTitle || (primaryIsMulti ? "Event" : "Market"),
    markets,
    primaryUrl,
  };
}

function findMoreMenuButton(articleEl) {
  const buttons = articleEl.querySelectorAll(SELECTORS.moreMenuButton);
  for (const btn of buttons) {
    if (btn.closest(SELECTORS.article) === articleEl) return btn;
  }

  const icons = articleEl.querySelectorAll(SELECTORS.moreMenuIcon);
  for (const icon of icons) {
    const btn = icon.closest('button, div[role="button"]');
    if (btn && btn.closest(SELECTORS.article) === articleEl) return btn;
  }

  const ariaButtons = articleEl.querySelectorAll(SELECTORS.moreMenuAriaButton);
  for (const btn of ariaButtons) {
    const label = String(btn.getAttribute("aria-label") || "").trim().toLowerCase();
    if (!label) continue;

    // Keep the match broad enough for i18n, but narrow enough to avoid picking share/bookmark menus.
    const looksLikeMore =
      label.includes("more") ||
      label.includes("more options") ||
      label.includes("more actions") ||
      label.includes("更多");
    const looksLikeShare = label.includes("share") || label.includes("分享");
    if (!looksLikeMore || looksLikeShare) continue;

    if (btn.closest(SELECTORS.article) === articleEl) return btn;
  }

  return null;
}

function findIconInArticle(articleEl) {
  const icons = articleEl.querySelectorAll(`div[${ICON_ATTR}]`);
  for (const icon of icons) {
    if (icon.closest(SELECTORS.article) === articleEl) return icon;
  }
  return null;
}

function isIconPlacedNextToMoreButton(articleEl) {
  const icon = findIconInArticle(articleEl);
  if (!icon) return false;
  const moreBtn = findMoreMenuButton(articleEl);
  if (!moreBtn) return false;
  return moreBtn.previousElementSibling === icon;
}

function attachIconToArticle(articleEl, match) {
  if (state.invalidated) return;

  const moreBtn = findMoreMenuButton(articleEl);
  if (!moreBtn?.parentElement) {
    const existingIcon = findIconInArticle(articleEl);
    if (existingIcon) {
      try {
        removeHud();
      } catch {
        // ignore
      }
      existingIcon.remove();
    }
    return;
  }

  // Check if icon already exists
  let icon = findIconInArticle(articleEl);
  if (!icon) {
    icon = createIcon();
  }

  icon.style.marginLeft = "0";
  moreBtn.insertAdjacentElement("beforebegin", icon);

  // Click to toggle HUD
  icon.onclick = (e) => {
    try {
      e.stopPropagation();
      if (state.activeHud) {
        removeHud();
      } else {
        renderHud(icon, match, articleEl);
      }
    } catch (err) {
      if (!handleInvalidation(err)) throw err;
    }
  };

  // Also support hover
  icon.onmouseenter = () => {
    try {
      if (state.hoverTimer) window.clearTimeout(state.hoverTimer);
      if (!state.activeHud) {
        state.hoverTimer = window.setTimeout(() => renderHud(icon, match, articleEl), HOVER_DELAY_MS);
      }
    } catch (err) {
      if (!handleInvalidation(err)) throw err;
    }
  };
  icon.onmouseleave = () => {
    if (state.hoverTimer) window.clearTimeout(state.hoverTimer);
    state.hoverTimer = null;
  };
}

function findRootArticleForTweetText(tweetTextEl) {
  let articleEl = tweetTextEl.closest(SELECTORS.article);
  if (!articleEl) return null;

  // Quote-retweets contain a nested <article> for the quoted tweet. We want the outer one
  // so we can show a single icon for the whole timeline item (main text + quoted text).
  while (true) {
    const parentArticle = articleEl.parentElement?.closest(SELECTORS.article) || null;
    if (!parentArticle) break;
    articleEl = parentArticle;
  }
  return articleEl;
}

function scanArticleNode(articleEl) {
  if (state.invalidated) return;
  if (!(articleEl instanceof HTMLElement)) return;

  if (articleEl.getAttribute(ARTICLE_SCANNED_ATTR) === "true") {
    if (isIconPlacedNextToMoreButton(articleEl)) {
      return;
    }
    articleEl.removeAttribute(ARTICLE_SCANNED_ATTR);
  }

  articleEl.setAttribute(ARTICLE_SCANNED_ATTR, "true");

  const tweetTextNodes = Array.from(articleEl.querySelectorAll(SELECTORS.tweetText));
  const parts = [];
  for (const el of tweetTextNodes) {
    if (!(el instanceof HTMLElement)) continue;
    const t = el.innerText || el.textContent || "";
    const normalized = String(t || "").trim();
    if (normalized) parts.push(normalized);
  }

  const combinedText = parts.join("\n");
  const match = computeMatchForTweetText(combinedText);
  if (!match) return;
  attachIconToArticle(articleEl, match);
}

function scanTweetTextNode(tweetTextEl) {
  if (state.invalidated) return;
  if (!(tweetTextEl instanceof HTMLElement)) return;
  if (tweetTextEl.getAttribute(SCANNED_ATTR) === "true") {
    const articleEl = findRootArticleForTweetText(tweetTextEl);
    if (articleEl && isIconPlacedNextToMoreButton(articleEl)) {
      return;
    }
    tweetTextEl.removeAttribute(SCANNED_ATTR);
  }
  tweetTextEl.setAttribute(SCANNED_ATTR, "true");

  const rootArticle = findRootArticleForTweetText(tweetTextEl);
  if (!rootArticle) return;
  scanArticleNode(rootArticle);
}

function scanAll() {
  if (state.invalidated) return;
  const nodes = document.querySelectorAll(SELECTORS.tweetText);
  for (const node of nodes) scanTweetTextNode(node);
}

async function loadDataFromStorage() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.cachedData);
    const data = result[STORAGE_KEYS.cachedData];
    if (!data) return null;
    return data;
  } catch (err) {
    if (handleInvalidation(err)) return null;
    throw err;
  }
}

async function ensureData() {
  try {
    const data = await loadDataFromStorage();
    if (data) return data;

    try {
      const resp = await chrome.runtime.sendMessage({ type: "opinionHud.refresh" });
      if (resp?.ok) return await loadDataFromStorage();
    } catch (err) {
      if (handleInvalidation(err)) return null;
      // ignore refresh failures
    }
    return null;
  } catch (err) {
    if (handleInvalidation(err)) return null;
    throw err;
  }
}

function debouncedScanAll() {
  if (state.scanDebounceTimer) {
    clearTimeout(state.scanDebounceTimer);
  }
  state.scanDebounceTimer = setTimeout(() => {
    state.scanDebounceTimer = null;
    try {
      scanAll();
    } catch (err) {
      if (!handleInvalidation(err)) throw err;
    }
  }, SCAN_DEBOUNCE_MS);
}

function startObserver() {
  if (state.invalidated) return;
  if (state.observer) state.observer.disconnect();
  state.observer = new MutationObserver(debouncedScanAll);
  state.observer.observe(document.body, { childList: true, subtree: true });
}

async function main() {
  try {
    state.data = await ensureData();
    if (!state.data || state.invalidated) return;
    state.matcher = buildMatcher(state.data);
    startObserver();
    scanAll();
  } catch (err) {
    if (!handleInvalidation(err)) throw err;
  }
}

main();
