const DEFAULT_DATA_URL = null;
const STORAGE_KEYS = {
  settings: "opinionHudSettings",
  cachedData: "opinionHudData",
  cachedAt: "opinionHudDataCachedAt",
};

const ALARM_NAME = "opinionHudRefresh";
const REFRESH_MINUTES = 60;

function normalizeDataUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  return trimmed;
}

async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const settings = result[STORAGE_KEYS.settings] || {};
  return {
    dataUrl: normalizeDataUrl(settings.dataUrl ?? DEFAULT_DATA_URL),
  };
}

function originFor(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function ensureHostPermissionFor(url) {
  const origin = originFor(url);
  if (!origin) return false;
  const pattern = `${origin}/*`;
  const already = await chrome.permissions.contains({ origins: [pattern] });
  return already;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`data fetch failed: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

function isValidDataShape(data) {
  if (!data || typeof data !== "object") return false;
  if (!data.meta || typeof data.meta !== "object") return false;
  if (!data.markets || typeof data.markets !== "object") return false;
  if (!data.index || typeof data.index !== "object") return false;
  return true;
}

async function refreshData({ force = false } = {}) {
  const { dataUrl } = await getSettings();
  if (!dataUrl) {
    if (force) {
      throw new Error("No dataUrl configured. Set it in extension options.");
    }
    return { ok: false, reason: "no_data_url" };
  }

  const hasPermission = await ensureHostPermissionFor(dataUrl);
  if (!hasPermission) {
    if (force) {
      throw new Error(
        "Host permission not granted for dataUrl origin. Open extension options and click Refresh to grant it."
      );
    }
    return { ok: false, reason: "permission_required" };
  }

  const data = await fetchJson(dataUrl);
  if (!isValidDataShape(data)) {
    throw new Error("Invalid data.json shape (expected meta/markets/index).");
  }

  const cached = await chrome.storage.local.get(STORAGE_KEYS.cachedData);
  const old = cached[STORAGE_KEYS.cachedData];

  const oldVersion = old?.meta?.version ?? old?.meta?.generatedAt ?? null;
  const newVersion = data?.meta?.version ?? data?.meta?.generatedAt ?? null;
  if (!force && oldVersion && newVersion && String(oldVersion) === String(newVersion)) {
    return { ok: true, updated: false, version: newVersion };
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.cachedData]: data,
    [STORAGE_KEYS.cachedAt]: Date.now(),
  });

  return { ok: true, updated: true, version: newVersion };
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_MINUTES });
  try {
    await refreshData({ force: false });
  } catch {
    // Fail silently; content script will still run with empty cache.
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  try {
    await refreshData({ force: false });
  } catch {
    // Silent refresh failure.
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "opinionHud.refresh") {
    refreshData({ force: true })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "opinionHud.getSettings") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});
