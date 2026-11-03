// Telescope: find a file by name or by its content, preview it, and open it in
// an editor. Every search and preview runs herdr-telescope on the machine that
// holds the files, because exec() returns only once a command has ended and
// cannot cancel it: one call at a time, and when the person has moved on by the
// time it ends, the next call starts at once and the answer is dropped.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { appHome, closeOverlay, exec, focused, hc, notify, panes, props, readTextFile, run, settings, spaces, theme } from "herdr";
import * as fs from "fs/promises";
import { EDITORS, inLoginShell, openCommand } from "./editors.js";
import { clearImages, loadPreview } from "./preview.js";
import { languageOf, matchRuns, parseResults } from "./results.js";

const TYPING_DELAY = 40;
const SELECTION_DELAY = 80;
const FILE_ROW = 28;
const HIT_ROW = 46;
const PAGE_ROWS = 12;
const SCROLL_LINES = 20;
const RESULT_LIMIT = 500;

const stateFile = () => `${appHome()}/telescope/state.json`;
const codeFont = () => (typeof settings().font === "string" && settings().font) || "JetBrains Mono";
const codeSize = () => Math.max(9, (Number(settings().font_size) || 14) - 1);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

async function sshHost(machine) {
  const listed = await hc(["machine", "ls", "--json"]);
  const found = (JSON.parse(listed.stdout).machines ?? []).find((m) => m.name === machine);
  return found?.target && !found.via ? found.target : machine;
}

function syntaxColors(t) {
  return {
    keyword: t.ansi5, string: t.ansi2, "string.escape": t.ansi3, comment: t.dim, function: t.ansi4, type: t.ansi6,
    number: t.ansi3, constant: t.ansi3, boolean: t.ansi3, variable: t.foreground, operator: t.muted, punctuation: t.muted,
  };
}

export default class Telescope extends View {
  init(_props, cx) {
    this.mode = "files";
    this.editor = EDITORS[0].id;
    this.ignored = false;
    this.results = [];
    this.selected = 0;
    this.searched = null;
    this.searching = false;
    this.previewing = false;
    this.preview = null;
    this.first = 0;
    this.page = 1;
    this.viewport = { width: 400, height: 400 };
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search…" });
    this.input.on("change", (_e, cx) => this.queueSearch(cx));
    this.input.on("submit", (_e, cx) => this.open(this.editor, cx));
    // The keyboard belongs in the search box: a click on the preview must not
    // leave the arrow keys with nowhere to go.
    this.input.on("blur", (_e, cx) => cx.timer.after(40, () => { if (!this.closed) this.input.focus(); }));
    this.input.focus();
    cx.timer.after(600, () => { if (!this.closed) this.input.focus(); });
    cx.spawn(async (cx) => {
      await this.start();
      if (this.closed) return;
      this.search(cx);
      cx.notify();
    });
  }

  async start() {
    await clearImages().catch((error) => console.warn(`telescope: ${error}`));
    await this.loadState();
    const { folder, machine } = location();
    this.machine = machine;
    try {
      const found = await exec("sh", ["-c", "git rev-parse --show-toplevel 2>/dev/null || pwd"], { cwd: folder ?? undefined, on: machine });
      this.root = found.stdout.trim();
    } catch (error) {
      this.error = String(error.message ?? error);
    }
  }

  async loadState() {
    try {
      const state = JSON.parse((await readTextFile(stateFile())) ?? "{}");
      if (EDITORS.some((e) => e.id === state.editor)) this.editor = state.editor;
      if (state.mode === "files" || state.mode === "grep") this.mode = state.mode;
    } catch (error) {
      console.warn(`telescope: ${stateFile()}: ${error}`);
    }
  }

  saveState() {
    const save = async () => {
      await fs.mkdir(`${appHome()}/telescope`, { recursive: true });
      await fs.writeFile(stateFile(), JSON.stringify({ editor: this.editor, mode: this.mode }));
    };
    save().catch((error) => console.warn(`telescope: ${stateFile()}: ${error}`));
  }

  wanted() {
    return { mode: this.mode, query: this.input.value(), ignored: this.ignored };
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
      const flags = request.ignored ? ["--no-ignore"] : [];
      let results = [], error = null;
      try {
        const found = await exec("herdr-telescope", [request.mode, ...flags, "--", this.root, request.query], { on: this.machine });
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
    return result ? { path: this.absolute(result), line: result.line, first: this.first, page: this.page } : null;
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
        preview = await loadPreview(request, this.machine);
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

  setPreview(preview) {
    const text = preview?.kind === "text" || preview?.kind === "details";
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
    this.preview = preview;
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

  setMode(mode, cx) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.results = [];
    this.saveState();
    this.search(cx);
    cx.notify();
  }

  open(id, cx) {
    const result = this.results[this.selected];
    if (!result) return;
    const target = { path: this.absolute(result), line: result.line, column: result.column };
    const editor = EDITORS.find((e) => e.id === id);
    const machine = this.machine;
    this.editor = id;
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
    closeOverlay(props().overlay);
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
      "ctrl-t": () => { this.ignored = !this.ignored; this.search(cx); },
      ...Object.fromEntries(EDITORS.map((editor) => [editor.key, () => this.open(editor.id, cx)])),
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

  runs(text, query, color, t) {
    return matchRuns(text, query).map((run) =>
      div().flex_none().whitespace_nowrap().text_color(run.hit ? t.accent : color).when(run.hit, (el) => el.font_semibold()).child(run.text));
  }

  fileRow(result, index, query, t) {
    const slash = result.path.lastIndexOf("/");
    const name = result.path.slice(slash + 1), folder = slash < 0 ? "" : result.path.slice(0, slash);
    return h_flex().h(FILE_ROW).px(12).gap(10).items_center().overflow_hidden()
      .when(index === this.selected, (el) => el.bg(t.selected))
      .child(h_flex().flex_none().items_center().children(this.runs(name, query, t.foreground, t)))
      .child(h_flex().flex_1().min_w(0).items_center().text_size(11.5).overflow_hidden().children(this.runs(folder, query, t.dim, t)));
  }

  hitRow(result, index, query, t) {
    return v_flex().h(HIT_ROW).px(12).justify_center().gap(2).overflow_hidden()
      .when(index === this.selected, (el) => el.bg(t.selected))
      .child(h_flex().items_center().overflow_hidden().font_family(codeFont()).text_size(12.5).children(this.runs(result.text.trim(), query, t.foreground, t)))
      .child(div().text_size(11).text_color(t.dim).truncate().child(`${result.path}:${result.line}`));
  }

  status() {
    const ignored = this.ignored ? " · with ignored files" : "";
    if (this.searching) return `Searching…${ignored}`;
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
    return h_flex().h(54).flex_none().px(12).gap(6).items_center().border_b_1().border_color(t.border)
      .child(pill("files", "Files"))
      .child(pill("grep", "Content"))
      .child(h_flex().flex_1().min_w(0).h(36).ml(6).px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(14).text_color(t.foreground)))
      .child(div().flex_none().ml(6).text_size(11).text_color(t.dim).child(this.status()));
  }

  emptyMessage() {
    if (this.error) return this.error;
    if (this.searching || !this.root) return "";
    if (this.mode === "grep" && !this.input.value().trim()) return "Type to search the content of the files.";
    return "Nothing matches.";
  }

  resultsPane(t) {
    if (!this.results.length) {
      return div().flex_1().min_w(0).min_h(0).p(16).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(this.emptyMessage());
    }
    const query = this.input.value(), row = this.mode === "files" ? FILE_ROW : HIT_ROW;
    const draw = this.mode === "files" ? this.fileRow.bind(this) : this.hitRow.bind(this);
    return div().flex_1().min_w(0).min_h(0).relative()
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

  previewBody(t) {
    const shown = this.preview;
    if (!shown) return div().flex_1();
    if (shown.kind === "error") return div().flex_1().p(16).text_size(12).text_color(t.ansi1).child(shown.text);
    if (shown.kind === "image") return this.imageBody(shown, t);
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
    const button = (editor) => h_flex().id(`telescope-open-${editor.id}`).h(26).px(10).gap(6).items_center().rounded(6).text_size(12).cursor_pointer()
      .when(editor.id === this.editor, (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
      .when(editor.id !== this.editor, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.open(editor.id, cx))
      .child(svg(`mods/telescope/icons/${editor.id}.svg`).size(14).flex_none().text_color(editor.id === this.editor ? t.foreground : t.muted))
      .child(editor.name)
      .child(div().text_size(10.5).text_color(t.dim).child(editor.key));
    return h_flex().h(40).flex_none().px(12).gap(4).items_center().border_t_1().border_color(t.border)
      .children(EDITORS.map(button))
      .child(div().flex_1().min_w(0).ml(12).text_size(11).text_color(t.dim).text_right().truncate().child("Enter open · ctrl-g files/content · ctrl-t ignored · ctrl-u/d preview · Esc close"));
  }

  render() {
    const t = theme();
    return v_flex().id("telescope").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(this.header(t))
      .child(h_flex().flex_1().min_h(0).items_stretch().child(this.resultsPane(t)).child(this.previewPane(t)))
      .child(this.footer(t));
  }

  close() {
    this.closed = true;
    this.code?.release();
    this.scroll.release();
    this.input.release();
  }
}
