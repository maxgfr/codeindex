// Append-only record of who did what. Never mutated, only appended, so it can
// back an investigation after the fact.
/** One immutable audit entry. */
export interface Entry {
  actor: string;
  action: string;
  at: number;
}

/** Append an entry to the trail. */
export function record(trail: Entry[], actor: string, action: string): Entry[] {
  return [...trail, { actor, action, at: trail.length }];
}
