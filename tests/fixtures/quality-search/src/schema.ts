// Forward-only schema evolution. Each step is applied once, in order, and
// recorded, so a half-applied upgrade can be resumed rather than restarted.
/** One irreversible schema change. */
export interface Step {
  id: string;
  apply(): void;
}

/** Apply every step not yet recorded as done. */
export function upgrade(steps: Step[], done: Set<string>): string[] {
  const applied: string[] = [];
  for (const step of steps) {
    if (done.has(step.id)) continue;
    step.apply();
    applied.push(step.id);
  }
  return applied;
}
