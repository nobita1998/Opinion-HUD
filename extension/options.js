const STORAGE_KEYS = {
  settings: "opinionHudSettings",
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
  const resp = await chrome.runtime.sendMessage({ type: "opinionHud.refresh" });
  if (!resp?.ok) {
    setStatus(`Refresh failed: ${resp?.error || "unknown error"}`);
    return;
  }
  const result = resp.result;
  setStatus(result.updated ? `Updated (version=${result.version}).` : `No change (version=${result.version}).`);
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  $("save").addEventListener("click", async () => {
    await save();
  });
  $("refresh").addEventListener("click", async () => {
    await refreshNow();
  });
});

