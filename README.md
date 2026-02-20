# Miniflux Read Marker

Small Firefox extension for Miniflux.

It checks the current page URL against your Miniflux entries, updates the toolbar icon for match status, and lets you toggle read/unread from the pop-up.

## Install (temporary)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `manifest.json` from this folder.

## Settings

Open extension preferences and set:

- Miniflux base URL
- API token

Other settings:

- Auto-mark on open
- Fallback scan depth
- Blocked domains

## Matching flow

1. Search by URL.
2. Try feed-specific lookup.
3. Fallback scan (`unread`, then `read`) with configured depth.
