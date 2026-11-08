# Telescope

A dialog that finds a file by its name or by its content, previews it, and opens
it in an editor, in the way of telescope.nvim. Every search and preview runs a
small command, `herdr-telescope`, on the machine that holds the files.

## What you see

A dialog of 90% of the window's width and 85% of its height, top to bottom:

1. **Header**, 54px: the telescope icon in the theme's accent, two pills,
   **Files | Content**, the search box with its **Changed**, **Exact**, **.\*** and
   **Aa** buttons, on `accent` while they are on, and the number of results.
2. **Body**, the rest, in two equal halves.
   - Left, the results in a virtual list. In Files a 28px row shows the file's
     name, then its folder dimmed. In Content a 46px row shows the matching line
     in the code font, then `path:line` dimmed. Matched letters are marked as a
     search hit in an editor: `background` on `ansi3`. The selected row sits on
     `selected`.
   - Right, the preview on `background`: a 30px title with the path, the line or
     the page, then the preview itself. A content match shows its lines with their
     numbers, the matching line on `selected`, and the query's letters marked.
3. **Footer**, 40px: an **Open with** radio group, one option per editor with
   its icon and key, the selected editor marked with a filled circle, a **Reveal**
   button when filetree can answer, then the key hints naming the editor Enter will
   open.

## How it behaves

- It follows the focused terminal's folder and that space's machine, and
  searches from the git root there, or from that folder outside a repository.
- Typing searches after 40 ms and moving the selection previews after 80 ms. One
  search and one preview run at a time. When one ends and the person has moved
  on, its answer is dropped and the next one starts at once.
- When Herdr already runs as many commands as it allows, the dialog says
  "Searching…" and waits for up to 30 seconds. Only then does it show the error.
- An older preview stays until the new one is ready, so nothing flickers.
- Content mode needs a query; an empty query shows a hint.
- A term that fits in a file's name is marked there, not in its folders. A term
  is marked only when all of it matches. In a content preview the matching line
  shows the fuzzy letters; other lines show only exact terms, because any line
  holds a query's letters somewhere.
- Case follows fzf's smart case, term by term: a term in lower case ignores case,
  and a capital letter makes that term match its case. **Aa** and `ctrl-s` make
  every term match its case until the dialog closes. It is not remembered, because
  a forgotten switch would quietly hide results from later searches. The marks
  apply the same rule, so they never show a letter the search left out.
- **Exact** and `ctrl-e` make each term match only as letters in a row, which is
  fzf's `--exact`; a term starting with `'` is then the fuzzy one. Matches are
  still ranked, and only letters in a row are marked.
- **.\*** and `ctrl-w` make the query one regular expression in rg's syntax. In
  Files it matches the relative path. The results come in path and line order,
  shown as "First 500" when they reach the limit. Every match is marked, on every
  line of the preview. A capital letter makes it match its case, but not a letter
  in an escape such as `\W`, in `\p{…}` or in a group's name. An invalid expression
  shows rg's reason in place of the results.
- Exact and regular expression exclude each other: turning one on turns the other
  off. Like **Aa**, they last until the dialog closes.
- **Changed** and `ctrl-o` limit both searches to what `git status` reports, until
  the dialog closes. Deleted files are left out, because they cannot be opened. An
  empty query in Files then lists what changed.
- A text preview is a window of 400 lines, at most 64 KiB. For a content match
  it starts 10 lines above the match. `ctrl-u` and `ctrl-d` move the window by 20
  lines, and turn the page of a PDF or document.
- A long line whose match would fall past the edge loses its start, with "…" in
  its place and 12 letters kept before the match. This applies to a row of the list
  and to the matching line of the preview, whose width is measured in code-font
  letters, about 0.6 of the font's size each.
- An editor's radio control selects it without opening a file. Enter opens the
  selected file in that editor. `ctrl-1` to `ctrl-8` open immediately in their
  editor, which also becomes the selection. Both kinds of choice are remembered.
- Only installed editors appear. Terminal editors are checked on the machine
  holding the files, in the login shell that starts them; Zed and VS Code are
  checked on this computer, in the environment used to run their commands.
  Checks run whenever the dialog opens. A hidden editor's shortcut does nothing,
  and the other editors keep their numbers. An unavailable remembered choice
  falls back to the first available editor. With none installed, Enter does
  nothing and the footer says so; a failed check shows its error instead.
- A terminal editor opens in a new pane to the right, or in a new tab when a
  layout terminal block has the focus, because a split needs a pane. The pane
  closes when the editor ends. An editor the machine does not have says so in the
  pane, which closes on Enter.
- Zed and VS Code run on this computer. For a remote space they connect to the
  SSH host that `hc machine ls` gives for the machine. If one fails to start, a
  notification says why.
- `ctrl-r` and the **Reveal** button show the selected file in filetree, when a block
  of the side panel holds that mod, under any id. The side panel opens on that block's
  Tree tab, the file's folders open, its row is selected and centred, and the dialog
  closes. The footer offers the key and the button only when this can work. Without
  filetree's folder, or with no such block in the shown layout, the key does nothing.
- Opening a file in an editor shows it in filetree in the same way. Where that cannot
  work the file still opens, without a warning, because a warning on each open would
  only be noise.
- filetree shows the focused terminal's folder and the search starts at the git root,
  so `ctrl-r` on a file outside that folder gets a warning. A preview or a filter open
  in the panel stays open, and the row is selected behind it.
- With no query in Files, the files opened last in that folder on that machine
  come first, tagged "recent", as long as they still exist. A query ranks by the
  match alone.
- The last used editor and mode, and the 30 files opened last in each of the last
  50 folders, are kept in `~/.config/herdr-app/telescope/state.json`.

## Built from

- `mods/telescope/main.js`: the view. `results.js`: reads the command's output and
  finds the letters to highlight. `code.js`: the rows of a content preview.
  `highlight.js`: their syntax colors, the tokenizer of herdr-commit-review.
  `editors.js`: the editors and their commands. `preview.js`: runs the preview and
  stores its image.
- `herdr-telescope/herdr-telescope.sh`: bash, with rg, fzf and jq.
- `herdr` functions: `exec`, `hc`, `run` (`terminal.open`, `layout.select`,
  `layout.show`), `focused`, `spaces`, `panes`, `layout`, `theme`, `settings`, `props`,
  `closeOverlay`, `nextCommand`, `notify`, `appHome`, `home`, `readTextFile`,
  `setShared`. `gpui-base`: `Input`, `Editor`, `TextView`, `v_virtual_list`,
  `Scrollbar`, `Radio`, `RadioGroup`. `fs/promises` and `Buffer` store images.
- Icons: Simple Icons, Codicons and Lucide, drawn with `svg()` so they follow the
  theme. Nano has no logo with a clear licence, so its icon is an "n" of our own;
  Micro uses an "M" drawn for this project.

## Watch out

- `exec` cannot cancel a command, returns nothing until the command ends, kills
  it after 30 seconds, and keeps 8 MiB of its output, or about 6 MiB of a remote
  machine's. So every search runs under `timeout 8` and is cut to 500 results, a
  converter runs under `timeout 20`, and an image is resized to fit.
- `herdr-core` refuses a command while 16 are running, and every mod counts towards
  those 16. `exec` then rejects at once instead of queueing the command. The dialog
  cannot work without its root folder, so `patientExec` in `main.js` retries for 30
  seconds, the longest a command can hold its place. It recognises the refusal by
  its words, so a new wording shows the error at once, as any other failure does.
  `open()` starts an editor or writes filetree's line after the dialog has closed, and
  does not retry.
- Mod tasks run on the app's foreground executor, so `fzf` ranks the results on
  the file's machine. A JavaScript matcher could stall the window on a large tree.
- Content search is `rg`, then `fzf`. Each term becomes a pattern of its letters
  in order (`p.*e.*r.*m`), or in a row for an exact term (`perm`), so `rg` keeps
  only lines `fzf` could match, and `fzf` ranks those. Ranking every line instead
  took about 15 times as long on 3 million lines. With **Exact**, a term starting
  with `'` must keep its fuzzy pattern, or `rg` would drop lines `fzf` would match.
- A pattern writes punctuation as `\x{..}`, because some escaped characters, such
  as `\<`, have a meaning of their own in `rg`'s regex syntax.
- `fzf` cannot apply a regular expression, so a regex search is `rg` alone. Its
  lines are sorted by path and line, and its paths by name, because `rg`'s threads
  print in a different order on each run. Sorting keeps `rg` multithreaded, where
  `rg --sort=path` would search with one thread.
- Every search pipeline ends in `head` or `sort`, whose exit status hides `rg`'s.
  So `check_regex` asks `rg` to read the expression first, and fails with `rg`'s
  reason when it cannot.
- The mod decides the smart case of a regular expression and passes
  `--case-sensitive`, instead of using `rg --smart-case`. That flag treats a
  pattern without plain letters, such as `[a-z]+`, as case-sensitive, a rule the
  marks could not follow. The marks use JavaScript's `RegExp`, which reads a few
  of `rg`'s patterns differently or not at all, such as `(?i)x` or `\pL`: these
  find the same lines but mark nothing. A JavaScript expression can also take very
  long on a pathological pattern, which `rg`'s engine never does, and the marks run
  on the app's thread.
- `rg` separates its fields with 0x1f, because a path can contain `:`. With no path
  it searches a readable stdin, so its stdin is `/dev/null`.
- `image()` reads only from the app's folder, and the bytes of a remote file reach
  it through the JSON the command prints. Each image gets a new name, because
  Herdr keeps a loaded image by its path.
- An image reaches `magick` on stdin with its format named, so neither its file
  name nor its content can select a format such as MVG. An SVG goes to
  `rsvg-convert`, because `magick` would hand it to Inkscape if it found it.
- Every tool that parses a file goes through `run_tool`, which runs it under
  bubblewrap when bubblewrap can start. A new preview must do the same. The sandbox
  hides the home folder, so `run_tool` uses the tool's real path, and it hides
  `/run`, so only `/run/current-system` is shown. A converted document's cache is
  the one folder added, for LibreOffice's profile and its PDF.
- The mod and the command update apart, and another machine can lag behind. When the
  mod starts to need something new from the command, raise `INTERFACE_VERSION` in the
  command and `COMMAND_VERSION` in `results.js` together; `test.sh` fails if they
  differ. The dialog warns when a machine's command is older. A command from before
  `--version` prints no number, which counts as older.
- `Editor` has no call to scroll, to go to a line or to mark text. A file therefore
  shows in `Editor` without line numbers, and a content match is drawn line by
  line by `code.js`, whose tokenizer is simpler than `Editor`'s.
- `syntect` highlights the whole document again on each change, so a preview stays
  small.
- `terminal.open` starts a program directly, in herdr-core's environment, and on
  another machine that can be an SSH session's minimal PATH. `tab.new` wraps its
  command in a login shell, and `inLoginShell` does the same here.
- filetree has no public key for a reveal: `filetree.preview` only opens a preview
  and `filetree.view` only picks a tab. So `ctrl-r` adds the `mention` line that
  filetree's Claude Code hook writes to `~/.local/state/herdr-filetree/activity.jsonl`.
  That format is private to filetree: if it changes, `ctrl-r` does nothing and says
  nothing. The file is on this computer even for a remote space, because filetree
  reads it here and only matches the path against the folder it shows.
- A mod's copy starts the first time it shows, and filetree misses a line written
  before its watch begins, so `ctrl-r` waits 300 ms when its block was not on screen.
  `<mod>.<command>` would not help: it reaches shown copies only and carries no data.
- `open()` closes the dialog at once, because keeping it would hand the focus back to
  the search box instead of a terminal editor's new pane. A task's `cx` ends with the
  dialog, so that wait is a `sleep` in the shell command. A terminal editor always
  waits: its pane takes the focus, and filetree must move to that pane's folder before
  it reads the line.
- A key can only toggle a mod, not pass it an argument, so one key opens the
  dialog and `ctrl-g` switches the mode.
- Editor keys belong in the `mod:telescope` section of `keys.json` and reach
  `nextCommand()`. Herdr's global tab bindings intercept the same keys before
  a raw `on_key_down` handler can see them.
- `h_flex` centers its children, so the body needs `items_stretch` or the two
  halves collapse.

## Done when

- `bash herdr-telescope/test.sh herdr-telescope/herdr-telescope.sh` passes, and
  fails when the limit on results or the escaping of punctuation is removed.
- `herdr-app check mods/telescope` passes.
- `ctrl-shift-f` opens the dialog on the focused terminal's repository, and typing
  narrows the list as you type.
- `ctrl-g` and a misspelled phrase find the right lines, with the matching letters
  marked in the list and in the preview.
- `ctrl-e` drops the misspelled phrase's results, `ctrl-w` with `permission\s+check`
  finds the line again in path order, and each one's button lights up and turns the
  other off.
- Moving through a code file, Markdown, an image, a PDF and a binary file shows
  each one's preview.
- Each editor opens a content match on its line, and a terminal editor's pane
  closes when the editor ends.
- Choosing an editor's radio control keeps the dialog open, and Enter opens in
  that editor. Each editor shortcut opens directly while Telescope has focus.
- With filetree in the side panel, `ctrl-r`, the **Reveal** button and opening a file
  each show the file there, also when filetree has never been shown. Without filetree
  the key does nothing, the button is gone, and files open as usual.
