/* global browser */

function getBrowser() {
  if (typeof browser !== "undefined") return browser;
  if (typeof chrome !== "undefined") return chrome;
  throw new Error("No browser API available");
}

const api = getBrowser();

const subtitleEl = document.getElementById("subtitle");
const entrySection = document.getElementById("entry");
const emptySection = document.getElementById("empty");
const missingSection = document.getElementById("missing");
const entryTitleEl = document.getElementById("entry-title");
const entryUrlEl = document.getElementById("entry-url");
const entryStatusEl = document.getElementById("entry-status");
const markReadButton = document.getElementById("mark-read");
const forceRefreshButton = document.getElementById("force-refresh");
const toggleDomainButton = document.getElementById("toggle-domain");
const openSettingsButton = document.getElementById("open-settings");
const entryActionsEl = document.getElementById("entry-actions");

let currentTabId = null;
let currentEntryId = null;
let currentHost = null;
let isBlockedHost = false;

function show(el) {
  el.classList.remove("hidden");
}

function hide(el) {
  el.classList.add("hidden");
}

function setStatus(text) {
  subtitleEl.textContent = text;
}

function setMarkReadButton(status) {
  markReadButton.disabled = false;
  markReadButton.textContent = status === "read" ? "Mark Unread" : "Mark Read";
}

function disableMarkReadButton() {
  currentEntryId = null;
  markReadButton.disabled = true;
  markReadButton.textContent = "Mark Read";
}

function showEntryActions(visible) {
  if (!entryActionsEl) return;
  entryActionsEl.style.display = visible ? "grid" : "none";
}

function showStateSection(section) {
  hide(entrySection);
  hide(emptySection);
  hide(missingSection);
  show(section);
}

function showNonMatchState(statusText, section) {
  setStatus(statusText);
  showStateSection(section);
  showEntryActions(false);
  disableMarkReadButton();
}

async function getBlockedDomains() {
  const settings = await api.storage.local.get({ blockedDomains: [] });
  if (!Array.isArray(settings.blockedDomains)) {
    return [];
  }

  return settings.blockedDomains
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function setEntry(entry, status) {
  entryTitleEl.textContent = entry.title || "(Untitled entry)";
  entryUrlEl.textContent = entry.url || "";
  entryStatusEl.textContent = status === "read" ? "Status: read" : "Status: unread";

  currentEntryId = entry.id;
  setMarkReadButton(status);
}

async function loadState() {
  forceRefreshButton.disabled = true;
  forceRefreshButton.classList.add("hidden");
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus("No active tab.");
    return;
  }

  currentTabId = tab.id;
  try {
    const tabUrl = new URL(tab.url || "");
    currentHost = tabUrl.hostname.replace(/^www\./i, "").toLowerCase();
  } catch (err) {
    currentHost = null;
  }
  const debugSettings = await api.storage.local.get({ debugEnabled: false });
  const showForceRefresh = Boolean(debugSettings.debugEnabled);
  if (showForceRefresh) {
    forceRefreshButton.classList.remove("hidden");
  }

  await updateDomainToggle();
  showEntryActions(false);
  if (isBlockedHost) {
    showNonMatchState("Disabled for this domain.", missingSection);
    forceRefreshButton.disabled = true;
    return;
  }

  forceRefreshButton.disabled = !showForceRefresh;
  const response = await api.runtime.sendMessage({
    type: "getTabState",
    tabId: tab.id
  });

  if (!response || response.missingSettings) {
    showNonMatchState("Missing settings.", missingSection);
    return;
  }

  if (!response.state) {
    showNonMatchState("No match found.", emptySection);
    return;
  }

  const { entry, status } = response.state;
  if (!entry) {
    showNonMatchState("No match found.", emptySection);
    return;
  }

  setStatus("Match found.");
  showStateSection(entrySection);
  showEntryActions(true);
  setEntry(entry, status || "read");
}

async function updateDomainToggle() {
  if (!currentHost) {
    toggleDomainButton.disabled = true;
    toggleDomainButton.textContent = "Disable for domain";
    isBlockedHost = false;
    return;
  }
  const blocked = await getBlockedDomains();
  const isBlocked = blocked.includes(currentHost);
  isBlockedHost = isBlocked;
  toggleDomainButton.disabled = false;
  toggleDomainButton.textContent = isBlocked
    ? `Enable for ${currentHost}`
    : `Disable for ${currentHost}`;
}

toggleDomainButton.addEventListener("click", async () => {
  if (!currentHost) return;
  const blocked = await getBlockedDomains();
  const isBlocked = blocked.includes(currentHost);
  const next = isBlocked
    ? blocked.filter((entry) => entry !== currentHost)
    : blocked.concat(currentHost);
  await api.storage.local.set({ blockedDomains: next });
  await updateDomainToggle();
  loadState();
});

forceRefreshButton.addEventListener("click", async () => {
  if (currentTabId === null) return;
  forceRefreshButton.disabled = true;
  const originalText = forceRefreshButton.textContent;
  forceRefreshButton.textContent = "Looking up…";
  setStatus("Running full refresh…");

  try {
    await api.runtime.sendMessage({
      type: "forceRefresh",
      tabId: currentTabId
    });
  } finally {
    forceRefreshButton.textContent = originalText;
    await loadState();
  }
});

markReadButton.addEventListener("click", async () => {
  if (!currentEntryId || currentTabId === null) return;
  markReadButton.disabled = true;
  markReadButton.textContent = "Updating…";

  try {
    const desiredStatus =
      entryStatusEl.textContent === "Status: read" ? "unread" : "read";

    const response = await api.runtime.sendMessage({
      type: "markRead",
      tabId: currentTabId,
      entryId: currentEntryId,
      status: desiredStatus
    });

    if (response && response.ok) {
      entryStatusEl.textContent =
        desiredStatus === "read" ? "Status: read" : "Status: unread";
      setMarkReadButton(desiredStatus);
      return;
    }

    setMarkReadButton("unread");
  } catch (err) {
    setMarkReadButton("unread");
  }
});

openSettingsButton.addEventListener("click", () => {
  if (api.runtime && typeof api.runtime.openOptionsPage === "function") {
    api.runtime.openOptionsPage();
  }
});

window.addEventListener("load", () => {
  document.body.classList.remove("preload");
  loadState();
});
