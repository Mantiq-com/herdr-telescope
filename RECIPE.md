# Telescope

A dialog that finds a file by its name or by its content, previews it, and opens
it in an editor, in the way of telescope.nvim. Every search and preview runs a
small command, `herdr-telescope`, on the machine that holds the files.

## What you see

A dialog of 90% of the window's width and 85% of its height, top to bottom:

1. **Header**, 54px: the telescope icon in the theme's accent, two pills,
   **Files | Content**, the search box with its **Changed** and **Aa** buttons, on
   `accent` while they are on, and the number of results.
2. **Body**, the rest, in two equal halves.
   - Left, the results in a virtual list. In Files a 28px row shows the file's
     name, then its folder dimmed. In Content a 46px row shows the matching line
     in the code font, then `path:line` dimmed. Matched letters are marked as a
     search hit in an editor: `background` on `ansi3`. The selected row sits on
     `selected`.
   - Right, the preview on `background`: a 30px title with the path, the line or
     the page, then the preview itself. A content match shows its lines with their
     numbers, the matching line on `selected`, and the query's letters marked.
3. **Footer**, 40px: one button per editor with its icon and key, the last used
   editor highlighted, then the key hints.

## How it behaves

- It follows the focused terminal's folder and that space's machine, and
  searches from the git root there, or from that folder outside a repository.
- Typing searches after 40 ms and moving the selection previews after 80 ms. One
  search and one preview run at a time. When one ends and the person has moved
  on, its answer is dropped and the next one starts at once.
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
- **Changed** and `ctrl-o` limit both searches to what `git status` reports, until
  the dialog closes. Deleted files are left out, because they cannot be opened. An
  empty query in Files then lists what changed.
- A text preview is a window of 400 lines, at most 64 KiB. For a content match
  it starts 10 lines above the match. `ctrl-u` and `ctrl-d` move the window by 20
  lines, and turn the page of a PDF or document.
- Enter opens the selected file in the last used editor. The buttons and their
  keys open it in that editor, which becomes the last used.
- A terminal editor opens in a new pane to the right, or in a new tab when a
  layout terminal block has the focus, because a split needs a pane. The pane
  closes when the editor ends. An editor the machine does not have says so in the
  pane, which closes on Enter.
- Zed and VS Code run on this computer. For a remote space they connect to the
  SSH host that `hc machine ls` gives for the machine. If one fails to start, a
  notification says why.
- The last used editor and mode are kept in
  `~/.config/herdr-app/telescope/state.json`.

## Built from

- `mods/telescope/main.js`: the view. `results.js`: reads the command's output and
  finds the letters to highlight. `code.js`: the rows of a content preview.
  `highlight.js`: their syntax colors, the tokenizer of herdr-commit-review.
  `editors.js`: the editors and their commands. `preview.js`: runs the preview and
  stores its image.
- `herdr-telescope/herdr-telescope.sh`: bash, with rg, fzf and jq.
- `herdr` functions: `exec`, `hc`, `run` (`terminal.open`), `focused`, `spaces`,
  `panes`, `theme`, `settings`, `props`, `closeOverlay`, `notify`, `appHome`,
  `readTextFile`. `gpui-base`: `Input`, `Editor`, `TextView`, `v_virtual_list`,
  `Scrollbar`. `fs/promises` and `Buffer` store images.
- Icons: Simple Icons, Codicons and Lucide, drawn with `svg()` so they follow the
  theme. Nano has no logo with a clear licence, so its icon is an "n" of our own.

## Watch out

- `exec` cannot cancel a command, returns nothing until the command ends, kills
  it after 30 seconds, and keeps 8 MiB of its output, or about 6 MiB of a remote
  machine's. So every search runs under `timeout 8` and is cut to 500 results, a
  converter runs under `timeout 20`, and an image is resized to fit.
- Mod tasks run on the app's foreground executor, so `fzf` ranks the results on
  the file's machine. A JavaScript matcher could stall the window on a large tree.
- Content search is `rg`, then `fzf`. Each term becomes a pattern of its letters
  in order (`p.*e.*r.*m`), so `rg` keeps only lines `fzf` could match, and `fzf`
  ranks those. Ranking every line instead took about 15 times as long on 3
  million lines.
- A pattern writes punctuation as `\x{..}`, because some escaped characters, such
  as `\<`, have a meaning of their own in `rg`'s regex syntax.
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
- `Editor` has no call to scroll, to go to a line or to mark text. A file therefore
  shows in `Editor` without line numbers, and a content match is drawn line by
  line by `code.js`, whose tokenizer is simpler than `Editor`'s.
- `syntect` highlights the whole document again on each change, so a preview stays
  small.
- `terminal.open` starts a program directly, in herdr-core's environment, and on
  another machine that can be an SSH session's minimal PATH. `tab.new` wraps its
  command in a login shell, and `inLoginShell` does the same here.
- A key can only toggle a mod, not pass it an argument, so one key opens the
  dialog and `ctrl-g` switches the mode.
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
- Moving through a code file, Markdown, an image, a PDF and a binary file shows
  each one's preview.
- Each editor opens a content match on its line, and a terminal editor's pane
  closes when the editor ends.
