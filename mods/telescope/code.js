// The lines of a content match's preview, cut into what main.js draws. Herdr's
// Editor cannot mark text, so these lines are drawn one by one, with their syntax
// colors and the letters that matched. This file imports nothing from Herdr, so
// test.sh can run it under node.

import { languageOf, tokenize } from "./highlight.js";
import { cutBefore, matchHits } from "./results.js";

// Cuts each token where a run of matched letters starts or ends.
function markSpans(line, spans, hits) {
  const marked = [];
  let at = 0;
  for (const span of spans) {
    const end = at + span.text.length;
    for (let start = at, next = at + 1; start < end; next++) {
      if (next === end || hits[next] !== hits[start]) {
        marked.push({ text: line.slice(start, next), cls: span.cls, hit: hits[start] });
        start = next;
      }
    }
    at = end;
  }
  return marked;
}

// The spans without their first `count` letters, which an ellipsis replaces.
function dropStart(spans, count) {
  const kept = [{ text: "…", cls: "comment", hit: false }];
  let at = 0;
  for (const span of spans) {
    const end = at + span.text.length;
    if (end > count) kept.push({ ...span, text: span.text.slice(Math.max(0, count - at)) });
    at = end;
  }
  return kept;
}

/**
 * The rows of `text`, whose first line is `firstLine`, as { number, matched, spans }
 * with spans of { text, cls, hit }. The line of the match shows its fuzzy letters,
 * and loses its start if they would fall past `columns`. Other lines show only exact
 * terms, because any line holds a query's letters somewhere. Every line shows the
 * matches of a regex, which is never fuzzy.
 */
export function codeRows(text, firstLine, path, { query, matchLine, matchCase = false, matching = "fuzzy", columns = Infinity }) {
  const language = languageOf(path);
  let state = null;
  return text.replace(/\n$/, "").split("\n").map((raw, index) => {
    const line = raw.replace(/\t/g, "    ");
    const number = firstLine + index;
    const tokens = tokenize(line, language, state);
    state = tokens.state;
    const matched = number === matchLine;
    const hits = matchHits(line, query, matched, matchCase, matching);
    const spans = markSpans(line, tokens.spans, hits);
    const cut = matched ? cutBefore(hits, columns) : 0;
    return { number, matched, spans: cut ? dropStart(spans, cut) : spans };
  });
}
