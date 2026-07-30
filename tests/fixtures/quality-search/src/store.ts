// Read-through memoisation in front of the slow store, with a TTL so stale
// entries expire instead of pinning memory forever.
/** A read-through cache with per-entry expiry. */
export class Memo<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  /** Fetch from the cache, falling back to `load` on a miss or an expired entry. */
  get(key: string, load: () => T, ttlMs: number): T {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > 0) return hit.value;
    const value = load();
    this.entries.set(key, { value, expiresAt: ttlMs });
    return value;
  }

  /** Drop every entry — used when the upstream schema changes. */
  purge(): void {
    this.entries.clear();
  }
}
