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
  export const VirtualListScrollHandle = { new: () => ({}) };
  export const Input = {}, Editor = {}, EditorState = {}, TextView = {}, Scrollbar = {}, v_virtual_list = {};
`;
const herdr = `
  export const nextCommand = () => globalThis.telescopeTest.nextCommand();
  export const appHome = () => "/test-home";
  export const closeOverlay = () => {};
  export const exec = (...args) => globalThis.telescopeTest.exec(...args);
  export const focused = () => {}, hc = () => {}, notify = () => {};
  export const panes = () => [], props = () => ({}), readTextFile = () => {};
  export const run = (...args) => globalThis.telescopeTest.run(...args);
  export const settings = () => ({}), spaces = () => [], theme = () => ({});
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = specifier === "herdr" ? herdr : ["gpui-kit", "gpui-base"].includes(specifier) ? ui : null;
    return source === null ? nextResolve(specifier, context)
      : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

const { default: Telescope } = await import("../mods/telescope/main.js");
const tasks = [];
const cx = { focus_handle: () => ({}), timer: { after() {} }, spawn: (task) => tasks.push(task), notify() {} };
const view = new Telescope();
view.start = async () => { await view.checkEditors(); };
view.search = () => {};
view.init({}, cx);
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
await view.checkEditors();
assert.equal(selected()[0].properties.id[0], "telescope-editor-code");
view.editor = "hx";
await view.checkEditors();
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

globalThis.telescopeTest.exec = async () => ({ code: 0, stdout: "", stderr: "" });
await view.checkEditors();
assert.deepEqual(radios(), []);
assert.equal(view.editor, null);
input.submit({}, cx);
assert.deepEqual(runs, []);

globalThis.telescopeTest.exec = async () => { throw new Error("machine is unreachable"); };
await view.checkEditors();
assert.deepEqual(radios(), []);
assert.match(view.editorError, /machine is unreachable/);

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
