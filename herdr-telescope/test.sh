#!/usr/bin/env bash
# Checks the herdr-telescope command against throwaway files: the rules the
# Telescope mod relies on, not the wording of its output. It needs rg, fzf, jq, git,
# file, magick, rsvg-convert, pdftoppm, pdfinfo, bsdtar, sqlite3 and node, and
# exits non-zero on the first failed check, so a package build can run it.
#
# Usage: test.sh <path to herdr-telescope>
set -o errexit -o nounset -o pipefail

telescope=$(realpath "${1}")
mods=$(realpath "$(dirname "${BASH_SOURCE[0]}")/../mods/telescope")
work=$(mktemp --directory)
trap 'rm --recursive --force "${work}"' EXIT

fail() {
  echo "FAIL: ${1}" >&2
  exit 1
}

for tool in rg fzf jq git file magick rsvg-convert pdftoppm pdfinfo bsdtar sqlite3 node; do
  command -v "${tool}" > /dev/null || fail "${tool} is needed to run these checks"
done

export HOME="${work}/home" XDG_RUNTIME_DIR="${work}/runtime"
mkdir --parents "${HOME}" "${XDG_RUNTIME_DIR}"

repo="${work}/repo"
mkdir --parents "${repo}/src/deep/er" "${repo}/.git"
cd "${repo}"
printf 'target/\n' > .gitignore
printf 'not a project file\n' > .git/config
mkdir target
printf 'generated\n' > target/ignored-output.txt
printf 'fn main() {}\n' > src/permission_check.rs
printf 'x\n' > src/deep/er/pxexrxmxcxhxexcxk.rs
printf 'first line\nthe permission check runs here\nlast line\n' > notes.txt
printf 'p e r m c h e c k scattered across this whole line of text\n' > scattered.txt
printf 'colon in the name\n' > 'a:b c.txt'

first_line() {
  head --lines=1
}
field() {
  cut --delimiter=$'\x1f' --fields="${1}"
}

# Files: a tight match comes before a scattered one.
[ "$("${telescope}" files -- "${repo}" permcheck | first_line)" = "src/permission_check.rs" ] \
  || fail "files does not rank the tight match first"

# Files: ignored files stay out unless asked for, and .git never appears.
"${telescope}" files -- "${repo}" "" > "${work}/listed"
rg --quiet 'ignored-output' "${work}/listed" && fail "files listed an ignored file"
rg --quiet '^\.git/' "${work}/listed" && fail "files listed the .git folder"
"${telescope}" files --no-ignore -- "${repo}" ignoredoutput > "${work}/listed"
rg --quiet 'ignored-output' "${work}/listed" || fail "--no-ignore did not list the ignored file"

# Files: an empty query lists paths in a stable order.
[ "$("${telescope}" files -- "${repo}" "")" = "$("${telescope}" files -- "${repo}" "")" ] \
  || fail "an empty query does not list paths in a stable order"

# Files: with no query, recent files come first, in their order, without the ones
# that are gone, and without showing a file twice.
"${telescope}" files --recent notes.txt --recent gone.txt --recent src/permission_check.rs -- "${repo}" "" > "${work}/listed"
[ "$(head --lines=2 "${work}/listed")" = $'notes.txt\nsrc/permission_check.rs' ] \
  || fail "recent files do not come first, in their order"
rg --quiet 'gone.txt' "${work}/listed" && fail "a recent file that is gone was listed"
[ "$(rg --count --fixed-strings notes.txt "${work}/listed")" = 1 ] || fail "a recent file was listed twice"
[ "$(wc --lines < "${work}/listed")" = "$("${telescope}" files -- "${repo}" "" | wc --lines)" ] \
  || fail "recent files changed which files are listed"

# A query ranks by the match alone, and --changed lists what changed alone.
[ "$("${telescope}" files --recent notes.txt -- "${repo}" permcheck | first_line)" = "src/permission_check.rs" ] \
  || fail "a recent file changed the ranking of a query"

# Content: a tight match comes before a scattered one, and fuzzy spelling matches.
"${telescope}" grep -- "${repo}" permcheck > "${work}/hits"
[ "$(first_line < "${work}/hits" | field 1)" = "notes.txt" ] \
  || fail "grep does not rank the tight match first"
[ "$(first_line < "${work}/hits" | field 2)" = "2" ] || fail "grep reports the wrong line"
[ "$(first_line < "${work}/hits" | field 3)" -ge 1 ] || fail "grep reports no column"
[ "$(first_line < "${work}/hits" | field 4)" = "the permission check runs here" ] \
  || fail "grep reports the wrong text"
rg --quiet 'scattered' "${work}/hits" || fail "grep dropped a scattered subsequence match"

# Content: the path survives a colon and a space in the name.
[ "$("${telescope}" grep -- "${repo}" colonname | first_line | field 1)" = "a:b c.txt" ] \
  || fail "grep did not keep a path with a colon and a space"

# Content: fzf's syntax narrows the result, which rg's patterns must not prevent.
"${telescope}" grep -- "${repo}" "'permission check" > "${work}/hits"
[ "$(wc --lines < "${work}/hits")" -ge 1 ] || fail "an exact term found nothing"
"${telescope}" grep -- "${repo}" "permcheck !runs" > "${work}/hits"
rg --quiet 'runs here' "${work}/hits" && fail "an excluded term was not excluded"

# Content: a query of only excluded terms searches nothing rather than everything.
[ -z "$("${telescope}" grep -- "${repo}" '!line')" ] || fail "a query of only exclusions returned lines"

# Punctuation in a query is text, never a flag or regular expression syntax.
printf 'a.b [c] <d> back\\slash -dash (e) $f ^g\n' > punctuation.txt
for query in '-dash' '--hidden' '.' '[c' '<d>' 'back\slash' '(e' '$f' '*' '+' '?' '{'; do
  "${telescope}" grep -- "${repo}" "${query}" > /dev/null 2> "${work}/errors" \
    || fail "grep failed on the query ${query}"
  [ ! -s "${work}/errors" ] || fail "grep reported an error for the query ${query}"
  "${telescope}" files -- "${repo}" "${query}" > /dev/null 2> "${work}/errors" \
    || fail "files failed on the query ${query}"
done
[ "$("${telescope}" grep -- "${repo}" '<d>' | first_line | field 1)" = "punctuation.txt" ] \
  || fail "a query with < and > did not match them as text"

# A match far along a long line is found, and its row carries the text to show it.
printf '{"padding": "%s", "name": "farneedle"}\n' "$(head --bytes=1500 /dev/zero | tr '\000' 'x')" > wide.json
[ "$("${telescope}" grep -- "${repo}" farneedle | first_line | field 1)" = wide.json ] \
  || fail "a match far along a long line was not found"
"${telescope}" grep -- "${repo}" farneedle | first_line | field 4 | rg --quiet farneedle \
  || fail "the row of a long line lost the match"

# A lower-case term ignores case, a capital letter makes a term match its case, and
# --case-sensitive makes every term match it.
mkdir casing
printf 'needlecase\n' > casing/lower.txt
printf 'NEEDLECASE\n' > casing/upper.txt
printf 'x\n' > casing/MixedName.txt
[ "$("${telescope}" grep -- "${repo}" needlecase | wc --lines)" = 2 ] \
  || fail "a lower-case query did not match both cases"
[ "$("${telescope}" grep -- "${repo}" NEEDLECASE | field 4)" = NEEDLECASE ] \
  || fail "a query with capitals did not match its case"
[ "$("${telescope}" grep --case-sensitive -- "${repo}" needlecase | field 4)" = needlecase ] \
  || fail "--case-sensitive did not match the case of a lower-case query"
[ -n "$("${telescope}" files -- "${repo}" mixedname)" ] \
  || fail "a lower-case query did not find a mixed-case name"
[ -z "$("${telescope}" files --case-sensitive -- "${repo}" mixedname)" ] \
  || fail "--case-sensitive found a name in another case"
[ -n "$("${telescope}" files --case-sensitive -- "${repo}" MixedName)" ] \
  || fail "--case-sensitive did not find the name in its case"

# --changed keeps what git reports as changed, apart from what can no longer be opened.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="Alice Smith" GIT_AUTHOR_EMAIL="alice@example.com"
export GIT_COMMITTER_NAME="Alice Smith" GIT_COMMITTER_EMAIL="alice@example.com"
changes="${work}/changes"
git init --quiet --initial-branch=main "${changes}"
printf 'quiet words\n' > "${changes}/clean.txt"
printf 'edited words\n' > "${changes}/edited.txt"
printf 'gone words\n' > "${changes}/deleted.txt"
printf 'moved words\n' > "${changes}/old-name.txt"
git -C "${changes}" add .
git -C "${changes}" commit --quiet --message "first"
[ -z "$("${telescope}" files --changed -- "${changes}" "")" ] || fail "--changed listed files in a clean repository"
[ -z "$("${telescope}" grep --changed -- "${changes}" words)" ] || fail "--changed searched files in a clean repository"
printf 'more words\n' >> "${changes}/edited.txt"
rm "${changes}/deleted.txt"
git -C "${changes}" mv old-name.txt new-name.txt
printf 'fresh words\n' > "${changes}/new file.txt"
want=$'edited.txt\nnew file.txt\nnew-name.txt'
[ "$("${telescope}" files --changed -- "${changes}" "")" = "${want}" ] \
  || fail "--changed did not list exactly the changed files that exist"
[ "$("${telescope}" files --changed -- "${changes}" edit)" = edited.txt ] || fail "--changed did not narrow by the query"
[ "$("${telescope}" grep --changed -- "${changes}" words | field 1 | LC_ALL=C sort --unique)" = "${want}" ] \
  || fail "--changed did not search exactly the changed files"
[ -z "$("${telescope}" grep --changed -- "${changes}" quiet)" ] || fail "--changed searched an unchanged file"
[ "$("${telescope}" files --changed --recent clean.txt -- "${changes}" "")" = "${want}" ] \
  || fail "--changed listed a recent file that did not change"
if "${telescope}" files --changed -- "${work}" x 2> "${work}/errors"; then
  fail "--changed outside a repository did not fail"
fi
rg --quiet 'not a git repository' "${work}/errors" || fail "--changed outside a repository gave no reason"

# Results stay within the limit the mod's list and the app's output cap rely on.
mkdir many
for number in $(seq 1 700); do
  printf 'needle %s\n' "${number}" > "many/file-${number}.txt"
done
[ "$("${telescope}" files -- "${repo}" many | wc --lines)" -le 500 ] || fail "files returned more than 500 paths"
[ "$("${telescope}" grep -- "${repo}" needle | wc --lines)" -le 500 ] || fail "grep returned more than 500 lines"

kind_of() {
  "${telescope}" preview -- "${1}" | jq --raw-output .kind
}

# Each kind of file gets its own preview.
printf '# Title\n' > readme.md
printf 'print("x")\n' > script.py
printf 'no extension, still text\n' > LICENCE
magick -size 64x32 xc:red picture.png
cp picture.png picture-without-extension
printf '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12"/></svg>\n' > drawing.svg
magick xc:red xc:blue document.pdf
bsdtar --create --format=zip --file archive.zip readme.md
sqlite3 database.sqlite 'create table people (name text);'
printf 'binary\000data\n' > blob.bin

[ "$(kind_of "${repo}/script.py")" = text ] || fail "a Python file is not previewed as text"
[ "$(kind_of "${repo}/LICENCE")" = text ] || fail "a file without an extension is not previewed as text"
[ "$(kind_of "${repo}/readme.md")" = markdown ] || fail "a Markdown file is not previewed as Markdown"
[ "$(kind_of "${repo}/picture.png")" = image ] || fail "a PNG is not previewed as an image"
[ "$(kind_of "${repo}/picture-without-extension")" = image ] \
  || fail "an image without an extension is not found by its content"
[ "$(kind_of "${repo}/drawing.svg")" = image ] || fail "an SVG is not previewed as an image"
[ "$(kind_of "${repo}/document.pdf")" = image ] || fail "a PDF is not previewed as an image"
[ "$(kind_of "${repo}/blob.bin")" = details ] || fail "a binary file does not show its details"
"${telescope}" preview -- "${repo}/archive.zip" | jq --exit-status '.text | contains("readme.md")' > /dev/null \
  || fail "an archive does not list its contents"
"${telescope}" preview -- "${repo}/database.sqlite" | jq --exit-status '.text | contains("people")' > /dev/null \
  || fail "a database does not show its schema"

# An image is real, decodable data with sizes the mod can lay out.
"${telescope}" preview -- "${repo}/picture.png" > "${work}/preview"
jq --raw-output .base64 "${work}/preview" | base64 --decode > "${work}/decoded"
[ "$(magick identify -format '%w %h' "webp:${work}/decoded")" = "64 32" ] \
  || fail "the image data does not decode to the reported picture"
[ "$(jq '[.width, .height] == [64, 32]' "${work}/preview")" = true ] || fail "the image reports the wrong size"

# A PDF reports its pages, and a page past the end shows the last one.
"${telescope}" preview --page 2 -- "${repo}/document.pdf" > "${work}/preview"
[ "$(jq '[.page, .pages] == [2, 2]' "${work}/preview")" = true ] || fail "a PDF does not report its pages"
"${telescope}" preview --page 9 -- "${repo}/document.pdf" > "${work}/preview"
[ "$(jq .page "${work}/preview")" = 2 ] || fail "a page past the end was not limited to the last page"

# A large noisy image stays inside what a remote machine can return, about 6 MiB.
magick -size 4000x4000 xc: +noise Random noisy.png
[ "$("${telescope}" preview -- "${repo}/noisy.png" | wc --bytes)" -lt 6000000 ] \
  || fail "a large image exceeds the output limit of a remote machine"

# Odd file names reach the converters as data.
cp picture.png 'odd [1] -name;$(touch pwned).png'
[ "$(kind_of "${repo}/odd [1] -name;\$(touch pwned).png")" = image ] || fail "an odd file name broke the preview"
[ ! -e pwned ] || fail "a file name was run as a command"
cp picture.png 'frame.png[1]'
[ "$(kind_of "${repo}/frame.png[1]")" = image ] || fail "a file name was read as ImageMagick's frame syntax"

# A script in ImageMagick's drawing language is not run, whatever its extension
# says. This one would draw a valid picture, so running it would give an image.
printf 'push graphic-context\nviewbox 0 0 64 64\nfill red\nrectangle 0,0 64,64\npop graphic-context\n' > script.png
[ "$(kind_of "${repo}/script.png")" = details ] || fail "an ImageMagick script was run as an image"

# A line window holds the matched line near its top, however deep the line is.
seq 1 100000 > long.txt
"${telescope}" preview --line 50000 -- "${repo}/long.txt" > "${work}/preview"
jq --raw-output .text "${work}/preview" > "${work}/window"
rg --quiet '^50000$' "${work}/window" || fail "the line window does not hold the matched line"
[ "$(jq .first_line "${work}/preview")" = "$(first_line < "${work}/window")" ] \
  || fail "first_line does not name the window's first line"
[ "$(wc --lines < "${work}/window")" -le 401 ] || fail "the line window is not bounded"

# --first starts the window exactly there, and a plain preview starts at line 1.
[ "$("${telescope}" preview --first 700 -- "${repo}/long.txt" | jq --raw-output '.text | split("\n") | .[0]')" = 700 ] \
  || fail "--first does not start the window at that line"
[ "$("${telescope}" preview -- "${repo}/long.txt" | jq .first_line)" = 1 ] \
  || fail "a plain preview does not start at line 1"
[ "$("${telescope}" preview --first 200000 -- "${repo}/long.txt" | jq --raw-output .text)" = "" ] \
  || fail "a window past the end of the file is not empty"

# One very long line, as in a minified file, is cut at the limit.
head --bytes=1000000 /dev/zero | tr '\000' 'x' > huge.txt
[ "$("${telescope}" preview -- "${repo}/huge.txt" | jq '.text | length')" -le 65536 ] \
  || fail "a large text file was not cut"

# Without a converter the preview still works, and names what to install.
limited="${work}/limited"
mkdir "${limited}"
for tool in bash env jq rg fzf head tr wc od stat date mktemp rm sed cut base64 sort timeout readlink; do
  ln --symbolic "$(command -v "${tool}")" "${limited}/${tool}"
done
for pair in document.pdf:poppler picture.png:ImageMagick drawing.svg:librsvg archive.zip:libarchive database.sqlite:sqlite; do
  PATH="${limited}" "${telescope}" preview -- "${repo}/${pair%%:*}" > "${work}/preview" \
    || fail "${pair%%:*} failed without its converter"
  [ "$(jq --raw-output .kind "${work}/preview")" = details ] \
    || fail "${pair%%:*} does not show its details without a converter"
  jq --exit-status --arg tool "${pair##*:}" '.hint | contains($tool)' "${work}/preview" > /dev/null \
    || fail "${pair%%:*} does not name ${pair##*:} when it is missing"
done

# A stand-in for bubblewrap that cannot run shows what the sandbox was asked for, and
# that a preview still works where the sandbox cannot start.
fake="${work}/fake"
mkdir "${fake}"
printf '#!%s\nprintf "%%s " "$@" >> "%s/box"\nexit 1\n' "$(command -v bash)" "${work}" > "${fake}/bwrap"
chmod 755 "${fake}/bwrap"
PATH="${fake}:${PATH}" "${telescope}" preview -- "${repo}/picture.png" > "${work}/preview"
[ "$(jq --raw-output .kind "${work}/preview")" = image ] || fail "a preview failed where the sandbox cannot start"
for wanted in --unshare-all --clearenv --die-with-parent --new-session "--tmpfs ${HOME} " "--ro-bind ${repo}/picture.png"; do
  rg --quiet --fixed-strings -- "${wanted}" "${work}/box" || fail "the sandbox lacks ${wanted}"
done
rg --quiet --fixed-strings -- '--share-net' "${work}/box" && fail "the sandbox keeps the network"
rg --quiet -- '--ro-bind(-try)? /run ' "${work}/box" && fail "the sandbox shows /run, where secrets can live"
rg --quiet --fixed-strings -- '--setenv SECRET' "${work}/box" && fail "the sandbox passes on the environment"

# Text is only read, so browsing it starts no sandbox.
rm "${work}/box"
PATH="${fake}:${PATH}" "${telescope}" preview -- "${repo}/script.py" > /dev/null
[ ! -e "${work}/box" ] || fail "a text preview started a sandbox"

# A missing required tool is a failure the mod can show, not an empty result.
if PATH="${work}/nothing" "$(command -v bash)" "${telescope}" files -- "${repo}" x 2> "${work}/errors"; then
  fail "a missing rg did not fail"
fi
rg --quiet 'rg is not installed' "${work}/errors" || fail "a missing rg is not named"

# A file that vanished before the preview is an error, not a crash without one.
if "${telescope}" preview -- "${repo}/no-such-file" 2> "${work}/errors"; then
  fail "a missing file did not fail"
fi
[ -s "${work}/errors" ] || fail "a missing file gave no message"

# Every mod file parses. Herdr itself only reports this when the mod loads.
for source in "${mods}"/*.js; do
  copy="${work}/$(basename "${source}" .js).mjs"
  cp "${source}" "${copy}"
  node --check "${copy}" || fail "$(basename "${source}") does not parse"
done

node "${mods}/../../herdr-telescope/mod-test.mjs" || fail "the editor controls or key commands do not work"

node --input-type=module --eval "
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const { EDITORS, inLoginShell, openCommand } = await import('${mods}/editors.js');
const hit = { path: '/home/alice/my project/a.rs', line: 12, column: 5 };
const plain = { path: '/home/alice/my project/a.rs', line: 0, column: 0 };

assert.deepEqual(openCommand('zed', hit, null), ['zed', '/home/alice/my project/a.rs:12:5']);
assert.deepEqual(openCommand('zed', plain, null), ['zed', '/home/alice/my project/a.rs']);
assert.deepEqual(openCommand('zed', plain, 'build.example.com'), ['zed', 'ssh://build.example.com/home/alice/my project/a.rs']);
assert.deepEqual(openCommand('code', hit, null), ['code', '--goto', '/home/alice/my project/a.rs:12:5']);
assert.deepEqual(openCommand('code', plain, null), ['code', '--goto', '/home/alice/my project/a.rs']);
assert.deepEqual(openCommand('code', hit, 'build.example.com'), ['code', '--remote', 'ssh-remote+build.example.com', '--goto', '/home/alice/my project/a.rs:12:5']);
assert.deepEqual(openCommand('nvim', hit, null), ['nvim', '+call cursor(12,5)', '/home/alice/my project/a.rs']);
assert.deepEqual(openCommand('nvim', plain, null), ['nvim', '/home/alice/my project/a.rs']);
assert.deepEqual(openCommand('emacs', hit, null), ['emacs', '-nw', '+12:5', '/home/alice/my project/a.rs']);
assert.deepEqual(openCommand('emacs', plain, null), ['emacs', '-nw', '/home/alice/my project/a.rs']);
assert.deepEqual(openCommand('hx', hit, null), ['hx', '/home/alice/my project/a.rs:12:5']);
assert.deepEqual(openCommand('hx', plain, null), ['hx', '/home/alice/my project/a.rs']);
assert.deepEqual(openCommand('nano', hit, null), ['nano', '+12,5', '/home/alice/my project/a.rs']);
assert.deepEqual(openCommand('nano', plain, null), ['nano', '/home/alice/my project/a.rs']);

// Every editor can be opened, by a key of its own, and has an icon on its control.
for (const editor of EDITORS) {
  assert.ok(openCommand(editor.id, hit, null).length > 1);
  assert.ok(existsSync('${mods}/icons/' + editor.id + '.svg'), editor.id + ' has no icon');
}
assert.equal(new Set(EDITORS.map((e) => e.key)).size, EDITORS.length);

// The login shell passes arguments through whole, for a shell it knows and one it does not.
const inShell = (shell, argv) => execFileSync(argv[0], argv.slice(1), {
  encoding: 'utf8', input: '\n', stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, SHELL: shell },
});
const bash = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
assert.equal(inShell(bash, inLoginShell(['printf', '%s|', 'a b', '\$HOME', \"it's\"])), \"a b|\$HOME|it's|\");
assert.equal(inShell('/no/such/fish', inLoginShell(['printf', '%s|', 'a b'])), 'a b|');

// An editor the machine does not have says so, rather than closing the pane unread.
assert.match(inShell(bash, inLoginShell(['no-such-editor', 'a.rs'])), /no-such-editor is not installed/);
" || fail "editors.js builds a wrong command"

# The mod reads the output this command really prints.
"${telescope}" grep -- "${repo}" colonname > "${work}/hits"
"${telescope}" files -- "${repo}" permcheck > "${work}/listed"
node --input-type=module --eval "
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { clipped, COMMAND_VERSION, commandIsCurrent, hitRuns, languageOf, matchHits, parseResults, pathHits } = await import('${mods}/results.js');
const { codeRows: rowsOf } = await import('${mods}/code.js');
const codeRows = (text, first, path, query, matchLine, matchCase) => rowsOf(text, first, path, { query, matchLine, matchCase });

const [hit] = parseResults('grep', readFileSync('${work}/hits', 'utf8'));
assert.equal(hit.path, 'a:b c.txt');
assert.equal(hit.line, 1);
assert.equal(hit.text, 'colon in the name');
const [file] = parseResults('files', readFileSync('${work}/listed', 'utf8'));
assert.equal(file.path, 'src/permission_check.rs');
assert.equal(file.line, 0);

// The mod and this command agree on the interface, and an older command is found out,
// also one from before --version, which prints nothing on stdout.
assert.equal('$("${telescope}" --version)', 'herdr-telescope ' + COMMAND_VERSION);
assert.ok(commandIsCurrent('herdr-telescope ' + COMMAND_VERSION + '\n'));
assert.ok(commandIsCurrent('herdr-telescope ' + (COMMAND_VERSION + 1)));
assert.equal(commandIsCurrent('herdr-telescope ' + (COMMAND_VERSION - 1)), false);
assert.equal(commandIsCurrent(''), false);

// The list needs a key per row, and a row per line of output.
const keys = parseResults('grep', 'a\x1f1\x1f1\x1fx\na\x1f2\x1f1\x1fx\n').map((r) => r.key);
assert.equal(new Set(keys).size, 2);
assert.deepEqual(parseResults('files', ''), []);

// A text the search kept is whole again when its runs are joined.
const marked = (runs) => runs.filter((r) => r.hit).map((r) => r.text);
const hits = (text, query, fuzzy) => marked(hitRuns(text, matchHits(text, query, fuzzy)));
assert.equal(hitRuns('permission_check.rs', matchHits('permission_check.rs', 'permcheck')).map((r) => r.text).join(''), 'permission_check.rs');
assert.deepEqual(hits('permission_check.rs', 'check'), ['check']);
assert.deepEqual(hits('src/app.rs', 'sap'), ['s', 'ap']);
assert.deepEqual(hits('MixedCase', 'mixed'), ['Mixed']);
assert.deepEqual(hits('hello', '!hello'), []);
assert.deepEqual(hits('hello', \"'hell\"), ['hell']);
assert.deepEqual(hitRuns('', matchHits('', 'x')), []);

// The marks stay together: the first letter that fits is not always the one that matched.
assert.deepEqual(hits('export function openCommand', 'opncmd'), ['op', 'nC', 'm', 'd']);

// Half a term marks nothing, and without fuzzy only whole terms mark anything.
assert.deepEqual(hits('hello world', 'hez'), []);
assert.deepEqual(hits('src/app.rs', 'sap', false), []);
assert.deepEqual(hits('one two one', 'one', false), ['one', 'one']);

// The marks follow the search's case rule, which applies to each term on its own.
const inCase = (text, query) => marked(hitRuns(text, matchHits(text, query, true, true)));
assert.deepEqual(hits('editors EDITORS', 'editors'), ['editors', 'EDITORS']);
assert.deepEqual(hits('editors EDITORS', 'EDITORS'), ['EDITORS']);
assert.deepEqual(hits('editors EDITORS', 'Editors'), []);
assert.deepEqual(hits('foo FOO bar BAR', 'foo BAR'), ['foo', 'FOO', 'BAR']);
assert.deepEqual(hits('permCheck', 'pC'), ['p', 'C']);
assert.deepEqual(hits('permcheck', 'pC'), []);
assert.deepEqual(inCase('editors EDITORS', 'editors'), ['editors']);
assert.deepEqual(marked(hitRuns('src/Main.rs', pathHits('src/Main.rs', 'main', true))), []);
assert.deepEqual(marked(hitRuns('src/Main.rs', pathHits('src/Main.rs', 'main'))), ['Main']);
assert.deepEqual(marked(codeRows('word WORD\n', 1, '/repo/a.txt', 'WORD', 9)[0].spans), ['WORD']);
assert.deepEqual(marked(codeRows('word WORD\n', 1, '/repo/a.txt', 'word', 9, true)[0].spans), ['word']);

// A term that fits in a file's name is marked there, not in its folders. One that
// only fits across the path is marked across it.
const named = (path, query) => {
  const all = pathHits(path, query), slash = path.lastIndexOf('/');
  return { name: marked(hitRuns(path.slice(slash + 1), all.slice(slash + 1))), folder: marked(hitRuns(path.slice(0, slash), all)) };
};
assert.deepEqual(named('main/deep/main.rs', 'main'), { name: ['main'], folder: [] });
assert.deepEqual(named('src/app.rs', 'srcapp'), { name: ['app'], folder: ['src'] });
assert.deepEqual(named('app.rs', 'app').name, ['app']);

// A preview row is its line again, with its real number.
const source = 'fn check() {\n\tlet permission = 1; // permcheck\n}\n';
const rows = codeRows(source, 40, '/repo/a.rs', 'permcheck', 41);
assert.deepEqual(rows.map((r) => r.number), [40, 41, 42]);
assert.deepEqual(rows.map((r) => r.matched), [false, true, false]);
assert.equal(rows[1].spans.map((s) => s.text).join(''), '    let permission = 1; // permcheck');
assert.ok(rows[0].spans.some((s) => s.cls === 'keyword'), 'a preview row lost its syntax colors');

// The match's line shows the query; a line that merely holds its letters does not.
assert.deepEqual(marked(rows[1].spans), ['permcheck']);
assert.deepEqual(marked(codeRows('alpha permission check\n', 1, '/repo/a.txt', 'permcheck', 1)[0].spans).join(''), 'permcheck');
assert.deepEqual(marked(codeRows('alpha permission check\n', 1, '/repo/a.txt', 'permcheck', 9)[0].spans), []);
assert.deepEqual(marked(codeRows('the word here\n', 1, '/repo/a.txt', 'word', 9)[0].spans), ['word']);

// An empty line and a language the tokenizer does not know still make rows.
assert.deepEqual(codeRows('\n\n', 1, '/repo/a.unknown', 'x', 1).map((r) => r.spans), [[], []]);

// A match past the edge of a long line stays in view, with some text before it.
const long = 'x'.repeat(200) + ' needle tail';
const hitsOf = (text) => matchHits(text, 'needle');
const cutLine = clipped(long, hitsOf(long), 80);
assert.ok(cutLine.text.startsWith('…'));
assert.equal(cutLine.hits.length, cutLine.text.length);
assert.ok(cutLine.hits.lastIndexOf(true) < 80, 'the match is still past the edge');
assert.ok(cutLine.hits.indexOf(true) > 5, 'no text was kept before the match');
assert.deepEqual(marked(hitRuns(cutLine.text, cutLine.hits)), ['needle']);

// A line whose match already shows, or that has none, keeps its start.
assert.equal(clipped('a needle here', hitsOf('a needle here'), 80).text, 'a needle here');
assert.equal(clipped(long, new Array(long.length).fill(false), 80).text, long);

// The preview's matching line does the same, and only that line.
const wide = rowsOf(long + '\n' + long + '\n', 1, '/repo/a.txt', { query: 'needle', matchLine: 1, columns: 80 });
assert.ok(wide[0].spans[0].text === '…');
assert.deepEqual(marked(wide[0].spans), ['needle']);
assert.ok(wide[0].spans.map((s) => s.text).join('').length < long.length);
assert.equal(wide[1].spans.map((s) => s.text).join(''), long);

assert.equal(languageOf('TSX'), 'js');
assert.equal(languageOf('rs'), 'rs');
" || fail "results.js does not read the command's output"

echo "All checks passed."
