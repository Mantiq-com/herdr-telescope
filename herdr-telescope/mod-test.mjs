import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
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
  export const exec = () => {}, focused = () => {}, hc = () => {}, notify = () => {};
  export const panes = () => [], props = () => ({}), readTextFile = () => {}, run = () => {};
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
view.start = async () => {};
view.search = () => {};
view.init({}, cx);
const opened = [];
view.open = (editor) => opened.push(editor);
const saved = [];
view.saveState = () => saved.push(view.editor);
for (const task of tasks) task(cx);

// The app dispatches scoped keys as commands, without a raw key event.
for (const editor of EDITORS) {
  assert.equal(typeof deliverCommand, "function", "Telescope must listen for app key commands");
  deliverCommand(keys["mod:telescope"][editor.key].slice("telescope.".length));
  await Promise.resolve();
  assert.equal(opened.at(-1), editor.id);
}
opened.length = 0;

const descendants = (node) => typeof node !== "object" || node === null ? []
  : [node, ...node.childNodes.flatMap(descendants)];
const radios = () => descendants(view.footer({})).filter((node) => node.type === "Radio");
const selected = () => radios().filter((node) => node.properties.checked[0]);
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

view.closed = true;
deliverCommand("open-nvim");
await Promise.resolve();
assert.deepEqual(opened, []);
