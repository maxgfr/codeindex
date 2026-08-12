/** Maps a GIP row onto the declaration form, step by step. */

export interface GipRow {
  step1: number | null;
  step2: number | null;
}

/** Reads the GIP row and returns null when a step carries no value. */
export function mapGipToForm(row: GipRow): GipRow {
  return { step1: row.step1 ?? null, step2: row.step2 ?? null };
}
