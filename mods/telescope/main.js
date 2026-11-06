// Telescope: find a file by name or by its content, preview it, and open it in
// an editor. Every search and preview runs herdr-telescope on the machine that
// holds the files, because exec() returns only once a command has ended and
// cannot cancel it: one call at a time, and when the person has moved on by the
// time it ends, the next call starts at once and the answer is dropped.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState, Radio, RadioGroup, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { appHome, closeOverlay, exec, focused, hc, home, layout, nextCommand, notify, panes, props, readTextFile, run, setShared, settings, spaces, theme } from "herdr";
import * as fs from "fs/promises";
import { EDITORS, availableEditors, inLoginShell, openCommand } from "./editors.js";
import { codeRows } from "./code.js";
import { clearImages, loadPreview } from "./preview.js";
import { clipped, commandIsCurrent, hitRuns, languageOf, matchHits, parseResults, pathHits } from "./results.js";

const TYPING_DELAY = 40;
const SELECTION_DELAY = 80;
const FILE_ROW = 28;
const HIT_ROW = 46;
const HIT_FONT = 12.5;
const LINE_ROW = 20;
const GUTTER = 60;
const PAGE_ROWS = 12;
const SCROLL_LINES = 20;
const RESULT_LIMIT = 500;
const RECENT_FILES = 30;
const RECENT_FOLDERS = 50;
const BUSY = "execs are running already";
const BUSY_RETRY = 250;
const BUSY_WAIT = 30000;
const REVEAL_WAIT = 300;
const APPEND_LINE = 'mkdir -p "$(dirname "$1")" && printf "%s\\n" "$2" >> "$1"';

const stateFile = () => `${appHome()}/telescope/state.json`;
const filetreeActivity = () => `${home()}/.local/state/herdr-filetree/activity.jsonl`;
const codeFont = () => (typeof settings().font === "string" && settings().font) || "JetBrains Mono";
const codeSize = () => Math.max(9, (Number(settings().font_size) || 14) - 1);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A code font's letter is about this much of its size wide.
const columnsIn = (width, fontSize) => Math.floor(width / (fontSize * 0.6));

// All mods share herdr-core's 16 running commands, and it refuses a command past
// them instead of queueing it. exec ends each within 30 seconds, so one frees up by then.
const patientExec = (cx) => async (...args) => {
  for (let waited = 0; ; waited += BUSY_RETRY) {
    try {
      return await exec(...args);
    } catch (error) {
      if (waited >= BUSY_WAIT || !String(error.message ?? error).includes(BUSY)) throw error;
      await cx.sleep(BUSY_RETRY);
    }
  }
};

// Where the person is working. A focused layout terminal block has no pane, and
// its address names its machine ("machine/t7").
function location() {
  const now = focused();
  const space = spaces().find((s) => s.id === now?.space) ?? spaces().find((s) => s.active);
  const pane = now?.pane ? panes().find((p) => p.pane === now.pane) : null;
  const inBlock = !now?.pane && Boolean(now?.terminal);
  const machine = inBlock ? (now.terminal.includes("/") ? now.terminal.split("/")[0] : null) : (space?.machine ?? null);
  return { folder: pane?.cwd || now?.cwd || space?.folder || null, machine };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The block of Herdr's side panel that holds filetree. A layout can give it the Files
// block or one of its own, so the mod identifies it and not the block's id.
function filetreePanel() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  const block = body?.children?.find((child) => child.content?.mod === "filetree");
  return panel && block ? { panel, body, block } : null;
}

// filetree has no public key for a reveal, so the request is the line its Claude Code
// hook writes when a prompt mentions a file. It reads that file on this computer, also
// for a remote space.
async function writeMention(execute, script, folder, file) {
  try {
    const line = JSON.stringify({ at: Date.now(), cwd: folder, kind: "mention", paths: [file] });
    const written = await execute("sh", ["-c", script, "telescope", filetreeActivity(), line]);
    if (written.code !== 0) throw new Error(written.stderr.trim() || `sh exited with ${written.code}`);
  } catch (reason) {
    notify({ title: "Could not reveal the file", body: String(reason.message ?? reason), level: "error" });
  }
}

async function sshHost(machine) {
  const listed = await hc(["machine", "ls", "--json"]);
  const found = (JSON.parse(listed.stdout).machines ?? []).find((m) => m.name === machine);
  return found?.target && !found.via ? found.target : machine;
}

function syntaxColors(t) {
  return {
    keyword: t.ansi5, string: t.ansi2, "string.escape": t.ansi3, comment: t.dim, function: t.ansi4, type: t.ansi6,
    number: t.ansi3, constant: t.ansi3, boolean: t.ansi3, variable: t.foreground, operator: t.muted, punctuation: t.muted,
    property: t.ansi4,
  };
}

export default class Telescope extends View {
  init(_props, cx) {
    this.mode = "files";
    this.editor = null;
    this.editors = [];
    this.checkingEditors = true;
    this.filetree = false;
    this.ignored = false;
    this.matchCase = false;
    this.changed = false;
    this.recent = {};
    this.results = [];
    this.selected = 0;
    this.searched = null;
    this.searching = false;
    this.previewing = false;
    this.preview = null;
    this.first = 0;
    this.page = 1;
    this.viewport = { width: 400, height: 400 };
    this.listWidth = 500;
    this.codeWidth = 500;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.lineScroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search…" });
    this.input.on("change", (_e, cx) => this.queueSearch(cx));
    this.input.on("submit", (_e, cx) => this.open(this.editor, cx));
    // The keyboard belongs in the search box: a click on the preview must not
    // leave the arrow keys with nowhere to go.
    this.input.on("blur", (_e, cx) => cx.timer.after(40, () => { if (!this.closed) this.input.focus(); }));
    this.input.focus();
    cx.timer.after(600, () => { if (!this.closed) this.input.focus(); });
    cx.spawn(async (cx) => {
      await this.start(cx);
      if (this.closed) return;
      this.search(cx);
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed) return;
        const editor = this.editors.find((e) => command === `open-${e.id}`);
        if (editor) this.open(editor.id, cx);
        cx.notify();
      }
    });
  }

  async start(cx) {
    await clearImages().catch((error) => console.warn(`telescope: ${error}`));
    await this.loadState();
    const { folder, machine } = location();
    this.folder = folder;
    this.machine = machine;
    const checked = Promise.all([this.checkCommand(cx), this.checkEditors(cx), this.checkFiletree()]);
    try {
      const found = await patientExec(cx)("sh", ["-c", "git rev-parse --show-toplevel 2>/dev/null || pwd"], { cwd: folder ?? undefined, on: machine });
      this.root = found.stdout.trim();
    } catch (error) {
      this.error = String(error.message ?? error);
    }
    await checked;
  }

  async checkEditors(cx) {
    try {
      this.editors = await availableEditors(patientExec(cx), this.machine);
      if (!this.editors.some((editor) => editor.id === this.editor)) this.editor = this.editors[0]?.id ?? null;
    } catch (error) {
      this.editorError = String(error.message ?? error);
    }
    this.checkingEditors = false;
  }

  async checkFiletree() {
    try {
      this.filetree = await fs.exists(`${appHome()}/mods/filetree/main.js`);
    } catch (error) {
      console.warn(`telescope: ${error}`);
    }
  }

  // The mod and the command update apart, and another machine can lag behind. A
  // command that cannot run is left to the first search, which says why.
  async checkCommand(cx) {
    const version = await patientExec(cx)("herdr-telescope", ["--version"], { on: this.machine }).catch(() => null);
    if (!version || commandIsCurrent(version.stdout)) return;
    this.warning = `herdr-telescope${this.machine ? ` on ${this.machine}` : ""} is older than this mod, so some searches can fail. Update it.`;
  }

  async loadState() {
    try {
      const state = JSON.parse((await readTextFile(stateFile())) ?? "{}");
      if (EDITORS.some((e) => e.id === state.editor)) this.editor = state.editor;
      if (state.mode === "files" || state.mode === "grep") this.mode = state.mode;
      this.recent = state.recent ?? {};
    } catch (error) {
      console.warn(`telescope: ${stateFile()}: ${error}`);
    }
  }

  saveState() {
    const save = async () => {
      await fs.mkdir(`${appHome()}/telescope`, { recursive: true });
      await fs.writeFile(stateFile(), JSON.stringify({ editor: this.editor, mode: this.mode, recent: this.recent }));
    };
    save().catch((error) => console.warn(`telescope: ${stateFile()}: ${error}`));
  }

  recentPaths() {
    return this.recent[`${this.machine ?? ""}:${this.root}`] ?? [];
  }

  // The folder used last moves to the end, so the oldest folder is the one dropped.
  remember(path) {
    const key = `${this.machine ?? ""}:${this.root}`;
    const paths = [path, ...this.recentPaths().filter((p) => p !== path)].slice(0, RECENT_FILES);
    delete this.recent[key];
    this.recent[key] = paths;
    for (const old of Object.keys(this.recent).slice(0, -RECENT_FOLDERS)) delete this.recent[old];
  }

  wanted() {
    return { mode: this.mode, query: this.input.value(), ignored: this.ignored, matchCase: this.matchCase, changed: this.changed };
  }

  queueSearch(cx) {
    this.searchTimer?.cancel();
    this.searchTimer = cx.timer.after(TYPING_DELAY, (cx) => this.search(cx));
  }

  search(cx) {
    if (this.searching || !this.root) return;
    const request = this.wanted();
    if (same(request, this.searched)) return;
    if (request.mode === "grep" && !request.query.trim()) {
      this.searched = request;
      this.show([], null, cx);
      return;
    }
    this.searching = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const flags = [request.ignored && "--no-ignore", request.matchCase && "--case-sensitive", request.changed && "--changed"].filter(Boolean);
      if (request.mode === "files" && !request.query) flags.push(...this.recentPaths().flatMap((path) => ["--recent", path]));
      let results = [], error = null;
      try {
        const found = await patientExec(cx)("herdr-telescope", [request.mode, ...flags, "--", this.root, request.query], { on: this.machine });
        if (found.code !== 0) error = found.stderr.trim() || "The search failed.";
        else results = parseResults(request.mode, found.stdout);
      } catch (reason) {
        error = `herdr-telescope could not run${this.machine ? ` on ${this.machine}` : ""}: ${reason.message ?? reason}`;
      }
      this.searching = false;
      if (this.closed) return;
      if (same(request, this.wanted())) {
        this.searched = request;
        this.show(results, error, cx);
      } else this.search(cx);
    });
  }

  show(results, error, cx) {
    this.results = results;
    this.error = error;
    this.selected = 0;
    this.scroll.scroll_to_item(0);
    this.selectionChanged(cx);
    cx.notify();
  }

  selectionChanged(cx) {
    this.first = 0;
    this.page = 1;
    this.queuePreview(cx);
  }

  absolute(result) {
    return `${this.root}/${result.path}`;
  }

  wantedPreview() {
    const result = this.results[this.selected];
    if (!result) return null;
    // A content match shows the query's letters, so a new query redraws it.
    const query = result.line ? this.input.value() : "";
    return { path: this.absolute(result), line: result.line, first: this.first, page: this.page, query, matchCase: this.matchCase };
  }

  queuePreview(cx) {
    this.previewTimer?.cancel();
    this.previewTimer = cx.timer.after(SELECTION_DELAY, (cx) => this.loadPreview(cx));
  }

  loadPreview(cx) {
    if (this.previewing) return;
    const request = this.wantedPreview();
    if (same(request, this.preview?.request ?? null)) return;
    if (!request) {
      this.setPreview(null);
      cx.notify();
      return;
    }
    this.previewing = true;
    cx.spawn(async (cx) => {
      let preview;
      try {
        preview = await loadPreview(patientExec(cx), request, this.machine);
      } catch (reason) {
        preview = { kind: "error", text: String(reason.message ?? reason) };
      }
      this.previewing = false;
      if (this.closed) return;
      if (same(request, this.wantedPreview())) {
        // Scrolled past the end of the file: stay on the last window.
        if (request.first && preview.text === "") this.first = this.preview.first_line;
        else this.setPreview({ ...preview, request });
        cx.notify();
      } else this.loadPreview(cx);
    });
  }

  buildRows() {
    const { text, first_line: first, request } = this.preview;
    const { line: matchLine, path, query, matchCase } = request;
    this.rows = codeRows(text, first, path, { query, matchLine, matchCase, columns: columnsIn(this.codeWidth - GUTTER, codeSize()) });
  }

  setPreview(preview) {
    this.preview = preview;
    const lines = preview?.kind === "text" || preview?.kind === "markdown";
    this.rows = null;
    if (lines && preview.request.line) {
      this.buildRows();
      this.lineScroll.scroll_to_item(0);
    }
    const text = !this.rows && (preview?.kind === "text" || preview?.kind === "details");
    const language = text ? languageOf(preview.language) : null;
    if (text && this.code && this.codeLanguage === language) this.code.set_value(preview.text);
    else {
      this.code?.release();
      this.code = text ? EditorState.new({
        language, value: preview.text, readonly: true, line_numbers: false, folding: false,
        font_family: codeFont(), font_size: codeSize(), syntax: syntaxColors(theme()),
      }) : null;
      this.codeLanguage = language;
    }
  }

  move(delta, cx) {
    const last = this.results.length - 1;
    const next = Math.max(0, Math.min(last, this.selected + delta));
    if (next === this.selected || last < 0) return;
    this.select(next, cx);
  }

  select(index, cx) {
    this.selected = index;
    this.scroll.scroll_to_item(index);
    this.selectionChanged(cx);
  }

  // Scrolling moves the window of lines, because Editor has no way to scroll
  // from code, and turns the page of a document.
  scrollPreview(direction, cx) {
    const shown = this.preview;
    if (!shown) return;
    if (shown.kind === "image") {
      const page = Math.max(1, Math.min(shown.pages, shown.page + direction));
      if (page === shown.page) return;
      this.page = page;
    } else if (shown.first_line) {
      const first = Math.max(1, shown.first_line + direction * SCROLL_LINES);
      if (first === shown.first_line) return;
      this.first = first;
    } else return;
    this.queuePreview(cx);
  }

  // The options below last until the dialog closes: a forgotten one would quietly
  // hide results from later searches.
  flip(option, cx) {
    this[option] = !this[option];
    this.search(cx);
    cx.notify();
  }

  setMode(mode, cx) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.results = [];
    this.saveState();
    this.search(cx);
    cx.notify();
  }

  selectEditor(id, cx) {
    if (!this.editors.some((editor) => editor.id === id)) return;
    this.editor = id;
    this.saveState();
    this.input.focus();
    cx.notify();
  }

  open(id, cx) {
    const editor = this.editors.find((e) => e.id === id);
    if (!editor) return;
    const result = this.results[this.selected];
    if (!result) return;
    const target = { path: this.absolute(result), line: result.line, column: result.column };
    const machine = this.machine;
    this.editor = id;
    this.remember(result.path);
    this.saveState();
    if (editor.terminal) {
      // A split needs a pane, and a focused layout terminal block has none.
      run("terminal.open", { argv: inLoginShell(openCommand(id, target, null)), folder: this.root, place: focused()?.pane ? "right" : "tab" });
    } else {
      // The popup closes at once, and with it this view, so the task outlives it.
      cx.spawn(async () => {
        try {
          const [program, ...args] = openCommand(id, target, machine ? await sshHost(machine) : null);
          const opened = await exec(program, args);
          if (opened.code !== 0) throw new Error(opened.stderr.trim() || `${program} exited with ${opened.code}`);
        } catch (reason) {
          notify({ title: `Could not open ${editor.name}`, body: String(reason.message ?? reason), level: "error" });
        }
      }, { owner: null });
    }
    const found = this.filetree ? filetreePanel() : null;
    if (found && this.inTree(target.path)) {
      const onScreen = this.showTree(found), folder = this.folder;
      // The wait runs in the shell because a task's cx ends with the dialog. A terminal
      // editor's pane takes the focus, and filetree must follow it before reading the line.
      const wait = onScreen && !editor.terminal ? "" : `sleep ${REVEAL_WAIT / 1000} && `;
      cx.spawn(() => writeMention(exec, `${wait}${APPEND_LINE}`, folder, target.path), { owner: null });
    }
    closeOverlay(props().overlay);
  }

  canReveal() {
    return this.filetree && Boolean(filetreePanel());
  }

  inTree(file) {
    return Boolean(this.folder) && file.startsWith(`${this.folder.replace(/\/+$/, "")}/`);
  }

  // Answers whether filetree was on screen already.
  showTree(found) {
    const onScreen = !found.panel.hidden && found.body.active === found.block.id;
    run("layout.select", { stack: "panel-body", child: found.block.id });
    run("layout.show", { id: "panel" });
    setShared("filetree.view", { view: "tree", n: Date.now() });
    return onScreen;
  }

  reveal(cx) {
    const result = this.results[this.selected], found = this.filetree ? filetreePanel() : null;
    if (!result || !found) return;
    const file = this.absolute(result), overlay = props().overlay;
    if (!this.inTree(file)) {
      notify({ title: "Not in the file tree", body: `The tree shows ${this.folder ?? "no folder"}, and ${result.path} is outside it.`, level: "warning" });
      return;
    }
    const onScreen = this.showTree(found);
    cx.spawn(async (cx) => {
      // A copy starts when it first shows, and misses a line written before its watch.
      if (!onScreen) await cx.sleep(REVEAL_WAIT);
      await writeMention(patientExec(cx), APPEND_LINE, this.folder, file);
      closeOverlay(overlay);
    });
  }

  onKey(event, cx) {
    const actions = {
      down: () => this.move(1, cx),
      up: () => this.move(-1, cx),
      "ctrl-n": () => this.move(1, cx),
      "ctrl-p": () => this.move(-1, cx),
      pagedown: () => this.move(PAGE_ROWS, cx),
      pageup: () => this.move(-PAGE_ROWS, cx),
      "ctrl-d": () => this.scrollPreview(1, cx),
      "ctrl-u": () => this.scrollPreview(-1, cx),
      "ctrl-g": () => this.setMode(this.mode === "files" ? "grep" : "files", cx),
      "ctrl-t": () => this.flip("ignored", cx),
      "ctrl-s": () => this.flip("matchCase", cx),
      "ctrl-o": () => this.flip("changed", cx),
      "ctrl-r": () => this.reveal(cx),
    };
    const action = actions[event.keystroke];
    if (!action) return;
    action();
    cx.stop_propagation();
    cx.notify();
  }

  measure(size, cx) {
    // Sizes arrive in window points; the sizes a view sets are also zoomed.
    const zoom = settings().zoom || 1, width = size.width / zoom, height = size.height / zoom;
    if (Math.abs(width - this.viewport.width) < 1 && Math.abs(height - this.viewport.height) < 1) return;
    this.viewport = { width, height };
    cx.notify();
  }

  measureWidth(name, size, cx) {
    const width = size.width / (settings().zoom || 1);
    if (Math.abs(width - this[name]) < 1) return;
    this[name] = width;
    if (name === "codeWidth" && this.rows) this.buildRows();
    cx.notify();
  }

  // A matched letter looks the same everywhere, like a search hit in an editor.
  span(run, color, t) {
    return div().flex_none().whitespace_nowrap()
      .text_color(run.hit ? t.background : color)
      .when(run.hit, (el) => el.bg(t.ansi3).rounded(2).font_semibold())
      .child(run.text);
  }

  fileRow(result, index, query, t) {
    const slash = result.path.lastIndexOf("/");
    const name = result.path.slice(slash + 1), folder = slash < 0 ? "" : result.path.slice(0, slash);
    const hits = pathHits(result.path, query, this.matchCase);
    const recent = !query && !this.changed && this.recentPaths().includes(result.path);
    return h_flex().h(FILE_ROW).px(12).gap(10).items_center().overflow_hidden()
      .when(index === this.selected, (el) => el.bg(t.selected))
      .child(h_flex().flex_none().items_center().children(hitRuns(name, hits.slice(slash + 1)).map((run) => this.span(run, t.foreground, t))))
      .child(h_flex().flex_1().min_w(0).items_center().text_size(11.5).overflow_hidden().children(hitRuns(folder, hits).map((run) => this.span(run, t.dim, t))))
      .when(recent, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("recent")));
  }

  hitRow(result, index, query, t) {
    const line = result.text.trim();
    const { text, hits } = clipped(line, matchHits(line, query, true, this.matchCase), columnsIn(this.listWidth - 24, HIT_FONT));
    return v_flex().h(HIT_ROW).px(12).justify_center().gap(2).overflow_hidden()
      .when(index === this.selected, (el) => el.bg(t.selected))
      .child(h_flex().items_center().overflow_hidden().font_family(codeFont()).text_size(HIT_FONT).children(hitRuns(text, hits).map((run) => this.span(run, t.foreground, t))))
      .child(div().text_size(11).text_color(t.dim).truncate().child(`${result.path}:${result.line}`));
  }

  status() {
    const ignored = this.ignored ? " · with ignored files" : "";
    if (this.searching || (!this.root && !this.error)) return `Searching…${ignored}`;
    const count = this.results.length;
    if (count >= RESULT_LIMIT) return `Best ${RESULT_LIMIT}${ignored}`;
    return `${count} ${count === 1 ? "result" : "results"}${ignored}`;
  }

  header(t) {
    const pill = (mode, label) => div().id(`telescope-mode-${mode}`).h(26).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(this.mode === mode, (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
      .when(this.mode !== mode, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.setMode(mode, cx))
      .child(label);
    const chip = (option, label, name, key) => div().id(`telescope-${option}`).h(24).px(6).flex_none().flex().items_center().rounded(5).text_size(12).cursor_pointer()
      .role("button").accessibility_label(name).tooltip(`${name} (${key})`)
      .when(this[option], (el) => el.bg(t.accent).text_color(t.accent_foreground).font_medium())
      .when(!this[option], (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.flip(option, cx))
      .child(label);
    return h_flex().h(54).flex_none().px(12).gap(6).items_center().border_b_1().border_color(t.border)
      .child(svg("mods/telescope/icons/telescope.svg").size(20).flex_none().mr(4).text_color(t.accent))
      .child(pill("files", "Files"))
      .child(pill("grep", "Content"))
      .child(h_flex().flex_1().min_w(0).h(36).ml(6).px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(14).text_color(t.foreground))
        .child(chip("changed", "Changed", "Only changed files", "Ctrl+O"))
        .child(chip("matchCase", "Aa", "Match case", "Ctrl+S")))
      .child(div().flex_none().ml(6).text_size(11).text_color(t.dim).child(this.status()));
  }

  emptyMessage() {
    if (this.error) return this.error;
    if (this.searching || !this.root) return "";
    if (this.mode === "grep" && !this.input.value().trim()) return "Type to search the content of the files.";
    if (this.changed && !this.input.value().trim()) return "No file has changed.";
    return "Nothing matches.";
  }

  resultsPane(t) {
    if (!this.results.length) {
      return div().flex_1().min_w(0).min_h(0).p(16).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(this.emptyMessage());
    }
    const query = this.input.value(), row = this.mode === "files" ? FILE_ROW : HIT_ROW;
    const draw = this.mode === "files" ? this.fileRow.bind(this) : this.hitRow.bind(this);
    return div().id("telescope-list").flex_1().min_w(0).min_h(0).relative()
      .on_size_change((size, cx) => this.measureWidth("listWidth", size, cx))
      .child(v_virtual_list("telescope-results", this.results.length, row, (i) => this.results[i].key,
        (range) => this.results.slice(range.start, range.end).map((result, i) => draw(result, range.start + i, query, t)))
        .size_full().track_scroll(this.scroll)
        .on_item_click((key, cx) => {
          const index = this.results.findIndex((r) => r.key === key);
          if (index >= 0) this.select(index, cx);
          cx.notify();
        }))
      .child(Scrollbar.vertical("telescope-results").viewport_from_layout().absolute().inset_0());
  }

  previewTitle() {
    const shown = this.preview;
    const path = shown?.request.path.slice(this.root.length + 1) ?? "";
    if (shown?.kind === "image" && shown.pages > 1) return `${path} · page ${shown.page} of ${shown.pages}`;
    if (shown?.request.line) return `${path}:${shown.request.line}`;
    return path;
  }

  imageBody(shown, t) {
    const scale = Math.min(1, (this.viewport.width - 32) / shown.width, (this.viewport.height - 32) / shown.height);
    return v_flex().flex_1().min_h(0)
      .child(div().id("telescope-image").flex_1().min_h(0).flex().items_center().justify_center().overflow_hidden()
        .on_size_change((size, cx) => this.measure(size, cx))
        .child(image(shown.path).w(shown.width * scale).h(shown.height * scale)))
      .when(Boolean(shown.details), (el) => el.child(div().flex_none().max_h(120).px(16).py(8).text_size(11).text_color(t.dim).overflow_hidden().child(shown.details)));
  }

  codeBody(t) {
    const colors = syntaxColors(t);
    const draw = (row) => h_flex().h(LINE_ROW).items_center().overflow_hidden()
      .when(row.matched, (el) => el.bg(t.selected))
      .child(div().w(GUTTER).flex_none().pr(12).text_right().text_color(row.matched ? t.foreground : t.dim).child(String(row.number)))
      .children(row.spans.map((span) => this.span(span, colors[span.cls] ?? t.foreground, t)));
    return div().id("telescope-code").flex_1().min_h(0).relative().pt(4).font_family(codeFont()).text_size(codeSize())
      .on_size_change((size, cx) => this.measureWidth("codeWidth", size, cx))
      .child(v_virtual_list("telescope-lines", this.rows.length, LINE_ROW, (i) => String(this.rows[i].number),
        (range) => this.rows.slice(range.start, range.end).map(draw)).size_full().track_scroll(this.lineScroll))
      .child(Scrollbar.vertical("telescope-lines").viewport_from_layout().absolute().inset_0());
  }

  previewBody(t) {
    const shown = this.preview;
    if (!shown) return div().flex_1();
    if (shown.kind === "error") return div().flex_1().p(16).text_size(12).text_color(t.ansi1).child(shown.text);
    if (shown.kind === "image") return this.imageBody(shown, t);
    if (this.rows) return this.codeBody(t);
    if (shown.kind === "markdown") {
      return v_flex().id("telescope-markdown").flex_1().min_h(0).p(16).overflow_y_scrollbar()
        .child(TextView.markdown(`telescope-markdown-${shown.request.path}-${shown.first_line}`, shown.text).scrollable(false).selectable(true).w_full().flex_none().text_size(13));
    }
    return v_flex().flex_1().min_h(0)
      .when(Boolean(shown.hint), (el) => el.child(div().flex_none().px(16).py(8).text_size(12).text_color(t.blocked).child(shown.hint)))
      .child(div().flex_1().min_h(0).pl(14).pt(8).child(Editor.new(this.code).size_full()));
  }

  previewPane(t) {
    return v_flex().flex_1().min_w(0).min_h(0).border_l_1().border_color(t.border).bg(t.background)
      .child(div().h(30).flex_none().px(14).flex().items_center().border_b_1().border_color(t.border).text_size(11.5).text_color(t.muted).truncate().child(this.previewTitle()))
      .child(this.previewBody(t));
  }

  footer(t) {
    const selected = this.editors.find((editor) => editor.id === this.editor);
    const status = this.checkingEditors ? "Checking editors…" : this.editorError ? `Could not check editors: ${this.editorError}` : "No supported editors found";
    const option = (editor, index) => Radio.new(`telescope-editor-${editor.id}`).checked(editor.id === this.editor)
      .accessibility_label(editor.name).set_position(index + 1, this.editors.length)
      .flex().flex_row().h(26).px(8).gap(6).items_center().rounded(6).text_size(12).cursor_pointer()
      .text_color(editor.id === this.editor ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_change((_checked, cx) => this.selectEditor(editor.id, cx))
      .child(div().size(12).flex_none().rounded_full().border_1().border_color(editor.id === this.editor ? t.accent : t.dim)
        .flex().items_center().justify_center()
        .when(editor.id === this.editor, (el) => el.child(div().size(6).rounded_full().bg(t.accent))))
      .child(svg(`mods/telescope/icons/${editor.id}.svg`).size(14).flex_none().text_color(editor.id === this.editor ? t.foreground : t.muted))
      .child(editor.name)
      .child(div().text_size(10.5).text_color(t.dim).child(editor.key));
    const canReveal = this.canReveal();
    return h_flex().h(40).flex_none().px(12).gap(4).items_center().border_t_1().border_color(t.border)
      .when(this.editors.length > 0, (el) => el
        .child(div().text_size(11).text_color(t.muted).child("Open with"))
        .child(RadioGroup.new("telescope-editors").accessibility_label("Editor").axis("horizontal")
          .flex().flex_row().flex_none().gap(4).items_center().children(this.editors.map(option))))
      .when(this.editors.length === 0, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11)
        .text_color(this.editorError ? t.ansi1 : t.muted).child(status)))
      .when(canReveal, (el) => el.child(div().id("telescope-reveal").h(26).px(8).ml(4).flex_none().flex().items_center().rounded(6).text_size(12).cursor_pointer()
        .role("button").accessibility_label("Reveal in the file tree").tooltip("Reveal in the file tree (Ctrl+R)")
        .text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.reveal(cx))
        .child("Reveal")))
      .child(div().flex_1().min_w(0).ml(12).text_size(11).text_color(t.dim).text_right().truncate()
        .child(`${selected ? `Enter open in ${selected.name} · ` : ""}${canReveal ? "ctrl-r reveal · " : ""}ctrl-g files/content · ctrl-o changed · ctrl-s case · ctrl-t ignored · ctrl-u/d preview · Esc close`));
  }

  render() {
    const t = theme();
    return v_flex().id("telescope").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(this.header(t))
      .when(Boolean(this.warning), (el) => el.child(div().flex_none().px(14).py(6).border_b_1().border_color(t.border).text_size(12).text_color(t.blocked).child(this.warning)))
      .child(h_flex().flex_1().min_h(0).items_stretch().child(this.resultsPane(t)).child(this.previewPane(t)))
      .child(this.footer(t));
  }

  close() {
    this.closed = true;
    this.code?.release();
    this.scroll.release();
    this.lineScroll.release();
    this.input.release();
  }
}
