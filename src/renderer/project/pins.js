import { resolveHeadingPath } from './headings.js';
import { readApplicationList, writeApplicationList } from './application.js';

export function readPins(metadata) {
  return readApplicationList(metadata, 'Context');
}

export function writePins(metadata, pins) {
  return writeApplicationList(metadata, 'Context', [...new Set(pins.map(String))]);
}

export function resolvePins(metadata, documents) {
  return readPins(metadata).map((path) => resolveHeadingPath(documents, path));
}
