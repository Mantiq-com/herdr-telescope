// Reading what herdr-telescope prints. This file imports nothing from Herdr, so
// test.sh can run it under node.

const SEPARATOR = "\x1f";

// The interface of herdr-telescope this mod needs. test.sh checks it against the
// command's own number.
export const COMMAND_VERSION = 3;

/** Whether `herdr-telescope --version` printed what this mod needs. An older command prints none. */
export function commandIsCurrent(stdout) {
  return Number(stdout.trim().split(" ")[1]) >= COMMAND_VERSION;
}

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
// As in fzf, a term with a capital letter matches its case, whatever the others do,
// and a term starting with ' is exact, unless `exact` makes it the only fuzzy kind.
function shownTerms(query, matchCase, exact) {
  return query
    .split(/\s+/)
    .filter((term) => term && !term.startsWith("!"))
    .map((term) => ({ text: term.replace(/^['^]/, "").replace(/\$$/, ""), exact: term.startsWith("'") !== exact }))
    .filter((term) => term.text)
    .map((term) => ({ ...term, matchCase: matchCase || term.text !== term.text.toLowerCase() }));
}

// Where `term` is in `text`: every exact occurrence, else with `fuzzy` the letters
// of a term that is not exact, in order. Null when the whole term is not there, so
// that a text is never marked for half a term.
function termHits(text, term, fuzzy) {
  const searched = term.matchCase ? text : text.toLowerCase();
  const wanted = term.matchCase ? term.text : term.text.toLowerCase();
  const hits = [];
  for (let at = searched.indexOf(wanted); at >= 0; at = searched.indexOf(wanted, at + wanted.length)) {
    for (let i = 0; i < wanted.length; i++) hits.push(at + i);
  }
  if (hits.length) return hits;
  if (!fuzzy || term.exact) return null;
  const letters = [...wanted];
  let at = -1;
  for (const letter of letters) {
    at = searched.indexOf(letter, at + 1);
    if (at < 0) return null;
  }
  // Walking back from the last letter keeps the marks together, as fzf's are: the
  // first "o" of "export openCommand" is not the one that matched.
  hits.push(at);
  for (const letter of letters.reverse().slice(1)) {
    at = searched.lastIndexOf(letter, at - 1);
    hits.push(at);
  }
  return hits;
}

/**
 * Whether a regular expression matches case: always with `matchCase`, and otherwise,
 * like fzf's smart case, when one of its own letters is a capital. The mod decides
 * this for rg as well, so the marks and the search follow one rule.
 */
export function regexMatchesCase(pattern, matchCase = false) {
  // The letters of an escape such as \W, a class such as \p{Lu} or a group's name
  // do not stand for themselves.
  const letters = pattern.replace(/\\[pP]\{[^}]*\}|\\.|\(\?P?<[A-Za-z_]\w*>/gs, "");
  return matchCase || letters !== letters.toLowerCase();
}

// Where a regular expression matches `text`. JavaScript cannot read a few of rg's
// patterns, such as (?i)x or \pL, and those mark nothing; rg itself reports a
// pattern that is really wrong.
function regexHits(text, pattern, matchCase) {
  let expression;
  try {
    expression = new RegExp(pattern, regexMatchesCase(pattern, matchCase) ? "gu" : "giu");
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  const hits = [];
  for (const match of text.matchAll(expression)) {
    for (let i = 0; i < match[0].length; i++) hits.push(match.index + i);
  }
  return hits;
}

/**
 * For each letter of `text`, whether it matched `query`. Without `fuzzy` only exact
 * terms match, and with `matchCase` every term matches its case. `matching` is how
 * the search matched: "fuzzy", "exact" for letters in a row, or "regex", whose
 * matches are all marked.
 */
export function matchHits(text, query, fuzzy = true, matchCase = false, matching = "fuzzy") {
  const hits = new Array(text.length).fill(false);
  if (matching === "regex") {
    for (const at of regexHits(text, query, matchCase)) hits[at] = true;
    return hits;
  }
  for (const term of shownTerms(query, matchCase, matching === "exact")) {
    for (const at of termHits(text, term, fuzzy) ?? []) hits[at] = true;
  }
  return hits;
}

/**
 * matchHits for a path: a term that fits in the file's name is marked there, not in
 * its folders. A regex matched the whole path, so it is marked across it.
 */
export function pathHits(path, query, matchCase = false, matching = "fuzzy") {
  if (matching === "regex") return matchHits(path, query, true, matchCase, matching);
  const name = path.lastIndexOf("/") + 1;
  const hits = new Array(path.length).fill(false);
  for (const term of shownTerms(query, matchCase, matching === "exact")) {
    const inName = termHits(path.slice(name), term, true);
    if (inName) for (const at of inName) hits[name + at] = true;
    else for (const at of termHits(path, term, true) ?? []) hits[at] = true;
  }
  return hits;
}

// How many letters stay before the first mark when the start of a line is cut.
const CONTEXT = 12;

/** Where to cut the start of a line so that its marks show in `columns` letters; 0 for nowhere. */
export function cutBefore(hits, columns) {
  const first = hits.indexOf(true), last = hits.lastIndexOf(true);
  if (first < 0 || last < columns) return 0;
  return Math.max(0, first - CONTEXT);
}

/** `text` and `hits` with what cutBefore cuts replaced by an ellipsis. */
export function clipped(text, hits, columns) {
  const cut = cutBefore(hits, columns);
  return cut ? { text: `…${text.slice(cut)}`, hits: [false, ...hits.slice(cut)] } : { text, hits };
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
