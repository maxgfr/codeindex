// The playground's UI thread: parse what the user typed, drive the worker, and
// render what comes back. No indexing happens here — that is all in worker.js,
// which is why the palette stays responsive while a repo is being pulled.

import { parseRepoInput } from "./sources.js";
import { toManifest } from "./local-folder.js";

const $ = (id) => document.getElementById(id);

const els = {
  form: $("load-form"),
  repo: $("repo"),
  loadBtn: $("load-btn"),
  status: $("status"),
  bar: $("bar"),
  barFill: $("bar").querySelector("i"),
  summary: $("summary"),
  stats: $("stats"),
  tags: $("tags"),
  capNote: $("cap-note"),
  consolePanel: $("console-panel"),
  folder: $("folder"),
  folderBtn: $("folder-btn"),
  cmd: $("cmd"),
  palette: $("palette"),
  paletteList: $("palette-list"),
  outHead: $("out-head"),
  outRan: $("out-ran"),
  outMeta: $("out-meta"),
  outBody: $("out-body"),
  copyBtn: $("copy-btn"),
  rawBtn: $("raw-btn"),
  envLine: $("env-line"),
};

let commands = [];
let selectedIndex = 0;
let lastResult = null;
let showRaw = false;
let requestId = 0;
let loaded = false;
let failed = false;

// ---------------------------------------------------------------------------
// Theme — same three-state toggle as the overview page.

const themeIcon = { system: "◐", light: "☀", dark: "☾" };
function applyTheme(mode) {
  if (mode === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
  $("theme-toggle-icon").textContent = themeIcon[mode];
  $("theme-toggle-label").textContent = mode;
  try {
    localStorage.setItem("codeindex-theme", mode);
  } catch {
    /* private mode — the toggle still works for this session */
  }
}
let theme = "system";
try {
  theme = localStorage.getItem("codeindex-theme") ?? "system";
} catch {
  /* ignore */
}
applyTheme(theme);
$("theme-toggle").addEventListener("click", () => {
  theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  applyTheme(theme);
});

// ---------------------------------------------------------------------------
// URL state: #/owner/repo@ref?cmd=…&files=…&mb=…
//
// Rewritten through one helper because every part of it is load-bearing: the
// repo makes the link shareable, cmd replays a session, and files/mb are the
// only way to bound a very large repository now that the caps are not on
// screen. Writing the hash by hand used to drop whichever params it did not
// happen to be setting.

const hashParams = () => new URLSearchParams(location.hash.split("?")[1] ?? "");
const hashRepo = () => location.hash.replace(/^#\/?/, "").split("?")[0];

function setHash({ repo = hashRepo(), cmd } = {}) {
  const params = hashParams();
  if (cmd !== undefined) params.set("cmd", cmd);
  const query = params.toString();
  location.hash = `#/${repo}${query ? `?${decodeURIComponent(query)}` : ""}`;
}

const positiveNumber = (raw) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

// ---------------------------------------------------------------------------
// Worker

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

worker.onmessage = (event) => {
  const message = event.data;
  if (message.type === "ready") {
    commands = message.commands;
    els.envLine.textContent = `engine v${message.engineVersion} · running in your browser`;
    renderPalette("");
  } else if (message.type === "progress") {
    // A load that has already reported an error is over, and its counter is
    // frozen wherever it stopped. Showing that counter again would paint over
    // the only explanation the user gets and leave the page looking busy
    // forever — which is exactly how a rate-limited 2,900-file repo used to
    // fail. The worker no longer emits progress past a failure (fetch-pool.js
    // drains every worker before rethrowing); this makes it unable to matter.
    if (failed) return;
    setStatus(message.detail);
    advanceBar(message.phase);
  } else if (message.type === "loaded") {
    onLoaded(message.summary);
  } else if (message.type === "result") {
    onResult(message);
  } else if (message.type === "error") {
    onError(message.message);
  }
};

worker.onerror = (event) => onError(event.message || "The engine worker failed to start.");

// ---------------------------------------------------------------------------
// Loading

const PHASE_PROGRESS = { manifest: 12, fetch: 55, grammars: 78, index: 92 };

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function advanceBar(phase) {
  els.bar.hidden = false;
  els.barFill.style.width = `${PHASE_PROGRESS[phase] ?? 5}%`;
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  startLoad(els.repo.value);
});

for (const button of document.querySelectorAll(".examples button")) {
  button.addEventListener("click", () => {
    els.repo.value = button.dataset.repo;
    startLoad(button.dataset.repo);
  });
}

// Opening a folder. `webkitdirectory` is the standard folder picker: the
// browser hands back every file under it, already carrying a size, and the
// files never leave the page — they are passed to the worker as File objects
// (structured-cloneable) and read there.
els.folderBtn.addEventListener("click", () => els.folder.click());
els.folder.addEventListener("change", () => {
  if (els.folder.files.length) startLocalLoad(els.folder.files);
  // Reset so picking the SAME folder twice fires `change` the second time too.
  els.folder.value = "";
});

/** Everything a load resets, whichever source it came from. */
function beginLoad() {
  loaded = false;
  failed = false;
  lastResult = null;
  els.summary.hidden = true;
  els.consolePanel.hidden = true;
  els.outHead.hidden = true;
  els.loadBtn.disabled = true;
  els.bar.hidden = false;
  els.barFill.style.width = "5%";
  setStatus("starting…");
}

// No cap by default: index the whole repository. That is also the engine's own
// default — walk() imposes no file-count limit unless a caller asks for one,
// and asking is what sets the `capped` flag. The URL keeps the escape hatch
// for a repository big enough to be worth bounding, without putting two
// number fields in front of everyone who just wants to try it.
const caps = () => ({
  maxFiles: positiveNumber(hashParams().get("files")),
  maxBytes: positiveNumber(hashParams().get("mb")) && positiveNumber(hashParams().get("mb")) * 1_000_000,
});

function startLoad(rawInput) {
  const target = parseRepoInput(rawInput);
  if (!target) {
    setStatus("Give a repository as owner/repo, owner/repo@branch, or a github.com URL.", true);
    return;
  }

  beginLoad();
  setHash({ repo: `${target.owner}/${target.repo}${target.ref ? `@${target.ref}` : ""}` });
  worker.postMessage({ type: "load", ...target, ...caps() });
}

function startLocalLoad(fileList) {
  let manifest;
  try {
    manifest = toManifest(fileList);
  } catch (error) {
    setStatus(String(error?.message ?? error), true);
    return;
  }

  beginLoad();
  els.repo.value = "";
  // A folder on this machine is not something a link can reopen, so the repo
  // slug comes out of the URL rather than being replaced by a name that would
  // send a reload off to fetch a GitHub repository that does not exist. The
  // cmd param stays: replaying a command against a freshly opened folder works.
  setHash({ repo: "" });
  worker.postMessage({ type: "loadLocal", name: manifest.name, files: manifest.files, ...caps() });
}

const int = (value) => Number(value ?? 0).toLocaleString();

function onLoaded(summary) {
  loaded = true;
  els.loadBtn.disabled = false;
  els.barFill.style.width = "100%";
  setStatus(`${summary.label} indexed in ${int(summary.elapsedMs)} ms`);
  setTimeout(() => {
    els.bar.hidden = true;
  }, 700);

  const topLanguages = Object.entries(summary.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  els.stats.innerHTML = [
    tile(int(summary.indexedFiles), "files indexed"),
    tile(int(summary.symbolCount), "symbol names"),
    tile(int(summary.edgeCount), "graph edges"),
    tile(int(summary.moduleCount), "modules"),
    tile(`${int(summary.elapsedMs)} ms`, "index time"),
    tile(`${(summary.residentBytes / 1e6).toFixed(1)} MB`, "source in memory"),
  ].join("");

  const grammars = summary.grammars;
  els.tags.innerHTML = [
    grammars.tier === "ast"
      ? tag("ok", `AST tier · ${grammars.loaded.join(", ")}`)
      : tag("warn", `regex tier${grammars.note ? ` · ${grammars.note}` : ""}`),
    summary.capped ? tag("warn", `capped by ${summary.cappedBy}`) : tag("ok", "capped: false"),
    ...topLanguages.map(([language, count]) => tag("", `${language} ${int(count)}`)),
  ].join("");

  const parts = [
    `File list via ${summary.sourceLabel}.`,
    `Walked ${int(summary.walkedFiles)} of ${int(summary.manifestFiles)} listed files; ${int(summary.excluded)} excluded by the engine's own rules (ignores, lockfiles, binaries, the 1 MiB cap).`,
  ];
  if (summary.providerNote) parts.push(summary.providerNote);
  if (summary.capped) {
    parts.push(
      `Your ${summary.cappedBy} stopped it short: ${int(summary.pruned)} more files were listed but not downloaded, so they are not in this index.`,
    );
  }
  if (summary.unreadable) {
    parts.push(`${int(summary.unreadable)} listed files could not be fetched and were dropped rather than indexed as empty.`);
  }
  if (grammars.failed?.length) parts.push(`Grammars that did not load: ${grammars.failed.join(", ")}.`);
  els.capNote.textContent = parts.join(" ");

  els.summary.hidden = false;
  els.consolePanel.hidden = false;
  els.cmd.focus();

  const fromUrl = hashParams().get("cmd");
  if (fromUrl) {
    els.cmd.value = fromUrl;
    submitCommand();
  }
}

// The overview page's stat tile: mono label above a large mono value.
const tile = (value, label) =>
  `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div></div>`;
const tag = (cls, label) => `<span class="pill ${cls}">${escapeHtml(label)}</span>`;

function onError(message) {
  els.loadBtn.disabled = false;
  els.bar.hidden = true;
  if (loaded) {
    // A command failed, not the load: keep the index and report it in the
    // output pane, where the user is looking.
    els.outHead.hidden = false;
    els.outMeta.textContent = "";
    els.outBody.innerHTML = `<p class="empty" style="color:var(--annotation)">${escapeHtml(message)}</p>`;
    return;
  }
  failed = true;
  setStatus(message, true);
}

// ---------------------------------------------------------------------------
// Command palette

function visibleCommands(query) {
  const term = query.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!term) return commands;
  return commands.filter((command) => command.name.includes(term) || command.describe.toLowerCase().includes(term));
}

function renderPalette(query) {
  const list = visibleCommands(query);
  selectedIndex = Math.min(selectedIndex, Math.max(0, list.length - 1));
  els.paletteList.innerHTML = list
    .map(
      (command, index) => `
      <li>
        <button type="button" data-name="${escapeHtml(command.name)}" ${command.unavailable ? "disabled" : ""}
                aria-selected="${index === selectedIndex}">
          <span class="name">${escapeHtml(command.name)} ${command.hint ? `<em>${escapeHtml(command.hint)}</em>` : ""}</span>
          <span class="desc">${escapeHtml(command.describe)}</span>
          ${command.unavailable ? `<span class="why">${escapeHtml(command.unavailable)}</span>` : ""}
        </button>
      </li>`,
    )
    .join("");

  for (const button of els.paletteList.querySelectorAll("button:not([disabled])")) {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const command = commands.find((c) => c.name === button.dataset.name);
      els.cmd.value = command.hint ? `${command.name} ` : command.name;
      els.cmd.focus();
      // A command that takes an argument leaves you in the input to type it,
      // with the list dismissed; one that does not just runs.
      if (command.hint) closePalette();
      else submitCommand();
    });
  }
}

const openPalette = () => {
  renderPalette(els.cmd.value);
  els.palette.hidden = false;
};
const closePalette = () => {
  els.palette.hidden = true;
};

els.cmd.addEventListener("focus", openPalette);
els.cmd.addEventListener("blur", () => setTimeout(closePalette, 120));
els.cmd.addEventListener("input", () => {
  selectedIndex = 0;
  // The palette exists to pick a COMMAND. Once there is a space in the input
  // the command is chosen and the rest is its argument, so the list gets out of
  // the way instead of hovering over the results while you type a query.
  if (els.cmd.value.includes(" ")) closePalette();
  else openPalette();
});

els.cmd.addEventListener("keydown", (event) => {
  const list = visibleCommands(els.cmd.value);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    selectedIndex = (selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + list.length) % Math.max(1, list.length);
    renderPalette(els.cmd.value);
  } else if (event.key === "Tab" && list[selectedIndex]) {
    event.preventDefault();
    const command = list[selectedIndex];
    els.cmd.value = command.hint ? `${command.name} ` : command.name;
    openPalette();
  } else if (event.key === "Enter") {
    event.preventDefault();
    closePalette();
    submitCommand();
  } else if (event.key === "Escape") {
    closePalette();
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    els.cmd.focus();
    els.cmd.select();
    openPalette();
  }
});

function submitCommand() {
  const raw = els.cmd.value.trim();
  if (!raw) return;
  // Always, whatever route got here — Enter, or a click in the palette. The
  // click path used to leave the list open on top of the result it had just
  // produced, because preventDefault() on mousedown suppresses the blur that
  // would otherwise have closed it.
  closePalette();
  const [name, ...rest] = raw.split(/\s+/);
  const args = raw.slice(name.length).trim();

  setHash({ cmd: raw });

  els.outHead.hidden = false;
  els.outRan.textContent = `${name}${rest.length ? ` ${args}` : ""}`;
  els.outMeta.textContent = "running…";
  worker.postMessage({ type: "run", id: ++requestId, command: name, args });
}

// ---------------------------------------------------------------------------
// Rendering

function onResult({ id, command, result }) {
  if (id !== requestId) return; // a later command already superseded this one
  lastResult = result;
  showRaw = false;
  els.rawBtn.setAttribute("aria-pressed", "false");
  els.outMeta.textContent = describeResult(result);
  els.outBody.innerHTML = "";
  els.outBody.append(renderResult(result, command));
  els.outBody.scrollTop = 0;
}

function describeResult(result) {
  const data = result.data;
  if (Array.isArray(data)) return `${int(data.length)} ${data.length === 1 ? "row" : "rows"}`;
  if (result.kind === "binary") return `${int(data.byteLength)} bytes`;
  if (typeof data === "string") return `${int(data.length)} chars`;
  return "";
}

function renderResult(result, command) {
  if (showRaw) return codeBlock(rawText(result));
  switch (result.kind) {
    case "hits":
      return renderHits(result.data);
    case "grep":
      return renderGrep(result.data);
    case "symbols":
      return renderSymbols(result.data);
    case "modules":
      return renderModules(result.data);
    case "text":
    case "mermaid":
      return codeBlock(result.data);
    case "download":
      return renderDownload([[result.filename, result.data]], result.data);
    case "artifacts":
      return renderDownload(Object.entries(result.data), Object.values(result.data)[0]);
    case "binary":
      return renderBinary(result);
    default:
      return codeBlock(JSON.stringify(result.data, null, 2));
  }
}

function table(headers, rows) {
  const element = document.createElement("table");
  element.className = "rows";
  element.innerHTML =
    `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows
      .map((row) => `<tr>${row.map(([value, cls]) => `<td class="${cls ?? ""}">${value}</td>`).join("")}</tr>`)
      .join("")}</tbody>`;
  return element;
}

function renderHits(hits) {
  if (!hits.length) return empty("No match.");
  return table(
    ["file", "score", "matched", "symbols"],
    hits.map((hit) => [
      [escapeHtml(hit.file) + (hit.line ? `<span class="num">:${hit.line}</span>` : ""), "path"],
      [hit.score, "num"],
      [(hit.matchedFields ?? hit.matchedTerms ?? []).map((f) => `<span class="kind">${escapeHtml(f)}</span>`).join(""), "fields"],
      [escapeHtml((hit.topSymbols ?? []).join(", ")), "sym"],
    ]),
  );
}

function renderGrep(hits) {
  if (!hits.length) return empty("No match.");
  return table(
    ["file", "line", "text"],
    hits.map((hit) => [
      [escapeHtml(hit.file ?? hit.rel ?? ""), "path"],
      [hit.line ?? "", "num"],
      [escapeHtml((hit.text ?? hit.preview ?? "").trim().slice(0, 220)), "snippet"],
    ]),
  );
}

function renderSymbols(symbols) {
  if (!symbols.length) return empty("No symbols.");
  return table(
    ["symbol", "kind", "line", "signature"],
    symbols.map((symbol) => [
      [escapeHtml(symbol.parent ? `${symbol.parent}.${symbol.name}` : symbol.name), "sym"],
      [`<span class="kind">${escapeHtml(symbol.kind ?? "")}</span>`, ""],
      [symbol.line ?? "", "num"],
      [escapeHtml((symbol.signature ?? symbol.doc ?? "").slice(0, 200)), "snippet"],
    ]),
  );
}

function renderModules(modules) {
  if (!modules.length) return empty("No modules.");
  return table(
    ["module", "files", "pagerank", "community"],
    [...modules]
      .sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0))
      .map((module) => [
        [escapeHtml(module.slug ?? module.path ?? ""), "path"],
        [module.files?.length ?? module.fileCount ?? "", "num"],
        [(module.pagerank ?? 0).toFixed?.(4) ?? "", "num"],
        [escapeHtml(String(module.community ?? "")), "num"],
      ]),
  );
}

function renderDownload(entries, preview) {
  const wrapper = document.createElement("div");
  const buttons = document.createElement("div");
  buttons.className = "downloads";
  for (const [filename, content] of entries) {
    const button = document.createElement("button");
    button.className = "btn btn-ghost";
    button.textContent = `Download ${filename} (${(content.length / 1024).toFixed(0)} KB)`;
    button.addEventListener("click", () => download(filename, new Blob([content], { type: "application/json" })));
    buttons.append(button);
  }
  wrapper.append(buttons, codeBlock(clip(preview, 8000)));
  return wrapper;
}

function renderBinary(result) {
  const wrapper = document.createElement("div");
  const button = document.createElement("button");
  button.className = "btn btn-ghost";
  button.style.margin = "1rem 1.2rem";
  button.textContent = `Download ${result.filename} (${int(result.data.byteLength)} bytes)`;
  button.addEventListener("click", () => download(result.filename, new Blob([result.data], { type: "application/octet-stream" })));
  wrapper.append(button, empty("A SCIP protobuf index — validate it with the official `scip` CLI: scip stats index.scip"));
  return wrapper;
}

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function codeBlock(text) {
  const pre = document.createElement("pre");
  pre.className = "code";
  pre.textContent = text ?? "";
  return pre;
}

function empty(message) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty";
  paragraph.textContent = message;
  return paragraph;
}

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}\n… (${int(text.length - limit)} more characters)` : text);

function rawText(result) {
  if (result.kind === "binary") return `<${int(result.data.byteLength)} bytes of protobuf>`;
  if (typeof result.data === "string") return result.data;
  return JSON.stringify(result.data, null, 2);
}

els.rawBtn.addEventListener("click", () => {
  if (!lastResult) return;
  showRaw = !showRaw;
  els.rawBtn.setAttribute("aria-pressed", String(showRaw));
  els.outBody.innerHTML = "";
  els.outBody.append(renderResult(lastResult));
});

els.copyBtn.addEventListener("click", async () => {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(rawText(lastResult));
    els.copyBtn.textContent = "Copied";
    setTimeout(() => (els.copyBtn.textContent = "Copy"), 1400);
  } catch {
    els.copyBtn.textContent = "Copy failed";
    setTimeout(() => (els.copyBtn.textContent = "Copy"), 1400);
  }
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

// ---------------------------------------------------------------------------
// Deep links: #/owner/repo@ref?cmd=search+foo replays a whole session.

const hashTarget = hashRepo();
if (hashTarget) {
  els.repo.value = hashTarget;
  startLoad(hashTarget);
}
