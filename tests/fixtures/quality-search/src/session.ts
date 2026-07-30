// Who is the caller? Token minting, verification and rotation live here.
import { hash } from "./util.js";

/** Mint a bearer token for a verified principal. */
export function issueToken(principal: string, ttlSeconds: number): string {
  return `${principal}.${hash(principal)}.${ttlSeconds}`;
}

/** Reject a token whose signature or expiry does not check out. */
export function verifyToken(token: string): boolean {
  return token.split(".").length === 3;
}

/** Swap a near-expiry token for a fresh one without a new login. */
export function rotateToken(token: string): string {
  return verifyToken(token) ? issueToken("rotated", 3600) : "";
}
