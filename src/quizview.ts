import { ItemView, TFile, ViewStateResult, WorkspaceLeaf, normalizePath } from "obsidian";
import type KodingPlugin from "./main";
import { Card, interleave, parseCards, pickCards, record } from "./cards";

export const QUIZ_VIEW = "koding-quiz";

const KIND: Record<Card["kind"], string> = {
  word: "Word",
  blank: "Fill the blank",
  task: "Make a sentence",
  basic: "Card",
};

/** Draw card text: [[?hint]] as a blank, **x** in bold. */
function renderCardText(el: HTMLElement, text: string): void {
  const parts = text.split(/(\[\[\?[^\]]*\]\]|\*\*[^*]+\*\*)/);
  for (const part of parts) {
    if (!part) continue;
    const blank = /^\[\[\?([^\]]*)\]\]$/.exec(part);
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    if (blank) el.createSpan({ cls: "koding-blank", text: blank[1] ? blank[1] : "…" });
    else if (bold) el.createEl("strong", { text: bold[1] });
    else el.appendText(part);
  }
}

/** All cards in every quiz file. */
export async function allCards(plugin: KodingPlugin): Promise<Card[]> {
  const folder = normalizePath(plugin.settings.quizFolder) + "/";
  const files = plugin.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder));
  const out: Card[] = [];
  for (const f of files) out.push(...parseCards(await plugin.app.vault.cachedRead(f), f.path));
  return out;
}

export class QuizView extends ItemView {
  private mode: "file" | "few" = "few";
  private path = "";
  private deck: Card[] = [];
  private at = 0;
  private shown = false;
  private typed = "";
  private missed: Card[] = [];

  constructor(leaf: WorkspaceLeaf, private plugin: KodingPlugin) {
    super(leaf);
  }
  getViewType(): string {
    return QUIZ_VIEW;
  }
  getDisplayText(): string {
    return "Quiz";
  }
  getIcon(): string {
    return "layers";
  }
  getState(): Record<string, unknown> {
    return { mode: this.mode, path: this.path };
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state || {}) as { mode?: "file" | "few"; path?: string; fresh?: number };
    this.mode = s.mode === "file" ? "file" : "few";
    this.path = s.path || "";
    await this.start();
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    this.contentEl.addClass("koding-quiz-view");
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.key(e));
  }

  private async start(): Promise<void> {
    const p = this.plugin;
    if (this.mode === "file") {
      const f = p.app.vault.getAbstractFileByPath(this.path);
      const cards = f instanceof TFile ? parseCards(await p.app.vault.read(f), f.path) : [];
      this.deck = interleave(cards);
    } else {
      this.deck = pickCards(await allCards(p), p.state.cards, p.settings.quizSize, Date.now());
    }
    this.at = 0;
    this.missed = [];
    this.shown = false;
    this.typed = "";
    this.draw();
  }

  private key(e: KeyboardEvent): void {
    const typing = (e.target as HTMLElement).tagName === "INPUT";
    if (!this.shown) {
      if (e.key === "Enter" || (!typing && e.key === " ")) {
        e.preventDefault();
        this.reveal();
      }
      return;
    }
    if (e.key === "1") void this.answer(false);
    else if (e.key === "2" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void this.answer(true);
    }
  }

  private reveal(): void {
    if (!this.deck[this.at]) return;
    const input = this.contentEl.querySelector("input.koding-quiz-input") as HTMLInputElement | null;
    this.typed = input?.value.trim() || "";
    this.shown = true;
    this.draw();
  }

  private async answer(gotIt: boolean): Promise<void> {
    const c = this.deck[this.at];
    if (!c) return;
    const st = this.plugin.state;
    st.cards[c.id] = record(st.cards[c.id], gotIt, Date.now());
    if (!gotIt) this.missed.push(c);
    await this.plugin.saveState();
    this.at++;
    this.shown = false;
    this.typed = "";
    this.draw();
  }

  private draw(): void {
    const el = this.contentEl;
    el.empty();
    const wrap = el.createDiv({ cls: "koding-quiz" });
    const c = this.deck[this.at];

    if (!c) {
      if (!this.deck.length) {
        wrap.createDiv({ cls: "koding-quiz-end", text: this.mode === "file" ? "This file has no cards in it." : "There are no quiz cards yet. They come from the Quiz step of a note." });
      } else {
        wrap.createDiv({ cls: "koding-quiz-end", text: "That's the lot." });
      }
      const row = wrap.createDiv({ cls: "koding-row koding-quiz-buttons" });
      if (this.missed.length) {
        const again = row.createEl("button", { text: "Again, the ones not yet", cls: "mod-cta" });
        again.onclick = () => {
          this.deck = interleave(this.missed);
          this.missed = [];
          this.at = 0;
          this.draw();
        };
      }
      const desk = row.createEl("button", { text: "Back to the Desk" });
      desk.onclick = () => void this.plugin.openDesk();
      return;
    }

    const head = wrap.createDiv({ cls: "koding-quiz-head" });
    head.createSpan({ text: KIND[c.kind] });
    const from = c.source.slice(c.source.lastIndexOf("/") + 1).replace(/ quiz( \d+)?\.md$|\.md$/, "");
    if (from) head.createSpan({ cls: "koding-quiz-from", text: from });

    renderCardText(wrap.createDiv({ cls: "koding-quiz-front" }), c.front);

    if (!this.shown) {
      const input = wrap.createEl("input", { cls: "koding-quiz-input", type: "text" });
      input.placeholder = "Say it aloud, or type it";
      const row = wrap.createDiv({ cls: "koding-row koding-quiz-buttons" });
      const show = row.createEl("button", { text: "Show", cls: "mod-cta" });
      show.onclick = () => this.reveal();
      wrap.createDiv({ cls: "koding-hint", text: "Enter shows the answer." });
      window.setTimeout(() => input.focus(), 0);
      return;
    }

    renderCardText(wrap.createDiv({ cls: "koding-quiz-back" }), c.back);
    if (this.typed) wrap.createDiv({ cls: "koding-quiz-typed", text: `You wrote: ${this.typed}` });
    const row = wrap.createDiv({ cls: "koding-row koding-quiz-buttons" });
    const no = row.createEl("button", { text: "Not yet" });
    no.onclick = () => void this.answer(false);
    const yes = row.createEl("button", { text: "Got it", cls: "mod-cta" });
    yes.onclick = () => void this.answer(true);
    wrap.createDiv({ cls: "koding-hint", text: "1 for not yet, 2 or Enter for got it. Not yet comes back sooner; that's all it means." });
    this.contentEl.focus();
  }
}
