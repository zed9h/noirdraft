import { normalizeVisibleRootText } from '../project/projection.js';

export async function hashStory(story) {
  const bytes = new TextEncoder().encode(normalizeVisibleRootText(story));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
