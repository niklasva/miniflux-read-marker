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
const toggleDomainButton = document.getElementById("toggle-domain");
const openSettingsButton = document.getElementById("open-settings");
const actionsEl = document.querySelector(".actions");
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

function setEntry(entry, status) {
  entryTitleEl.textContent = entry.title || "(Untitled entry)";
  entryUrlEl.textContent = entry.url || "";
  entryStatusEl.textContent = status === "read" ? "Status: read" : "Status: unread";

  currentEntryId = entry.id;
  if (status === "read") {
    markReadButton.disabled = false;
    markReadButton.textContent = "Mark Unread";
  } else {
    markReadButton.disabled = false;
    markReadButton.textContent = "Mark Read";
  }
}

async function loadState() {
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

  await updateDomainToggle();
  if (entryActionsEl) {
    entryActionsEl.style.display = "none";
  }
  if (isBlockedHost) {
    setStatus("Disabled for this domain.");
    hide(entrySection);
    hide(emptySection);
    show(missingSection);
    markReadButton.disabled = true;
    markReadButton.textContent = "Mark Read";
    return;
  }
  const response = await api.runtime.sendMessage({
    type: "getTabState",
    tabId: tab.id
  });

  if (!response || response.missingSettings) {
    setStatus("Missing settings.");
    hide(entrySection);
    hide(emptySection);
    show(missingSection);
    markReadButton.disabled = true;
    markReadButton.textContent = "Mark Read";
    return;
  }

  if (!response.state) {
    setStatus("No match found.");
    hide(entrySection);
    hide(missingSection);
    show(emptySection);
    markReadButton.disabled = true;
    markReadButton.textContent = "Mark Read";
    return;
  }

  const { entry, status } = response.state;
  if (!entry) {
    setStatus("No match found.");
    hide(entrySection);
    hide(missingSection);
    show(emptySection);
    markReadButton.disabled = true;
    return;
  }

  setStatus("Match found.");
  hide(emptySection);
  hide(missingSection);
  show(entrySection);
  if (entryActionsEl) {
    entryActionsEl.style.display = "grid";
  }
  setEntry(entry, status || "read");
}

async function updateDomainToggle() {
  if (!currentHost) {
    toggleDomainButton.disabled = true;
    toggleDomainButton.textContent = "Disable for domain";
    isBlockedHost = false;
    return;
  }
  const settings = await api.storage.local.get({ blockedDomains: [] });
  const blocked = Array.isArray(settings.blockedDomains)
    ? settings.blockedDomains.map((entry) => String(entry).toLowerCase())
    : [];
  const isBlocked = blocked.includes(currentHost);
  isBlockedHost = isBlocked;
  toggleDomainButton.disabled = false;
  toggleDomainButton.textContent = isBlocked
    ? `Enable for ${currentHost}`
    : `Disable for ${currentHost}`;
}

toggleDomainButton.addEventListener("click", async () => {
  if (!currentHost) return;
  const settings = await api.storage.local.get({ blockedDomains: [] });
  const blocked = Array.isArray(settings.blockedDomains)
    ? settings.blockedDomains.map((entry) => String(entry).toLowerCase())
    : [];
  const isBlocked = blocked.includes(currentHost);
  const next = isBlocked
    ? blocked.filter((entry) => entry !== currentHost)
    : blocked.concat(currentHost);
  await api.storage.local.set({ blockedDomains: next });
  await updateDomainToggle();
  loadState();
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
      markReadButton.textContent =
        desiredStatus === "read" ? "Mark Unread" : "Mark Read";
      markReadButton.disabled = false;
      return;
    }

    markReadButton.textContent = "Mark Read";
    markReadButton.disabled = false;
  } catch (err) {
    markReadButton.textContent = "Mark Read";
    markReadButton.disabled = false;
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
