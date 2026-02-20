/* global browser */

function getBrowser() {
  if (typeof browser !== "undefined") return browser;
  if (typeof chrome !== "undefined") return chrome;
  throw new Error("No browser API available");
}

const api = getBrowser();

const form = document.getElementById("settings-form");
const baseUrlInput = document.getElementById("base-url");
const apiTokenInput = document.getElementById("api-token");
const debugEnabledInput = document.getElementById("debug-enabled");
const cacheMissesEnabledInput = document.getElementById("cache-misses-enabled");
const fallbackDepthInput = document.getElementById("fallback-depth");
const statusEl = document.getElementById("status");

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "status error" : "status";
  if (message) {
    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "status";
    }, 2500);
  }
}

async function loadSettings() {
  const settings = await api.storage.local.get({
    baseUrl: "",
    apiToken: "",
    debugEnabled: false,
    cacheMissesEnabled: true,
    fallbackDepth: 10
  });

  baseUrlInput.value = settings.baseUrl || "";
  apiTokenInput.value = settings.apiToken || "";
  debugEnabledInput.checked = Boolean(settings.debugEnabled);
  cacheMissesEnabledInput.checked = Boolean(settings.cacheMissesEnabled);
  fallbackDepthInput.value = String(settings.fallbackDepth || 10);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const baseUrl = baseUrlInput.value.trim();
  const apiToken = apiTokenInput.value.trim();
  const debugEnabled = debugEnabledInput.checked;
  const cacheMissesEnabled = cacheMissesEnabledInput.checked;
  const fallbackDepth = Number.parseInt(fallbackDepthInput.value, 10);

  if (!baseUrl || !apiToken) {
    showStatus("Base URL and token are required.", true);
    return;
  }

  try {
    await api.storage.local.set({
      baseUrl,
      apiToken,
      debugEnabled,
      cacheMissesEnabled,
      fallbackDepth: Number.isNaN(fallbackDepth) ? 10 : fallbackDepth
    });
    showStatus("Saved.");
  } catch (err) {
    showStatus("Failed to save settings.", true);
  }
});

loadSettings();
