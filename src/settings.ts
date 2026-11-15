import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type KodingPlugin from "./main";
import { run } from "./io";

export interface Bookmark {
  name: string;
  url: string;
  mode: "tab" | "browser";
}

export type TakeFormat = "m4a" | "mp3" | "ogg" | "wav" | "webm";

export interface KodingSettings {
  // who and what
  recipient: string;
  languageName: string;
  languageCode: string;
  hangulOnly: boolean;
  // folders and files
  notesFolder: string;
  takesFolder: string;
  modelsFolder: string;
  phoneFolder: string;
  inboxFolder: string;
  inboxDoneFolder: string;
  tutorFolder: string;
  quizFolder: string;
  seedsFile: string;
  wordsFile: string;
  logFile: string;
  archiveSources: string;
  seedSources: string;
  // desk
  openDeskOnStartup: boolean;
  handfulSize: number;
  quizSize: number;
  cardsOnDesk: boolean;
  listenOrder: "newest" | "shuffle";
  // ai
  bookmarks: Bookmark[];
  userAgent: string;
  sendOnCorrect: boolean;
  // voice
  ttsPath: string;
  voice: string;
  slowRate: number;
  ttsCommand: string;
  shadowPause: number;
  // recorder and listener
  ffmpegPath: string;
  takeFormat: TakeFormat;
  whisperPath: string;
  whisperModel: string;
  whisperArgs: string;
  // inbox
  inboxInterval: number;
}

export const DEFAULT_SETTINGS: KodingSettings = {
  recipient: "Friend",
  languageName: "Korean",
  languageCode: "ko",
  hangulOnly: true,
  notesFolder: "Notes",
  takesFolder: "Audio/Takes",
  modelsFolder: "Audio/Models",
  phoneFolder: "Audio/Phone",
  inboxFolder: "Inbox",
  inboxDoneFolder: "Inbox/_done",
  tutorFolder: "Tutor",
  quizFolder: "Quizzes",
  seedsFile: "Seeds.md",
  wordsFile: "Words.md",
  logFile: "Log.md",
  archiveSources: "Sources/Archive",
  seedSources: "Sources",
  openDeskOnStartup: true,
  handfulSize: 5,
  quizSize: 8,
  cardsOnDesk: true,
  listenOrder: "newest",
  bookmarks: [
    { name: "Claude", url: "https://claude.ai/", mode: "tab" },
    { name: "ChatGPT", url: "https://chatgpt.com/", mode: "tab" },
    { name: "Gemini", url: "https://gemini.google.com/", mode: "tab" },
    { name: "NotebookLM", url: "https://notebooklm.google.com/", mode: "tab" },
  ],
  userAgent: "",
  sendOnCorrect: true,
  ttsPath: "edge-tts",
  voice: "ko-KR-SunHiNeural",
  slowRate: -30,
  ttsCommand: "",
  shadowPause: 1.2,
  ffmpegPath: "ffmpeg",
  takeFormat: "m4a",
  whisperPath: "whisper",
  whisperModel: "small",
  whisperArgs: "",
  inboxInterval: 60,
};

export function lines(s: string): string[] {
  return s
    .split("\n")
    .map((x) => x.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

export class KodingSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: KodingPlugin) {
    super(app, plugin);
  }

  private text(el: HTMLElement, name: string, desc: string, key: keyof KodingSettings, placeholder = ""): void {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addText((t) =>
        t
          .setPlaceholder(placeholder || String((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key] ?? ""))
          .setValue(String(s[key] ?? ""))
          .onChange(async (v) => {
            s[key] = v.trim();
            await this.plugin.saveSettings();
          })
      );
  }

  private num(el: HTMLElement, name: string, desc: string, key: keyof KodingSettings, min: number, max: number): void {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(s[key])).onChange(async (v) => {
          const n = Number(v);
          if (v.trim() === "" || Number.isNaN(n)) return;
          s[key] = Math.min(max, Math.max(min, n));
          await this.plugin.saveSettings();
        });
      });
  }

  private area(el: HTMLElement, name: string, desc: string, key: keyof KodingSettings): void {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.addClass("koding-wide");
        t.setValue(String(s[key] ?? "")).onChange(async (v) => {
          s[key] = v;
          await this.plugin.saveSettings();
        });
      });
  }

  private tester(setting: Setting, label: string, cmd: () => string, args: string[]): void {
    setting.addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        try {
          const r = await run(cmd(), args, 20000);
          const first = (r.stdout || r.stderr).split("\n").find((l) => l.trim()) || "";
          new Notice(`${label} works. ${first.slice(0, 80)}`);
        } catch (e) {
          new Notice(`${label} did not start: ${(e as Error).message}`, 8000);
        }
      })
    );
  }

  display(): void {
    const el = this.containerEl;
    const p = this.plugin;
    const s = p.settings;
    el.empty();

    // ---- who ----
    new Setting(el).setName("Who and what").setHeading();
    this.text(el, "Notes are for", "Goes into each new note's “to:” line and into the AI instructions.", "recipient");
    this.text(el, "Language", "The language you are learning, as it should be named to the AI.", "languageName");
    this.text(el, "Language code", "Given to Whisper (ko, ja, es, …).", "languageCode");
    new Setting(el)
      .setName("Hangul lines only from source texts")
      .setDesc("When making a model from a source text that mixes languages, speak only the lines that contain Hangul. Turn off for other languages.")
      .addToggle((t) =>
        t.setValue(s.hangulOnly).onChange(async (v) => {
          s.hangulOnly = v;
          await p.saveSettings();
        })
      );

    // ---- desk ----
    new Setting(el).setName("Desk").setHeading();
    new Setting(el)
      .setName("Open the Desk at startup")
      .addToggle((t) =>
        t.setValue(s.openDeskOnStartup).onChange(async (v) => {
          s.openDeskOnStartup = v;
          await p.saveSettings();
        })
      );
    this.num(el, "Handful size", "How many items from the word pool the Desk shows each day. 0 hides it.", "handfulSize", 0, 20);
    new Setting(el)
      .setName("“A few cards” on the Desk")
      .setDesc("A button that quizzes you on a few cards from your quizzes. Cards you marked “not yet” come back sooner.")
      .addToggle((t) =>
        t.setValue(s.cardsOnDesk).onChange(async (v) => {
          s.cardsOnDesk = v;
          await p.saveSettings();
        })
      );
    this.num(el, "Cards per sitting", "How many cards “A few cards” shows.", "quizSize", 1, 40);
    new Setting(el)
      .setName("Just listen order")
      .addDropdown((d) =>
        d
          .addOption("newest", "Newest first")
          .addOption("shuffle", "Shuffled")
          .setValue(s.listenOrder)
          .onChange(async (v) => {
            s.listenOrder = v as "newest" | "shuffle";
            await p.saveSettings();
          })
      );

    // ---- bookmarks ----
    new Setting(el).setName("AI bookmarks").setHeading().setDesc("Requests from “Send to AI”, Translate and Correct go to the first bookmark that opens in a tab. Use the arrows to choose which one that is.");
    s.bookmarks.forEach((b, i) => {
      const row = new Setting(el).setClass("koding-bookmark-row");
      row.addText((t) =>
        t
          .setPlaceholder("Name")
          .setValue(b.name)
          .onChange(async (v) => {
            b.name = v;
            await p.saveSettings();
          })
      );
      row.addText((t) => {
        t.inputEl.addClass("koding-url");
        t.setPlaceholder("https://…")
          .setValue(b.url)
          .onChange(async (v) => {
            b.url = v.trim();
            await p.saveSettings();
          });
      });
      row.addDropdown((d) =>
        d
          .addOption("tab", "In a tab")
          .addOption("browser", "In the browser")
          .setValue(b.mode)
          .onChange(async (v) => {
            b.mode = v as "tab" | "browser";
            await p.saveSettings();
          })
      );
      row.addExtraButton((x) =>
        x
          .setIcon("arrow-up")
          .setTooltip("Move up")
          .setDisabled(i === 0)
          .onClick(async () => {
            [s.bookmarks[i - 1], s.bookmarks[i]] = [s.bookmarks[i], s.bookmarks[i - 1]];
            await p.saveSettings();
            this.display();
          })
      );
      row.addExtraButton((x) =>
        x
          .setIcon("arrow-down")
          .setTooltip("Move down")
          .setDisabled(i === s.bookmarks.length - 1)
          .onClick(async () => {
            [s.bookmarks[i + 1], s.bookmarks[i]] = [s.bookmarks[i], s.bookmarks[i + 1]];
            await p.saveSettings();
            this.display();
          })
      );
      row.addExtraButton((x) =>
        x
          .setIcon("trash")
          .setTooltip("Remove")
          .onClick(async () => {
            s.bookmarks.splice(i, 1);
            await p.saveSettings();
            this.display();
          })
      );
    });
    new Setting(el).addButton((b) =>
      b.setButtonText("Add bookmark").onClick(async () => {
        s.bookmarks.push({ name: "", url: "https://", mode: "tab" });
        await p.saveSettings();
        this.display();
      })
    );
    new Setting(el)
      .setName("On the correction step, send to the AI straight away")
      .setDesc("The Desk button copies the corrector packet and brings the AI tab forward. Turn off if corrections usually come from a person.")
      .addToggle((t) =>
        t.setValue(s.sendOnCorrect).onChange(async (v) => {
          s.sendOnCorrect = v;
          await p.saveSettings();
        })
      );
    this.text(el, "Browser identity", "The user agent the AI tabs present. Leave empty for a standard Chrome identity.", "userAgent", "automatic");

    // ---- voice ----
    new Setting(el).setName("Model voice").setHeading();
    this.text(el, "Voice", "For example ko-KR-SunHiNeural or ko-KR-InJoonNeural. “edge-tts --list-voices” shows them all.", "voice");
    this.num(el, "Slow rate (%)", "Speed change for the slow model. -30 is 30% slower.", "slowRate", -90, 0);
    const tts = new Setting(el).setName("edge-tts program").setDesc("Name or full path.");
    tts.addText((t) =>
      t.setValue(s.ttsPath).onChange(async (v) => {
        s.ttsPath = v.trim();
        await p.saveSettings();
      })
    );
    this.tester(tts, "edge-tts", () => s.ttsPath || "edge-tts", ["--version"]);
    this.area(
      el,
      "Another engine (optional)",
      "A full command line that replaces edge-tts. Placeholders: {voice} {rate} {text} (a text file) {out} (audio file to write) {subs} (subtitle file to write, optional). Leave empty to use edge-tts.",
      "ttsCommand"
    );
    this.num(el, "Shadow pause", "In a shadow run, the pause after each sentence, as a multiple of the sentence's length.", "shadowPause", 0.5, 4);

    // ---- recorder ----
    new Setting(el).setName("Recorder and listener").setHeading();
    const ff = new Setting(el).setName("ffmpeg program").setDesc("Name or full path.");
    ff.addText((t) =>
      t.setValue(s.ffmpegPath).onChange(async (v) => {
        s.ffmpegPath = v.trim();
        await p.saveSettings();
      })
    );
    this.tester(ff, "ffmpeg", () => s.ffmpegPath || "ffmpeg", ["-version"]);
    new Setting(el)
      .setName("Take format")
      .setDesc("Takes are recorded as .webm and converted to this. “webm” keeps the recording as it is and needs no ffmpeg.")
      .addDropdown((d) =>
        d
          .addOptions({ m4a: "m4a", mp3: "mp3", ogg: "ogg", wav: "wav", webm: "webm (no conversion)" })
          .setValue(s.takeFormat)
          .onChange(async (v) => {
            s.takeFormat = v as TakeFormat;
            await p.saveSettings();
          })
      );
    const wh = new Setting(el).setName("Whisper program").setDesc("Name or full path (whisper, whisper-ctranslate2, …).");
    wh.addText((t) =>
      t.setValue(s.whisperPath).onChange(async (v) => {
        s.whisperPath = v.trim();
        await p.saveSettings();
      })
    );
    this.tester(wh, "Whisper", () => s.whisperPath || "whisper", ["--help"]);
    this.text(el, "Whisper model", "tiny, base, small, medium, large-v3, …", "whisperModel");
    this.text(el, "Extra Whisper arguments", "Added to the end of the command.", "whisperArgs", "none");

    // ---- inbox ----
    new Setting(el).setName("Inbox").setHeading();
    this.num(el, "Check interval (seconds)", "How often the Inbox folder is checked for phone uploads. It is also checked at startup. 0 turns the timer off.", "inboxInterval", 0, 3600);

    // ---- folders ----
    new Setting(el).setName("Folders and files").setHeading().setDesc("Paths inside the vault. Missing ones are created.");
    this.text(el, "Notes", "", "notesFolder");
    this.text(el, "Takes", "", "takesFolder");
    this.text(el, "Models", "", "modelsFolder");
    this.text(el, "Phone audio", "", "phoneFolder");
    this.text(el, "Inbox", "", "inboxFolder");
    this.text(el, "Inbox, processed", "", "inboxDoneFolder");
    this.text(el, "Tutor roles", "Every Markdown file here is a role. _Rules.md is added to every packet.", "tutorFolder");
    this.text(el, "Quizzes", "Each quiz is saved here as its own file, in Spaced Repetition flashcard format.", "quizFolder");
    this.text(el, "Seeds file", "", "seedsFile");
    this.text(el, "Words file", "", "wordsFile");
    this.text(el, "Log file", "", "logFile");
    this.area(el, "Archive sources", "Folders of older texts that join the Archive and Just listen. One per line.", "archiveSources");
    this.area(el, "Seed sources", "Folders the seed finder draws lines from. One per line.", "seedSources");
    new Setting(el)
      .setName("Set up the vault")
      .setDesc("Create any missing folders, files and tutor roles now.")
      .addButton((b) =>
        b.setButtonText("Set up").onClick(async () => {
          await p.setupVault(true);
          new Notice("Vault is set up.");
        })
      );
  }

  hide(): void {
    this.plugin.settingsChanged();
  }
}
