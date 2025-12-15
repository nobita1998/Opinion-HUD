const STORAGE_KEYS = {
  settings: "opinionHudSettings",
  cachedData: "opinionHudData",
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  $("status").textContent = text || "";
}

function normalizeUrl(url) {
  const trimmed = String(url || "").trim();
  return trimmed || null;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

function computeMatchForText(data, matcher, text) {
  const { s, tokens } = tokenize(text);
  if (!s) return { ok: true, matched: false, reason: "empty_text" };

  const candidates = [];
  for (const t of tokens) {
    const list = matcher.firstTokenMap.get(t);
    if (list) candidates.push(...list);
  }

  let best = null;
  for (const entry of candidates) {
    const keyword = entry.keyword;
    if (!keyword || keyword.length < 2) continue;
    if (!s.includes(keyword)) continue;
    const score = keyword.length;
    if (!best || score > best.score) best = { score, keyword, entry };
  }

  if (!best) return { ok: true, matched: false, reason: "no_keyword_match" };

  if (matcher.mode === "event") {
    const eventId = best.entry.eventIds?.[0] ? String(best.entry.eventIds[0]) : null;
    const event = eventId ? data.events?.[eventId] : null;
    if (!event) return { ok: true, matched: false, reason: "event_missing" };

    const marketIds = event.marketIds || [];
    const markets = marketIds
      .slice(0, 5)
      .map((id) => ({ id, ...data.markets?.[id] }))
      .filter((m) => m && m.title);
    const primaryId = event.bestMarketId || marketIds[0] || null;
    const primaryUrl = primaryId ? data.markets?.[primaryId]?.url : null;

    return {
      ok: true,
      matched: true,
      mode: "event",
      keyword: best.keyword,
      eventId,
      title: event.title,
      primaryUrl,
      markets,
    };
  }

  const marketId = best.entry.marketIds?.[0] ? String(best.entry.marketIds[0]) : null;
  const market = marketId ? data.markets?.[marketId] : null;
  if (!market) return { ok: true, matched: false, reason: "market_missing" };

  return {
    ok: true,
    matched: true,
    mode: "market",
    keyword: best.keyword,
    marketId,
    title: market.title,
    primaryUrl: market.url,
    markets: [{ id: marketId, ...market }],
  };
}

function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.origin}/*`;
  } catch {
    return null;
  }
}

async function ensurePermissionForDataUrl(dataUrl) {
  const pattern = originPatternFor(dataUrl);
  if (!pattern) throw new Error("Invalid Data URL.");

  const already = await chrome.permissions.contains({ origins: [pattern] });
  if (already) return true;

  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error("Permission request was denied.");
  return true;
}

async function load() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const settings = result[STORAGE_KEYS.settings] || {};
  $("dataUrl").value = settings.dataUrl || "";
}

async function save() {
  const dataUrl = normalizeUrl($("dataUrl").value);
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: { dataUrl },
  });
  setStatus("Saved.");
}

async function refreshNow() {
  setStatus("Refreshing...");
  try {
    const dataUrl = normalizeUrl($("dataUrl").value);
    if (!dataUrl) throw new Error("Set Data URL first.");
    await ensurePermissionForDataUrl(dataUrl);

    const resp = await chrome.runtime.sendMessage({ type: "opinionHud.refresh" });
    if (!resp?.ok) {
      setStatus(`Refresh failed: ${resp?.error || "unknown error"}`);
      return;
    }
    const result = resp.result;
    setStatus(result.updated ? `Updated (version=${result.version}).` : `No change (version=${result.version}).`);
  } catch (err) {
    setStatus(`Refresh failed: ${String(err?.message || err)}`);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  $("save").addEventListener("click", async () => {
    await save();
  });
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
      const match = computeMatchForText(data, matcher, text);
      if (!match.matched) {
        $("testResult").textContent = `No match (${match.reason}).`;
        return;
      }

      const lines = [];
      lines.push(`Matched keyword: ${match.keyword}`);
      lines.push(`Mode: ${match.mode}`);
      lines.push(`Title: ${match.title}`);
      if (match.primaryUrl) lines.push(`Trade URL: ${match.primaryUrl}`);
      lines.push("");
      lines.push("Markets:");
      for (const m of match.markets || []) {
        const yes = m.labels?.yesLabel || "YES";
        const no = m.labels?.noLabel || "NO";
        lines.push(`- ${m.id}: ${m.title} [${yes}/${no}]`);
      }
      $("testResult").textContent = lines.join("\n");
    } catch (err) {
      $("testResult").textContent = `Test failed: ${String(err?.message || err)}`;
    }
  });
});
