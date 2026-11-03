// Reading what herdr-telescope prints. This file imports nothing from Herdr, so
// test.sh can run it under node.

const SEPARATOR = "\x1f";

// The extensions syntect does not know, written as the language it does.
const LANGUAGES = {
  cjs: "js", cts: "js", jsonc: "json", jsx: "js", md: "markdown", mjs: "js", mts: "js",
  svelte: "html", toml: "yaml", ts: "js", tsx: "js", vue: "html",
};

export function languageOf(extension) {
  const name = extension.toLowerCase();
  return LANGUAGES[name] ?? name;
}

/** The results of a search, as { key, path, line, column, text }; line 0 means no position. */
export function parseResults(mode, stdout) {
  const rows = stdout.split("\n").filter(Boolean);
  if (mode === "files") return rows.map((path) => ({ key: path, path, line: 0, column: 0, text: "" }));
  return rows.map((row) => {
    const [path, line, column, ...text] = row.split(SEPARATOR);
    return { key: `${path}:${line}:${column}`, path, line: Number(line), column: Number(column), text: text.join(SEPARATOR) };
  });
}

// The terms a result can show: fzf's markers go, and an excluded term shows nowhere.
function shownTerms(query) {
  return query
    .split(/\s+/)
    .filter((term) => term && !term.startsWith("!"))
    .map((term) => term.replace(/^['^]/, "").replace(/\$$/, "").toLowerCase())
    .filter(Boolean);
}

/** `text` cut into runs of { text, hit }, where hit marks the letters that matched `query`. */
export function matchRuns(text, query) {
  const lower = text.toLowerCase();
  const hits = new Array(text.length).fill(false);
  for (const term of shownTerms(query)) {
    const exact = lower.indexOf(term);
    if (exact >= 0) {
      hits.fill(true, exact, exact + term.length);
      continue;
    }
    let from = 0;
    for (const letter of term) {
      const at = lower.indexOf(letter, from);
      if (at < 0) break;
      hits[at] = true;
      from = at + 1;
    }
  }
  const runs = [];
  for (let start = 0, at = 1; start < text.length; at++) {
    if (at === text.length || hits[at] !== hits[start]) {
      runs.push({ text: text.slice(start, at), hit: hits[start] });
      start = at;
    }
  }
  return runs;
}
