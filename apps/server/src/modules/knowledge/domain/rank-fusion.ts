export interface RankedHit {
  id: string;
  score: number;
}

export interface FusedHit {
  id: string;
  score: number;
  ranks: (number | null)[];
  scores: (number | null)[];
}

/**
 * Reciprocal Rank Fusion (Cormack et al., 2009): score(d) = Σ 1 / (k + rank_i(d)).
 *
 * Vector similarity and full-text rank live on different scales, so we fuse by *rank*
 * instead of normalising scores. k = 60 is the paper's default: it damps the influence of
 * the very top ranks so one list can't dominate.
 */
export function reciprocalRankFusion(lists: RankedHit[][], k = 60): FusedHit[] {
  const fused = new Map<string, FusedHit>();
  lists.forEach((list, listIndex) => {
    list.forEach((hit, position) => {
      const rank = position + 1;
      let entry = fused.get(hit.id);
      if (!entry) {
        entry = {
          id: hit.id,
          score: 0,
          ranks: lists.map(() => null),
          scores: lists.map(() => null),
        };
        fused.set(hit.id, entry);
      }
      entry.score += 1 / (k + rank);
      entry.ranks[listIndex] = rank;
      entry.scores[listIndex] = hit.score;
    });
  });
  return [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
