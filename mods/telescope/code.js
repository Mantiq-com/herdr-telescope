// The lines of a content match's preview, cut into what main.js draws. Herdr's
// Editor cannot mark text, so these lines are drawn one by one, with their syntax
// colors and the letters that matched. This file imports nothing from Herdr, so
// test.sh can run it under node.

import { languageOf, tokenize } from "./highlight.js";
import { matchHits } from "./results.js";

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

/**
 * The rows of `text`, whose first line is `firstLine`, as { number, matched, spans }
 * with spans of { text, cls, hit }. The line of the match shows its fuzzy letters.
 * Other lines show only exact terms: any line holds a query's letters somewhere.
 */
export function codeRows(text, firstLine, path, query, matchLine) {
  const language = languageOf(path);
  let state = null;
  return text.replace(/\n$/, "").split("\n").map((raw, index) => {
    const line = raw.replace(/\t/g, "    ");
    const number = firstLine + index;
    const tokens = tokenize(line, language, state);
    state = tokens.state;
    const matched = number === matchLine;
    return { number, matched, spans: markSpans(line, tokens.spans, matchHits(line, query, matched)) };
  });
}
