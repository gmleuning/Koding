import { TFile, normalizePath } from "obsidian";
import type KodingPlugin from "./main";
import { editText, ensureFolder, freePath, listFiles, markdownFilesUnder, readText, baseOf } from "./io";
import {
  appendToSection,
  embedsIn,
  fill,
  frontValue,
  hasHangul,
  subtitleLines,
  getSection,
  getSubsection,
  checklistFor,
  listItems,
  parseChecklist,
  sentenceWith,
  setSection,
  textWords,
  hangulShare,
  isoDate,
  koreanFromReply,
  lastReply,
  meaningful,
  parseWords,
  plainText,
  safeName,
  setFrontValue,
  stripExt,
  WordItem,
  yamlQuote,
} from "./text";

export type Status = "draft" | "corrected" | "recorded" | "review" | "done";

/** The study steps after the audio is finished, in order. */
export const REVIEW_STEPS = ["questions", "checklist", "quiz", "words"] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

export interface NoteInfo {
  file: TFile;
  content: string;
  status: Status;
  date: string;
  draft: string;
  corrections: string;
  final: string;
  takes: string[];
  models: string[];
}

export type Step = "draft" | "translate" | "correct" | "final" | "model" | "shadow" | "take" | ReviewStep | "seed" | "new";

export interface NextAction {
  step: Step;
  label: string;
  detail: string;
  note?: NoteInfo;
  seed?: Seed;
}

export interface Seed {
  date: string;
  text: string;
  line: string;
}

const USED = "## Used";

export function isNotePath(plugin: KodingPlugin, path: string): boolean {
  return path.endsWith(".md") && path.startsWith(normalizePath(plugin.settings.notesFolder) + "/");
}

export async function readNote(plugin: KodingPlugin, file: TFile): Promise<NoteInfo> {
  const content = (await plugin.app.vault.read(file)).replace(/\r\n/g, "\n");
  const raw = frontValue(content, "status").toLowerCase();
  const status: Status = raw === "corrected" || raw === "recorded" || raw === "review" || raw === "done" ? raw : "draft";
  return {
    file,
    content,
    status,
    date: frontValue(content, "date") || isoDate(new Date(file.stat.ctime)),
    draft: meaningful(getSection(content, "Draft")),
    corrections: meaningful(getSection(content, "Corrections")),
    final: plainText(getSection(content, "Final")),
    takes: embedsIn(getSection(content, "Takes")),
    models: embedsIn(getSection(content, "Model")),
  };
}

export async function listNotes(plugin: KodingPlugin): Promise<NoteInfo[]> {
  const files = markdownFilesUnder(plugin.app, plugin.settings.notesFolder);
  const notes = await Promise.all(files.map((f) => readNote(plugin, f)));
  // newest first
  return notes.sort((a, b) => (a.date === b.date ? b.file.stat.ctime - a.file.stat.ctime : a.date < b.date ? 1 : -1));
}

export async function setStatus(plugin: KodingPlugin, file: TFile, status: Status): Promise<void> {
  await editText(plugin.app, file.path, (t) => setFrontValue(t, "status", status));
}

export function stepFor(n: NoteInfo): Step {
  if (n.status === "review") {
    const r = frontValue(n.content, "review") as ReviewStep;
    return REVIEW_STEPS.includes(r) ? r : "questions";
  }
  if (!n.final) {
    if (!n.draft) return "draft";
    if (n.corrections) return "final";
    return hangulShare(n.draft) >= 0.3 ? "correct" : "translate";
  }
  if (n.takes.length) return "take";
  return n.models.length ? "shadow" : "model";
}

const LABELS: Record<Step, string> = {
  draft: "Write the draft",
  translate: "Turn it into Korean",
  correct: "Get it corrected",
  final: "Write the final text",
  model: "Make the model voice",
  shadow: "Read it aloud and shadow",
  take: "Record a take",
  questions: "Ask about what you didn't know",
  checklist: "Tick the words you know",
  quiz: "Make the quiz",
  words: "Check the new word list",
  seed: "Start a note",
  new: "Start a note",
};

/** The one thing the Desk offers: worked out from the files, never from a schedule. */
export async function nextAction(plugin: KodingPlugin): Promise<NextAction> {
  const notes = await listNotes(plugin);
  const open = notes.find((n) => n.status !== "done");
  if (open) {
    // keep the status line in step with what the note already holds
    const step = stepFor(open);
    const should: Status = open.status === "review" ? "review" : step === "take" ? "recorded" : open.final ? "corrected" : "draft";
    if (should !== open.status) {
      await setStatus(plugin, open.file, should);
      open.status = should;
    }
    return { step, label: LABELS[step], detail: open.file.basename, note: open };
  }
  const seed = (await readSeeds(plugin))[0];
  if (seed) return { step: "seed", label: LABELS.seed, detail: seedLabel(seed.text), seed };
  return { step: "new", label: LABELS.new, detail: "" };
}

// ---------- Seeds ----------

export function seedLabel(text: string): string {
  const t = text.replace(/!\[\[[^\]]*\]\]/g, "voice memo").trim();
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

export async function readSeeds(plugin: KodingPlugin): Promise<Seed[]> {
  const text = await readText(plugin.app, plugin.settings.seedsFile);
  const out: Seed[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === USED) break;
    const m = /^\s*[-*+]\s+(?:(\d{4}-\d{2}-\d{2})\s*[·:-]\s*)?(.+)$/.exec(line);
    if (m && m[2].trim()) out.push({ date: m[1] || "", text: m[2].trim(), line });
  }
  return out;
}

/** Put seeds at the top of the seeds file, newest first. */
export async function addSeeds(plugin: KodingPlugin, seeds: { date: string; text: string }[]): Promise<void> {
  if (!seeds.length) return;
  const fresh = seeds.map((s) => `- ${s.date || isoDate()} · ${s.text.replace(/\s*\n\s*/g, " ").trim()}`);
  await editText(plugin.app, plugin.settings.seedsFile, (t) => {
    const lines = t.split("\n");
    let at = lines.findIndex((l) => /^\s*[-*+]\s+/.test(l) || l.trim() === USED);
    if (at < 0) {
      at = lines.length;
      while (at > 0 && lines[at - 1].trim() === "") at--;
      if (at > 0) fresh.unshift("");
    }
    lines.splice(at, 0, ...fresh);
    return lines.join("\n").replace(/\s*$/, "\n");
  });
}

async function markSeedUsed(plugin: KodingPlugin, seed: Seed): Promise<void> {
  await editText(plugin.app, plugin.settings.seedsFile, (t) => {
    const lines = t.split("\n");
    const i = lines.indexOf(seed.line);
    if (i < 0) return t;
    lines.splice(i, 1);
    let u = lines.findIndex((l) => l.trim() === USED);
    if (u < 0) {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push("", USED);
      u = lines.length - 1;
    }
    lines.splice(u + 1, 0, seed.line);
    return lines.join("\n").replace(/\s*$/, "\n");
  });
}

// ---------- Notes ----------

export function noteTemplate(to: string, date: string, seed: string): string {
  return [
    "---",
    `to: ${to}`,
    `date: ${date}`,
    `seed: ${yamlQuote(seed)}`,
    "status: draft",
    "---",
    "",
    "## Draft",
    "",
    "",
    "## Corrections",
    `### ${to}`,
    "",
    "### AI",
    "",
    "## Final",
    "",
    "",
    "## Model",
    "",
    "## Takes",
    "",
    "## Heard",
    "",
    "## Questions",
    "",
    "## Answers",
    "",
    "## Checklist",
    "",
    "## Quiz",
    "",
    "## Words",
    "",
  ].join("\n");
}

export async function createNote(plugin: KodingPlugin, seedText: string, seed?: Seed): Promise<TFile> {
  const s = plugin.settings;
  const date = isoDate();
  await ensureFolder(plugin.app, s.notesFolder);
  const title = safeName(seedText) || "note";
  const path = await freePath(plugin.app, s.notesFolder, `${date} ${title}.md`);
  const origin = seed?.date ? `${seedText} (${seed.date})` : seedText;
  const file = await plugin.app.vault.create(path, noteTemplate(s.recipient, date, origin));
  if (seed) await markSeedUsed(plugin, seed);
  return file;
}

/** Number for the next take of a note: one more than the highest already on disk. */
export async function nextTakeNumber(plugin: KodingPlugin, noteBase: string): Promise<number> {
  const files = await listFiles(plugin.app, plugin.settings.takesFolder);
  let max = 0;
  for (const f of files) {
    const name = stripExt(baseOf(f));
    if (!name.startsWith(noteBase + " take ")) continue;
    const n = parseInt(name.slice(noteBase.length + 6), 10);
    if (n > max) max = n;
  }
  return max + 1;
}

export async function embedTake(plugin: KodingPlugin, note: TFile, takePath: string): Promise<void> {
  await editText(plugin.app, note.path, (t) => {
    let out = appendToSection(t, "Takes", `![[${baseOf(takePath)}]]`);
    const st = frontValue(out, "status");
    if (st !== "done" && st !== "recorded") out = setFrontValue(out, "status", "recorded");
    return out;
  });
}

/** Mark a note done and move its words into the pool. */
export async function finishNote(plugin: KodingPlugin, file: TFile): Promise<void> {
  const note = await readNote(plugin, file);
  await setStatus(plugin, file, "done");
  const words = parseWords(getSection(note.content, "Words"));
  if (!words.length) return;
  await editText(plugin.app, plugin.settings.wordsFile, (t) => {
    const have = new Set(parseWords(t).map(wordKey));
    const add = words.filter((w) => !have.has(wordKey(w))).map((w) => `- ${w.word}: ${w.sentence}`);
    if (!add.length) return t;
    return t.replace(/\s*$/, "") + (t.trim() ? "\n" : "") + add.join("\n") + "\n";
  });
}

// ---------- After the audio: questions, checklist, quiz, words ----------

export async function setReviewStep(plugin: KodingPlugin, file: TFile, step: ReviewStep): Promise<void> {
  await editText(plugin.app, file.path, (t) => {
    let out = setFrontValue(setFrontValue(t, "status", "review"), "review", step);
    // older notes may not have the sections yet
    for (const h of ["Questions", "Answers", "Checklist", "Quiz"]) if (!new RegExp(`^## ${h}\\s*$`, "m").test(out)) out = insertBefore(out, h, "Words");
    if (step === "checklist" && !meaningful(getSection(out, "Checklist"))) {
      out = setSection(out, "Checklist", checklistFor(textWords(plainText(getSection(out, "Final")))));
    }
    return out;
  });
}

/** Add an empty "## heading" just before "## before" (or at the end). */
function insertBefore(content: string, heading: string, before: string): string {
  const lines = content.split("\n");
  const at = lines.findIndex((l) => l.trim() === `## ${before}`);
  if (at < 0) return setSection(content, heading, "");
  lines.splice(at, 0, `## ${heading}`, "");
  return lines.join("\n");
}

export async function nextReviewStep(plugin: KodingPlugin, file: TFile): Promise<void> {
  const n = await readNote(plugin, file);
  const cur = stepFor(n) as ReviewStep;
  const i = REVIEW_STEPS.indexOf(cur);
  if (i >= 0 && i < REVIEW_STEPS.length - 1) await setReviewStep(plugin, file, REVIEW_STEPS[i + 1]);
}

export interface ReviewMaterial {
  questions: string[];
  answers: string;
  checklist: ReturnType<typeof parseChecklist>;
}

export function reviewMaterial(n: NoteInfo): ReviewMaterial {
  return {
    questions: listItems(getSection(n.content, "Questions")),
    answers: meaningful(getSection(n.content, "Answers")),
    checklist: parseChecklist(getSection(n.content, "Checklist")),
  };
}

/** A word list made on this computer: what was asked about, and the words not ticked. */
export function localWordList(n: NoteInfo): string {
  const m = reviewMaterial(n);
  const words = new Set<string>();
  for (const q of m.questions) if (hasHangul(q) && n.final.includes(q)) words.add(q);
  for (const c of m.checklist) if (!c.known || !c.meaning) words.add(c.word);
  return Array.from(words)
    .map((w) => {
      const meaning = m.checklist.find((c) => c.word === w)?.meaning;
      return `- ${w}${meaning ? ` (${meaning})` : ""}: ${sentenceWith(n.final, w)}`;
    })
    .join("\n");
}

// ---------- Today's handful ----------

export function wordKey(w: WordItem): string {
  return `${w.word}|${w.sentence}`;
}

/**
 * A few items from the pool, favouring the ones not seen for longest.
 * The same items stay up for the whole day. Nothing is ever "due".
 */
export async function todaysHandful(plugin: KodingPlugin): Promise<WordItem[]> {
  const size = plugin.settings.handfulSize;
  if (size <= 0) return [];
  const pool = parseWords(await readText(plugin.app, plugin.settings.wordsFile));
  if (!pool.length) return [];
  const st = plugin.state;
  const today = isoDate();
  const byKey = new Map(pool.map((w) => [wordKey(w), w]));
  if (st.handfulDate === today) {
    const kept = st.handful.map((k) => byKey.get(k)).filter((w): w is WordItem => !!w);
    if (kept.length >= Math.min(size, pool.length)) return kept.slice(0, size);
  }
  const ranked = pool
    .map((w) => ({ w, seen: st.lastShown[wordKey(w)] || 0, r: Math.random() }))
    // bucket by day so that a little chance mixes items of similar age
    .sort((a, b) => Math.floor(a.seen / 864e5) - Math.floor(b.seen / 864e5) || a.r - b.r)
    .slice(0, size)
    .map((x) => x.w);
  const now = Date.now();
  for (const w of ranked) st.lastShown[wordKey(w)] = now;
  for (const k of Object.keys(st.lastShown)) if (!byKey.has(k)) delete st.lastShown[k];
  st.handfulDate = today;
  st.handful = ranked.map(wordKey);
  await plugin.saveState();
  return ranked;
}

// ---------- Tutor packets ----------

export interface Role {
  name: string;
  file: TFile;
}

export function listRoles(plugin: KodingPlugin): Role[] {
  return markdownFilesUnder(plugin.app, plugin.settings.tutorFolder)
    .filter((f) => !f.basename.startsWith("_"))
    .sort((a, b) => a.basename.localeCompare(b.basename))
    .map((f) => ({ name: f.basename.replace(/^\d+[.\s-]*/, ""), file: f }));
}

export function findRole(plugin: KodingPlugin, word: string): Role | undefined {
  return listRoles(plugin).find((r) => r.name.toLowerCase().includes(word));
}

function block(title: string, body: string): string {
  return body.trim() ? `### ${title}\n${body.trim()}\n` : "";
}

function noteHeader(n: NoteInfo): string {
  const to = frontValue(n.content, "to");
  const seed = frontValue(n.content, "seed");
  return [to ? `To: ${to}` : "", seed ? `Seed: ${seed}` : ""].filter(Boolean).join("\n");
}

async function seedMaterial(plugin: KodingPlugin): Promise<string> {
  const folders = plugin.settings.seedSources.split("\n").map((x) => x.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const folder of folders) {
    const files = markdownFilesUnder(plugin.app, folder).concat(
      plugin.app.vault.getFiles().filter((f) => f.path.startsWith(normalizePath(folder) + "/") && /^(srt|vtt|txt)$/.test(f.extension))
    );
    if (!files.length) continue;
    // a few random lines from a few random files: phrases, not reading assignments
    const picks = files.sort(() => Math.random() - 0.5).slice(0, 4);
    for (const f of picks) {
      let ls = subtitleLines(await plugin.app.vault.cachedRead(f));
      if (plugin.settings.hangulOnly) ls = ls.filter((l) => hasHangul(l));
      ls = ls.filter((l) => l.length >= 4 && l.length <= 60);
      if (!ls.length) continue;
      const start = Math.floor(Math.random() * Math.max(1, ls.length - 12));
      parts.push(`#### ${f.basename}\n` + ls.slice(start, start + 12).join("\n"));
    }
  }
  const past = (await listNotes(plugin)).filter((n) => n.final).slice(0, 5);
  if (past.length) parts.push("#### My own past notes\n" + past.map((n) => n.final.split("\n")[0]).join("\n"));
  return parts.join("\n\n");
}

/** Role instructions + shared rules + the relevant part of the note. */
export async function buildPacket(plugin: KodingPlugin, role: Role, note: NoteInfo | null): Promise<string> {
  const s = plugin.settings;
  const vars = { to: s.recipient, language: s.languageName };
  const roleText = fill(await plugin.app.vault.read(role.file), vars).trim();
  const rules = fill(await readText(plugin.app, `${s.tutorFolder}/_Rules.md`), vars).trim();
  const kind = role.name.toLowerCase();
  let context = "";

  if (kind.includes("seed")) {
    context = block("Material", await seedMaterial(plugin));
  } else if (kind.includes("look back")) {
    const done = (await listNotes(plugin)).filter((n) => n.status === "done" && n.final);
    if (done.length < 2) throw new Error("Look back needs two finished notes.");
    const early = done[done.length - 1];
    const late = done[0];
    const part = (n: NoteInfo) => `Date: ${n.date}\n\nDraft:\n${n.draft}\n\nFinal:\n${n.final}`;
    context = block("An early note", part(early)) + "\n" + block("A recent note", part(late));
  } else if (note) {
    const head = noteHeader(note);
    const theirs = meaningful(getSubsection(note.content, "Corrections", frontValue(note.content, "to") || s.recipient));
    if (kind.includes("noticer")) {
      context = [head, block("My draft", note.draft)].join("\n\n");
    } else if (kind.includes("listener")) {
      context = [head, block("Final text", note.final), block(
          "What Whisper heard in my latest take",
          getSection(note.content, "Heard").replace(/%%[\s\S]*?%%/g, "").trim() +
            "\n\n(==marked== words are what Whisper heard differently; ~~struck~~ words are in the final text but were not heard.)"
        ),
      ].join("\n\n");
    } else if (kind.includes("question")) {
      const m = reviewMaterial(note);
      if (!m.questions.length) throw new Error("Write what you want to ask under “## Questions” first, one per line.");
      context = [head, block("The text", note.final), block("What I didn't know", m.questions.map((q) => `- ${q}`).join("\n"))].join("\n\n");
    } else if (kind.includes("quiz")) {
      const m = reviewMaterial(note);
      const known = m.checklist.filter((c) => c.known).map((c) => `- ${c.word} — my meaning: ${c.meaning || "(I didn't write one)"}`);
      const unknown = m.checklist.filter((c) => !c.known).map((c) => `- ${c.word}`);
      context = [
        head,
        block("The text", note.final),
        block("What I asked about", m.questions.map((q) => `- ${q}`).join("\n")),
        block("The answers I got", m.answers),
        block("Words I ticked as known, with what I think they mean", known.join("\n")),
        block("Words I did not tick", unknown.join("\n")),
      ].join("\n\n");
    } else if (kind.includes("translat")) {
      context = [head, block("My draft", note.draft)].join("\n\n");
    } else if (kind.includes("corrector")) {
      context = [head, block("My draft", note.draft), block(`${frontValue(note.content, "to") || s.recipient}'s corrections`, theirs)].join("\n\n");
    } else {
      context = note.content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    }
  }
  if (!context.trim() && !kind.includes("seed")) throw new Error("There is nothing in this note to send yet.");
  return [roleText, rules ? "---\n\n" + rules : "", "---\n\n" + context.trim()].filter(Boolean).join("\n\n") + "\n";
}

export const DEFAULT_ROLES: Record<string, string> = {
  "_Rules.md": `## Rules for every reply

- I am learning {{language}} by making short voice notes for {{to}}. Help with the note in front of you and nothing else.
- Never mention streaks, missed days, overdue or due items, or counts of anything waiting. Never suggest catching up.
- Do not give me a plan, a schedule, a menu of options, or homework.
- Never romanize. Write {{language}} in its own script only.
- {{to}} is the person the note is for, not my teacher. Never treat {{to}}'s reaction as a grade, and never tell me to ask {{to}} for corrections.
- Do not assume I have energy to spare. Keep the reply short enough to read in a minute.
- Describe; do not score, rank or praise.
`,
  "1 Corrector.md": `# Corrector

Correct my draft so that it is what a native speaker would actually say in a voice note to {{to}}.

- Keep my register. Notes to {{to}} are casual and spoken: aim for natural 반말, not textbook prose, unless my draft is clearly in polite speech.
- Change as little as you can. Keep what I was trying to say, including anything I wrote in English in brackets, which you should put into {{language}}.
- Give the corrected text first, in one code block (\`\`\`), one sentence per line, with nothing else in the block.
- Then list each change on one line: what changed, and why.
- If {{to}}'s corrections are included below, {{to}}'s version decides how things are said. Explain the grammar behind those changes, and flag only real errors.
`,
  "2 Noticer.md": `# Noticer

I want to try fixing this myself first.

- Mark the places in my draft that need fixing, and do not fix them.
- Quote each place and say only what kind of problem it is (particle, ending, word choice, word order, register).
- Do not give the corrected form or a hint that contains it.
`,
  "3 Seed finder.md": `# Seed finder

Propose three seeds for my next voice note.

- Each seed is one line taken from the material below, exactly as written, paired with someone it could be said to and when.
- Choose lines I could plausibly say out loud this week.
- Propose phrases only. Never propose something to read, watch or study.
`,
  "4 Listener.md": `# Listener

Below are the final text of my note and what Whisper heard in my latest take.

- Whisper fills in what it expects to hear, so a match proves little and a mismatch is worth a look.
- Explain only the differences that matter: what Whisper heard instead, the likely sound behind it, and one thing to try when I say it again.
- Describe. Never score.
`,
  "5 Look back.md": `# Look back

Below are an early note and a recent one.

- Describe what I can say in the recent note that I could not say in the early one: structures, endings, vocabulary, how much needed correcting.
- Be specific and quote both notes.
- Describe only. No score, no advice, no next steps.
`,
  "6 Translator.md": `# Translator

My draft is in English, perhaps with some {{language}} in it. Turn it into what I would actually say to {{to}} in a voice note.

- Spoken and casual: natural 반말, the way close friends talk, not textbook prose.
- Keep it simple enough for me to say aloud. Keep my meaning and my voice, and add nothing I did not write.
- Keep any {{language}} I already wrote unless it is wrong.
- First give the whole {{language}} text in one code block (\`\`\`), one sentence per line, with nothing else in the block.
- Then one short line per sentence: the words or grammar I need to say it. No romanization.
`,
  "8 Questions.md": `# Questions

Below is the text of my voice note and a list of the words and grammar I did not know.

- Explain only the items in my list. Do not explain any other word or grammar in the text, even if it seems useful.
- For each item, as it appears in the text: its dictionary form, what it means here, and what its ending or pattern does.
- Give one more short example of the same item in natural 반말.
- Keep each item short. No romanization.
`,
  "9 Quiz.md": `# Quiz

Make me a quiz from the material below. I asked for this quiz.

What to test, most weight first:
1. Everything I asked about (words and grammar).
2. Words I did not tick.
3. Words I ticked whose meaning I got wrong or left blank. Words I ticked with a right meaning are known: leave them out.

How, based on what is known to work for remembering:
- Recall, not recognition: no multiple choice. Make me produce the answer.
- Use my own sentences. Blank out the word or ending (cloze) so I recall it in context.
- Test both directions for words: {{language}} → meaning, and meaning → {{language}}.
- For grammar, make me use the pattern in a new short sentence, not name it.
- Mix vocabulary and grammar cards together rather than grouping them.
- One fact per card. About 10 to 20 cards. No romanization.

Format: Obsidian Spaced Repetition flashcards. Every card is exactly one line, and there is a blank line between cards. Use only these three kinds:
- Word, both directions: \`단어:::meaning\`
- Sentence with a blank: my sentence with the hidden part as \`==answer;;English hint==\` and nothing after it. Never put \`::\` on a line that has \`==\`.
- A hint is one to four English words giving the meaning, such as \`;;easily\` or \`;;the most\`. Never explain grammar in a hint, never use {{language}} in a hint, and never give away the form of the answer.
- Grammar task: \`English instruction to make a new sentence with the pattern::one example answer\`
- Every card has something on both sides. Never write a line that ends in \`::\` or \`:::\`.
- Put the whole quiz in one code block that starts with \`\`\`quiz and has nothing else in it.

Then, in a second code block that starts with \`\`\`words, list the words to keep studying (the ones you tested), one per line exactly like this:
\`- 단어 (dictionary form, meaning): my sentence with **단어** in bold\`
`,
  "7 Explainer.md": `# Explainer

Explain the {{language}} below to a learner who will say it aloud to {{to}}.

- What it means, and the grammar of each ending, briefly.
- How it sounds to {{to}}: its tone and register.
- If there is a more natural way to say it in a voice note, give it in a code block (\`\`\`).
- No romanization.
`,
};

/** Create the default roles that have never been created, so deleting one keeps it deleted. */
export async function writeDefaultRoles(plugin: KodingPlugin, restore: boolean): Promise<void> {
  const folder = plugin.settings.tutorFolder;
  await ensureFolder(plugin.app, folder);
  const seeded = new Set(plugin.state.rolesSeeded);
  for (const [name, text] of Object.entries(DEFAULT_ROLES)) {
    if (seeded.has(name) && !restore) continue;
    const path = normalizePath(`${folder}/${name}`);
    if (!(await plugin.app.vault.adapter.exists(path))) await plugin.app.vault.create(path, text);
    seeded.add(name);
  }
  plugin.state.rolesSeeded = Array.from(seeded);
  await plugin.saveState();
}

/** Korean in the latest AI reply, and in the recipient's corrections. */
export function correctionTexts(n: NoteInfo, recipient: string): { ai: string; theirs: string } {
  const to = frontValue(n.content, "to") || recipient;
  return {
    ai: koreanFromReply(lastReply(getSubsection(n.content, "Corrections", "AI"))),
    theirs: plainText(getSubsection(n.content, "Corrections", to)),
  };
}

/** A packet for a piece of selected text rather than a whole note. */
export async function buildSelectionPacket(plugin: KodingPlugin, role: Role, text: string): Promise<string> {
  const s = plugin.settings;
  const vars = { to: s.recipient, language: s.languageName };
  const roleText = fill(await plugin.app.vault.read(role.file), vars).trim();
  const rules = fill(await readText(plugin.app, `${s.tutorFolder}/_Rules.md`), vars).trim();
  return [roleText, rules ? "---\n\n" + rules : "", `---\n\nTo: ${s.recipient}\n\n### Text\n${text.trim()}`].filter(Boolean).join("\n\n") + "\n";
}
