import { resolveHeadingPath } from './headings.js';
import { readApplicationList, readApplicationOrder, writeApplicationList } from './application.js';

export function readPins(metadata) {
  return readApplicationList(metadata, 'Context');
}

export function writePins(metadata, pins) {
  return writeApplicationList(metadata, 'Context', [...new Set(pins.map(String))]);
}

export function resolvePins(metadata, documents) {
  return readPins(metadata).map((path) => resolveHeadingPath(documents, path));
}

/** Pinned change/revision references, alongside section pins (`## Changes` under `# Application`). */
export function readChangePins(metadata) {
  return readApplicationList(metadata, 'Changes');
}

export function writeChangePins(metadata, pins) {
  return writeApplicationList(metadata, 'Changes', [...new Set(pins.map(String))]);
}

/**
 * The chat-history bucket is represented the same way, but holds at most one
 * marker rather than a list: either a recent-turn count (`"12"`) or a
 * pinned-turn id (`"turn:7"`). Absent, the caller's own default applies.
 */
export function readChatBucketMarker(metadata) {
  return readApplicationList(metadata, 'Chat')[0] ?? null;
}

export function writeChatBucketMarker(metadata, marker) {
  return writeApplicationList(metadata, 'Chat', marker == null ? [] : [String(marker)]);
}

/**
 * Priority order (highest first) of the three context buckets that can be
 * trimmed when a turn's composed context doesn't fit: pinned sections,
 * pinned changes, and chat history. Determined by the order their headings
 * appear under `# Application` in METADATA; reordering those headings
 * reorders this list. Buckets with no heading yet default to
 * Context, Changes, Chat.
 */
export function readBucketPriority(metadata) {
  return readApplicationOrder(metadata, ['Context', 'Changes', 'Chat']);
}
