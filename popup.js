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

let currentTabId = null;
let currentEntryId = null;

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
  setEntry(entry, status || "read");
}

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

loadState();
