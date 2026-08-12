/** Fixtures for the GIP pay-gap steps. */

export interface GipStep {
  value: number | null;
  population: number | null;
}

/** An empty step 2, used when the GIP has no pay-gap data to prefill. */
export function nullGipStep2(): GipStep {
  return { value: null, population: null };
}

/** An empty step 3, built on top of step 2. */
export function nullGipStep3(): GipStep {
  return { ...nullGipStep2() };
}
