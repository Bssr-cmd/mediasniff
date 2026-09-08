# MediaSniff Download Routing & Architecture Specification

This document specifies the routing decision tree, error classification model, and security policies for media download pipelines in MediaSniff.

---

## 1. Routing Decision Matrix

When a user initiates a download via the MediaSniff UI, the background Service Worker routes the job according to stream characteristics, authentication status, and native host availability:

```text
Incoming Download Request (START_DOWNLOAD)
  │
  ├─► Is YouTube / yt-dlp?
  │     ├─► Native Host Available?
  │     │     ├─► YES: Native yt-dlp Pipeline
  │     │     │        • Delegates netscape session cookies
  │     │     │        • Passes User-Agent & Referer
  │     │     │        • Downloads & muxes losslessly to ~/Downloads
  │     │     │        • If native fails mid-stream ──► In-Browser Offscreen Fallback
  │     │     │
  │     │     └─► NO: In-Browser YouTube Pipeline (offscreen.js)
  │     │              • Innertube / Invidious API audio+video fetch
  │     │              • In-browser WASM muxer / segment stitcher
  │     │
  ├─► Is Authenticated / Native-Required HLS or DASH?
  │   (item.needsAuth || item.requiresNative || options.useNative)
  │     ├─► Native Host Available?
  │     │     ├─► YES: Native yt-dlp Manifest Streamer
  │     │     │        • Passes delegated authentication cookies/tokens
  │     │     │        • Transmuxes native segments directly to disk
  │     │     │        • If native fails mid-stream ──► In-Browser Offscreen Fallback
  │     │     │
  │     │     └─► NO: In-Browser Stream Pipeline (offscreen.js)
  │     │              • In-browser segment downloader + transmuxer
  │     │
  ├─► Is Public / Simple HLS or DASH?
  │     └─► In-Browser Stream Pipeline (offscreen.js)
  │              • Default in-browser pipeline
  │              • Fetches chunks via fetch() and transmuxes in WASM
  │              • Zero native dependencies required
  │
  └─► Is Direct File (MP4, WebM, MP3, etc.)?
        └─► Chrome Downloads API (chrome.downloads.download())
                 • Standard browser download manager
```

---

## 2. Duplicate Fallback Prevention

To eliminate race conditions and prevent duplicate download tasks:
1. `service-worker.js` maintains an in-memory `fallbackTracker = Set<itemId>`.
2. When a native download failure is caught, `triggerBrowserFallback(itemId)` checks `fallbackTracker`.
3. If `itemId` is already in `fallbackTracker`, the fallback request is ignored.
4. Once in-browser fallback starts, popup UI listeners display active progress without re-issuing `START_DOWNLOAD`.
5. Upon completion, failure, or cancellation, `fallbackTracker.delete(itemId)` safely frees the lock.

---

## 3. Failure Classification (`ERROR_TYPE`)

All download failures across both native and browser pipelines are classified into standardized error codes:

| Error Code | Detection Criteria | User Message |
| :--- | :--- | :--- |
| `NATIVE_UNAVAILABLE` | Host not found, host disconnected, pipe broken | "Native companion app is not installed or not running." |
| `PERMISSION_DENIED` | `nativeMessaging` permission rejected | "Native messaging permission not granted." |
| `AUTH_FAILURE` | HTTP 401, 403, "forbidden", "unauthorized", expired token | "Authentication failed or stream requires active login." |
| `DRM_PROTECTED` | Widevine, PlayReady, FairPlay, SAMPLE-AES | "Media stream is encrypted or DRM-protected." |
| `NETWORK_ERROR` | Connection timed out, `net::ERR_*`, DNS failure | "Network connection error or request timed out." |
| `CANCELLED` | Aborted by user via `CANCEL_DOWNLOAD` | "Download was cancelled by user." |
| `UNKNOWN` | Unhandled parser or container exceptions | Standard error message string |

---

## 4. Security & Cookie Isolation Policy

* **Least Privilege**: The `cookies` permission is used strictly for on-demand delegation during active native downloads (`chrome.cookies.getAll`).
* **Zero Persistence**: Cookies are never written to `chrome.storage`, never exposed to popup scripts, and never passed to content scripts.
* **Ephemeral Lifecycle**: In `coapp.py`, delegated cookies are written to a temporary file (`ms_cookies_<uuid>.txt`) with restrictive permissions, used by `yt-dlp --cookies`, and unlinked immediately in a `finally:` block upon completion, failure, or termination.
* **Log Redaction**: `coapp.log` utilizes `sanitize_for_log()`, replacing sensitive headers, auth tokens, and cookies with `<N bytes redacted>`.
