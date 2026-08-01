// Where a repository's file list and file contents come from.
//
// The playground needs two things from a public repo: a manifest of paths WITH
// SIZES (so walk() can choose what is worth downloading before anything is
// downloaded), and a CORS-readable URL per file. Two providers can supply both,
// and they are not equivalent:
//
//   GitHub trees API + raw.githubusercontent.com — authoritative and current.
//     One `git/trees?recursive=1` call returns every blob with its size, and
//     raw serves contents with `access-control-allow-origin: *` outside the API
//     rate limit. Measured on t3-oss/create-t3-turbo: 141 blobs listed, 141
//     fetched, zero failures. The catch is 60 unauthenticated API calls per
//     hour per IP — one per repo load, but shared by everyone behind a NAT.
//
//   jsDelivr — unlimited and unauthenticated, but its branch manifest is a
//     SNAPSHOT rather than the branch head, and it can lag badly. Measured on
//     the same repo and commit: 125 files listed, 37 of which no longer exist
//     (confirmed 404 on raw too, so genuinely deleted, not a URL bug). Recent
//     additions are missing entirely.
//
// So GitHub is primary and jsDelivr is the fallback for when the API rate limit
// is exhausted — with `note` carrying the caveat so the page can say which one
// answered rather than quietly serving a stale index.
//
// GitHub's tarball is not an option at all: codeload.github.com replies
// `access-control-allow-origin: https://render.githubusercontent.com`, so a
// browser cannot read it, which is why this is file-by-file in the first place.

const GITHUB_API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const JSDELIVR_DATA = "https://data.jsdelivr.com/v1/packages/gh";
const JSDELIVR_CDN = "https://cdn.jsdelivr.net/gh";

/**
 * Encode a manifest path for use in a URL: each segment individually, so "/"
 * survives while brackets, spaces and other real-world characters do not break
 * the request (Next.js dynamic routes like `[...slug]` are ordinary in real
 * trees). Any leading slash is dropped so callers can join with exactly one.
 */
const encodePath = (path) =>
  path
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");

class RateLimited extends Error {}

async function githubTree(fetchImpl, owner, repo, ref) {
  const response = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (response.status === 403 || response.status === 429) throw new RateLimited("GitHub API rate limit reached");
  if (!response.ok) return null;

  const body = await response.json();
  if (!Array.isArray(body.tree)) return null;

  const files = body.tree.filter((entry) => entry.type === "blob").map((entry) => ({ path: `/${entry.path}`, size: entry.size ?? 0 }));
  return {
    provider: "github",
    ref,
    files,
    // `truncated` means the repo exceeded what one tree call can return. Said
    // out loud rather than silently indexing a partial tree.
    note: body.truncated ? "GitHub truncated the file list for this repository — it is too large to enumerate in one request." : "",
    contentUrl: (path) => `${RAW}/${owner}/${repo}/${encodeURIComponent(ref)}/${encodePath(path)}`,
  };
}

async function jsdelivrManifest(fetchImpl, owner, repo, ref) {
  const response = await fetchImpl(`${JSDELIVR_DATA}/${owner}/${repo}@${encodeURIComponent(ref)}?structure=flat`);
  if (response.status === 429) throw new RateLimited("jsDelivr is rate-limiting this browser");
  if (!response.ok) return null;

  const body = await response.json();
  if (!Array.isArray(body.files)) return null;

  return {
    provider: "jsdelivr",
    ref,
    files: body.files.map((file) => ({ path: file.name, size: file.size ?? 0 })),
    note: "File list from jsDelivr, which snapshots a branch rather than following its head — it can lag by a few commits.",
    contentUrl: (path) => `${JSDELIVR_CDN}/${owner}/${repo}@${encodeURIComponent(ref)}/${encodePath(path)}`,
  };
}

/**
 * Resolve a repository to a file manifest and a way to fetch each file.
 *
 * Tries each candidate ref against GitHub first, then the same refs against
 * jsDelivr. Ref candidates are `main` then `master` when none was given —
 * gin-gonic/gin is on master while pallets/flask is on main, so assuming either
 * one fails on a large share of real repositories.
 *
 * @returns {{provider, ref, files, note, contentUrl}}
 * @throws when no provider can answer, with a message naming what was tried
 */
export async function resolveSource(owner, repo, requestedRef, fetchImpl = fetch) {
  const refs = requestedRef ? [requestedRef] : ["main", "master"];
  let rateLimited = "";

  for (const provider of [githubTree, jsdelivrManifest]) {
    for (const ref of refs) {
      let resolved;
      try {
        resolved = await provider(fetchImpl, owner, repo, ref);
      } catch (error) {
        if (error instanceof RateLimited) {
          // Move to the next provider rather than the next ref: another ref on
          // the same provider will be rate-limited too.
          rateLimited = error.message;
          break;
        }
        throw error;
      }
      if (resolved?.files.length) {
        return rateLimited ? { ...resolved, note: [`${rateLimited}.`, resolved.note].filter(Boolean).join(" ") } : resolved;
      }
    }
  }

  const tried = requestedRef ? `@${requestedRef}` : " on main or master";
  throw new Error(
    `Could not read ${owner}/${repo}${tried}. Check the name and that the repository is public${
      requestedRef ? "" : ", or give the ref explicitly (owner/repo@branch)"
    }.`,
  );
}

/**
 * Accept the forms people actually paste: a bare slug, a slug with a ref, a
 * repository URL, or a deep link to a branch or file.
 */
export function parseRepoInput(raw) {
  const input = (raw ?? "").trim();
  if (!input) return null;

  const url = input.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/([^/\s#?]+))?/i);
  if (url) return { owner: url[1], repo: url[2].replace(/\.git$/, ""), ref: url[3] ?? "" };

  const slug = input.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@(.+))?$/);
  if (slug) return { owner: slug[1], repo: slug[2], ref: slug[3] ?? "" };

  return null;
}
