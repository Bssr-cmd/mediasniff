// shared/unified.js
// Adapter layer that receives unified protocol messages and updates the media registry.

import { MSG_TYPE, generateMediaId } from './protocol.js';

/**
 * Get the per‑tab media map, creating it if missing.
 */
function getTabMap(tabId, mediaRegistry) {
  let map = mediaRegistry.get(tabId);
  if (!map) {
    map = new Map();
    mediaRegistry.set(tabId, map);
  }
  return map;
}

/**
 * Merge incoming mediaInfo into an existing item or create a new one.
 */
function upsertMedia(tabId, mediaRegistry, mediaId, mediaInfo) {
  const tabMap = getTabMap(tabId, mediaRegistry);
  const existing = tabMap.get(mediaId);
  if (existing) {
    Object.assign(existing, mediaInfo);
    tabMap.set(mediaId, existing);
    return existing;
  }
  const newItem = { id: mediaId, ...mediaInfo };
  tabMap.set(mediaId, newItem);
  return newItem;
}

/**
 * Core entry point for the unified protocol.
 * @param {object} msg - Message adhering to the unified schema.
 * @param {number} tabId - Chrome tab identifier.
 * @param {Map} mediaRegistry - Global registry reference.
 */
export function handleUnifiedMessage(msg, tabId, mediaRegistry) {
  // Unified message handling disabled — detection is handled directly
  // by handleManifestDetected/handleDirectMedia in service-worker.js
  return;
}
