/* global browser */

(function initReadToast() {
  if (window.__minifluxReadMarkerToastInitialized) return;
  window.__minifluxReadMarkerToastInitialized = true;

  function isIOS() {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const isIPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    return /iPhone|iPad|iPod/i.test(ua) || isIPadOS;
  }

  if (!isIOS()) return;

  function getBrowser() {
    if (typeof browser !== "undefined") return browser;
    if (typeof chrome !== "undefined") return chrome;
    return null;
  }

  const api = getBrowser();
  if (!api || !api.runtime || !api.runtime.onMessage) return;

  let toastDiv = null;
  let toastText = null;
  let dismissTimer = null;

  function ensureToast() {
    if (toastDiv) return;

    toastDiv = document.createElement("div");
    toastDiv.id = "miniflux-read-marker-toast";
    toastDiv.setAttribute("aria-live", "polite");
    toastDiv.style.position = "fixed";
    toastDiv.style.left = "50%";
    toastDiv.style.bottom = "max(14px, env(safe-area-inset-bottom))";
    toastDiv.style.transform = "translateX(-50%) translateY(12px)";
    toastDiv.style.maxWidth = "min(88vw, 420px)";
    toastDiv.style.padding = "10px 14px";
    toastDiv.style.borderRadius = "10px";
    toastDiv.style.background = "rgba(24, 28, 36, 0.92)";
    toastDiv.style.color = "#f5f7fb";
    toastDiv.style.fontSize = "13px";
    toastDiv.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    toastDiv.style.lineHeight = "1.35";
    toastDiv.style.textAlign = "center";
    toastDiv.style.boxShadow = "0 8px 26px rgba(0, 0, 0, 0.24)";
    toastDiv.style.zIndex = "2147483647";
    toastDiv.style.opacity = "0";
    toastDiv.style.pointerEvents = "auto";
    toastDiv.style.cursor = "pointer";
    toastDiv.style.transition = "opacity 160ms ease, transform 160ms ease";

    toastText = document.createElement("span");
    toastDiv.appendChild(toastText);

    const parent = document.documentElement || document.body;
    if (!parent) return;
    parent.appendChild(toastDiv);

    toastDiv.addEventListener("click", () => {
      api.runtime.sendMessage({ type: "openActionPopup" }).catch(() => {});
    });
  }

  function showToast(message) {
    ensureToast();
    if (!toastDiv || !toastText) return;

    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }

    toastText.textContent = message || "Marked as read in Miniflux";
    toastDiv.style.opacity = "1";
    toastDiv.style.transform = "translateX(-50%) translateY(0)";

    dismissTimer = setTimeout(() => {
      toastDiv.style.opacity = "0";
      toastDiv.style.transform = "translateX(-50%) translateY(12px)";
      dismissTimer = null;
    }, 5000);
  }

  api.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "showToast") return;
    showToast(message.text);
  });
})();
