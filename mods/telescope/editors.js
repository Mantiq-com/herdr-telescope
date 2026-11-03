// The editors the finder opens a file in. This file imports nothing from Herdr,
// so test.sh can run it under node.

// A terminal editor opens in a new pane on the machine that holds the file. The
// others run on this computer, and reach another machine over SSH.
export const EDITORS = [
  { id: "nvim", name: "Neovim", key: "ctrl-1", terminal: true },
  { id: "zed", name: "Zed", key: "ctrl-2" },
  { id: "code", name: "VS Code", key: "ctrl-3" },
  { id: "emacs", name: "Emacs", key: "ctrl-4", terminal: true },
  { id: "hx", name: "Helix", key: "ctrl-5", terminal: true },
  { id: "nano", name: "Nano", key: "ctrl-6", terminal: true },
];

const located = (path, line, column) => (!line ? path : column ? `${path}:${line}:${column}` : `${path}:${line}`);

/**
 * The command that opens `target` ({ path, line, column }; line 0 means no
 * position). `host` is the SSH host of the machine holding the file, null for
 * this computer. A terminal editor runs on that machine, so it never needs one.
 */
export function openCommand(editor, target, host) {
  const { path, line, column } = target;
  switch (editor) {
    case "nvim":
      return line ? ["nvim", `+call cursor(${line},${column || 1})`, path] : ["nvim", path];
    case "emacs":
      return line ? ["emacs", "-nw", `+${line}:${column || 1}`, path] : ["emacs", "-nw", path];
    case "hx":
      return ["hx", located(path, line, column)];
    case "nano":
      return line ? ["nano", `+${line},${column || 1}`, path] : ["nano", path];
    case "zed":
      // Zed documents no position inside an ssh:// URL.
      return host ? ["zed", `ssh://${host}${path}`] : ["zed", located(path, line, column)];
    case "code": {
      const goto = ["--goto", located(path, line, column)];
      return host ? ["code", "--remote", `ssh-remote+${host}`, ...goto] : ["code", ...goto];
    }
    default:
      throw new Error(`Unknown editor ${editor}`);
  }
}

// exec makes the pane end with the editor. Without the editor, the pane would
// close before anyone could read why, so it says so and waits.
const LAUNCH = 'command -v "$1" > /dev/null 2>&1 && exec "$@"; printf "%s is not installed on this machine. Press Enter to close.\\n" "$1"; read -r _';

/**
 * `argv` as terminal.open must start it. That command runs a program directly,
 * in the environment of herdr-core, which on another machine can be an SSH
 * session's minimal PATH. A login shell finds the person's own programs.
 */
export function inLoginShell(argv) {
  const script = `case "\${SHELL##*/}" in sh|bash|zsh|dash|ksh) exec "$SHELL" -lic '${LAUNCH}' "$SHELL" "$@" ;; *) exec sh -c '${LAUNCH}' sh "$@" ;; esac`;
  return ["sh", "-c", script, "sh", ...argv];
}
