import { Notice, TFile, normalizePath } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as nodePath from "path";
import type KodingPlugin from "./main";
import { absPath, baseOf, editText, ensureFolder, run } from "./io";
import { embedTake, nextTakeNumber, readNote } from "./core";
import { Cue, diffWords, fill, getSection, groupCues, hangulLines, isoDate, parseSubtitles, plainText, setSection, signedPercent, stripExt, tokenize } from "./text";

// ---------- Recorder ----------

const FFMPEG_ARGS: Record<string, string[]> = {
  m4a: ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"],
  mp3: ["-c:a", "libmp3lame", "-q:a", "3"],
  ogg: ["-c:a", "libopus", "-b:a", "64k"],
  wav: [],
};

export class Recorder {
  private media: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private note: TFile | null = null;
  private started = 0;
  private timer: number | null = null;

  constructor(private plugin: KodingPlugin, private statusEl: HTMLElement) {
    statusEl.addClass("koding-rec-status");
    statusEl.onclick = () => void this.stop();
    statusEl.hide();
  }

  get recording(): boolean {
    return !!this.media;
  }

  async toggle(note: TFile | null): Promise<void> {
    if (this.recording) await this.stop();
    else if (note) await this.start(note);
    else new Notice("Open a voice note first.");
  }

  async start(note: TFile): Promise<void> {
    if (this.recording) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      new Notice(`No microphone: ${(e as Error).message}`);
      return;
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    this.media = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.note = note;
    this.started = Date.now();
    this.media.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.media.start();
    this.statusEl.show();
    const tick = () => {
      const sec = Math.floor((Date.now() - this.started) / 1000);
      this.statusEl.setText(`● ${Math.floor(sec / 60)}:${sec % 60 < 10 ? "0" : ""}${sec % 60}  stop`);
    };
    tick();
    this.timer = window.setInterval(tick, 500);
    this.plugin.recordingChanged();
  }

  async stop(): Promise<void> {
    const media = this.media;
    const note = this.note;
    if (!media || !note) return;
    const done = new Promise<void>((res) => (media.onstop = () => res()));
    media.stop();
    await done;
    media.stream.getTracks().forEach((t) => t.stop());
    this.media = null;
    this.note = null;
    if (this.timer) window.clearInterval(this.timer);
    this.statusEl.hide();
    this.plugin.recordingChanged();

    try {
      const blob = new Blob(this.chunks, { type: "audio/webm" });
      const path = await this.save(note, await blob.arrayBuffer());
      await embedTake(this.plugin, note, path);
      new Notice(`Saved ${baseOf(path)}`);
    } catch (e) {
      new Notice(`The take could not be saved: ${(e as Error).message}`, 10000);
    }
    this.chunks = [];
    this.plugin.refreshDesk();
  }

  /** Write the recording, convert it, and return the vault path of the take. */
  private async save(note: TFile, data: ArrayBuffer): Promise<string> {
    const s = this.plugin.settings;
    const app = this.plugin.app;
    await ensureFolder(app, s.takesFolder);
    const n = await nextTakeNumber(this.plugin, note.basename);
    const stem = normalizePath(`${s.takesFolder}/${note.basename} take ${n}`);
    const webm = stem + ".webm";
    await app.vault.adapter.writeBinary(webm, data);
    if (s.takeFormat === "webm") return webm;
    const out = `${stem}.${s.takeFormat}`;
    try {
      await run(s.ffmpegPath || "ffmpeg", ["-y", "-loglevel", "error", "-i", absPath(app, webm), "-vn", ...(FFMPEG_ARGS[s.takeFormat] || []), absPath(app, out)], 120000);
    } catch (e) {
      new Notice(`Kept the take as .webm because the conversion failed. ${(e as Error).message}`, 10000);
      return webm;
    }
    await app.vault.adapter.remove(webm);
    return out;
  }
}

/** Convert any audio file to the take format (used for phone memos). Returns the new vault path. */
export async function convertToTakeFormat(plugin: KodingPlugin, from: string, toStem: string): Promise<string> {
  const s = plugin.settings;
  const ext = from.slice(from.lastIndexOf(".") + 1).toLowerCase();
  if (s.takeFormat === "webm" || ext === s.takeFormat) {
    const to = `${toStem}.${ext}`;
    await plugin.app.vault.adapter.rename(normalizePath(from), normalizePath(to));
    return to;
  }
  const to = `${toStem}.${s.takeFormat}`;
  try {
    await run(s.ffmpegPath || "ffmpeg", ["-y", "-loglevel", "error", "-i", absPath(plugin.app, from), "-vn", ...(FFMPEG_ARGS[s.takeFormat] || []), absPath(plugin.app, to)], 120000);
    await plugin.app.vault.adapter.remove(normalizePath(from));
    return to;
  } catch {
    const keep = `${toStem}.${ext}`;
    await plugin.app.vault.adapter.rename(normalizePath(from), normalizePath(keep));
    return keep;
  }
}

// ---------- Model voice ----------

export interface ModelTimings {
  text: string;
  voice: string;
  normal: Cue[];
  slow: Cue[];
}

export function modelPaths(plugin: KodingPlugin, base: string): { normal: string; slow: string; timings: string } {
  const f = normalizePath(plugin.settings.modelsFolder);
  return { normal: `${f}/${base} model.mp3`, slow: `${f}/${base} model slow.mp3`, timings: `${f}/${base} model.json` };
}

async function speak(plugin: KodingPlugin, textFile: string, rate: number, outAbs: string): Promise<Cue[]> {
  const s = plugin.settings;
  const subs = nodePath.join(os.tmpdir(), `koding-${Date.now()}-${Math.round(Math.random() * 1e6)}.srt`);
  const vars = { voice: s.voice, rate: signedPercent(rate), text: textFile, out: outAbs, subs };
  if (s.ttsCommand.trim()) {
    const parts = tokenize(s.ttsCommand.trim()).map((p) => fill(p, vars));
    await run(parts[0], parts.slice(1), 180000);
  } else {
    await run(s.ttsPath || "edge-tts", ["--voice", s.voice, `--rate=${vars.rate}`, "--file", textFile, "--write-media", outAbs, "--write-subtitles", subs], 180000);
  }
  if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size === 0) throw new Error("The voice engine wrote no audio.");
  let cues: Cue[] = [];
  if (fs.existsSync(subs)) {
    cues = groupCues(parseSubtitles(fs.readFileSync(subs, "utf8")));
    fs.unlinkSync(subs);
  }
  return cues;
}

/** Make the normal and slow models and the sentence timings for a text. */
export async function makeModel(plugin: KodingPlugin, base: string, text: string): Promise<void> {
  const s = plugin.settings;
  if (!text.trim()) throw new Error("There is no text to speak.");
  await ensureFolder(plugin.app, s.modelsFolder);
  const paths = modelPaths(plugin, base);
  const textFile = nodePath.join(os.tmpdir(), `koding-${Date.now()}.txt`);
  fs.writeFileSync(textFile, text, "utf8");
  try {
    const normal = await speak(plugin, textFile, 0, absPath(plugin.app, paths.normal));
    const slow = await speak(plugin, textFile, s.slowRate, absPath(plugin.app, paths.slow));
    const timings: ModelTimings = { text, voice: s.voice, normal, slow };
    await plugin.app.vault.adapter.write(paths.timings, JSON.stringify(timings, null, 1));
  } finally {
    fs.unlinkSync(textFile);
  }
}

/** Text a model should speak for a file: its Final section if it has one, else the text itself. */
export async function speakableText(plugin: KodingPlugin, file: TFile): Promise<string> {
  const content = (await plugin.app.vault.read(file)).replace(/\r\n/g, "\n");
  const final = plainText(getSection(content, "Final"));
  if (final) return final;
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
  return plugin.settings.hangulOnly ? hangulLines(body) : plainText(body);
}

export async function makeModelForNote(plugin: KodingPlugin, note: TFile): Promise<void> {
  const info = await readNote(plugin, note);
  if (!info.final) {
    new Notice("Write the text you will record under “## Final” first.");
    return;
  }
  const notice = new Notice("Making the model voice…", 0);
  try {
    await makeModel(plugin, note.basename, info.final);
    const p = modelPaths(plugin, note.basename);
    await editText(plugin.app, note.path, (t) => setSection(t, "Model", `![[${baseOf(p.normal)}]]\n![[${baseOf(p.slow)}]]`));
    notice.hide();
    new Notice("The model voice is in the note.");
  } catch (e) {
    notice.hide();
    new Notice(`The model voice could not be made. ${(e as Error).message}`, 12000);
  }
  plugin.refreshDesk();
}

export async function readTimings(plugin: KodingPlugin, base: string): Promise<ModelTimings | null> {
  const p = modelPaths(plugin, base).timings;
  if (!(await plugin.app.vault.adapter.exists(p))) return null;
  try {
    return JSON.parse(await plugin.app.vault.adapter.read(p)) as ModelTimings;
  } catch {
    return null;
  }
}

// ---------- Listener (Whisper) ----------

/** Vault path of an embedded audio file, wherever it lives. */
export async function findAudio(plugin: KodingPlugin, name: string, from: string): Promise<string | null> {
  const s = plugin.settings;
  const hit = plugin.app.metadataCache.getFirstLinkpathDest(name, from);
  if (hit) return hit.path;
  for (const folder of [s.takesFolder, s.modelsFolder, s.phoneFolder]) {
    const p = normalizePath(`${folder}/${baseOf(name)}`);
    if (await plugin.app.vault.adapter.exists(p)) return p;
  }
  return null;
}

export async function listenToLatestTake(plugin: KodingPlugin, note: TFile): Promise<void> {
  const s = plugin.settings;
  const info = await readNote(plugin, note);
  const last = info.takes[info.takes.length - 1];
  if (!last) {
    new Notice("This note has no take yet.");
    return;
  }
  const audio = await findAudio(plugin, last, note.path);
  if (!audio) {
    new Notice(`Could not find ${last}.`);
    return;
  }
  const notice = new Notice("Whisper is listening to the latest take…", 0);
  const outDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "koding-whisper-"));
  try {
    await run(
      s.whisperPath || "whisper",
      [absPath(plugin.app, audio), "--language", s.languageCode, "--model", s.whisperModel, "--output_format", "txt", "--output_dir", outDir, ...tokenize(s.whisperArgs)],
      15 * 60000
    );
    const txt = nodePath.join(outDir, stripExt(baseOf(audio)) + ".txt");
    if (!fs.existsSync(txt)) throw new Error("Whisper wrote no transcript.");
    const heard = fs.readFileSync(txt, "utf8").replace(/\s+/g, " ").trim();
    const body = info.final
      ? `${last} · ${isoDate()}\n\n${diffWords(info.final.replace(/\n/g, " "), heard).marked}\n\n%% ==marked== is what Whisper heard differently; ~~struck~~ is in the final text but was not heard. %%`
      : `${last} · ${isoDate()}\n\n${heard}`;
    await editText(plugin.app, note.path, (t) => setSection(t, "Heard", body));
    notice.hide();
    new Notice("What Whisper heard is under “## Heard”.");
  } catch (e) {
    notice.hide();
    new Notice(`Whisper could not run. ${(e as Error).message}`, 12000);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
