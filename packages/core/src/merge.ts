import { diff3Merge } from 'node-diff3';
import { splitLinesKeepEnds } from './text.ts';

export interface ConflictHunk {
  base: string;
  ours: string;
  theirs: string;
}

export type MergeOutcome =
  | { clean: true; text: string }
  | { clean: false; regions: Array<{ ok: string } | { conflict: ConflictHunk }> };

/**
 * Line-based three-way merge. Identical changes on both sides are not conflicts. When a conflict
 * remains, the caller must keep both revisions and ask the user — never pick a side silently.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeOutcome {
  if (ours === theirs) return { clean: true, text: ours };
  if (base === ours) return { clean: true, text: theirs };
  if (base === theirs) return { clean: true, text: ours };

  const regions = diff3Merge<string>(
    splitLinesKeepEnds(ours),
    splitLinesKeepEnds(base),
    splitLinesKeepEnds(theirs),
    { excludeFalseConflicts: true },
  );

  const out: Array<{ ok: string } | { conflict: ConflictHunk }> = [];
  let clean = true;
  for (const region of regions) {
    if (region.ok) {
      out.push({ ok: region.ok.join('') });
    } else if (region.conflict) {
      clean = false;
      out.push({
        conflict: {
          ours: region.conflict.a.join(''),
          base: region.conflict.o.join(''),
          theirs: region.conflict.b.join(''),
        },
      });
    }
  }

  if (clean) return { clean: true, text: out.map((r) => ('ok' in r ? r.ok : '')).join('') };
  return { clean: false, regions: out };
}
