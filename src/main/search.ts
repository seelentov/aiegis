import type { SearchHit } from '../shared/types';

/**
 * Hits whose id, title, detail or location hold every word of the query (case-insensitive), best first: the id itself,
 * an id prefix, a title prefix, the phrase in the title, then a match anywhere. Equal ranks keep the order given.
 */
export function rankHits(hits: Iterable<SearchHit>, query: string, limit: number): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const phrase = words.join(' ');
  const scored: { hit: SearchHit; rank: number }[] = [];
  for (const hit of hits) {
    const id = hit.id.toLowerCase();
    const title = hit.title.toLowerCase();
    const loc = hit.location ? `${hit.location.file}:${hit.location.line ?? ''}` : '';
    const hay = `${id}\n${title}\n${hit.detail}\n${loc}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const rank = id === phrase ? 0 : id.startsWith(phrase) ? 1 : title.startsWith(phrase) ? 2 : title.includes(phrase) ? 3 : 4;
    scored.push({ hit, rank });
  }
  return scored
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((x) => x.hit);
}
