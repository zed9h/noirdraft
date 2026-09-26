// CSS Custom Highlight API names are global, but each editor contributes its
// own ranges. Keep every owner's ranges apart and publish their union, so one
// editor clearing its decoration never removes another's.
const rangesByName = new Map(); // name -> Map(owner -> Range[])

export function setHighlightRanges(owner, name, ranges, priority = 0) {
  if (!globalThis.CSS?.highlights) return;
  let owners = rangesByName.get(name);
  if (!owners) { owners = new Map(); rangesByName.set(name, owners); }
  if (ranges.length === 0) owners.delete(owner); else owners.set(owner, ranges);
  const all = [...owners.values()].flat();
  if (all.length === 0) { CSS.highlights.delete(name); return; }
  const highlight = new Highlight(...all);
  highlight.priority = priority;
  CSS.highlights.set(name, highlight);
}
