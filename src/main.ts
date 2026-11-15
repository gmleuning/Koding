import { App, Editor, MarkdownView, Modal, Notice, Plugin, Setting, SuggestModal, TFile, WorkspaceLeaf, debounce, normalizePath } from "obsidian";
import { Bookmark, DEFAULT_SETTINGS, KodingSettingTab, KodingSettings } from "./settings";
import { NoteInfo, ReviewStep, Role, buildPacket, localWordList, nextReviewStep, setReviewStep, stepFor, buildSelectionPacket, createNote, findRole, finishNote, isNotePath, listNotes, listRoles, nextAction, readNote, writeDefaultRoles } from "./core";
import { StepBars } from "./steps";
import { Recorder, listenToLatestTake, makeModel, makeModelForNote, modelPaths, speakableText } from "./audio";
import { processInbox } from "./inbox";
import { QUIZ_VIEW, QuizView } from "./quizview";
import type { CardRecord } from "./cards";
import { AIView, AI_VIEW, ARCHIVE_VIEW, ArchiveView, DESK_VIEW, DeskView, SHADOW_VIEW, ShadowView } from "./views";
import { editText, ensureFolder, parentOf } from "./io";
import { appendToSection, appendToSubsection, fencedBlock, getSection, repairQuiz, isoDate, koreanFromReply, meaningful, setFrontValue, setSection } from "./text";
import { freePath } from "./io";

interface KodingState {
  lastShown: Record<string, number>;
  handfulDate: string;
  handful: string[];
  lastBookmark: string;
  lastNotePath: string;
  /** The request copied for a note and not yet answered with Take reply. */
  sent: { path: string; role: string; app: string } | null;
  rolesSeeded: string[];
  /** When each quiz card was last answered, and how well it is known. Kept here, not in your notes. */
  cards: Record<string, CardRecord>;
}

const DEFAULT_STATE: KodingState = { lastShown: {}, handfulDate: "", handful: [], lastBookmark: "", lastNotePath: "", sent: null, rolesSeeded: [], cards: {} };

function clipboard(): { readText(): string; writeText(t: string): void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("electron").clipboard;
}

export default class KodingPlugin extends Plugin {
  settings: KodingSettings = DEFAULT_SETTINGS;
  state: KodingState = DEFAULT_STATE;
  recorder!: Recorder;
  steps = new StepBars(this);
  private inboxTimer: number | null = null;
  private actions = new Map<MarkdownView, HTMLElement[]>();
  private lastPacket = "";

  refreshDesk = debounce(() => this.redraw(), 400, true);
  private inboxSoon = debounce(() => void this.checkInbox(), 3500, true);

  async onload(): Promise<void> {
    const data = ((await this.loadData()) || {}) as { settings?: Partial<KodingSettings>; state?: Partial<KodingState> };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    this.settings.bookmarks = (data.settings?.bookmarks || DEFAULT_SETTINGS.bookmarks).map((b) => ({ ...b }));
    this.state = Object.assign({}, DEFAULT_STATE, data.state);

    this.registerView(DESK_VIEW, (leaf) => new DeskView(leaf, this));
    this.registerView(AI_VIEW, (leaf) => new AIView(leaf, this));
    this.registerView(SHADOW_VIEW, (leaf) => new ShadowView(leaf, this));
    this.registerView(ARCHIVE_VIEW, (leaf) => new ArchiveView(leaf, this));
    this.registerView(QUIZ_VIEW, (leaf) => new QuizView(leaf, this));

    this.recorder = new Recorder(this, this.addStatusBarItem());
    this.addRibbonIcon("mail", "Koding: Desk", () => void this.openDesk());
    this.addSettingTab(new KodingSettingTab(this.app, this));
    this.addCommands();

    this.app.workspace.onLayoutReady(async () => {
      await this.setupVault(false);
      await this.checkInbox();
      if (this.settings.openDeskOnStartup) {
        await this.openDesk();
        // the AI tab sits in the right column; open the first bookmark there if none is open yet
        const b = this.defaultBookmark();
        if (b && b.mode === "tab" && !this.app.workspace.getLeavesOfType(AI_VIEW).length) {
          await this.openBookmark(b);
          await this.openDesk();
        }
      }
      this.syncActions();
      this.watch();
      this.resetInboxTimer();
    });
  }

  onunload(): void {
    if (this.inboxTimer) window.clearInterval(this.inboxTimer);
    for (const els of this.actions.values()) els.forEach((e) => e.remove());
    this.actions.clear();
    this.steps.clear();
  }

  // ---------- data ----------

  private async persist(): Promise<void> {
    await this.saveData({ settings: this.settings, state: this.state });
  }
  async saveSettings(): Promise<void> {
    await this.persist();
  }
  async saveState(): Promise<void> {
    await this.persist();
  }

  /** Called when the settings pane closes. */
  settingsChanged(): void {
    this.resetInboxTimer();
    void this.setupVault(false).then(() => {
      this.syncActions();
      this.refreshDesk();
    });
  }

  async setupVault(restoreRoles: boolean): Promise<void> {
    const s = this.settings;
    const app = this.app;
    for (const f of [s.notesFolder, s.takesFolder, s.modelsFolder, s.phoneFolder, s.inboxFolder, s.inboxDoneFolder, s.tutorFolder, s.quizFolder]) {
      await ensureFolder(app, f);
    }
    for (const [path, text] of [
      [s.seedsFile, ""],
      [s.wordsFile, ""],
      [s.logFile, ""],
    ]) {
      const p = normalizePath(path);
      if (!(await app.vault.adapter.exists(p))) {
        await ensureFolder(app, parentOf(p));
        await app.vault.create(p, text);
      }
    }
    await writeDefaultRoles(this, restoreRoles);
  }

  // ---------- watching the vault ----------

  private watch(): void {
    const inInbox = (path: string) => parentOf(path) === normalizePath(this.settings.inboxFolder);
    const matters = (path: string) =>
      isNotePath(this, path) || path === normalizePath(this.settings.seedsFile) || path === normalizePath(this.settings.wordsFile) || inInbox(path);
    this.registerEvent(
      this.app.vault.on("create", (f) => {
        if (inInbox(f.path)) this.inboxSoon();
        if (matters(f.path)) this.refreshDesk();
      })
    );
    this.registerEvent(this.app.vault.on("modify", (f) => matters(f.path) && this.refreshDesk()));
    this.registerEvent(this.app.vault.on("delete", (f) => matters(f.path) && this.refreshDesk()));
    this.registerEvent(this.app.vault.on("rename", (f, old) => (matters(f.path) || matters(old)) && this.refreshDesk()));
    this.registerEvent(
      this.app.workspace.on("file-open", (f) => {
        if (f && isNotePath(this, f.path) && f.path !== this.state.lastNotePath) {
          this.state.lastNotePath = f.path;
          void this.saveState();
        }
        this.syncActions();
      })
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncActions()));
  }

  private resetInboxTimer(): void {
    if (this.inboxTimer) window.clearInterval(this.inboxTimer);
    this.inboxTimer = null;
    const sec = this.settings.inboxInterval;
    if (sec > 0) this.inboxTimer = window.setInterval(() => void this.checkInbox(), Math.max(5, sec) * 1000);
  }

  async checkInbox(): Promise<void> {
    await processInbox(this);
    this.refreshDesk();
  }

  private redraw(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DESK_VIEW)) if (leaf.view instanceof DeskView) void leaf.view.render();
    for (const leaf of this.app.workspace.getLeavesOfType(ARCHIVE_VIEW)) if (leaf.view instanceof ArchiveView) void leaf.view.render();
    this.steps.sync();
  }

  recordingChanged(): void {
    this.refreshDesk();
  }

  // ---------- the record button in every note ----------

  private syncActions(): void {
    const live = new Set<MarkdownView>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      live.add(view);
      const isNote = !!view.file && isNotePath(this, view.file.path);
      const has = this.actions.get(view);
      if (isNote && !has) {
        const file = () => view.file;
        this.actions.set(view, [
          view.addAction("ear", "What did Whisper hear in the latest take?", () => file() && void listenToLatestTake(this, file()!)),
          view.addAction("audio-lines", "Shadow the model", () => file() && void this.openShadow(file()!.basename, file()!.path)),
          view.addAction("wand", "Make the model voice", () => file() && void makeModelForNote(this, file()!)),
          view.addAction("mic", "Record a take (again to stop)", () => void this.recorder.toggle(file())),
        ]);
      } else if (!isNote && has) {
        has.forEach((e) => e.remove());
        this.actions.delete(view);
      }
    }
    for (const view of Array.from(this.actions.keys())) if (!live.has(view)) this.actions.delete(view);
    this.steps.sync();
  }

  // ---------- finding the note ----------

  private activeNoteFile(): TFile | null {
    const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    return f && isNotePath(this, f.path) ? f : null;
  }

  /** The note a command is about: the one in front, else the last one opened, else the one in progress. */
  async currentNote(): Promise<TFile | null> {
    const active = this.activeNoteFile();
    if (active) return active;
    const last = this.app.vault.getAbstractFileByPath(this.state.lastNotePath);
    if (last instanceof TFile && isNotePath(this, last.path)) return last;
    return (await nextAction(this)).note?.file ?? null;
  }

  private async withNote(fn: (f: TFile) => unknown): Promise<void> {
    const f = await this.currentNote();
    if (f) await fn(f);
    else new Notice("There is no voice note yet.");
  }

  // ---------- opening things ----------

  private async reveal(type: string, where: () => WorkspaceLeaf, state?: Record<string, unknown>, match?: (l: WorkspaceLeaf) => boolean): Promise<WorkspaceLeaf> {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(type).find((l) => (match ? match(l) : true));
    if (!leaf) {
      leaf = where();
      await leaf.setViewState({ type, active: true, state });
    } else if (state) {
      await leaf.setViewState({ type, active: true, state });
    }
    await ws.revealLeaf(leaf);
    return leaf;
  }

  async openDesk(): Promise<void> {
    const leaf = await this.reveal(DESK_VIEW, () => this.app.workspace.getLeaf("tab"));
    if (leaf.view instanceof DeskView) await leaf.view.render();
  }

  async openArchive(listen: boolean): Promise<void> {
    const leaf = await this.reveal(ARCHIVE_VIEW, () => this.app.workspace.getLeaf("tab"));
    if (leaf.view instanceof ArchiveView) {
      await leaf.view.render();
      if (listen) await leaf.view.listen();
    }
  }

  async openShadow(base: string, notePath: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(modelPaths(this, base).normal))) {
      new Notice("This text has no model voice yet.");
      return;
    }
    await this.reveal(SHADOW_VIEW, () => this.app.workspace.getLeaf("split", "vertical"), { base, notePath });
  }

  async openBookmark(b: Bookmark): Promise<void> {
    this.state.lastBookmark = b.name;
    void this.saveState();
    if (b.mode === "browser") {
      window.open(b.url);
      return;
    }
    const ws = this.app.workspace;
    const others = ws.getLeavesOfType(AI_VIEW);
    await this.reveal(
      AI_VIEW,
      () => {
        if (!others.length) return ws.getLeaf("split", "vertical");
        ws.setActiveLeaf(others[0], { focus: false });
        return ws.getLeaf("tab");
      },
      { name: b.name, url: b.url },
      (l) => (l.getViewState().state as { name?: string } | undefined)?.name === b.name
    );
  }

  private defaultBookmark(): Bookmark | undefined {
    const usable = this.settings.bookmarks.filter((b) => b.name && b.url);
    // the order in the settings decides: requests go to the first bookmark that opens in a tab
    return usable.find((b) => b.mode === "tab") || usable[0];
  }

  async openNote(file: TFile, section?: string): Promise<void> {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType("markdown").find((l) => (l.getViewState().state as { file?: string } | undefined)?.file === file.path);
    if (!leaf) {
      leaf = ws.getLeaf("tab");
      await leaf.openFile(file);
    }
    await ws.revealLeaf(leaf);
    ws.setActiveLeaf(leaf, { focus: true });
    const view = leaf.view;
    if (section && view instanceof MarkdownView) {
      const ed = view.editor;
      const want = `## ${section}`.toLowerCase();
      for (let i = 0; i < ed.lineCount(); i++) {
        if (ed.getLine(i).trim().toLowerCase() === want) {
          const line = Math.min(i + 1, ed.lineCount() - 1);
          ed.setCursor({ line, ch: ed.getLine(line).length });
          ed.scrollIntoView({ from: { line: i, ch: 0 }, to: { line, ch: 0 } }, true);
          ed.focus();
          break;
        }
      }
    }
  }

  // ---------- the session ----------

  async doNextAction(): Promise<void> {
    if (this.recorder.recording) {
      await this.recorder.stop();
      return;
    }
    const a = await nextAction(this);
    const file = a.note?.file;
    switch (a.step) {
      case "draft":
        await this.openNote(file!, "Draft");
        break;
      case "translate":
      case "correct":
        await this.openNote(file!, "Draft");
        if (this.settings.sendOnCorrect && this.defaultBookmark()) await this.sendToAI(a.step === "translate" ? "translat" : "corrector", file!);
        break;
      case "final":
        await this.openNote(file!, "Final");
        new Notice("Write the text you will record under “## Final”.", 6000);
        break;
      case "model":
        await this.openNote(file!, "Final");
        await makeModelForNote(this, file!);
        break;
      case "shadow":
        await this.openNote(file!, "Final");
        await this.openShadow(file!.basename, file!.path);
        break;
      case "take":
        await this.openNote(file!, "Takes");
        await this.recorder.start(file!);
        break;
      case "questions":
        await this.openNote(file!, "Questions");
        break;
      case "checklist":
        await setReviewStep(this, file!, "checklist");
        await this.openNote(file!, "Checklist");
        break;
      case "quiz":
        await this.sendToAI("quiz", file!);
        break;
      case "words":
        await this.openNote(file!, "Words");
        break;
      case "seed":
        await this.openNote(await createNote(this, a.seed!.text, a.seed), "Draft");
        break;
      case "new":
        this.promptNewNote();
        break;
    }
    this.refreshDesk();
  }

  promptNewNote(): void {
    new PromptModal(this.app, "A new note", `What do you want to say to ${this.settings.recipient}? A phrase, a line, an idea.`, "Start", async (text) => {
      await this.openNote(await createNote(this, text), "Draft");
      this.refreshDesk();
    }).open();
  }

  async markDone(file: TFile): Promise<void> {
    await finishNote(this, file);
    new Notice(`${file.basename} is in the Archive.`);
    this.refreshDesk();
  }

  // ---------- AI ----------

  /** Copy a request to the clipboard, remember it for the note, and bring the AI tab forward. */
  private async deliver(packet: string, roleName: string, notePath: string | null): Promise<void> {
    clipboard().writeText(packet);
    this.lastPacket = packet.trim();
    const b = this.defaultBookmark();
    this.state.sent = notePath ? { path: notePath, role: roleName.toLowerCase(), app: b?.name || "AI" } : null;
    await this.saveState();
    if (b) await this.openBookmark(b);
    new Notice(`Copied. Paste it into ${b ? b.name : "your AI app"} (Ctrl+V) and send. Then copy the answer and press Take reply.`, 8000);
    this.refreshDesk();
  }

  async sendToAI(roleWord?: string, file?: TFile): Promise<void> {
    const send = async (role: Role) => {
      try {
        const kind = role.name.toLowerCase();
        const needsNote = !kind.includes("seed") && !kind.includes("look back");
        const target = file ?? (needsNote ? await this.currentNote() : null);
        if (needsNote && !target) {
          new Notice("There is no voice note to send.");
          return;
        }
        const note: NoteInfo | null = target ? await readNote(this, target) : null;
        await this.deliver(await buildPacket(this, role, note), role.name, needsNote && target ? target.path : null);
        if (kind.includes("look back")) await this.openArchive(false);
      } catch (e) {
        new Notice((e as Error).message, 8000);
      }
    };
    if (roleWord) {
      const role = findRole(this, roleWord);
      if (role) await send(role);
      else new Notice(`There is no “${roleWord}” role in ${this.settings.tutorFolder}/.`);
      return;
    }
    const roles = listRoles(this);
    if (!roles.length) {
      new Notice(`There are no roles in ${this.settings.tutorFolder}/. “Set up the vault” in the settings restores them.`);
      return;
    }
    new RoleModal(this.app, roles, (r) => void send(r)).open();
  }

  /** Send selected text (from any file) with a role. */
  async sendSelection(roleWord: string, text: string, file: TFile | null): Promise<void> {
    const role = findRole(this, roleWord);
    if (!role) {
      new Notice(`There is no “${roleWord}” role in ${this.settings.tutorFolder}/.`);
      return;
    }
    try {
      await this.deliver(await buildSelectionPacket(this, role, text), role.name, file && isNotePath(this, file.path) ? file.path : null);
    } catch (e) {
      new Notice((e as Error).message, 8000);
    }
  }

  async takeReply(appName?: string, file?: TFile): Promise<void> {
    const reply = clipboard().readText().trim();
    if (!reply) {
      new Notice("The clipboard is empty. Copy the AI's answer first.");
      return;
    }
    if (reply === this.lastPacket) {
      new Notice("The clipboard still holds the request. In the AI tab, copy the answer first (the copy button under it).", 8000);
      return;
    }
    const sent = this.state.sent;
    const sentFile = sent ? this.app.vault.getAbstractFileByPath(sent.path) : null;
    const f = file ?? this.activeNoteFile() ?? (sentFile instanceof TFile ? sentFile : null) ?? (await this.currentNote());
    if (!f) {
      new Notice("There is no voice note to put the reply in.");
      return;
    }
    const who = appName || sent?.app || this.aiName();
    const stamp = `**${who} · ${isoDate()}**`;
    // headings inside the reply would cut the note's own sections apart
    const safe = reply.replace(/\r\n/g, "\n").replace(/^#{1,6}\s+(.*)$/gm, "**$1**");
    // where the reply goes: what was asked for, else the step the note is on
    const step = stepFor(await readNote(this, f));
    const role = sent && sent.path === f.path ? sent.role : "";
    const kind = role.includes("question") || (!role && step === "questions") ? "answers" : role.includes("quiz") || (!role && step === "quiz") ? "quiz" : "corrections";
    let message = "";
    let section = "Final";

    if (kind === "answers") {
      await editText(this.app, f.path, (t) => appendToSection(t, "Answers", `${stamp}

${safe}`));
      if (step === "questions") await setReviewStep(this, f, "checklist");
      message = "The answers are under Answers. Next: tick the words you know.";
      section = "Answers";
    } else if (kind === "quiz") {
      const quiz = fencedBlock(reply, "quiz") ?? reply.replace(/```[ \t]*words[\s\S]*?```/i, "").trim();
      const words = fencedBlock(reply, "words");
      const body = `---\nnote: "[[${f.basename}]]"\ndate: ${isoDate()}\n---\n\n#flashcards/korean\n\n${repairQuiz(quiz)}\n`;
      // a quiz made again for the same note replaces the old one instead of adding a copy
      const linked = /\[\[([^\]|]+)/.exec(getSection(await this.app.vault.read(f), "Quiz"));
      const existing = linked ? this.app.metadataCache.getFirstLinkpathDest(linked[1], f.path) : null;
      let path: string;
      if (existing) {
        path = existing.path;
        await this.app.vault.modify(existing, body);
      } else {
        await ensureFolder(this.app, this.settings.quizFolder);
        path = await freePath(this.app, this.settings.quizFolder, `${f.basename} quiz.md`);
        await this.app.vault.create(path, body);
      }
      const quizName = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
      await editText(this.app, f.path, (t) => {
        let out = setSection(t, "Quiz", `[[${quizName}]]`);
        if (words && !meaningful(getSection(out, "Words"))) out = setSection(out, "Words", words);
        return out;
      });
      if (step === "quiz") await setReviewStep(this, f, "words");
      message = words ? "The quiz is saved as its own file, and the new word list is under Words." : "The quiz is saved as its own file. The reply had no word list; the bar can make one from your checklist.";
      section = "Words";
    } else {
      const korean = koreanFromReply(reply);
      let filled = false;
      await editText(this.app, f.path, (t) => {
        let out = appendToSubsection(t, "Corrections", "AI", `${stamp}

${safe}`);
        if (korean && !meaningful(getSection(out, "Final"))) {
          out = setSection(out, "Final", korean);
          filled = true;
        }
        return out;
      });
      message = filled ? "Reply added under Corrections → AI, and its Korean is now under Final. Change it as you like." : "Reply added under Corrections → AI.";
    }
    if (sent && sent.path === f.path) this.state.sent = null;
    await this.saveState();
    new Notice(message, 8000);
    await this.openNote(f, section);
    this.refreshDesk();
  }

  /** "The audio is finished": move on to questions. */
  async startReview(file: TFile): Promise<void> {
    await setReviewStep(this, file, "questions");
    await this.openNote(file, "Questions");
    new Notice("Write each word or grammar point you didn't know under Questions, one per line. Or select it in the text, right-click, and choose “Ask about this”.", 10000);
    this.refreshDesk();
  }

  async goToReviewStep(file: TFile, step: ReviewStep): Promise<void> {
    await setReviewStep(this, file, step);
    this.refreshDesk();
  }

  async nextReview(file: TFile): Promise<void> {
    await nextReviewStep(this, file);
    const n = await readNote(this, file);
    const step = stepFor(n);
    await this.openNote(file, step === "checklist" ? "Checklist" : step === "words" ? "Words" : step === "quiz" ? "Quiz" : "Questions");
    this.refreshDesk();
  }

  /** Fill Words from the questions and the checklist, without the AI. */
  async wordsFromChecklist(file: TFile): Promise<void> {
    const list = localWordList(await readNote(this, file));
    if (!list) {
      new Notice("Every word is ticked with a meaning and there were no questions, so there is nothing new to list.");
      return;
    }
    await editText(this.app, file.path, (t) => appendToSection(t, "Words", list));
    await this.openNote(file, "Words");
  }

  /** Take a note's quiz in the quiz pane. */
  async openQuiz(file: TFile): Promise<void> {
    const link = /\[\[([^\]|]+)/.exec(getSection(await this.app.vault.read(file), "Quiz"));
    const quiz = link ? this.app.metadataCache.getFirstLinkpathDest(link[1], file.path) : null;
    if (quiz) await this.openQuizPane("file", quiz.path);
    else new Notice("There is no quiz for this note yet.");
  }

  /** "few": a handful drawn from every quiz; "file": every card in one file. */
  async openQuizPane(mode: "few" | "file", path = ""): Promise<void> {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(QUIZ_VIEW)[0];
    if (!leaf) leaf = ws.getLeaf("tab");
    // the fresh value makes the pane start over even when nothing else changed
    await leaf.setViewState({ type: QUIZ_VIEW, active: true, state: { mode, path, fresh: Date.now() } });
    await ws.revealLeaf(leaf);
  }

  async useAsFinal(file: TFile, text: string): Promise<void> {
    const current = meaningful(getSection(await this.app.vault.read(file), "Final"));
    if (current && current !== text) {
      new Notice("Final already has text. Clear it first if you want to replace it.");
      return;
    }
    await editText(this.app, file.path, (t) => setFrontValue(setSection(t, "Final", text), "status", "corrected"));
    await this.openNote(file, "Final");
    this.refreshDesk();
  }

  async writeKoreanMyself(file: TFile): Promise<void> {
    await this.openNote(file, "Draft");
    new Notice("Write your Korean under the English in Draft, with English in brackets where you're stuck. Once it's mostly Korean, the bar moves on to corrections.", 10000);
  }

  /** Name of the AI app requests go to. */
  aiName(): string {
    return this.defaultBookmark()?.name || "AI";
  }

  async cancelSent(): Promise<void> {
    this.state.sent = null;
    await this.saveState();
    this.refreshDesk();
  }

  /** Bring the AI tab that requests go to to the front, opening it if needed. */
  async showAI(): Promise<void> {
    const b = this.defaultBookmark();
    if (b) await this.openBookmark(b);
  }

  // ---------- commands ----------

  private addCommands(): void {
    const cmd = (id: string, name: string, callback: () => unknown, hotkey?: { modifiers: ("Mod" | "Shift" | "Alt")[]; key: string }) =>
      this.addCommand({ id, name, callback: () => void callback(), hotkeys: hotkey ? [hotkey] : undefined });

    cmd("open-desk", "Open the Desk", () => this.openDesk());
    cmd("next-action", "Do the next action", () => this.doNextAction());
    cmd("new-note", "Start a new note", () => this.promptNewNote());
    cmd("record", "Record a take (start / stop)", async () => this.recorder.toggle(this.recorder.recording ? null : await this.currentNote()), { modifiers: ["Mod", "Shift"], key: "R" });
    cmd("make-model", "Make the model voice", async () => {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (active && !isNotePath(this, active.path)) {
        // any other text, such as an archive source
        const notice = new Notice("Making the model voice…", 0);
        try {
          await makeModel(this, active.basename, await speakableText(this, active));
          new Notice("The model voice is ready.");
        } catch (e) {
          new Notice(`The model voice could not be made. ${(e as Error).message}`, 12000);
        }
        notice.hide();
        this.refreshDesk();
        return;
      }
      await this.withNote((f) => makeModelForNote(this, f));
    });
    cmd("shadow", "Open the shadow player", async () => {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (active && !isNotePath(this, active.path)) return this.openShadow(active.basename, "");
      await this.withNote((f) => this.openShadow(f.basename, f.path));
    });
    cmd("listen-take", "Listener: what did Whisper hear in the latest take?", () => this.withNote((f) => listenToLatestTake(this, f)));
    cmd("send", "Send to AI (choose a role)", () => this.sendToAI());
    cmd("send-corrector", "Send to AI: correct my draft", () => this.sendToAI("corrector"));
    cmd("send-noticer", "Send to AI: let me try first", () => this.sendToAI("noticer"));
    cmd("send-seeds", "Send to AI: find seeds", () => this.sendToAI("seed"));
    cmd("send-listener", "Send to AI: explain what Whisper heard", () => this.sendToAI("listener"));
    cmd("look-back", "Look back: an early note beside a recent one", () => this.sendToAI("look back"));
    cmd("take-reply", "Take reply (paste the AI's answer into the note)", () => this.takeReply());
    cmd("mark-done", "Mark this note done", () => this.withNote((f) => this.markDone(f)));
    cmd("archive", "Open the Archive", () => this.openArchive(false));
    cmd("quiz-few", "Quiz: a few cards", () => this.openQuizPane("few"));
    cmd("quiz-file", "Quiz: every card in this file", async () => {
      const f = this.app.workspace.getActiveFile();
      if (!f) return new Notice("Open a quiz file or a voice note first.");
      if (isNotePath(this, f.path)) return this.openQuiz(f);
      await this.openQuizPane("file", f.path);
    });
    cmd("just-listen", "Just listen", () => this.openArchive(true));
    cmd("check-inbox", "Check the Inbox now", () => this.checkInbox());
    cmd("log", "Add a line to the log", () =>
      new PromptModal(this.app, "Log", "What got in the way, or what changed?", "Add", async (text) => {
        await editText(this.app, this.settings.logFile, (t) => t.replace(/\s*$/, "") + (t.trim() ? "\n" : "") + `- ${isoDate()} · ${text}\n`);
      }).open()
    );
    cmd("list-notes", "Open the note in progress", async () => {
      const open = (await listNotes(this)).find((n) => n.status !== "done");
      if (open) await this.openNote(open.file);
      else new Notice("No note is in progress.");
    });

    this.addCommand({
      id: "translate-selection",
      name: "Translate the selection with AI",
      editorCallback: (editor: Editor, ctx) => void this.sendSelection("translat", editor.getSelection(), ctx.file),
    });
    this.addCommand({
      id: "correct-selection",
      name: "Correct the selection with AI",
      editorCallback: (editor: Editor, ctx) => void this.sendSelection("corrector", editor.getSelection(), ctx.file),
    });

    // right-click on selected text
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const sel = editor.getSelection().trim();
        if (!sel) return;
        const file = info.file;
        const inNote = !!file && isNotePath(this, file.path);
        menu.addSeparator();
        menu.addItem((i) => i.setTitle("Koding: Translate into Korean with AI").setIcon("languages").onClick(() => void this.sendSelection("translat", sel, file)));
        menu.addItem((i) => i.setTitle("Koding: Correct with AI").setIcon("spell-check").onClick(() => void this.sendSelection("corrector", sel, file)));
        menu.addItem((i) => i.setTitle("Koding: Ask AI to explain").setIcon("help-circle").onClick(() => void this.sendSelection("explain", sel, file)));
        if (inNote && file) {
          menu.addItem((i) =>
            i
              .setTitle("Koding: Ask about this (add to Questions)")
              .setIcon("help-circle")
              .onClick(async () => {
                await editText(this.app, file.path, (t) => appendToSection(t, "Questions", `- ${sel.replace(/\s*\n\s*/g, " ")}`));
                new Notice(`Added to Questions: ${sel}`);
              })
          );
          menu.addItem((i) => i.setTitle("Koding: Use as Final").setIcon("check").onClick(() => void this.useAsFinal(file, sel)));
          if (!sel.includes("\n")) {
            menu.addItem((i) =>
              i
                .setTitle("Koding: Add to this note's words")
                .setIcon("list-plus")
                .onClick(async () => {
                  const line = editor.getLine(editor.getCursor("from").line).trim().replace(/\*\*/g, "").replace(sel, `**${sel}**`);
                  await editText(this.app, file.path, (t) => appendToSection(t, "Words", `- ${sel}: ${line}`));
                })
            );
          }
        }
      })
    );

    this.addCommand({
      id: "add-word",
      name: "Add the selected word to this note's words",
      editorCallback: async (editor: Editor, ctx) => {
        const word = editor.getSelection().trim();
        const file = ctx.file;
        if (!word || !file) {
          new Notice("Select a word first.");
          return;
        }
        const sentence = editor.getLine(editor.getCursor("from").line).trim().replace(/\*\*/g, "").replace(word, `**${word}**`);
        await editText(this.app, file.path, (t) => appendToSection(t, "Words", `- ${word}: ${sentence}`));
      },
    });
  }
}

class PromptModal extends Modal {
  constructor(app: App, private heading: string, private hint: string, private go: string, private done: (text: string) => unknown) {
    super(app);
  }
  onOpen(): void {
    this.setTitle(this.heading);
    let value = "";
    const submit = () => {
      if (!value.trim()) return;
      this.close();
      void this.done(value.trim());
    };
    new Setting(this.contentEl).setDesc(this.hint);
    const input = this.contentEl.createEl("input", { type: "text", cls: "koding-prompt" });
    input.oninput = () => (value = input.value);
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) submit();
    };
    new Setting(this.contentEl).addButton((b) => b.setButtonText(this.go).setCta().onClick(submit));
    window.setTimeout(() => input.focus(), 0);
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

class RoleModal extends SuggestModal<Role> {
  constructor(app: App, private roles: Role[], private pick: (r: Role) => void) {
    super(app);
    this.setPlaceholder("Which role?");
  }
  getSuggestions(query: string): Role[] {
    const q = query.toLowerCase();
    return this.roles.filter((r) => r.name.toLowerCase().includes(q));
  }
  renderSuggestion(r: Role, el: HTMLElement): void {
    el.setText(r.name);
  }
  onChooseSuggestion(r: Role): void {
    this.pick(r);
  }
}
