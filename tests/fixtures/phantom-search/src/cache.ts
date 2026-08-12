/** A tiny in-memory cache with an authentication-scoped key. */

export function cache<T>(key: string, value: T): Map<string, T> {
  return new Map([[key, value]]);
}

/** Builds the auth token used to scope a cache key to one principal. */
export function auth(principal: string): string {
  return `bearer:${principal}`;
}
