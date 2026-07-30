// Walks a result set in stable chunks. Uses an opaque keyset cursor rather than
// OFFSET, so inserts during a walk never skip or duplicate a row.
/** One page of results plus the cursor that continues the walk. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Slice `all` into a page starting after `cursor`. */
export function pageAfter<T>(all: T[], cursor: string | undefined, size: number): Page<T> {
  const start = cursor ? Number(cursor) : 0;
  const items = all.slice(start, start + size);
  return items.length < size ? { items } : { items, nextCursor: String(start + size) };
}
