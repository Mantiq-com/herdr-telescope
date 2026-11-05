import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDITORS } from "../mods/telescope/editors.js";

const keys = JSON.parse(readFileSync(new URL("../keys.json", import.meta.url), "utf8"));
for (const editor of EDITORS) {
  assert.equal(keys["mod:telescope"]?.[editor.key], `telescope.open-${editor.id}`,
    `${editor.key} must override app bindings while Telescope has focus`);
}

function element(type) {
  const node = { type, properties: {}, childNodes: [] };
  const proxy = new Proxy(node, {
    get(target, name) {
      if (name === "child") return (child) => { node.childNodes.push(child); return proxy; };
      if (name === "children") return (children) => { node.childNodes.push(...children); return proxy; };
      if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
      if (name in target) return target[name];
      return (...args) => { node.properties[name] = args; return proxy; };
    },
  });
  return proxy;
}

const input = { on: (name, callback) => { input[name] = callback; }, focus() {} };
let deliverCommand;
globalThis.telescopeTest = {
  element,
  input,
  exec: async () => ({ code: 0, stdout: EDITORS.map((editor) => editor.id).join("\n"), stderr: "" }),
  run() {},
  nextCommand: () => new Promise((resolve) => { deliverCommand = resolve; }),
  exists: async () => false,
  home: () => "/test-user",
  layout: () => null,
  setShared() {},
  notify() {},
  closeOverlay() {},
};

const ui = `
  const { element, input } = globalThis.telescopeTest;
  export class View {}
  export const div = () => element("div");
  export const image = () => element("image");
  export const svg = () => element("svg");
  export const h_flex = () => element("h_flex");
  export const v_flex = () => element("v_flex");
  export const Radio = { new: (id) => element("Radio").id(id) };
  export const RadioGroup = { new: (id) => element("RadioGroup").id(id) };
  export const InputState = { new: () => input };
  export const VirtualListScrollHandle = { new: () => ({ scroll_to_item() {} }) };
  export const Input = {}, Editor = {}, EditorState = {}, TextView = {}, Scrollbar = {}, v_virtual_list = {};
`;
const herdr = `
  export const nextCommand = () => globalThis.telescopeTest.nextCommand();
  export const appHome = () => "/test-home";
  export const closeOverlay = (...args) => globalThis.telescopeTest.closeOverlay(...args);
  export const exec = (...args) => globalThis.telescopeTest.exec(...args);
  export const focused = () => {}, hc = () => {};
  export const home = () => globalThis.telescopeTest.home();
  export const layout = () => globalThis.telescopeTest.layout();
  export const notify = (...args) => globalThis.telescopeTest.notify(...args);
  export const panes = () => [], props = () => ({ overlay: "dialog" }), readTextFile = () => {};
  export const run = (...args) => globalThis.telescopeTest.run(...args);
  export const setShared = (...args) => globalThis.telescopeTest.setShared(...args);
  export const settings = () => ({}), spaces = () => [], theme = () => ({});
`;
// Herdr's fs module has exists(), which node's does not.
const files = "export const exists = (...args) => globalThis.telescopeTest.exists(...args);";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = specifier === "herdr" ? herdr : specifier === "fs/promises" ? files
      : ["gpui-kit", "gpui-base"].includes(specifier) ? ui : null;
    return source === null ? nextResolve(specifier, context)
      : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

const { default: Telescope } = await import("../mods/telescope/main.js");
const tasks = [];
let slept = 0;
const cx = {
  focus_handle: () => ({}), timer: { after() {} }, spawn: (task) => tasks.push(task), notify() {},
  sleep: async (ms) => { slept += ms; },
};
// Herdr does not allow a cx to be kept past its callback: a task uses its own.
const kept = { ...cx, sleep() { throw new Error("a cx was kept past its callback"); } };
const view = new Telescope();
view.start = async () => { await view.checkEditors(cx); };
view.search = () => {};
view.init({}, kept);
const descendants = (node) => typeof node !== "object" || node === null ? []
  : [node, ...node.childNodes.flatMap(descendants)];
const radios = () => descendants(view.footer({})).filter((node) => node.type === "Radio");
const selected = () => radios().filter((node) => node.properties.checked[0]);
assert.equal(radios().length, 0, "no editor is offered before it is checked");
const opened = [];
view.open = (editor) => opened.push(editor);
const saved = [];
view.saveState = () => saved.push(view.editor);
const startup = tasks[0](cx);
for (const task of tasks.slice(1)) task(cx);
await startup;

// The app dispatches scoped keys as commands, without a raw key event.
for (const editor of EDITORS) {
  assert.equal(typeof deliverCommand, "function", "Telescope must listen for app key commands");
  deliverCommand(keys["mod:telescope"][editor.key].slice("telescope.".length));
  await Promise.resolve();
  assert.equal(opened.at(-1), editor.id);
}
opened.length = 0;

assert.equal(selected().length, 1);

// Choosing an editor keeps the dialog open; submitting uses that choice.
for (const editor of EDITORS) {
  const radio = radios().find((node) => node.properties.id[0] === `telescope-editor-${editor.id}`);
  assert.ok(radio, `${editor.name} must have a radio control`);
  radio.properties.on_change[0](true, cx);
  assert.deepEqual(opened, []);
  assert.equal(saved.at(-1), editor.id);
  assert.equal(selected().length, 1);
  assert.equal(selected()[0].properties.id[0], `telescope-editor-${editor.id}`);
  input.submit({}, cx);
  assert.deepEqual(opened.splice(0), [editor.id]);
}

// Terminal editors come from the file's machine, GUI editors from this one.
view.machine = "server.example.com";
globalThis.telescopeTest.exec = async (_command, _args, options) => ({
  code: 0, stdout: options.on === "server.example.com" ? "nvim\nShell setup: hx is unavailable\nzed\n" : "code\nhx\n", stderr: "",
});
view.editor = "code";
await view.checkEditors(cx);
assert.equal(selected()[0].properties.id[0], "telescope-editor-code");
view.editor = "hx";
await view.checkEditors(cx);
assert.deepEqual(radios().map((node) => node.properties.id[0]), ["telescope-editor-nvim", "telescope-editor-code"]);
assert.equal(selected()[0].properties.id[0], "telescope-editor-nvim");
deliverCommand("open-hx");
await Promise.resolve();
assert.deepEqual(opened, [], "an unavailable editor's shortcut does nothing");

const runs = [];
globalThis.telescopeTest.run = (...args) => runs.push(args);
view.results = [{ path: "notes.txt", line: 0, column: 0 }];
view.absolute = () => "/repo/notes.txt";
view.open = Telescope.prototype.open.bind(view);
view.open("hx", cx);
view.selectEditor("hx", cx);
assert.deepEqual(runs, []);
assert.equal(view.editor, "nvim");

// The mod recognises herdr-core's refusal by these words, so they must stay what
// herdr-core says.
const REFUSAL = "`herdr.exec`: 16 execs are running already";
const refusedFirst = (times, answer) => async (...args) => {
  if (times-- > 0) throw new Error(REFUSAL);
  return answer(...args);
};

// The dialog can do nothing without its root, so a refused lookup must not end it.
let lookups = 0, statusWhileWaiting = null;
globalThis.telescopeTest.exec = async (_command, args) => {
  if (args[1]?.startsWith("git rev-parse") && ++lookups <= 2) {
    statusWhileWaiting = view.status();
    throw new Error(REFUSAL);
  }
  return { code: 0, stdout: "/repo\n", stderr: "" };
};
await Telescope.prototype.start.call(view, cx);
assert.equal(view.root, "/repo");
assert.ok(!view.error, `a refused lookup must wait, not fail: ${view.error}`);
assert.doesNotMatch(statusWhileWaiting, /result/, "no count of results before the search has run");

globalThis.telescopeTest.exec = refusedFirst(2, async () => ({ code: 0, stdout: "nvim\ncode\n", stderr: "" }));
await view.checkEditors(cx);
assert.deepEqual(view.editors.map((editor) => editor.id), ["nvim", "code"]);
assert.ok(!view.editorError, `a refused check must wait, not fail: ${view.editorError}`);

globalThis.telescopeTest.exec = refusedFirst(1, async () => ({
  code: 0, stdout: JSON.stringify({ kind: "markdown", text: "# Notes", first_line: 1 }), stderr: "",
}));
view.loadPreview(kept);
await tasks.at(-1)(cx);
assert.equal(view.preview?.kind, "markdown", "a refused preview must wait, not fail");

input.value = () => "notes";
globalThis.telescopeTest.exec = refusedFirst(1, async () => ({ code: 0, stdout: "notes.txt\n", stderr: "" }));
Telescope.prototype.search.call(view, kept);
await tasks.at(-1)(cx);
assert.ok(!view.error, `a refused search must wait, not fail: ${view.error}`);
assert.deepEqual(view.results.map((result) => result.path), ["notes.txt"]);

// exec ends a command within 30 seconds, so a wait that long sees a slot free up,
// and a longer one would only hide a failure.
slept = 0;
globalThis.telescopeTest.exec = async () => { throw new Error(REFUSAL); };
await view.checkCommand(cx);
assert.ok(slept >= 30000 && slept < 31000, `waited ${slept} ms for a free slot`);
await view.checkEditors(cx);
assert.match(view.editorError, /execs are running already/, "a refusal that lasts is shown");

globalThis.telescopeTest.exec = async () => ({ code: 0, stdout: "", stderr: "" });
await view.checkEditors(cx);
assert.deepEqual(radios(), []);
assert.equal(view.editor, null);
input.submit({}, cx);
assert.deepEqual(runs, []);

slept = 0;
globalThis.telescopeTest.exec = async () => { throw new Error("machine is unreachable"); };
await view.checkEditors(cx);
assert.deepEqual(radios(), []);
assert.match(view.editorError, /machine is unreachable/);
assert.equal(slept, 0, "only a refusal is worth waiting for");

view.closed = true;
deliverCommand("open-nvim");
await Promise.resolve();
assert.deepEqual(opened, []);

// The probe finds executables through PATH without starting an editor.
const { availableEditors } = await import("../mods/telescope/editors.js");
const work = mkdtempSync(join(tmpdir(), "telescope-editors-"));
try {
  const shell = execFileSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).trim();
  const local = join(work, "local"), remote = join(work, "remote"), empty = join(work, "empty");
  for (const folder of [local, remote, empty]) {
    mkdirSync(folder);
    symlinkSync(shell, join(folder, "sh"));
  }
  for (const [folder, programs] of [[local, ["code", "hx"]], [remote, ["nvim", "zed"]]]) {
    for (const program of programs) writeFileSync(join(folder, program), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  }
  const probe = (program, args, options) => Promise.resolve({
    code: 0, stderr: "", stdout: execFileSync(program, args, {
      encoding: "utf8", env: { ...process.env, SHELL: "/no/such/fish", PATH: options.on ? remote : local },
    }),
  });
  assert.deepEqual((await availableEditors(probe, "server.example.com")).map((editor) => editor.id), ["nvim", "code"]);
  assert.deepEqual((await availableEditors(probe, null)).map((editor) => editor.id), ["code", "hx"]);
  for (const program of ["vim", "micro"]) {
    writeFileSync(join(remote, program), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  }
  assert.deepEqual((await availableEditors(probe, "server.example.com")).map((editor) => editor.id), ["nvim", "code", "vim", "micro"]);
  assert.deepEqual((await availableEditors(probe, null)).map((editor) => editor.id), ["code", "hx"]);
  const missing = (program, args) => Promise.resolve({
    code: 0, stderr: "", stdout: execFileSync(program, args, {
      encoding: "utf8", env: { ...process.env, SHELL: "/no/such/fish", PATH: empty },
    }),
  });
  assert.deepEqual(await availableEditors(missing, "server.example.com"), []);
  await assert.rejects(availableEditors(async () => ({ code: 1, stdout: "", stderr: "probe failed" }), null), /probe failed/);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Revealing a file in filetree.
const block = (id, mod) => ({ id, content: { mod } });
const sidePanel = (blocks, { hidden = false, active = "files" } = {}) => ({
  id: "root",
  children: [{ id: "panel", hidden, children: [{ id: "panel-body", active, children: [...blocks, { id: "changes" }] }] }],
});
const ownPanel = (options) => sidePanel([block("files", "preview-plus"), block("filetree", "filetree")], { active: "filetree", ...options });
const log = [];
Object.assign(globalThis.telescopeTest, {
  run: (name, args) => log.push(["run", name, args]),
  setShared: (key, value) => log.push(["shared", key, value]),
  notify: (notice) => log.push(["notify", notice]),
  closeOverlay: (id) => log.push(["close", id]),
  exec: async (program, args, options) => { log.push(["exec", program, args, options]); return { code: 0, stdout: "", stderr: "" }; },
  layout: () => ownPanel(),
});
const keyCx = { ...cx, stop_propagation() {} };
const finder = () => {
  const reveal = new Telescope();
  Object.assign(reveal, {
    root: "/repo", folder: "/repo", machine: null, filetree: true, selected: 0, editors: [], results: [{ path: "src/notes.txt" }],
  });
  return reveal;
};
const pressReveal = async (reveal) => {
  log.length = 0;
  slept = 0;
  const before = tasks.length;
  reveal.onKey({ keystroke: "ctrl-r" }, keyCx);
  await Promise.all(tasks.slice(before).map((task) => task(cx)));
  return log.map(([kind, name]) => kind === "run" ? name : kind);
};
const footerText = (reveal) => {
  const text = (node) => typeof node === "string" ? [node] : node?.childNodes?.flatMap(text) ?? [];
  return text(reveal.footer({})).join(" ");
};

// A machine without filetree must behave as if the key did not exist.
globalThis.telescopeTest.exists = async () => false;
const missing = finder();
await missing.checkFiletree();
assert.equal(missing.filetree, false);
assert.deepEqual(await pressReveal(missing), [], "without filetree the key does nothing");
assert.doesNotMatch(footerText(missing), /ctrl-r/);

globalThis.telescopeTest.exists = async () => { throw new Error("no such folder"); };
const unreadable = finder();
unreadable.filetree = false;
await unreadable.checkFiletree();
assert.equal(unreadable.filetree, false, "a check that fails counts as not installed");

globalThis.telescopeTest.exists = async (path) => path === "/test-home/mods/filetree/main.js";
const installed = finder();
installed.filetree = false;
await installed.checkFiletree();
assert.equal(installed.filetree, true);
assert.match(footerText(installed), /ctrl-r/);

// Installed is not enough: the shown layout decides whether a panel can answer.
for (const shown of [sidePanel([block("files", "preview-plus")]), sidePanel([block("files", "files")]), { id: "root", children: [] }, null]) {
  globalThis.telescopeTest.layout = () => shown;
  const other = finder();
  assert.deepEqual(await pressReveal(other), [], "another Files panel must not be asked to reveal");
  assert.doesNotMatch(footerText(other), /ctrl-r/);
}

// The panel must exist before the line is written, or filetree never hears of it.
globalThis.telescopeTest.layout = () => ownPanel({ hidden: true });
assert.deepEqual(await pressReveal(finder()), ["layout.select", "layout.show", "shared", "exec", "close"]);
assert.deepEqual(log.slice(0, 2).map((entry) => entry.slice(1)), [
  ["layout.select", { stack: "panel-body", child: "filetree" }],
  ["layout.show", { id: "panel" }],
]);
assert.equal(log[2][1], "filetree.view");
assert.equal(log[2][2].view, "tree");
assert.equal(log.at(-1)[1], "dialog");
assert.ok(slept > 0, "a hidden panel may have to start before it can hear the line");

globalThis.telescopeTest.layout = () => ownPanel({ active: "files" });
await pressReveal(finder());
assert.ok(slept > 0, "filetree may not have started behind another panel");

globalThis.telescopeTest.layout = () => ownPanel();
await pressReveal(finder());
assert.equal(slept, 0, "a panel on screen is listening already");

// A layout can also put filetree in the Files block itself, as its README shows.
globalThis.telescopeTest.layout = () => sidePanel([block("files", "filetree")]);
await pressReveal(finder());
assert.deepEqual(log[0].slice(1), ["layout.select", { stack: "panel-body", child: "files" }]);
assert.equal(slept, 0);
globalThis.telescopeTest.layout = () => ownPanel();

// filetree reads its activity file on this computer, also for a remote space.
const remote = finder();
remote.machine = "server.example.com";
await pressReveal(remote);
assert.equal(log.find(([kind]) => kind === "exec")[3], undefined);

// filetree roots at the terminal's folder, and the search starts at the git root.
const subfolder = finder();
subfolder.folder = "/repo/other";
assert.deepEqual(await pressReveal(subfolder), ["notify"]);
assert.equal(log[0][1].level, "warning");
const lookalike = finder();
lookalike.folder = "/rep";
assert.deepEqual(await pressReveal(lookalike), ["notify"], "a folder is not a prefix of a longer name");
const noFolder = finder();
noFolder.folder = null;
assert.deepEqual(await pressReveal(noFolder), ["notify"]);
const rootFolder = finder();
rootFolder.folder = "/";
assert.deepEqual(await pressReveal(rootFolder), ["layout.select", "layout.show", "shared", "exec", "close"]);

const empty = finder();
empty.results = [];
assert.deepEqual(await pressReveal(empty), [], "with nothing selected there is nothing to reveal");

// A failed write is reported, and the dialog still closes.
for (const failure of [async () => ({ code: 1, stdout: "", stderr: "disk full" }), async () => { throw new Error("disk full"); }]) {
  const exec = globalThis.telescopeTest.exec;
  globalThis.telescopeTest.exec = failure;
  assert.deepEqual(await pressReveal(finder()), ["layout.select", "layout.show", "shared", "notify", "close"]);
  const notice = log.find(([kind]) => kind === "notify")[1];
  assert.equal(notice.level, "error");
  assert.match(notice.body, /disk full/);
  globalThis.telescopeTest.exec = exec;
}

// The line is filetree's wire format: its readActivity takes `at`, `kind` and `paths`
// from each JSON line, so these names must stay what it reads.
const activityHome = mkdtempSync(join(tmpdir(), "telescope-reveal-"));
try {
  globalThis.telescopeTest.home = () => activityHome;
  globalThis.telescopeTest.exec = async (program, args, options) => ({
    code: 0, stderr: "", stdout: execFileSync(program, args, { encoding: "utf8", ...options }),
  });
  const awkward = `it's a "file" $(touch ${activityHome}/ran) \\ and a space.txt`;
  const first = finder();
  first.results = [{ path: awkward }];
  const startedAt = Date.now();
  await pressReveal(first);
  await pressReveal(finder());
  const lines = readFileSync(join(activityHome, ".local/state/herdr-filetree/activity.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2, "each reveal adds a line and keeps the ones before");
  const [mention, next] = lines.map((line) => JSON.parse(line));
  assert.equal(mention.kind, "mention");
  assert.deepEqual(mention.paths, [`/repo/${awkward}`]);
  assert.equal(mention.cwd, "/repo");
  assert.ok(mention.at >= startedAt, "filetree skips a line older than the last it saw");
  assert.deepEqual(next.paths, ["/repo/src/notes.txt"]);
  assert.throws(() => readFileSync(join(activityHome, "ran")), "a path must reach the shell as data");
} finally {
  rmSync(activityHome, { recursive: true, force: true });
}
