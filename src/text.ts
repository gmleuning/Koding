// Pure text helpers. No Obsidian imports, so they can be tested with plain node.

export function pad(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

export function isoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- Markdown sections ----------

function headingLevel(line: string): number {
  const m = /^(#{1,6})\s+\S/.exec(line);
  return m ? m[1].length : 0;
}

function findSection(lines: string[], heading: string, level: number, from = 0, to = lines.length): { start: number; end: number } | null {
  const want = heading.trim().toLowerCase();
  for (let i = from; i < to; i++) {
    if (headingLevel(lines[i]) === level && lines[i].replace(/^#+\s+/, "").trim().toLowerCase() === want) {
      let end = to;
      for (let j = i + 1; j < to; j++) {
        const l = headingLevel(lines[j]);
        if (l > 0 && l <= level) {
          end = j;
          break;
        }
      }
      return { start: i, end };
    }
  }
  return null;
}

/** Body of a `## heading` section (without the heading line), or "" if absent. */
export function getSection(content: string, heading: string): string {
  const lines = content.split("\n");
  const s = findSection(lines, heading, 2);
  return s ? lines.slice(s.start + 1, s.end).join("\n").trim() : "";
}

/** Body of a `### sub` inside `## heading`. */
export function getSubsection(content: string, heading: string, sub: string): string {
  const lines = content.split("\n");
  const s = findSection(lines, heading, 2);
  if (!s) return "";
  const t = findSection(lines, sub, 3, s.start + 1, s.end);
  return t ? lines.slice(t.start + 1, t.end).join("\n").trim() : "";
}

/** Replace the body of a `## heading` section, creating the section at the end if needed. */
export function setSection(content: string, heading: string, body: string): string {
  const lines = content.split("\n");
  const s = findSection(lines, heading, 2);
  const block = body.trim() === "" ? [""] : [body.trim(), ""];
  if (!s) {
    return content.replace(/\s*$/, "") + `\n\n## ${heading}\n` + block.join("\n");
  }
  lines.splice(s.start + 1, s.end - s.start - 1, ...block);
  return lines.join("\n");
}

/** Add text at the end of a `## heading` section. */
export function appendToSection(content: string, heading: string, text: string): string {
  const current = getSection(content, heading);
  return setSection(content, heading, current ? current + "\n" + text : text);
}

/** Add text at the end of `### sub` inside `## heading`, creating either if needed. */
export function appendToSubsection(content: string, heading: string, sub: string, text: string): string {
  let lines = content.split("\n");
  let s = findSection(lines, heading, 2);
  if (!s) {
    content = content.replace(/\s*$/, "") + `\n\n## ${heading}\n`;
    lines = content.split("\n");
    s = findSection(lines, heading, 2)!;
  }
  const t = findSection(lines, sub, 3, s.start + 1, s.end);
  if (!t) {
    let at = s.end;
    while (at > s.start + 1 && lines[at - 1].trim() === "") at--;
    lines.splice(at, 0, `### ${sub}`, text.trim(), "");
    return lines.join("\n");
  }
  let at = t.end;
  while (at > t.start + 1 && lines[at - 1].trim() === "") at--;
  const gap = at > t.start + 1 ? [""] : [];
  lines.splice(at, 0, ...gap, text.trim(), "");
  return lines.join("\n");
}

/** Section text with the template's "(placeholder)" lines and sub-headings removed. */
export function meaningful(text: string): string {
  return text
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (t === "") return false;
      if (/^\(.*\)$/.test(t)) return false;
      if (/^#{1,6}\s/.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export function embedsIn(text: string): string[] {
  const out: string[] = [];
  const re = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out;
}

/** Plain text to speak or compare: no embeds, markdown marks, or comments. */
export function plainText(text: string): string {
  return meaningful(text)
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(\*\*|__|==|~~|`)/g, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

export function hasHangul(s: string): boolean {
  return HANGUL.test(s);
}

/** Share of letters that are Hangul, ignoring anything in brackets (English where you were stuck). */
export function hangulShare(s: string): number {
  const letters = s.replace(/\([^)]*\)|\[[^\]]*\]/g, "").match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  return letters.filter((c) => HANGUL.test(c)).length / letters.length;
}

/** The Korean text in an AI reply: its first code block with Hangul, else its first run of Korean lines. */
export function koreanFromReply(reply: string): string {
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(reply))) if (hasHangul(m[1])) return m[1].trim();
  const out: string[] = [];
  for (const line of reply.split("\n")) {
    const t = line.trim();
    if (t && hangulShare(t) >= 0.5 && !/^\*\*.*\*\*$/.test(t)) out.push(t);
    else if (out.length && t) break;
  }
  return plainText(out.join("\n"));
}

/** The last reply under "### AI": everything after the last "**App · date**" line. */
export function lastReply(aiSection: string): string {
  const parts = aiSection.split(/^\*\*[^*\n]+ · \d{4}-\d{2}-\d{2}\*\*\s*$/m);
  return parts[parts.length - 1].trim();
}

/** The body of the first ```lang block, or null. */
export function fencedBlock(text: string, lang: string): string | null {
  const re = new RegExp("```[ \\t]*" + lang + "[^\\n]*\\n([\\s\\S]*?)```", "i");
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * Make an AI's flashcards safe for the Spaced Repetition plugin:
 * - a line with both a ==blank== and a :: back would show the answer on the front,
 *   so it becomes a pure blank with the back as its hint: ==answer;;hint==
 * - a line with an empty back ("-는 게:::") is a label, not a card, so it is dropped
 * - cards are separated by blank lines so none run together
 */
export function repairQuiz(text: string): string {
  const cards: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^#flashcards\S*$/.test(line)) continue;
    const sep = /:{2,3}/.exec(line);
    if (sep && !line.slice(sep.index + sep[0].length).trim()) continue;
    if (sep && /==[^=]+==/.test(line.slice(0, sep.index))) {
      const front = line.slice(0, sep.index).trim();
      const hint = line.slice(sep.index + sep[0].length).trim().replace(/==/g, "");
      cards.push(front.replace(/==([^=]+)==/, (all, answer: string) => (answer.includes(";;") ? all : `==${answer};;${hint}==`)));
      continue;
    }
    cards.push(line);
  }
  return cards.join("\n\n");
}

/** Every distinct word of a Korean text, in order, without punctuation. */
export function textWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!w || !hasHangul(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export interface CheckItem {
  word: string;
  known: boolean;
  meaning: string;
}

/** Lines like "- [x] 자기야 — honey" or "- [ ] 시작했어 — ". */
export function parseChecklist(text: string): CheckItem[] {
  const out: CheckItem[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!m) continue;
    const [word, ...rest] = m[2].split(/\s+[—–-]\s*|\s*[—–]\s*/);
    if (!word.trim()) continue;
    out.push({ word: word.trim(), known: m[1] !== " ", meaning: rest.join(" ").trim() });
  }
  return out;
}

export function checklistFor(words: string[]): string {
  return words.map((w) => `- [ ] ${w} — `).join("\n");
}

/** The items under a Questions section: one per line, bullets removed. */
export function listItems(text: string): string[] {
  return meaningful(text)
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

/** The sentence of a text that contains a word, with the word in bold. */
export function sentenceWith(text: string, word: string): string {
  const s = splitSentences(text).find((x) => x.includes(word));
  return s ? s.replace(word, `**${word}**`) : `**${word}**`;
}

/** Keep only the lines that contain Hangul (used for mixed-language source texts). */
export function hangulLines(text: string): string {
  return plainText(text)
    .split("\n")
    .filter((l) => hasHangul(l))
    .join("\n");
}

// ---------- Front matter ----------

export function frontValue(content: string, key: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!fm) return "";
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(fm[1]);
  if (!m) return "";
  let v = m[1].replace(/\s+#.*$/, "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).replace(/''/g, "'");
  return v;
}

export function setFrontValue(content: string, key: string, value: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!fm) return `---\n${key}: ${value}\n---\n\n` + content;
  const re = new RegExp(`^${key}:.*$`, "m");
  const body = re.test(fm[1]) ? fm[1].replace(re, `${key}: ${value}`) : fm[1] + `\n${key}: ${value}`;
  return `---\n${body}\n---` + content.slice(fm[0].length);
}

export function yamlQuote(s: string): string {
  return "'" + s.replace(/\r?\n/g, " ").replace(/'/g, "''") + "'";
}

// ---------- Names ----------

export function safeName(s: string, max = 28): string {
  const cleaned = s
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/[.!,;~…]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, max).join("").trim();
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** "2026-11-14 1532.txt" → "2026-11-14"; otherwise "". */
export function dateFromName(name: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(name);
  return m ? m[0] : "";
}

// ---------- Subtitles and sentences ----------

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function stamp(s: string): number {
  const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(s);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +("0." + m[4]);
}

/** Parse SRT or VTT into cues. */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() !== "");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split("-->");
    const t = lines.slice(ti + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!t) continue;
    cues.push({ start: stamp(a), end: stamp(z), text: t });
  }
  return cues;
}

const SENTENCE_END = /[.!?。？！…]["'”’)\]]*$/;

/** Merge word-level cues into sentences. Sentence-level cues pass through. */
export function groupCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  let cur: Cue | null = null;
  for (const c of cues) {
    if (!cur) cur = { ...c };
    else {
      cur.end = c.end;
      cur.text += " " + c.text;
    }
    if (SENTENCE_END.test(c.text)) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  // Overlaps would make one sentence bleed into the next.
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
  }
  return out;
}

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const parts = line.match(/[^.!?。？！…]+[.!?。？！…]*["'”’)\]]*/g) || [];
    for (const p of parts) if (p.trim()) out.push(p.trim());
  }
  return out;
}

/** Timings guessed from text length, for engines that give no subtitles. */
export function estimateCues(text: string, duration: number): Cue[] {
  const s = splitSentences(text);
  const total = s.reduce((n, x) => n + x.length, 0) || 1;
  let t = 0;
  return s.map((x) => {
    const d = (x.length / total) * duration;
    const cue = { start: t, end: t + d, text: x };
    t += d;
    return cue;
  });
}

/** Text lines of a subtitle file (or a Markdown copy of one), without numbers and timestamps. */
export function subtitleLines(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/<[^>]+>/g, "").trim())
    .filter((l) => l && !/^\d+$/.test(l) && !l.includes("-->") && !/^(WEBVTT|---|#)/.test(l));
}

// ---------- Word diff ----------

function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export interface DiffResult {
  /** The heard text, with ==differences== and ~~words that were not heard~~. */
  marked: string;
  same: boolean;
}

export function diffWords(finalText: string, heardText: string): DiffResult {
  const a = finalText.split(/\s+/).filter((w) => norm(w));
  const b = heardText.split(/\s+/).filter((w) => norm(w));
  const n = a.length;
  const m = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = norm(a[i]) === norm(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let same = true;
  while (i < n || j < m) {
    if (i < n && j < m && norm(a[i]) === norm(b[j])) {
      out.push(b[j]);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push(`==${b[j]}==`);
      j++;
      same = false;
    } else {
      out.push(`~~${a[i]}~~`);
      i++;
      same = false;
    }
  }
  return { marked: out.join(" "), same };
}

// ---------- Words pool ----------

export interface WordItem {
  word: string;
  sentence: string;
}

/** Lines like "- 따다: 귤 **따러** 갈래?" */
export function parseWords(text: string): WordItem[] {
  const out: WordItem[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*[-*+]\s+([^:：]+)[:：]\s*(.+)$/.exec(line);
    if (m && m[2].trim()) out.push({ word: m[1].trim(), sentence: m[2].trim() });
  }
  return out;
}

// ---------- Command templates ----------

/** Split a command line into arguments, honouring double and single quotes. */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{?(\w+)\}?\}/g, (all, k) => (k in vars ? vars[k] : all));
}

export function signedPercent(n: number): string {
  return (n >= 0 ? "+" : "") + Math.round(n) + "%";
}
