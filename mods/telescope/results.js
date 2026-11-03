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

// Where `term` is in `text`: every exact occurrence, else with `fuzzy` its letters
// in order. Null when the whole term is not there, so that a text is never marked
// for half a term.
function termHits(text, term, fuzzy) {
  const lower = text.toLowerCase();
  const hits = [];
  for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
    for (let i = 0; i < term.length; i++) hits.push(at + i);
  }
  if (hits.length) return hits;
  if (!fuzzy) return null;
  const letters = [...term];
  let at = -1;
  for (const letter of letters) {
    at = lower.indexOf(letter, at + 1);
    if (at < 0) return null;
  }
  // Walking back from the last letter keeps the marks together, as fzf's are: the
  // first "o" of "export openCommand" is not the one that matched.
  hits.push(at);
  for (const letter of letters.reverse().slice(1)) {
    at = lower.lastIndexOf(letter, at - 1);
    hits.push(at);
  }
  return hits;
}

/** For each letter of `text`, whether it matched `query`. Without `fuzzy`, only exact terms match. */
export function matchHits(text, query, fuzzy = true) {
  const hits = new Array(text.length).fill(false);
  for (const term of shownTerms(query)) {
    for (const at of termHits(text, term, fuzzy) ?? []) hits[at] = true;
  }
  return hits;
}

/** matchHits for a path: a term that fits in the file's name is marked there, not in its folders. */
export function pathHits(path, query) {
  const name = path.lastIndexOf("/") + 1;
  const hits = new Array(path.length).fill(false);
  for (const term of shownTerms(query)) {
    const inName = termHits(path.slice(name), term, true);
    if (inName) for (const at of inName) hits[name + at] = true;
    else for (const at of termHits(path, term, true) ?? []) hits[at] = true;
  }
  return hits;
}

/** `text` cut into runs of { text, hit }. */
export function hitRuns(text, hits) {
  const runs = [];
  for (let start = 0, at = 1; start < text.length; at++) {
    if (at === text.length || hits[at] !== hits[start]) {
      runs.push({ text: text.slice(start, at), hit: hits[start] });
      start = at;
    }
  }
  return runs;
}
