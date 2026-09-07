// Shared by the compiler-oracle tests and live MCP measurements. Resolve paths
// against the entire repository BEFORE grading; a suffix with two candidates
// is not evidence for either file.
export function pathsIn(text, knownFiles) {
  const out = new Set();
  for (const match of text.matchAll(/[\w./@\[\]$+~-]+\.[A-Za-z]{1,8}\b/g)) {
    const candidate = match[0].replace(/^\.\//, "");
    if (knownFiles.has(candidate)) out.add(candidate);
    else {
      const matches = [...knownFiles].filter((f) => candidate.endsWith(`/${f}`) || f.endsWith(`/${candidate}`));
      if (matches.length === 1) out.add(matches[0]);
    }
  }
  return [...out].sort();
}

export function gradeFiles(expected, actual) {
  const wanted = new Set(expected);
  const got = new Set(actual);
  const hits = [...got].filter((f) => wanted.has(f)).length;
  const precision = got.size ? hits / got.size : 0;
  const recall = wanted.size ? hits / wanted.size : (got.size ? 0 : 1);
  const grade = !got.size ? "empty" : !hits ? "wrong"
    : hits === wanted.size && hits === got.size ? "correct" : "incomplete";
  return { grade, precision, recall, hits, returned: got.size, expected: wanted.size };
}

export function gradeAnswer(expected, filesInAnswer) {
  return gradeFiles([expected], filesInAnswer).grade;
}
