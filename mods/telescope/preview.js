// Asks herdr-telescope what to show for a file, and keeps images where Herdr's
// image() can read them: it only reads from the app's own folder.

import { appHome, exec } from "herdr";
import { Buffer } from "buffer";
import * as fs from "fs/promises";

const CACHE = "mods/telescope/.cache";

let stored = 0;

/** Deletes the images of the last session, so the folder does not grow. */
export async function clearImages() {
  const folder = `${appHome()}/${CACHE}`;
  if (!(await fs.exists(folder))) return;
  for (const name of await fs.readdir(folder)) await fs.unlink(`${folder}/${name}`);
}

/**
 * What to show for `request` ({ path, line, first, page }), read on `machine`.
 * An image comes back with `path` set instead of its data. The name is new each
 * time, because Herdr keeps an image it has loaded by its path.
 */
export async function loadPreview(request, machine) {
  const args = ["preview", "--page", String(request.page)];
  if (request.first) args.push("--first", String(request.first));
  else if (request.line) args.push("--line", String(request.line));
  const result = await exec("herdr-telescope", [...args, "--", request.path], { on: machine });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "This file cannot be previewed.");
  const preview = JSON.parse(result.stdout);
  if (preview.kind !== "image") return preview;

  await fs.mkdir(`${appHome()}/${CACHE}`, { recursive: true });
  const relative = `${CACHE}/${Date.now()}-${++stored}.${preview.format}`;
  await fs.writeFile(`${appHome()}/${relative}`, Buffer.from(preview.base64, "base64"));
  return { ...preview, base64: null, path: relative };
}
