// A faithful POSIX-only reimplementation of the `node:path` surface the engine
// actually imports: join, dirname, basename, extname, relative, resolve,
// isAbsolute, normalize, sep — plus a `posix` self-reference, because
// resolve.ts and modules.ts import `posix` by name and lean on its EXACT
// semantics for import resolution.
//
// Faithfulness is not optional here. `resolve.ts` runs every module specifier
// through `posix.normalize`, and its comment at line 123 depends on one precise
// behaviour: a ".." that escapes the root must SURVIVE as a leading "../"
// rather than being clamped away. Clamping it would silently resolve
// out-of-tree imports to in-tree files and poison the link-graph. So this file
// mirrors Node's algorithm (including its trailing-slash preservation) instead
// of approximating it.
//
// The browser build never sees a Windows path: every path in it is synthesised
// by the playground from a jsDelivr manifest, which is POSIX by construction.

export const sep = "/";
export const delimiter = ":";

// Node's internal normalizeString: resolve "." and ".." within a segment list.
// `allowAboveRoot` is false for absolute paths (where ".." above "/" vanishes)
// and true for relative ones (where it must be preserved).
function normalizeSegments(path: string, allowAboveRoot: boolean): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === 47) break;
    else code = 47;

    if (code === 47) {
      if (lastSlash === i - 1 || dots === 1) {
        // "//" or "/./" — nothing to add.
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex === -1) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? "/.." : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += "/" + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === 46 && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

// Node preserves a trailing slash: normalize("a/b/") === "a/b/". Callers in
// resolve.ts strip it themselves (`.replace(/\/$/, "")`), so reproducing the
// quirk keeps their code correct rather than merely working by accident.
export function normalize(path: string): string {
  if (path.length === 0) return ".";
  const isAbs = path.charCodeAt(0) === 47;
  const trailingSeparator = path.charCodeAt(path.length - 1) === 47;
  let out = normalizeSegments(path, !isAbs);
  if (out.length === 0 && !isAbs) out = ".";
  if (out.length > 0 && trailingSeparator) out += "/";
  return isAbs ? "/" + out : out;
}

export function isAbsolute(path: string): boolean {
  return path.length > 0 && path.charCodeAt(0) === 47;
}

export function join(...parts: string[]): string {
  if (parts.length === 0) return ".";
  let joined: string | undefined;
  for (const part of parts) {
    if (part.length > 0) joined = joined === undefined ? part : joined + "/" + part;
  }
  if (joined === undefined) return ".";
  return normalize(joined);
}

// There is no process.cwd() in a browser; the playground mounts every repo
// under an absolute root, so an unresolved relative path resolves against "/".
export function resolve(...parts: string[]): string {
  let resolved = "";
  let isAbs = false;
  for (let i = parts.length - 1; i >= 0 && !isAbs; i--) {
    const part = parts[i];
    if (part === undefined || part.length === 0) continue;
    resolved = resolved.length === 0 ? part : part + "/" + resolved;
    isAbs = part.charCodeAt(0) === 47;
  }
  if (!isAbs) resolved = resolved.length === 0 ? "/" : "/" + resolved;
  const out = normalizeSegments(resolved, false);
  return out.length > 0 ? "/" + out : "/";
}

export function relative(from: string, to: string): string {
  if (from === to) return "";
  const fromAbs = resolve(from);
  const toAbs = resolve(to);
  if (fromAbs === toAbs) return "";

  const fromParts = fromAbs.slice(1).split("/").filter(Boolean);
  const toParts = toAbs.slice(1).split("/").filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = new Array(fromParts.length - i).fill("..");
  return [...up, ...toParts.slice(i)].join("/");
}

export function dirname(path: string): string {
  if (path.length === 0) return ".";
  const hasRoot = path.charCodeAt(0) === 47;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}

export function basename(path: string, suffix?: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return "";
  const base = path.slice(start, end);
  if (suffix !== undefined && suffix !== base && base.endsWith(suffix)) {
    return base.slice(0, base.length - suffix.length);
  }
  return base;
}

// Node's rules, which are subtler than "text after the last dot": a leading dot
// is a dotfile (extname(".bashrc") === ""), and a bare trailing dot IS the
// extension (extname("a.") === ".").
export function extname(path: string): string {
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === 47) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === 46) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return "";
  }
  return path.slice(startDot, end);
}

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export function parse(path: string): ParsedPath {
  const root = isAbsolute(path) ? "/" : "";
  const base = basename(path);
  const ext = extname(path);
  const dir = dirname(path);
  return { root, dir: dir === "." && root === "" ? "" : dir, base, ext, name: base.slice(0, base.length - ext.length) };
}

export function format(parsed: Partial<ParsedPath>): string {
  const dir = parsed.dir || parsed.root || "";
  const base = parsed.base || (parsed.name ?? "") + (parsed.ext ?? "");
  if (!dir) return base;
  return dir === parsed.root ? dir + base : dir + "/" + base;
}

export function toNamespacedPath(path: string): string {
  return path;
}

// `import { posix } from "node:path"` must keep working: the same functions,
// reachable through the namespace the source already uses.
export const posix = {
  sep,
  delimiter,
  normalize,
  isAbsolute,
  join,
  resolve,
  relative,
  dirname,
  basename,
  extname,
  parse,
  format,
  toNamespacedPath,
};

export const win32 = posix;

export default { ...posix, posix, win32: posix };
