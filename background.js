/* global browser */

const ACTION_ICONS = {
  default: {
    16: "icons/icon-default.svg",
    32: "icons/icon-default.svg"
  },
  active: {
    16: "icons/icon-active.svg",
    32: "icons/icon-active.svg"
  },
  unread: {
    16: "icons/icon-unread.svg",
    32: "icons/icon-unread.svg"
  }
};

const CHECK_DEBOUNCE_MS = 250;
const FALLBACK_PAGE_SIZE = 100;

const pendingChecks = new Map();
const tabStates = new Map();
const urlCache = new Map();
const SESSION_CACHE_TTL_MISS_MS = 5 * 60 * 1000;
const feedCache = new Map();
const FEED_CACHE_TTL_MS = 10 * 60 * 1000;

function getBrowser() {
  if (typeof browser !== "undefined") return browser;
  if (typeof chrome !== "undefined") return chrome;
  throw new Error("No browser API available");
}

const api = getBrowser();

async function getSettings() {
  const settings = await api.storage.local.get({
    baseUrl: "",
    apiToken: "",
    debugEnabled: false,
    cacheMissesEnabled: true,
    autoMarkEnabled: true,
    fallbackDepth: 10,
    blockedDomains: []
  });
  return {
    baseUrl: settings.baseUrl.trim(),
    apiToken: settings.apiToken.trim(),
    debugEnabled: Boolean(settings.debugEnabled),
    cacheMissesEnabled: Boolean(settings.cacheMissesEnabled),
    autoMarkEnabled: Boolean(settings.autoMarkEnabled),
    fallbackDepth: Number.isNaN(Number(settings.fallbackDepth))
      ? 10
      : Number(settings.fallbackDepth),
    blockedDomains: Array.isArray(settings.blockedDomains)
      ? settings.blockedDomains.map((entry) => String(entry).toLowerCase())
      : []
  };
}

function logDebug(enabled, message, extra) {
  if (!enabled) return;
  if (typeof extra === "undefined") {
    console.debug(`[Miniflux Read Marker] ${message}`);
  } else {
    console.debug(`[Miniflux Read Marker] ${message}`, extra);
  }
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return "";
  try {
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    return url.toString();
  } catch (err) {
    return "";
  }
}

function joinUrl(baseUrl, pathWithQuery) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (!normalizedBase) return "";
  return new URL(pathWithQuery.replace(/^\//, ""), normalizedBase).toString();
}

function isHttpUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (err) {
    return false;
  }
}

async function minifluxRequest(baseUrl, apiToken, pathWithQuery, options = {}, debugEnabled = false) {
  const url = joinUrl(baseUrl, pathWithQuery);
  if (!url) {
    throw new Error("Invalid base URL");
  }

  const headers = new Headers(options.headers || {});
  headers.set("X-Auth-Token", apiToken);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const method = options.method || "GET";
  logDebug(debugEnabled, "Miniflux request", {
    method,
    url,
    body: options.body || null
  });

  const response = await fetch(url, {
    ...options,
    headers
  });

  logDebug(debugEnabled, "Miniflux response", {
    url,
    status: response.status
  });

  return response;
}

function normalizeEntryUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    let pathname = url.pathname;
    if (pathname.endsWith("/") && pathname !== "/") {
      pathname = pathname.replace(/\/+$/, "");
    }
    const hostname = url.hostname.replace(/^www\./i, "");
    return `${hostname}${pathname}`;
  } catch (err) {
    return value;
  }
}

function matchesEntryUrl(entry, pageUrl) {
  if (!entry || !entry.url) return false;
  const normalizedEntry = normalizeEntryUrl(entry.url);
  const normalizedPage = normalizeEntryUrl(pageUrl);
  return normalizedEntry === normalizedPage;
}

function getHostKey(urlString) {
  try {
    const url = new URL(urlString);
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch (err) {
    return "";
  }
}

function getPathname(urlString) {
  try {
    const url = new URL(urlString);
    return url.pathname || "/";
  } catch (err) {
    return "/";
  }
}

function isBlockedDomain(urlString, blockedDomains) {
  if (!blockedDomains || blockedDomains.length === 0) return false;
  const host = getHostKey(urlString);
  if (!host) return false;
  return blockedDomains.includes(host);
}

function isRootPageUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.pathname === "/" || url.pathname === "";
  } catch (err) {
    return false;
  }
}

async function getFeeds(baseUrl, apiToken, debugEnabled) {
  const cached = feedCache.get(baseUrl);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.feeds;
  }

  const response = await minifluxRequest(baseUrl, apiToken, "/v1/feeds", {}, debugEnabled);
  if (!response.ok) {
    throw new Error(`Feeds request failed with status ${response.status}`);
  }
  const feeds = await response.json();
  if (!Array.isArray(feeds)) {
    throw new Error("Feeds response is not an array");
  }
  feedCache.set(baseUrl, { feeds, expiresAt: Date.now() + FEED_CACHE_TTL_MS });
  return feeds;
}

function getCandidateFeedIds(feeds, pageUrl) {
  const pageHost = getHostKey(pageUrl);
  if (!pageHost) return [];
  const pagePath = getPathname(pageUrl);

  return feeds
    .map((feed) => {
      const siteUrl = feed.site_url || "";
      const host = getHostKey(siteUrl);
      if (!host) return null;
      const hostMatches = pageHost === host || pageHost.endsWith(`.${host}`);
      if (!hostMatches) return null;
      const feedPath = getPathname(siteUrl);
      const pathScore = pagePath.startsWith(feedPath) ? feedPath.length : 0;
      return { id: feed.id, pathScore };
    })
    .filter(Boolean)
    .sort((a, b) => b.pathScore - a.pathScore)
    .map((item) => item.id);
}

function getCacheKey(url) {
  return normalizeEntryUrl(url);
}

function getCachedState(url) {
  const key = getCacheKey(url);
  const cached = urlCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    urlCache.delete(key);
    return null;
  }
  return cached.state;
}

function setCachedState(url, state) {
  const key = getCacheKey(url);
  urlCache.set(key, { state, expiresAt: Date.now() + SESSION_CACHE_TTL_MISS_MS });
}

const SEARCH_LIMIT_GLOBAL = 20;
const SEARCH_LIMIT_FEED = 50;

function getEntriesPath(feedId) {
  if (typeof feedId === "number") {
    return `/v1/feeds/${feedId}/entries`;
  }
  return "/v1/entries";
}

function getSearchLimit(feedId) {
  return typeof feedId === "number" ? SEARCH_LIMIT_FEED : SEARCH_LIMIT_GLOBAL;
}

async function searchEntriesWithServer(
  baseUrl,
  apiToken,
  feedId,
  status,
  pageUrl,
  debugEnabled
) {
  const params = new URLSearchParams({
    limit: String(getSearchLimit(feedId)),
    search: pageUrl
  });

  if (status) {
    params.set("status", status);
  }

  const response = await minifluxRequest(
    baseUrl,
    apiToken,
    `${getEntriesPath(feedId)}?${params.toString()}`,
    {},
    debugEnabled
  );

  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.entries)) return null;

  logDebug(debugEnabled, typeof feedId === "number" ? "Feed search results" : "Search results", {
    feedId,
    status,
    count: payload.entries.length,
    urls: payload.entries.map((item) => item.url)
  });

  const entry = payload.entries.find((item) => matchesEntryUrl(item, pageUrl));
  return entry || null;
}

async function searchEntriesWithFallback(
  baseUrl,
  apiToken,
  feedId,
  status,
  pageUrl,
  debugEnabled,
  fallbackDepth
) {
  if (!status) {
    return null;
  }

  let offset = 0;
  const pageLimit = typeof fallbackDepth === "number" ? fallbackDepth : 1;
  let page = 0;

  while (pageLimit === 0 || page < pageLimit) {
    const params = new URLSearchParams({
      status,
      limit: String(FALLBACK_PAGE_SIZE),
      offset: String(offset)
    });

    const response = await minifluxRequest(
      baseUrl,
      apiToken,
      `${getEntriesPath(feedId)}?${params.toString()}`,
      {},
      debugEnabled
    );

    if (!response.ok) {
      throw new Error(`List request failed with status ${response.status}`);
    }

    const payload = await response.json();
    if (!payload || !Array.isArray(payload.entries) || payload.entries.length === 0) {
      return null;
    }

    logDebug(
      debugEnabled,
      typeof feedId === "number" ? "Feed fallback page results" : "Fallback page results",
      {
        feedId,
        status,
        offset,
        count: payload.entries.length
      }
    );

    const entry = payload.entries.find((item) => matchesEntryUrl(item, pageUrl));
    if (entry) return entry;

    offset += payload.entries.length;
    if (payload.entries.length < FALLBACK_PAGE_SIZE) {
      return null;
    }

    page += 1;
  }

  return null;
}

async function findEntry(baseUrl, apiToken, feedId, status, pageUrl, debugEnabled, fallbackDepth) {
  try {
    const entry = await searchEntriesWithServer(
      baseUrl,
      apiToken,
      feedId,
      status,
      pageUrl,
      debugEnabled
    );
    if (entry) return entry;
    logDebug(debugEnabled, "Search returned no matches, falling back", { feedId, status });
    return await searchEntriesWithFallback(
      baseUrl,
      apiToken,
      feedId,
      status,
      pageUrl,
      debugEnabled,
      fallbackDepth
    );
  } catch (err) {
    logDebug(debugEnabled, "Search failed, falling back", err);
    return await searchEntriesWithFallback(
      baseUrl,
      apiToken,
      feedId,
      status,
      pageUrl,
      debugEnabled,
      fallbackDepth
    );
  }
}

async function setEntryStatus(baseUrl, apiToken, entryId, status, debugEnabled) {
  const response = await minifluxRequest(
    baseUrl,
    apiToken,
    "/v1/entries",
    {
      method: "PUT",
      body: JSON.stringify({
        entry_ids: [entryId],
        status
      })
    },
    debugEnabled
  );

  return response.ok;
}

async function setActionState(tabId, state) {
  const actionApi = api.action || api.browserAction;
  if (!actionApi) return;
  if (state === "unread") {
    await actionApi.setIcon({ tabId, path: ACTION_ICONS.unread });
    await actionApi.setBadgeText({ tabId, text: "●" });
    await actionApi.setBadgeBackgroundColor({ tabId, color: "#c07a2b" });
    await actionApi.setTitle({ tabId, title: "Miniflux entry unread" });
    return;
  }

  if (state === "active") {
    await actionApi.setIcon({ tabId, path: ACTION_ICONS.active });
    await actionApi.setBadgeText({ tabId, text: "✓" });
    await actionApi.setBadgeBackgroundColor({ tabId, color: "#2a7a2e" });
    await actionApi.setTitle({ tabId, title: "Miniflux entry found" });
    return;
  }

  await actionApi.setIcon({ tabId, path: ACTION_ICONS.default });
  await actionApi.setBadgeText({ tabId, text: "" });
  await actionApi.setTitle({ tabId, title: "Miniflux Read Marker" });
}

async function showReadToast(tabId, debugEnabled) {
  if (typeof tabId !== "number") return;
  try {
    await api.tabs.sendMessage(tabId, {
      type: "showToast",
      text: "Marked as read in Miniflux"
    });
  } catch (err) {
    logDebug(debugEnabled, "Toast not shown for tab", { tabId, err: String(err) });
  }
}

async function resetTabState(tabId, url, cacheMissesEnabled) {
  tabStates.delete(tabId);
  if (cacheMissesEnabled && url) {
    setCachedState(url, "miss");
  }
  await setActionState(tabId, "default");
}

async function applyMatchedEntryState(
  tabId,
  entry,
  normalizedBase,
  apiToken,
  autoMarkEnabled,
  debugEnabled
) {
  let status = entry.status === "unread" ? "unread" : "read";
  if (status === "unread" && autoMarkEnabled) {
    const marked = await setEntryStatus(normalizedBase, apiToken, entry.id, "read", debugEnabled);
    if (marked) {
      status = "read";
      await showReadToast(tabId, debugEnabled);
      logDebug(debugEnabled, "Auto-marked entry as read", entry.id);
    }
  }

  tabStates.set(tabId, { entry, status });
  await setActionState(tabId, status === "unread" ? "unread" : "active");
}

async function findEntryByStatuses(
  normalizedBase,
  apiToken,
  feedId,
  statuses,
  url,
  debugEnabled,
  depth
) {
  for (const status of statuses) {
    const entry = await findEntry(
      normalizedBase,
      apiToken,
      feedId,
      status,
      url,
      debugEnabled,
      depth
    );
    if (entry) {
      return entry;
    }
  }
  return null;
}

async function findEntryInFeedCandidates(normalizedBase, apiToken, url, debugEnabled, depth) {
  try {
    const feeds = await getFeeds(normalizedBase, apiToken, debugEnabled);
    const feedIds = getCandidateFeedIds(feeds, url);
    if (feedIds.length > 0) {
      logDebug(debugEnabled, "Matched feed candidates", feedIds);
    }

    for (const feedId of feedIds) {
      const entry = await findEntryByStatuses(
        normalizedBase,
        apiToken,
        feedId,
        [null, "unread", "read"],
        url,
        debugEnabled,
        depth
      );
      if (entry) {
        return { entry, hadCandidates: true };
      }
    }

    return { entry: null, hadCandidates: feedIds.length > 0 };
  } catch (err) {
    logDebug(debugEnabled, "Feed lookup failed, falling back to global", err);
  }

  return { entry: null, hadCandidates: false };
}

async function checkTab(tabId, url, options = {}) {
  const {
    baseUrl,
    apiToken,
    debugEnabled,
    cacheMissesEnabled,
    autoMarkEnabled,
    fallbackDepth: configuredFallbackDepth,
    blockedDomains
  } = await getSettings();

  const depth =
    typeof options.fallbackDepthOverride === "number"
      ? options.fallbackDepthOverride
      : configuredFallbackDepth;

  logDebug(debugEnabled, "Checking tab URL", { tabId, url });

  if (!baseUrl || !apiToken) {
    logDebug(debugEnabled, "Missing base URL or API token");
    await resetTabState(tabId);
    return;
  }

  if (!isHttpUrl(url)) {
    logDebug(debugEnabled, "URL is not http/https", url);
    await resetTabState(tabId);
    return;
  }

  if (isBlockedDomain(url, blockedDomains)) {
    logDebug(debugEnabled, "Domain is blocked", url);
    await resetTabState(tabId);
    return;
  }

  if (isRootPageUrl(url)) {
    logDebug(debugEnabled, "Skipping root page URL", url);
    await resetTabState(tabId);
    return;
  }

  if (cacheMissesEnabled && getCachedState(url) === "miss") {
    logDebug(debugEnabled, "Using cached miss");
    await resetTabState(tabId);
    return;
  }

  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (!normalizedBase) {
    logDebug(debugEnabled, "Base URL is invalid", baseUrl);
    await resetTabState(tabId);
    return;
  }

  try {
    // const anyEntry = await findEntryByStatuses(
    //   normalizedBase,
    //   apiToken,
    //   null,
    //   [null],
    //   url,
    //   debugEnabled,
    //   depth
    // );
    // if (anyEntry) {
    //   logDebug(debugEnabled, "Found entry", anyEntry);
    //   await applyMatchedEntryState(
    //     tabId,
    //     anyEntry,
    //     normalizedBase,
    //     apiToken,
    //     autoMarkEnabled,
    //     debugEnabled
    //   );
    //   return;
    // }

    // logDebug(debugEnabled, "Search returned no matches, trying feed-specific lookup");
    const feedLookup = await findEntryInFeedCandidates(
      normalizedBase,
      apiToken,
      url,
      debugEnabled,
      depth
    );
    if (feedLookup.entry) {
      logDebug(debugEnabled, "Found entry in feed", feedLookup.entry);
      await applyMatchedEntryState(
        tabId,
        feedLookup.entry,
        normalizedBase,
        apiToken,
        autoMarkEnabled,
        debugEnabled
      );
      return;
    }

    if (!feedLookup.hadCandidates) {
      logDebug(debugEnabled, "No matching feed candidates, skipping fallback search");
      await resetTabState(tabId, url, cacheMissesEnabled);
      return;
    }

    logDebug(debugEnabled, "Feed lookup failed to match, falling back to recent entries");
    const fallbackEntry = await findEntryByStatuses(
      normalizedBase,
      apiToken,
      null,
      ["unread", "read"],
      url,
      debugEnabled,
      depth
    );
    if (fallbackEntry) {
      logDebug(debugEnabled, "Found entry (fallback)", fallbackEntry);
      await applyMatchedEntryState(
        tabId,
        fallbackEntry,
        normalizedBase,
        apiToken,
        autoMarkEnabled,
        debugEnabled
      );
      return;
    }
  } catch (err) {
    logDebug(debugEnabled, "Miniflux API error", err);
  }

  await resetTabState(tabId, url, cacheMissesEnabled);
}
function queueTabCheck(tabId, url) {
  if (!tabId || !url) return;

  if (pendingChecks.has(tabId)) {
    clearTimeout(pendingChecks.get(tabId));
  }

  const timeout = setTimeout(() => {
    pendingChecks.delete(tabId);
    checkTab(tabId, url);
  }, CHECK_DEBOUNCE_MS);

  pendingChecks.set(tabId, timeout);
}

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab || !tab.url) return;
  queueTabCheck(tabId, tab.url);
});

// Only check on page load/refresh (onUpdated with status "complete").

api.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

api.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") return;
  if (
    !changes.baseUrl &&
    !changes.apiToken &&
    !changes.cacheMissesEnabled &&
    !changes.fallbackDepth &&
    !changes.autoMarkEnabled &&
    !changes.blockedDomains
  )
    return;

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  urlCache.clear();
  feedCache.clear();
  queueTabCheck(tab.id, tab.url);
});

api.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "getTabState") {
    return (async () => {
      const tabId = message.tabId;
      const { baseUrl, apiToken } = await getSettings();
      if (!baseUrl || !apiToken) {
        return { state: null, missingSettings: true };
      }
      const state = tabStates.get(tabId) || null;
      return { state, missingSettings: false };
    })();
  }

  if (message.type === "markRead") {
    return (async () => {
      const tabId = message.tabId;
      const entryId = message.entryId;
      const targetStatus = message.status || "read";
      const { baseUrl, apiToken, debugEnabled } = await getSettings();
      if (!baseUrl || !apiToken) {
        return { ok: false, error: "Missing settings" };
      }
      const normalizedBase = normalizeBaseUrl(baseUrl);
      if (!normalizedBase) {
        return { ok: false, error: "Invalid base URL" };
      }
      const ok = await setEntryStatus(
        normalizedBase,
        apiToken,
        entryId,
        targetStatus,
        debugEnabled
      );
      if (ok) {
        const existing = tabStates.get(tabId);
        if (existing && existing.entry && existing.entry.id === entryId) {
          tabStates.set(tabId, { entry: existing.entry, status: targetStatus });
        }
        if (targetStatus === "read") {
          await showReadToast(tabId, debugEnabled);
        }
        await setActionState(tabId, targetStatus === "unread" ? "unread" : "active");
        return { ok: true };
      }
      return { ok: false, error: "Failed to mark read" };
    })();
  }

  if (message.type === "forceRefresh") {
    return (async () => {
      const tabId = message.tabId;
      if (typeof tabId !== "number") {
        return { ok: false, error: "Invalid tab id" };
      }

      try {
        const tab = await api.tabs.get(tabId);
        if (!tab || !tab.url) {
          tabStates.delete(tabId);
          await setActionState(tabId, "default");
          return { ok: false, error: "Tab URL unavailable" };
        }

        if (pendingChecks.has(tabId)) {
          clearTimeout(pendingChecks.get(tabId));
          pendingChecks.delete(tabId);
        }

        await checkTab(tabId, tab.url, { fallbackDepthOverride: 0 });
        return { ok: true, state: tabStates.get(tabId) || null };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    })();
  }

  if (message.type === "openActionPopup") {
    return (async () => {
      const actionApi = api.action || api.browserAction;
      if (!actionApi || typeof actionApi.openPopup !== "function") {
        return { ok: false, error: "Popup API unavailable" };
      }

      try {
        if (sender && sender.tab && typeof sender.tab.windowId === "number") {
          await actionApi.openPopup({ windowId: sender.tab.windowId });
        } else {
          await actionApi.openPopup();
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    })();
  }

  return false;
});
