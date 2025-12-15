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

function scoreEntry({ raw, plain, tokens }, entry) {
  const reasons = [];
  let score = 0;

  const keywordPlain = entry.keywordPlain || "";
  const keywordTokens = entry.keywordTokens || [];

  if (keywordPlain && plain.includes(keywordPlain)) {
    score += 0.85;
    reasons.push(`phrase:${keywordPlain}`);
    score += Math.min(0.1, keywordPlain.length / 120);
  } else if (keywordTokens.length >= 2 && keywordTokens.length <= 3) {
    let present = 0;
    for (const t of keywordTokens) {
      if (tokens.has(t)) present += 1;
    }

    if (present === keywordTokens.length) {
      const near = tokensNear(plain, keywordTokens);
      score += near ? 0.7 : 0.45;
      reasons.push("tokens:all");
      if (near) reasons.push("near");
    } else if (present >= 2) {
      score += 0.35;
      reasons.push(`tokens:${present}/${keywordTokens.length}`);
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
  if (!plain) return { ok: true, matched: false, reason: "empty_text" };

  const candidates = [];
  for (const t of tokens) {
    const list = matcher.firstTokenMap.get(t);
    if (list) candidates.push(...list);
  }

  const targetBest = new Map();
  const tokenized = { raw: normalizeText(text), plain, tokens };

  for (const entry of candidates) {
    const keyword = entry.keyword;
    if (!keyword || keyword.length < 2) continue;

    const { score, reasons } = scoreEntry(tokenized, entry);

    if (matcher.mode === "event") {
      for (const id of entry.eventIds || []) {
        const eventId = String(id);
        const existing = targetBest.get(eventId);
        if (!existing || score > existing.score) {
          targetBest.set(eventId, { score, keyword: entry.keywordPlain || keyword, reasons, entry, eventId });
        }
      }
    } else {
      for (const id of entry.marketIds || []) {
        const marketId = String(id);
        const existing = targetBest.get(marketId);
        if (!existing || score > existing.score) {
          targetBest.set(marketId, { score, keyword: entry.keywordPlain || keyword, reasons, entry, marketId });
        }
      }
    }
  }

  if (targetBest.size === 0) return { ok: true, matched: false, reason: "no_candidates" };

  const ranked = Array.from(targetBest.values()).sort((a, b) => b.score - a.score).slice(0, topN);

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
  const top = computeTopMatchesForText(data, matcher, text, { topN: 1, threshold: 0.3 });
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
});
