import { MarkdownView, Menu, TFile, setIcon } from "obsidian";
import type KodingPlugin from "./main";
import { REVIEW_STEPS, ReviewStep, Step, correctionTexts, isNotePath, listRoles, readNote, reviewMaterial, stepFor } from "./core";
import { getSection, meaningful } from "./text";
import { listenToLatestTake, makeModelForNote } from "./audio";

const STAGES: { key: string; name: string }[] = [
  { key: "draft", name: "Draft" },
  { key: "korean", name: "Korean" },
  { key: "final", name: "Final" },
  { key: "model", name: "Model" },
  { key: "shadow", name: "Shadow" },
  { key: "take", name: "Takes" },
  { key: "questions", name: "Questions" },
  { key: "checklist", name: "Checklist" },
  { key: "quiz", name: "Quiz" },
  { key: "words", name: "Words" },
  { key: "done", name: "Done" },
];

function stageOf(step: Step | "done"): string {
  return step === "translate" || step === "correct" ? "korean" : step;
}

/** The bar at the top of every voice note: where you are, and the next thing to press. */
export class StepBars {
  private bars = new Map<MarkdownView, { el: HTMLElement; sig: string }>();

  constructor(private plugin: KodingPlugin) {}

  sync(): void {
    const live = new Set<MarkdownView>();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      live.add(view);
      const isNote = !!view.file && isNotePath(this.plugin, view.file.path);
      let bar = this.bars.get(view);
      if (isNote && !bar) {
        const el = createDiv({ cls: "koding-steps" });
        view.containerEl.insertBefore(el, view.contentEl);
        bar = { el, sig: "" };
        this.bars.set(view, bar);
      } else if (!isNote && bar) {
        bar.el.remove();
        this.bars.delete(view);
        bar = undefined;
      }
      if (bar) void this.render(view, bar);
    }
    for (const [view, bar] of Array.from(this.bars)) {
      if (!live.has(view)) {
        bar.el.remove();
        this.bars.delete(view);
      }
    }
  }

  clear(): void {
    for (const bar of this.bars.values()) bar.el.remove();
    this.bars.clear();
  }

  private async render(view: MarkdownView, bar: { el: HTMLElement; sig: string }): Promise<void> {
    const p = this.plugin;
    const file = view.file;
    if (!file) return;
    const info = await readNote(p, file);
    const step: Step | "done" = info.status === "done" ? "done" : stepFor(info);
    const sent = p.state.sent && p.state.sent.path === file.path ? p.state.sent : null;
    const { ai, theirs } = correctionTexts(info, p.settings.recipient);
    const recording = p.recorder.recording;
    const review = reviewMaterial(info);
    const hasWords = !!meaningful(getSection(info.content, "Words"));
    const hasQuiz = /\[\[[^\]]+\]\]/.test(getSection(info.content, "Quiz"));
    const ticked = review.checklist.filter((c) => c.known).length;
    const sig = JSON.stringify([step, sent, !!ai, !!theirs, recording, p.settings.recipient, p.aiName(), review.questions.length, ticked, hasWords, hasQuiz]);
    if (sig === bar.sig) return;
    bar.sig = sig;

    const el = bar.el;
    el.empty();
    const strip = el.createDiv({ cls: "koding-steps-strip" });
    const cur = STAGES.findIndex((s) => s.key === stageOf(step));
    // each step jumps to its part of the note, so you can always go back
    const SECTION: Record<string, string> = {
      draft: "Draft",
      korean: "Corrections",
      final: "Final",
      model: "Model",
      shadow: "Final",
      take: "Takes",
      questions: "Questions",
      checklist: "Checklist",
      quiz: "Quiz",
      words: "Words",
    };
    STAGES.forEach((s, i) => {
      const chip = strip.createSpan({ cls: "koding-step", text: s.name });
      if (i < cur) chip.addClass("is-past");
      if (i === cur) chip.addClass("is-current");
      const section = SECTION[s.key];
      if (section) {
        chip.addClass("is-link");
        chip.onclick = async () => {
          // once the audio is finished, the study steps can be revisited in any order
          if (info.status === "review" && (REVIEW_STEPS as readonly string[]).includes(s.key)) await p.goToReviewStep(file, s.key as ReviewStep);
          await p.openNote(file, section);
        };
      }
    });
    const more = strip.createEl("button", { cls: "clickable-icon koding-more" });
    setIcon(more, "more-horizontal");
    more.ariaLabel = "More";
    more.onclick = (e) => this.menu(file, e);

    const msg = el.createDiv({ cls: "koding-steps-msg" });
    const row = el.createDiv({ cls: "koding-row" });
    const btn = (text: string, fn: () => unknown, cta = false) => {
      const b = row.createEl("button", { text, cls: cta ? "mod-cta" : "" });
      b.onclick = () => void fn();
    };
    const to = p.settings.recipient;
    const waiting = () => {
      const app = p.aiName();
      msg.setText(
        `The request is copied. In the ${app} tab: click in the message box, paste (Ctrl+V) and send. ` +
          `When the answer is in, copy it with the copy button under it, then press Take reply.`
      );
      btn("Take reply", () => p.takeReply(undefined, file), true);
      btn(`Show ${app}`, () => p.showAI());
      btn("Copy the request again", () => p.sendToAI(sent!.role, file));
      btn("Cancel", () => p.cancelSent());
    };

    if (recording) {
      msg.setText("Recording. Read the Final text aloud.");
      btn("Stop", () => p.recorder.stop(), true);
      return;
    }
    switch (step) {
      case "draft":
        msg.setText(`Write what you want to say to ${to} under Draft: in Korean, in English, or a mix. Rough is fine.`);
        btn("Go to Draft", () => p.openNote(file, "Draft"));
        break;
      case "translate":
        if (sent) return waiting();
        msg.setText("Your draft is in English. Get a Korean version you can record. The draft itself is kept as it is.");
        btn("Translate with AI", () => p.sendToAI("translat", file), true);
        btn("I'll write the Korean myself", () => p.writeKoreanMyself(file));
        break;
      case "correct":
        if (sent) return waiting();
        msg.setText(`Your draft is in Korean. Get it corrected by AI, or by ${to} under Corrections → ${to}, or both.`);
        btn("Correct with AI", () => p.sendToAI("corrector", file), true);
        btn("Let me try first", () => p.sendToAI("noticer", file));
        break;
      case "final":
        msg.setText("Put the Korean you will record under Final. Change it as much as you like; the draft stays as it was.");
        if (ai) btn("Use the AI's Korean", () => p.useAsFinal(file, ai), true);
        if (theirs) btn(`Use ${to}'s version`, () => p.useAsFinal(file, theirs), !ai);
        btn("Go to Final", () => p.openNote(file, "Final"), !ai && !theirs);
        if (sent) btn("Take reply", () => p.takeReply(undefined, file));
        break;
      case "model":
        msg.setText("Make the model: a native voice reading your Final text, at normal and slow speed.");
        btn("Make the model voice", () => makeModelForNote(p, file), true);
        btn("Skip, record a take", () => p.recorder.start(file));
        break;
      case "shadow":
        msg.setText("Read the Final text aloud, then say each sentence after the model. Record when you're ready.");
        btn("Shadow", () => p.openShadow(file.basename, file.path), true);
        btn("Record a take", () => p.recorder.start(file));
        break;
      case "take":
        msg.setText("Record as many takes as you like; each one is saved under Takes. When the audio is finished, move on to the words and grammar.");
        btn("Record a take", () => p.recorder.start(file));
        btn("Shadow", () => p.openShadow(file.basename, file.path));
        btn("What did Whisper hear?", () => listenToLatestTake(p, file));
        btn("The audio is finished", () => p.startReview(file), true);
        break;
      case "questions":
        if (sent) return waiting();
        msg.setText(
          "Write each word or grammar point you didn't know under Questions, one per line. Or select it in the text, right-click, and choose “Ask about this”. The AI explains only those."
        );
        if (review.questions.length) btn("Ask AI", () => p.sendToAI("question", file), true);
        btn("Go to Questions", () => p.openNote(file, "Questions"), !review.questions.length);
        btn("No questions, next", () => p.nextReview(file));
        break;
      case "checklist":
        msg.setText("Tick every word you know and write what it means after the dash. Leave the ones you don't know unticked.");
        btn("Go to Checklist", () => p.openNote(file, "Checklist"));
        btn("Done ticking, next", () => p.nextReview(file), true);
        break;
      case "quiz":
        if (sent) return waiting();
        msg.setText("The AI makes a quiz from your questions and checklist, aimed at what you didn't know. You take it here in Koding, one card at a time; the cards also come back in “A few cards” on the Desk.");
        btn("Make the quiz with AI", () => p.sendToAI("quiz", file), true);
        if (hasQuiz) btn("Take the quiz", () => p.openQuiz(file));
        btn("Skip the quiz", () => p.nextReview(file));
        break;
      case "words":
        msg.setText(
          hasWords
            ? "The new word list is under Words. Change it as you like. When you mark the note done, the list joins Words.md."
            : "Make the new word list: what you asked about and the words you didn't tick, each in its sentence."
        );
        if (!hasWords) btn("Make the list from my checklist", () => p.wordsFromChecklist(file), true);
        if (hasWords) btn("Go to Words", () => p.openNote(file, "Words"));
        if (hasQuiz) btn("Take the quiz", () => p.openQuiz(file));
        btn("This one is done", () => p.markDone(file), hasWords);
        break;
      case "done":
        msg.setText(`Done, and in the Archive. Send it to ${to} however you like.`);
        btn("Open the Desk", () => p.openDesk(), true);
        btn("Open the Archive", () => p.openArchive(false));
        break;
    }
  }

  private menu(file: TFile, e: MouseEvent): void {
    const p = this.plugin;
    const m = new Menu();
    for (const r of listRoles(p)) {
      m.addItem((i) => i.setTitle(`Send to AI: ${r.name}`).setIcon("send").onClick(() => void p.sendToAI(r.name.toLowerCase(), file)));
    }
    m.addSeparator();
    m.addItem((i) => i.setTitle("Take reply").setIcon("clipboard-paste").onClick(() => void p.takeReply(undefined, file)));
    m.addItem((i) => i.setTitle("Make the model voice").setIcon("wand").onClick(() => void makeModelForNote(p, file)));
    m.addItem((i) => i.setTitle("Record a take").setIcon("mic").onClick(() => void p.recorder.start(file)));
    m.addItem((i) => i.setTitle("Mark this note done").setIcon("check").onClick(() => void p.markDone(file)));
    m.showAtMouseEvent(e);
  }
}
