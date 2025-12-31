/**
 * Opinion HUD - Options Page
 * Uses shared matcher logic from matcher.js (loaded via OpinionMatcher global)
 */

const STORAGE_KEYS = {
  cachedData: "opinionHudData",
};

// Get shared matcher functions
if (!window.OpinionMatcher) {
  console.error('[OpinionHUD] matcher.js not loaded');
}
const {
  buildMatcher,
  computeTopMatchesForText,
  clamp01,
} = window.OpinionMatcher || {};

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  $("status").textContent = text || "";
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

      const lines = [];
      lines.push(`Mode: ${top.mode}`);
      lines.push(`TopN: ${topN}  Threshold: ${threshold}`);
      if (typeof top.candidates === "number") lines.push(`Candidates scanned: ${top.candidates}`);
      lines.push("");

      for (const r of top.results) {
        const pass = r.score >= threshold ? "PASS" : "----";
        lines.push(`${pass}  Score: ${r.score.toFixed(2)}  Keyword: ${r.keyword}`);
        if (Array.isArray(r.matchedKeywords) && r.matchedKeywords.length) {
          lines.push(`Matched: ${r.matchedKeywords.join(", ")}`);
        }
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
          if (Array.isArray(r.matchedKeywords) && r.matchedKeywords.length) {
            lines.push(`    Matched: ${r.matchedKeywords.join(", ")}`);
          }
        } else {
          notMatched++;
          lines.push(`  ✗ NO MATCH`);
          if (top.results && top.results.length > 0) {
            const r = top.results[0];
            lines.push(`    Best candidate (${r.score.toFixed(2)}): ${r.title}`);
            lines.push(`    Keyword: ${r.keyword} | Reason: ${r.reasons.join(", ")}`);
            if (Array.isArray(r.matchedKeywords) && r.matchedKeywords.length) {
              lines.push(`    Matched: ${r.matchedKeywords.join(", ")}`);
            }
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
