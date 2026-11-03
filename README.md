# Telescope for Herdr

A [Herdr](https://herdr.dev) app mod, inspired by
[telescope.nvim](https://github.com/nvim-telescope/telescope.nvim), that finds a
file in a few keystrokes. Type a few letters of a file's name or of something
inside it, see the file in a preview, and open it in your editor at the line
that matched.

![Telescope](preview.png)

- **Fuzzy search on names.** `perchk` finds `permission_check.rs`.
- **Fuzzy search on content.** `prmsion chk` finds "the permission check runs
  here". A repository of 3 million lines answers in under 100 ms on a warm disk
  cache.
- **Matches you can see.** The letters that matched are marked in the list, and
  in the preview of a content match, which also shows its line numbers.
- **What just changed.** One key limits both searches to the files git reports as
  changed, to read what an agent touched, or to search only inside it.
- **Where you were.** With nothing typed, the files you opened last come first.
- **A preview for most files.** Code with syntax highlighting, rendered
  Markdown, images, SVG, PDF and Office documents page by page, video frames,
  audio tags, archive listings, SQLite schemas, and a hex dump for the rest.
- **Your editor.** Neovim, Emacs, Helix and Nano open in a new pane; Zed and VS
  Code open on this computer. Enter uses the editor you used last.
- **Remote spaces too.** Searches and previews run on the machine that holds the
  files, so a space on another machine works like a local one.

## Requirements

- The Herdr app (tested with 0.1.12) and herdr-core (tested with 0.1.17).
- On every machine whose files you browse: bash, GNU coreutils, and
  [ripgrep](https://github.com/BurntSushi/ripgrep),
  [fzf](https://github.com/junegunn/fzf) and [jq](https://jqlang.org). It targets
  Linux; macOS would need GNU coreutils.

Previews use these tools when the machine has them. Without one, the preview
shows the file's details and names what to install.

| Files | Tool |
|---|---|
| PNG, JPEG, WebP, GIF, BMP, TIFF, AVIF, HEIC, ICO | ImageMagick 7 (`magick`) |
| SVG | librsvg (`rsvg-convert`) |
| PDF | poppler-utils (`pdftoppm`, `pdfinfo`) |
| Word, Excel, PowerPoint, OpenDocument, RTF | LibreOffice (`soffice`) and poppler-utils |
| Video | `ffmpegthumbnailer`, and `ffprobe` for its details |
| Audio | `ffprobe` |
| Archives | libarchive (`bsdtar`) |
| SQLite | `sqlite3` |
| Type of other binary files | `file` |

Install [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) too: it
runs these tools in a sandbox, as described under
[What it runs and reads](#what-it-runs-and-reads).

## Install

1. Install `herdr-telescope` on every machine whose files you browse: this one,
   and each machine of a remote space, because the mod runs it there.

   ```sh
   install -D -m 755 herdr-telescope/herdr-telescope.sh ~/.local/bin/herdr-telescope
   ```

   Update it whenever you update the mod. The dialog warns when a machine's copy
   is older than the mod.

2. Copy the mod into the Herdr app's folder and check it:

   ```sh
   cp -r mods/telescope ~/.config/herdr-app/mods/
   herdr-app check ~/.config/herdr-app/mods/telescope
   ```

3. Give it a key: merge [keys.json](keys.json) into
   `~/.config/herdr-app/keys.json`, which adds this to its `global` section:

   ```json
   "ctrl-shift-f": "mod.open:telescope"
   ```

## Keys

| Key | Action |
|---|---|
| `ctrl-g` | Switch between Files and Content |
| up, down, `ctrl-p`, `ctrl-n`, page up, page down | Move the selection |
| Enter | Open in the last used editor |
| `ctrl-1` to `ctrl-6` | Open in Neovim, Zed, VS Code, Emacs, Helix or Nano |
| `ctrl-u`, `ctrl-d` | Scroll the preview, or turn the page of a document |
| `ctrl-o` | Only files git reports as changed, as the **Changed** button does |
| `ctrl-s` | Match case, as the **Aa** button does |
| `ctrl-t` | Include the files that `.gitignore` leaves out |
| Esc | Close |

The search starts at the git root of the focused terminal, or at its folder
outside a repository. It includes hidden files and leaves out `.git`.

## Search syntax

Both modes take [fzf's search syntax](https://junegunn.github.io/fzf/search-syntax/).
Terms separated by a space must all match:

| Term | Meaning |
|---|---|
| `word` | The letters of `word`, in order |
| `'word` | Exactly `word` |
| `!word` | Not `word` |
| `^word`, `word$` | Starts or ends with `word` |

A term in lower case ignores case, and a capital letter makes that term match its
case: `editors` finds `EDITORS`, but `EDITORS` does not find `editors`. To match the
case of a term in lower case, press `ctrl-s` or the **Aa** button. It stays on until
the dialog closes.

## What it runs and reads

The mod runs `git`, `sh` and `herdr-telescope` on the machine of the space it
shows, and the editors as described above. `herdr-telescope` runs `rg`, `fzf`
and the preview tools listed under [Requirements](#requirements). It only reads
files, and makes no network request. Preview images are kept in the mod's
`.cache/` folder until the popup next opens, converted Office documents in
`$XDG_RUNTIME_DIR/herdr-telescope/` for a day, and the last used editor and mode,
with the paths of the 30 files you opened last in each of 50 folders, in
`~/.config/herdr-app/telescope/state.json`.

**Moving the selection onto a file runs its preview tool on that file**, so a
malicious file in a repository you do not trust reaches ImageMagick, ffmpeg, poppler
or LibreOffice. With bubblewrap, those tools run with no network and an empty
environment. They see the system's files, the file itself and a throwaway folder,
but not your home folder or `/run`. Text is only read, so it needs no sandbox.

Without bubblewrap, or where it cannot start, as inside some containers, previews
still work but those tools run unprotected. To keep files away from a converter
there, do not install it on that machine.

## For other mods

`run("mod.open", { name: "telescope" })` opens the dialog, and running it again
closes it. A tab bar can offer this as a button, with the icon
`mods/telescope/icons/telescope.svg`.

## Development

```sh
bash herdr-telescope/test.sh herdr-telescope/herdr-telescope.sh
herdr-app check mods/telescope
```

`test.sh` needs rg, fzf, jq, file, magick, rsvg-convert, pdftoppm, pdfinfo,
bsdtar, sqlite3 and node. [RECIPE.md](RECIPE.md) describes how the mod behaves
and why.

## Licence

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The icons come from
Simple Icons (CC0 1.0), Codicons (CC BY 4.0) and Lucide (ISC), as NOTICE details.
