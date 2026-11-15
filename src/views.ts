import { ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type KodingPlugin from "./main";
import type { Bookmark } from "./settings";
import { lines } from "./settings";
import { NoteInfo, listNotes, nextAction, todaysHandful } from "./core";
import { ModelTimings, findAudio, makeModel, modelPaths, readTimings, speakableText } from "./audio";
import { attachAsTake, justKeep, keepAsSeed, phoneAudio } from "./inbox";
import { allCards } from "./quizview";
import { baseOf, markdownFilesUnder, resourceUrl } from "./io";
import { Cue, dateFromName, estimateCues, isoDate, splitSentences } from "./text";

export const DESK_VIEW = "koding-desk";
export const AI_VIEW = "koding-ai";
export const SHADOW_VIEW = "koding-shadow";
export const ARCHIVE_VIEW = "koding-archive";

function button(parent: HTMLElement, text: string, cls: string, onClick: () => unknown, icon?: string): HTMLButtonElement {
  const b = parent.createEl("button", { cls });
  if (icon) setIcon(b.createSpan({ cls: "koding-icon" }), icon);
  if (text) b.createSpan({ text });
  b.onclick = () => void onClick();
  return b;
}

/** Render "귤 **따러** 갈래?" with the bold part as <strong>. */
function renderBold(el: HTMLElement, text: string): void {
  text.split("**").forEach((part, i) => {
    if (!part) return;
    if (i % 2) el.createEl("strong", { text: part });
    else el.appendText(part);
  });
}

// =====================================================================
// Desk
// =====================================================================

export class DeskView extends ItemView {
  private turn = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: KodingPlugin) {
    super(leaf);
  }
  getViewType(): string {
    return DESK_VIEW;
  }
  getDisplayText(): string {
    return "Desk";
  }
  getIcon(): string {
    return "mail";
  }
  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const turn = ++this.turn;
    const p = this.plugin;
    const [action, phone, handful] = await Promise.all([nextAction(p), phoneAudio(p), todaysHandful(p)]);
    if (turn !== this.turn) return;

    const el = this.contentEl;
    el.empty();
    const desk = el.createDiv({ cls: "koding-desk" });

    // the next action
    const next = desk.createEl("button", { cls: "koding-next mod-cta" });
    next.createDiv({ cls: "koding-next-label", text: p.recorder.recording ? "Stop recording" : action.label });
    if (action.detail) next.createDiv({ cls: "koding-next-detail", text: action.detail });
    next.onclick = () => void p.doNextAction();
    if (action.step === "take" && action.note && !p.recorder.recording) {
      const done = desk.createEl("a", { cls: "koding-quiet", text: "The audio is finished" });
      const file = action.note.file;
      done.onclick = () => void p.startReview(file);
    }

    // low mode
    button(desk, "Just listen", "koding-listen", () => p.openArchive(true), "headphones");

    // from your phone
    if (phone.length) {
      const sec = desk.createDiv({ cls: "koding-section" });
      sec.createEl("h4", { text: "From your phone" });
      for (const path of phone) {
        const row = sec.createDiv({ cls: "koding-phone" });
        row.createDiv({ cls: "koding-phone-name", text: baseOf(path) });
        const audio = row.createEl("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = resourceUrl(p.app, path);
        const btns = row.createDiv({ cls: "koding-row" });
        const act = (fn: (pl: KodingPlugin, path: string) => Promise<void>) => async () => {
          audio.pause();
          audio.removeAttribute("src");
          audio.load(); // let go of the file so it can be moved
          try {
            await fn(p, path);
          } catch (e) {
            new Notice((e as Error).message);
          }
          await this.render();
        };
        button(btns, "Attach as a take", "", act(attachAsTake));
        button(btns, "Keep as a seed", "", act(keepAsSeed));
        button(btns, "Just keep", "", act(justKeep));
      }
    }

    // today's handful
    if (handful.length) {
      const sec = desk.createDiv({ cls: "koding-section" });
      sec.createEl("h4", { text: "Today's handful" });
      const list = sec.createDiv({ cls: "koding-handful" });
      for (const w of handful) renderBold(list.createDiv({ cls: "koding-handful-item" }), w.sentence);
      sec.createDiv({ cls: "koding-hint", text: "Read them aloud once." });
    }

    // a few quiz cards: the ones you missed come back sooner; nothing is ever due
    if (p.settings.cardsOnDesk && (await allCards(p)).length) {
      if (turn !== this.turn) return;
      const sec = desk.createDiv({ cls: "koding-section" });
      button(sec, "A few cards", "", () => p.openQuizPane("few"), "layers");
    }

    // AI bar
    const bar = desk.createDiv({ cls: "koding-section koding-aibar" });
    const marks = bar.createDiv({ cls: "koding-row" });
    for (const b of p.settings.bookmarks) {
      if (!b.name || !b.url) continue;
      button(marks, b.name, "koding-bookmark", () => p.openBookmark(b), b.mode === "browser" ? "external-link" : undefined);
    }
    const cmds = bar.createDiv({ cls: "koding-row" });
    button(cmds, "Send to AI", "", () => p.sendToAI(), "send");
    button(cmds, "Take reply", "", () => p.takeReply(), "clipboard-paste");
  }
}

// =====================================================================
// AI tab
// =====================================================================

const PARTITION = "persist:koding";

interface WebviewEl extends HTMLElement {
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
}

function chromeMajor(): string {
  return (process.versions as Record<string, string>).chrome?.split(".")[0] || "140";
}

/** The user agent of plain Chrome on this machine: no Obsidian or Electron marks. */
export function chromeUserAgent(custom: string): string {
  if (custom.trim()) return custom.trim();
  return navigator.userAgent
    .replace(/\s*obsidian\/\S+/i, "")
    .replace(/\s*Electron\/\S+/i, "")
    .replace(/Chrome\/\S+/, `Chrome/${chromeMajor()}.0.0.0`);
}

let sessionReady = false;

/** Give the plugin's own browser session a Chrome identity in its request headers too. */
function prepareSession(ua: string): void {
  if (sessionReady) return;
  sessionReady = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron");
    const remote = electron.remote ?? require("@electron/remote");
    const ses = remote.session.fromPartition(PARTITION);
    ses.setUserAgent(ua);
    const v = chromeMajor();
    const brands = `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not?A_Brand";v="99"`;
    ses.webRequest.onBeforeSendHeaders((details: { requestHeaders: Record<string, string> }, cb: (r: { requestHeaders: Record<string, string> }) => void) => {
      const h = details.requestHeaders;
      for (const k of Object.keys(h)) {
        const low = k.toLowerCase();
        if (low === "sec-ch-ua") h[k] = brands;
        else if (low === "user-agent") h[k] = ua;
      }
      cb({ requestHeaders: h });
    });
  } catch (e) {
    console.debug("koding: session headers left as they are", e);
  }
}

export class AIView extends ItemView {
  name = "AI";
  url = "";
  private web: WebviewEl | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: KodingPlugin) {
    super(leaf);
    this.navigation = false;
  }
  getViewType(): string {
    return AI_VIEW;
  }
  getDisplayText(): string {
    return this.name;
  }
  getIcon(): string {
    return "bot";
  }
  getState(): Record<string, unknown> {
    return { name: this.name, url: this.url };
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state || {}) as { name?: string; url?: string };
    const changed = !!s.url && s.url !== this.url;
    if (s.name) this.name = s.name;
    if (s.url) this.url = s.url;
    if (changed || !this.web) this.build();
    await super.setState(state, result);
  }

  private build(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("koding-ai");
    this.web = null;
    if (!this.url) return;
    const ua = chromeUserAgent(this.plugin.settings.userAgent);
    prepareSession(ua);

    const bar = el.createDiv({ cls: "koding-ai-bar" });
    button(bar, "", "clickable-icon", () => this.web?.goBack(), "arrow-left").ariaLabel = "Back";
    button(bar, "", "clickable-icon", () => this.web?.reload(), "rotate-cw").ariaLabel = "Reload";
    button(bar, "", "clickable-icon", () => this.web?.loadURL(this.url), "home").ariaLabel = this.name;
    button(bar, "", "clickable-icon", () => window.open(this.web?.getURL() || this.url), "external-link").ariaLabel = "Open in browser";
    bar.createDiv({ cls: "koding-spacer" });
    button(bar, "Send to AI", "", () => this.plugin.sendToAI(), "send");
    button(bar, "Take reply", "", () => this.plugin.takeReply(this.name), "clipboard-paste");

    const web = document.createElement("webview") as unknown as WebviewEl;
    web.setAttribute("partition", PARTITION);
    web.setAttribute("useragent", ua);
    web.setAttribute("allowpopups", "");
    web.setAttribute("src", this.url);
    web.addClass("koding-webview");
    el.appendChild(web);
    this.web = web;
  }
}

// =====================================================================
// Shadow player
// =====================================================================

export class ShadowView extends ItemView {
  private base = "";
  private notePath = "";
  private timings: ModelTimings | null = null;
  private audio: HTMLAudioElement | null = null;
  private slow = false;
  private loop = false;
  private running = false;
  private idx = 0;
  private stopAt = 0;
  private poll: number | null = null;
  private wait: number | null = null;
  private rows: HTMLElement[] = [];
  private guessed: Cue[] | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: KodingPlugin) {
    super(leaf);
  }
  getViewType(): string {
    return SHADOW_VIEW;
  }
  getDisplayText(): string {
    return this.base ? `Shadow · ${this.base}` : "Shadow";
  }
  getIcon(): string {
    return "audio-lines";
  }
  getState(): Record<string, unknown> {
    return { base: this.base, notePath: this.notePath };
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state || {}) as { base?: string; notePath?: string };
    if (s.base && s.base !== this.base) {
      this.base = s.base;
      this.notePath = s.notePath || "";
      await this.build();
    }
    await super.setState(state, result);
  }
  async onClose(): Promise<void> {
    this.halt();
  }

  private cues(): Cue[] {
    const t = this.timings;
    if (!t) return [];
    const c = this.slow ? t.slow : t.normal;
    if (c && c.length) return c;
    return this.guessed || splitSentences(t.text).map((text) => ({ start: 0, end: 0, text }));
  }

  private halt(): void {
    this.running = false;
    if (this.poll) window.clearInterval(this.poll);
    if (this.wait) window.clearTimeout(this.wait);
    this.poll = this.wait = null;
    this.audio?.pause();
  }

  private async build(): Promise<void> {
    this.halt();
    const el = this.contentEl;
    el.empty();
    const p = this.plugin;
    this.timings = await readTimings(p, this.base);
    const paths = modelPaths(p, this.base);
    if (!this.timings || !(await p.app.vault.adapter.exists(paths.normal))) {
      el.createDiv({ cls: "koding-hint", text: "This text has no model voice yet." });
      return;
    }
    const wrap = el.createDiv({ cls: "koding-shadow" });
    wrap.createEl("h3", { text: this.base });

    const audio = wrap.createEl("audio");
    this.audio = audio;
    audio.preload = "auto";
    audio.onloadedmetadata = () => {
      const t = this.timings;
      const have = t && (this.slow ? t.slow : t.normal);
      this.guessed = t && !(have && have.length) && isFinite(audio.duration) ? estimateCues(t.text, audio.duration) : null;
    };
    audio.onended = () => this.sentenceEnded();
    const setSrc = () => (audio.src = resourceUrl(p.app, this.slow ? paths.slow : paths.normal));
    setSrc();

    const bar = wrap.createDiv({ cls: "koding-row" });
    const speed = button(bar, "Normal", "", () => {
      this.halt();
      this.slow = !this.slow;
      speed.lastElementChild?.setText(this.slow ? "Slow" : "Normal");
      setSrc();
      runBtn.lastElementChild?.setText("Shadow run");
    }, "gauge");
    const loopBtn = button(bar, "Loop", "", () => {
      this.loop = !this.loop;
      loopBtn.toggleClass("is-active", this.loop);
    }, "repeat");
    const runBtn = button(bar, "Shadow run", "mod-cta", () => {
      if (this.running) {
        this.halt();
      } else {
        this.running = true;
        this.play(this.idx);
      }
      runBtn.lastElementChild?.setText(this.running ? "Stop" : "Shadow run");
    }, "play");
    if (this.notePath) {
      button(bar, "Record", "", () => {
        this.halt();
        runBtn.lastElementChild?.setText("Shadow run");
        const f = p.app.vault.getAbstractFileByPath(this.notePath);
        void p.recorder.toggle(f instanceof TFile ? f : null);
      }, "mic");
    }

    const list = wrap.createDiv({ cls: "koding-sentences" });
    this.rows = this.cues().map((c, i) => {
      const row = list.createDiv({ cls: "koding-sentence", text: c.text });
      row.onclick = () => this.play(i);
      return row;
    });
    this.mark();
    wrap.createDiv({ cls: "koding-hint", text: "Tap a sentence to hear it. A shadow run plays each sentence and leaves you room to say it." });
  }

  private mark(): void {
    this.rows.forEach((r, i) => r.toggleClass("is-current", i === this.idx));
  }

  private play(i: number): void {
    const audio = this.audio;
    const cues = this.cues();
    if (!audio || !cues[i]) return;
    if (this.wait) window.clearTimeout(this.wait);
    if (this.poll) window.clearInterval(this.poll);
    this.idx = i;
    this.mark();
    this.rows[i]?.scrollIntoView({ block: "nearest" });
    const c = cues[i];
    const whole = c.end <= c.start; // no timings at all: play everything
    audio.currentTime = whole ? 0 : c.start;
    this.stopAt = whole ? Infinity : c.end;
    void audio.play();
    this.poll = window.setInterval(() => {
      if (audio.currentTime >= this.stopAt - 0.02) {
        audio.pause();
        this.sentenceEnded();
      }
    }, 25);
  }

  private sentenceEnded(): void {
    if (this.poll) window.clearInterval(this.poll);
    this.poll = null;
    const cues = this.cues();
    const c = cues[this.idx];
    if (!c) return;
    if (!this.running && !this.loop) return;
    const length = Math.max(0.8, c.end - c.start);
    const pause = length * this.plugin.settings.shadowPause + 0.4;
    this.wait = window.setTimeout(() => {
      if (this.loop) this.play(this.idx);
      else if (this.idx + 1 < cues.length) this.play(this.idx + 1);
      else {
        this.running = false;
        this.idx = 0;
        this.mark();
        this.contentEl.querySelector(".mod-cta span:last-child")?.setText("Shadow run");
      }
    }, pause * 1000);
  }
}

// =====================================================================
// Archive and Just listen
// =====================================================================

interface Entry {
  date: string;
  title: string;
  text: string;
  take?: string;
  model?: string;
  source?: TFile;
  path: string;
}

interface Track {
  title: string;
  text: string;
  path: string;
}

export class ArchiveView extends ItemView {
  private audio: HTMLAudioElement | null = null;
  private queue: Track[] = [];
  private at = 0;
  private nowEl: HTMLElement | null = null;
  private textEl: HTMLElement | null = null;
  private entries: Entry[] = [];
  private turn = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: KodingPlugin) {
    super(leaf);
  }
  getViewType(): string {
    return ARCHIVE_VIEW;
  }
  getDisplayText(): string {
    return "Archive";
  }
  getIcon(): string {
    return "archive";
  }
  async onOpen(): Promise<void> {
    await this.render();
  }
  async onClose(): Promise<void> {
    this.audio?.pause();
  }

  private async collect(): Promise<Entry[]> {
    const p = this.plugin;
    const adapter = p.app.vault.adapter;
    const out: Entry[] = [];
    const modelOf = async (base: string) => {
      const m = modelPaths(p, base).normal;
      return (await adapter.exists(m)) ? m : undefined;
    };
    const notes: NoteInfo[] = (await listNotes(p)).filter((n) => n.status === "done");
    for (const n of notes) {
      const last = n.takes[n.takes.length - 1];
      out.push({
        date: n.date,
        title: n.file.basename.replace(/^\d{4}-\d{2}-\d{2}\s*/, ""),
        text: n.final,
        take: last ? (await findAudio(p, last, n.file.path)) || undefined : undefined,
        model: await modelOf(n.file.basename),
        path: n.file.path,
      });
    }
    for (const folder of lines(p.settings.archiveSources)) {
      for (const f of markdownFilesUnder(p.app, folder)) {
        out.push({
          date: dateFromName(f.basename) || isoDate(new Date(f.stat.ctime)),
          title: f.basename,
          text: "",
          model: await modelOf(f.basename),
          source: f,
          path: f.path,
        });
      }
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));
  }

  async render(): Promise<void> {
    const turn = ++this.turn;
    const entries = await this.collect();
    if (turn !== this.turn) return;
    this.entries = entries;
    const p = this.plugin;
    const el = this.contentEl;
    const wasPlaying = this.audio && !this.audio.paused;
    if (wasPlaying) return; // do not interrupt listening to redraw
    el.empty();
    const wrap = el.createDiv({ cls: "koding-archive" });

    const player = wrap.createDiv({ cls: "koding-player" });
    const row = player.createDiv({ cls: "koding-row" });
    button(row, "Just listen", "mod-cta", () => this.listen(), "headphones");
    const order = button(row, p.settings.listenOrder === "shuffle" ? "Shuffled" : "Newest first", "", async () => {
      p.settings.listenOrder = p.settings.listenOrder === "shuffle" ? "newest" : "shuffle";
      await p.saveSettings();
      order.lastElementChild?.setText(p.settings.listenOrder === "shuffle" ? "Shuffled" : "Newest first");
    }, "shuffle");
    button(row, "Next", "", () => this.step(), "skip-forward");
    this.nowEl = player.createDiv({ cls: "koding-now" });
    const audio = player.createEl("audio");
    audio.controls = true;
    audio.onended = () => this.step();
    this.audio = audio;
    this.textEl = player.createDiv({ cls: "koding-now-text" });

    const list = wrap.createDiv({ cls: "koding-archive-list" });
    if (!entries.length) list.createDiv({ cls: "koding-hint", text: "Finished notes appear here." });
    for (const e of entries) {
      const item = list.createDiv({ cls: "koding-entry" });
      item.createSpan({ cls: "koding-entry-date", text: e.date });
      const title = item.createEl("a", { cls: "koding-entry-title", text: e.title });
      title.onclick = () => void p.app.workspace.openLinkText(e.path, "", "tab");
      const btns = item.createDiv({ cls: "koding-row" });
      if (e.take) button(btns, "Take", "", () => this.playOne(e, e.take!), "mic");
      if (e.model) {
        button(btns, "Model", "", () => this.playOne(e, e.model!), "play");
        button(btns, "Shadow", "", () => p.openShadow(baseOf(e.path).replace(/\.md$/, ""), e.source ? "" : e.path), "audio-lines");
      } else if (e.source) {
        const src = e.source;
        button(btns, "Make model", "", async () => {
          const notice = new Notice("Making the model voice…", 0);
          try {
            await makeModel(p, src.basename, await speakableText(p, src));
            notice.hide();
          } catch (err) {
            notice.hide();
            new Notice(`The model voice could not be made. ${(err as Error).message}`, 12000);
          }
          await this.render();
        }, "wand");
      }
    }
  }

  private async textFor(e: Entry): Promise<string> {
    if (e.text) return e.text;
    if (e.source) return speakableText(this.plugin, e.source);
    return "";
  }

  private async playOne(e: Entry, path: string): Promise<void> {
    this.queue = [{ title: `${e.date} · ${e.title}`, text: await this.textFor(e), path }];
    this.at = 0;
    this.start();
  }

  /** Low mode: play the finished notes and their models, one after another. */
  async listen(): Promise<void> {
    const q: Track[] = [];
    let entries = this.entries.filter((e) => e.take || e.model);
    if (this.plugin.settings.listenOrder === "shuffle") entries = entries.slice().sort(() => Math.random() - 0.5);
    for (const e of entries) {
      const text = await this.textFor(e);
      const title = `${e.date} · ${e.title}`;
      if (e.take) q.push({ title, text, path: e.take });
      if (e.model) q.push({ title: `${title} · model`, text, path: e.model });
    }
    if (!q.length) {
      this.nowEl?.setText("Nothing to play yet. “Make model” on one of the texts below gives you something to listen to.");
      return;
    }
    this.queue = q;
    this.at = 0;
    this.start();
  }

  private step(): void {
    if (this.at + 1 >= this.queue.length) return;
    this.at++;
    this.start();
  }

  private start(): void {
    const t = this.queue[this.at];
    if (!t || !this.audio) return;
    this.nowEl?.setText(t.title);
    this.textEl?.setText(t.text);
    this.audio.src = resourceUrl(this.plugin.app, normalizePath(t.path));
    void this.audio.play();
  }
}
