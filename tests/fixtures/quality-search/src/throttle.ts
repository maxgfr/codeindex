// Protects downstreams from stampedes: a token bucket per client key, refilled
// at a steady rate. Requests beyond the burst allowance are shed.
/** A token bucket that refills at `ratePerSecond`. */
export class Bucket {
  private tokens: number;

  constructor(
    private readonly capacity: number,
    private readonly ratePerSecond: number,
  ) {
    this.tokens = capacity;
  }

  /** Consume one token; false when the caller must be shed. */
  take(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
