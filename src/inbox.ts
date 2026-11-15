import { Notice, normalizePath } from "obsidian";
import type KodingPlugin from "./main";
import { baseOf, ensureFolder, freePath, listFiles, movePath } from "./io";
import { addSeeds, embedTake, nextAction, nextTakeNumber } from "./core";
import { convertToTakeFormat } from "./audio";
import { dateFromName, extOf, isoDate } from "./text";

const TEXT = new Set(["txt", "md"]);
const AUDIO = new Set(["m4a", "mp3", "wav", "ogg", "opus", "webm", "aac", "3gp", "amr", "flac", "mp4"]);

let busy = false;

async function inboxFiles(plugin: KodingPlugin): Promise<string[]> {
  return (await listFiles(plugin.app, plugin.settings.inboxFolder)).filter((f) => !/^(desktop\.ini|\..*|~.*)$/i.test(baseOf(f)));
}

/** Audio waiting in the Inbox, oldest first. */
export async function phoneAudio(plugin: KodingPlugin): Promise<string[]> {
  return (await inboxFiles(plugin)).filter((f) => AUDIO.has(extOf(f))).sort();
}

/** Turn text captures into seeds and file the originals away. */
export async function processInbox(plugin: KodingPlugin): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const s = plugin.settings;
    const adapter = plugin.app.vault.adapter;
    const texts = (await inboxFiles(plugin)).filter((f) => TEXT.has(extOf(f))).sort();
    const seeds: { date: string; text: string }[] = [];
    const handled: string[] = [];
    for (const path of texts) {
      const stat = await adapter.stat(path);
      // Drive may still be writing it
      if (!stat || Date.now() - stat.mtime < 3000) continue;
      const body = (await adapter.read(path)).replace(/^﻿/, "");
      const date = dateFromName(baseOf(path)) || isoDate(new Date(stat.mtime));
      for (const line of body.split(/\r?\n/)) if (line.trim()) seeds.push({ date, text: `${line.trim()} (phone)` });
      handled.push(path);
    }
    if (handled.length) {
      // newest capture ends up on top
      await addSeeds(plugin, seeds.reverse());
      await ensureFolder(plugin.app, s.inboxDoneFolder);
      for (const path of handled) await movePath(plugin.app, path, await freePath(plugin.app, s.inboxDoneFolder, baseOf(path)));
    }
  } catch (e) {
    console.error("koding: inbox", e);
  } finally {
    busy = false;
  }
}

export async function attachAsTake(plugin: KodingPlugin, path: string): Promise<void> {
  const note = (await nextAction(plugin)).note;
  if (!note) {
    new Notice("There is no note in progress to attach it to.");
    return;
  }
  await ensureFolder(plugin.app, plugin.settings.takesFolder);
  const n = await nextTakeNumber(plugin, note.file.basename);
  const stem = normalizePath(`${plugin.settings.takesFolder}/${note.file.basename} take ${n}`);
  const take = await convertToTakeFormat(plugin, path, stem);
  await embedTake(plugin, note.file, take);
  new Notice(`Attached to ${note.file.basename}.`);
}

async function toPhoneFolder(plugin: KodingPlugin, path: string): Promise<string> {
  const to = await freePath(plugin.app, plugin.settings.phoneFolder, baseOf(path));
  await movePath(plugin.app, path, to);
  return to;
}

export async function keepAsSeed(plugin: KodingPlugin, path: string): Promise<void> {
  const date = dateFromName(baseOf(path)) || isoDate();
  const to = await toPhoneFolder(plugin, path);
  await addSeeds(plugin, [{ date, text: `![[${baseOf(to)}]] (voice memo)` }]);
}

export async function justKeep(plugin: KodingPlugin, path: string): Promise<void> {
  await toPhoneFolder(plugin, path);
}
