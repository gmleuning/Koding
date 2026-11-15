// Reading quiz files into cards. No Obsidian imports, so it can be tested with plain node.
// The files use the Spaced Repetition plugin's format, so that plugin still works on them if wanted.

export interface Card {
  id: string;
  /** Text to show first. In a blank, the hidden part is written as [[?hint]]. */
  front: string;
  /** Text to show after "Show". The answer of a blank is in **bold**. */
  back: string;
  kind: "word" | "blank" | "task" | "basic";
  source: string;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const BLANK = /==([^=]+?)==/g;

function splitBlank(inner: string): { answer: string; hint: string } {
  const parts = inner.split(";;");
  // "==1;;answer;;hint==" also exists in the format; a leading number is a group, not the answer
  if (parts.length === 3 && /^\d+$/.test(parts[0].trim())) parts.shift();
  return { answer: parts[0].trim(), hint: (parts[1] || "").trim() };
}

function card(kind: Card["kind"], front: string, back: string, source: string): Card {
  return { id: hash(`${kind}|${front}|${back}`), front, back, kind, source };
}

/** One card per blank in a line: that blank hidden, the others shown. */
function blankCards(line: string, extraHint: string, source: string): Card[] {
  const blanks = Array.from(line.matchAll(BLANK));
  return blanks.map((target) => {
    let front = "";
    let back = "";
    let last = 0;
    for (const b of blanks) {
      const { answer, hint } = splitBlank(b[1]);
      const pre = line.slice(last, b.index);
      front += pre;
      back += pre;
      if (b === target) {
        front += `[[?${hint || extraHint}]]`;
        back += `**${answer}**`;
      } else {
        front += answer;
        back += answer;
      }
      last = (b.index ?? 0) + b[0].length;
    }
    front += line.slice(last);
    back += line.slice(last);
    return card("blank", front.trim(), back.trim(), source);
  });
}

export function parseCards(text: string, source = ""): Card[] {
  const body = text
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--SR:[^>]*-->/g, "");
  const cards: Card[] = [];
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l && !/^#flashcards\S*$/.test(l) && !/^#+\s/.test(l));
    if (!lines.length) continue;

    // multi-line card: front lines, then "?" (or "??" for both ways), then back lines
    const q = lines.findIndex((l) => l === "?" || l === "??");
    if (q > 0 && q < lines.length - 1) {
      const front = lines.slice(0, q).join("\n");
      const back = lines.slice(q + 1).join("\n");
      cards.push(card("basic", front, back, source));
      if (lines[q] === "??") cards.push(card("basic", back, front, source));
      continue;
    }

    for (const line of lines) {
      const sep = /:{2,3}/.exec(line);
      const left = sep ? line.slice(0, sep.index).trim() : line;
      const right = sep ? line.slice(sep.index + sep[0].length).trim() : "";
      if (sep && !right) continue; // a label with nothing on the back
      if (/==[^=]+==/.test(left)) {
        // a blank; anything after :: is only a hint
        cards.push(...blankCards(left, right.replace(/==/g, ""), source));
      } else if (sep && sep[0] === ":::") {
        cards.push(card("word", left, right, source), card("word", right, left, source));
      } else if (sep) {
        cards.push(card(/^[A-Za-z]/.test(left) && left.split(" ").length > 4 ? "task" : "basic", left, right, source));
      }
    }
  }
  // the same card written twice counts once
  const seen = new Set<string>();
  return cards.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

// ---------- Spacing ----------

export interface CardRecord {
  /** 0 after "Not yet"; one more after each "Got it". */
  box: number;
  last: number;
}

/** Days to wait before a card is worth showing again. Nothing is ever "due" or "overdue". */
const REST_DAYS = [0, 1, 3, 7, 16, 35, 80];

export function restDays(box: number): number {
  return REST_DAYS[Math.min(box, REST_DAYS.length - 1)];
}

export function isRested(r: CardRecord | undefined, now: number): boolean {
  if (!r) return true;
  const rest = r.box === 0 ? 10 * 60000 : restDays(r.box) * 864e5;
  return now - r.last >= rest;
}

export function record(r: CardRecord | undefined, gotIt: boolean, now: number): CardRecord {
  return { box: gotIt ? (r?.box ?? 0) + 1 : 0, last: now };
}

/**
 * A few cards for the Desk: rested cards first, the shakiest and longest-unseen first among them.
 * If too few are rested, the rest are the ones seen longest ago. Never says how many are waiting.
 */
export function pickCards(cards: Card[], records: Record<string, CardRecord>, n: number, now: number, random = Math.random): Card[] {
  const scored = cards.map((c) => {
    const r = records[c.id];
    // misses first, then cards never seen, then the rest by how well they are known
    return { c, rested: isRested(r, now), box: r ? r.box : 0.5, last: r?.last ?? 0, r: random() };
  });
  scored.sort((a, b) => Number(b.rested) - Number(a.rested) || a.box - b.box || a.last - b.last || a.r - b.r);
  return interleave(scored.slice(0, n).map((x) => x.c), random);
}

/** Shuffle, then avoid two cards from the same line in a row where possible. */
export function interleave(cards: Card[], random = Math.random): Card[] {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  const key = (c: Card) => c.back.replace(/\*\*/g, "");
  for (let i = 1; i < out.length; i++) {
    if (key(out[i]) === key(out[i - 1]) || key(out[i]) === out[i - 1].front) {
      const k = out.findIndex((c, j) => j > i && key(c) !== key(out[i - 1]));
      if (k > 0) [out[i], out[k]] = [out[k], out[i]];
    }
  }
  return out;
}
