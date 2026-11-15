// Checks for the pure text helpers. Run with: npm test
import esbuild from "esbuild";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const out = path.join(os.tmpdir(), `koding-text-${Date.now()}.mjs`);
await esbuild.build({ entryPoints: ["src/text.ts"], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
const t = await import(pathToFileURL(out).href);

const note = `---
to: Minji
date: 2026-11-14
seed: '귤 따러 갈래? (2026-11-13)'
status: draft
---

## Draft
(my Korean, never overwritten)
귤 [pick] 갈래?

## Corrections
### Minji

### AI

## Final


## Model

## Takes
![[2026-11-14 귤 take 1.m4a]]
![[2026-11-14 귤 take 2.m4a]]

## Heard

## Words
- 따다: 귤 **따러** 갈래?
`;

// sections
assert.equal(t.meaningful(t.getSection(note, "Draft")), "귤 [pick] 갈래?");
assert.equal(t.meaningful(t.getSection(note, "Corrections")), "");
assert.equal(t.plainText(t.getSection(note, "Final")), "");
assert.deepEqual(t.embedsIn(t.getSection(note, "Takes")), ["2026-11-14 귤 take 1.m4a", "2026-11-14 귤 take 2.m4a"]);

let n = t.setSection(note, "Final", "귤 따러 갈래?");
assert.equal(t.getSection(n, "Final"), "귤 따러 갈래?");
assert.equal(t.meaningful(t.getSection(n, "Draft")), "귤 [pick] 갈래?", "draft untouched");
assert.ok(n.indexOf("## Final") < n.indexOf("## Model"), "order kept");

n = t.appendToSection(n, "Takes", "![[2026-11-14 귤 take 3.m4a]]");
assert.equal(t.embedsIn(t.getSection(n, "Takes")).length, 3);
assert.equal(t.getSection(n, "Heard"), "");

n = t.appendToSubsection(n, "Corrections", "AI", "**Claude · 2026-11-14**\n\n귤 따러 갈래?");
assert.match(t.getSubsection(n, "Corrections", "AI"), /^\*\*Claude/);
assert.equal(t.getSubsection(n, "Corrections", "Minji"), "");
n = t.appendToSubsection(n, "Corrections", "AI", "second reply");
assert.match(t.getSubsection(n, "Corrections", "AI"), /갈래\?\n\nsecond reply$/);
assert.equal(t.getSection(n, "Final"), "귤 따러 갈래?", "final survives replies");
n = t.appendToSubsection(n, "Corrections", "Mina", "new person");
assert.equal(t.getSubsection(n, "Corrections", "Mina"), "new person");
assert.equal(t.getSection(n, "Final"), "귤 따러 갈래?");

// a note with no such section gets one
assert.equal(t.getSection(t.setSection("hello", "Heard", "x"), "Heard"), "x");
assert.equal(t.getSubsection(t.appendToSubsection("hello", "Corrections", "AI", "x"), "Corrections", "AI"), "x");

// front matter
assert.equal(t.frontValue(note, "status"), "draft");
assert.equal(t.frontValue(note, "seed"), "귤 따러 갈래? (2026-11-13)");
assert.equal(t.frontValue("---\nstatus: draft            # draft → corrected\n---\n", "status"), "draft");
assert.equal(t.frontValue(t.setFrontValue(note, "status", "recorded"), "status"), "recorded");
assert.equal(t.frontValue(t.setFrontValue("no front matter", "status", "done"), "status"), "done");
assert.equal(t.yamlQuote("it's"), "'it''s'");

// names
assert.equal(t.safeName('귤 따러 갈래? "now": yes/no'), "귤 따러 갈래 now yesno");
assert.equal(t.dateFromName("2026-11-14 1532.txt"), "2026-11-14");
assert.equal(t.extOf("a b.M4A"), "m4a");
assert.equal(t.stripExt("a.b.m4a"), "a.b");

// subtitles
const srt = `1\n00:00:00,100 --> 00:00:02,800\n귤 따러 갈래?\n\n2\n00:00:02,750 --> 00:00:06,410\n오늘 날씨가 정말 좋아.\n`;
const cues = t.groupCues(t.parseSubtitles(srt));
assert.equal(cues.length, 2);
assert.equal(cues[0].text, "귤 따러 갈래?");
assert.ok(Math.abs(cues[0].start - 0.1) < 1e-9 && Math.abs(cues[1].end - 6.41) < 1e-9);
assert.ok(cues[0].end <= cues[1].start, "no overlap");
const words = t.groupCues([
  { start: 0, end: 1, text: "귤" },
  { start: 1, end: 2, text: "따러" },
  { start: 2, end: 3, text: "갈래?" },
  { start: 3, end: 4, text: "좋아." },
]);
assert.deepEqual(words.map((c) => c.text), ["귤 따러 갈래?", "좋아."]);
assert.deepEqual(t.splitSentences("귤 따러 갈래? 오늘 좋아.\n같이 가자!"), ["귤 따러 갈래?", "오늘 좋아.", "같이 가자!"]);
const est = t.estimateCues("가나. 다라마바.", 6);
assert.equal(est.length, 2);
assert.ok(Math.abs(est[1].end - 6) < 1e-9);
assert.deepEqual(t.subtitleLines("1\n00:00:01,000 --> 00:00:02,000\n<i>안녕</i>\n\n2\n00:00:03,000 --> 00:00:04,000\n잘 가\n"), ["안녕", "잘 가"]);

// diff
assert.deepEqual(t.diffWords("귤 따러 갈래?", "귤 따러 갈래"), { marked: "귤 따러 갈래", same: true });
assert.equal(t.diffWords("귤 따러 갈래?", "귤 타러 갈래?").marked, "귤 ==타러== ~~따러~~ 갈래?");
assert.equal(t.diffWords("오늘 날씨가 좋아", "날씨가 좋아 정말").marked, "~~오늘~~ 날씨가 좋아 ==정말==");

// words, templates
assert.deepEqual(t.parseWords("# Words\n- 따다: 귤 **따러** 갈래?\nnot a word\n- 가다：같이 **가자**"), [
  { word: "따다", sentence: "귤 **따러** 갈래?" },
  { word: "가다", sentence: "같이 **가자**" },
]);
assert.deepEqual(t.tokenize(`"C:\\Program Files\\x.exe" --voice {voice} 'a b'`), ["C:\\Program Files\\x.exe", "--voice", "{voice}", "a b"]);
assert.equal(t.fill("to {{to}} in {language} {unknown}", { to: "Minji", language: "Korean" }), "to Minji in Korean {unknown}");
assert.equal(t.signedPercent(-30), "-30%");
assert.equal(t.signedPercent(0), "+0%");
assert.equal(t.hangulLines("Hello there\n- 안녕 **친구**\n> quoted English"), "안녕 친구");

// english or korean draft
assert.ok(t.hangulShare("Dear my love, I have a new korean study project") < 0.3);
assert.ok(t.hangulShare("귤 [pick] 갈래? 오늘 (weather) 좋아") >= 0.9);
assert.equal(t.hangulShare(""), 0);

// pulling the korean out of a reply
const reply = "Here is a natural version:\n\n```\n자기야, 새 한국어 공부를 시작했어.\n너한테 녹음을 보낼 거야.\n```\n\n- 시작했어: started (past, 반말)";
assert.equal(t.koreanFromReply(reply), "자기야, 새 한국어 공부를 시작했어.\n너한테 녹음을 보낼 거야.");
assert.equal(t.koreanFromReply("Sure!\n\n자기야, 사랑해.\n보고 싶어.\n\nNotes:\n- 사랑해: I love you"), "자기야, 사랑해.\n보고 싶어.");
assert.equal(t.koreanFromReply("no korean here"), "");
assert.equal(t.lastReply("**Claude · 2026-11-12**\n\nfirst\n\n**ChatGPT · 2026-11-13**\n\nsecond"), "second");
assert.equal(t.lastReply(""), "");

// after the audio
assert.deepEqual(t.textWords("자기야, 새 한국어 공부를 시작했어.\n자기야 사랑해!"), ["자기야", "새", "한국어", "공부를", "시작했어", "사랑해"]);
assert.equal(t.checklistFor(["자기야", "새"]), "- [ ] 자기야 — \n- [ ] 새 — ");
assert.deepEqual(t.parseChecklist("- [x] 자기야 — honey\n- [ ] 새 — \n- [X] 공부를 - study (object)\nnot a box"), [
  { word: "자기야", known: true, meaning: "honey" },
  { word: "새", known: false, meaning: "" },
  { word: "공부를", known: true, meaning: "study (object)" },
]);
assert.deepEqual(t.listItems("- 시작했어\n-았/었어 past ending\n(placeholder)\n\n1. 공부"), ["시작했어", "-았/었어 past ending", "공부"]);
assert.equal(t.sentenceWith("자기야, 새 공부를 시작했어. 사랑해!", "시작했어"), "자기야, 새 공부를 **시작했어**.");
const quizReply = "Here you go:\n\n```quiz\n#flashcards\n시작하다::to start\n나는 공부를 ==시작했어==.\n```\n\n```words\n- 시작했어 (시작하다, to start): 새 공부를 **시작했어**.\n```";
assert.equal(t.fencedBlock(quizReply, "quiz"), "#flashcards\n시작하다::to start\n나는 공부를 ==시작했어==.");
assert.equal(t.fencedBlock(quizReply, "words"), "- 시작했어 (시작하다, to start): 새 공부를 **시작했어**.");
assert.equal(t.fencedBlock("no blocks", "quiz"), null);
assert.deepEqual(t.parseWords(t.fencedBlock(quizReply, "words")), [{ word: "시작했어 (시작하다, to start)", sentence: "새 공부를 **시작했어**." }]);

// quiz repair
assert.equal(
  t.repairQuiz(
    "#flashcards\n방법:::method; way\n자기야, 새로운 ==방법==을 생각해 봤어.::method\n-는 게:::\nMake a sentence with -는 게.::너랑 이야기하는 게 좋아.\n나는 ==쉽게;;easily== 배워.\n\n쉽게:::easily"
  ),
  "방법:::method; way\n\n자기야, 새로운 ==방법;;method==을 생각해 봤어.\n\nMake a sentence with -는 게.::너랑 이야기하는 게 좋아.\n\n나는 ==쉽게;;easily== 배워.\n\n쉽게:::easily"
);

console.log("text helpers: all checks passed");

// ---------- cards ----------
const cout = path.join(os.tmpdir(), `koding-cards-${Date.now()}.mjs`);
await esbuild.build({ entryPoints: ["src/cards.ts"], bundle: true, format: "esm", outfile: cout, logLevel: "silent" });
const k = await import(pathToFileURL(cout).href);

const quizFile = `---
note: "[[x]]"
---

#flashcards/korean

방법:::method, way

자기야, 새로운 ==방법;;method==을 생각해 봤어.

나는 ==쉽게== ==배울;;to learn== 수 있어.

==녹음해서== 보내려고 해.::recording

-는 게:::

Make a new short sentence using -는 게 to make an action the subject::한국어를 공부하는 게 재미있어.

What is 가장?
?
the most
<!--SR:!2026-11-20,3,250-->`;
const cs = k.parseCards(quizFile, "q.md");
const show = cs.map((c) => [c.kind, c.front, c.back]);
assert.deepEqual(show, [
  ["word", "방법", "method, way"],
  ["word", "method, way", "방법"],
  ["blank", "자기야, 새로운 [[?method]]을 생각해 봤어.", "자기야, 새로운 **방법**을 생각해 봤어."],
  ["blank", "나는 [[?]] 배울 수 있어.", "나는 **쉽게** 배울 수 있어."],
  ["blank", "나는 쉽게 [[?to learn]] 수 있어.", "나는 쉽게 **배울** 수 있어."],
  ["blank", "[[?recording]] 보내려고 해.", "**녹음해서** 보내려고 해."],
  ["task", "Make a new short sentence using -는 게 to make an action the subject", "한국어를 공부하는 게 재미있어."],
  ["basic", "What is 가장?", "the most"],
]);
assert.equal(new Set(cs.map((c) => c.id)).size, cs.length, "ids are distinct");
assert.equal(k.parseCards(quizFile)[0].id, cs[0].id, "ids are stable");
assert.equal(k.parseCards("a:::b\n\na:::b").length, 2, "duplicates dropped");

// spacing
const now = 1_800_000_000_000;
assert.equal(k.isRested(undefined, now), true);
assert.equal(k.isRested({ box: 0, last: now - 60000 }, now), false, "a miss rests ten minutes");
assert.equal(k.isRested({ box: 0, last: now - 11 * 60000 }, now), true);
assert.equal(k.isRested({ box: 2, last: now - 2 * 864e5 }, now), false);
assert.equal(k.isRested({ box: 2, last: now - 3 * 864e5 }, now), true);
assert.deepEqual(k.record({ box: 3, last: 0 }, true, now), { box: 4, last: now });
assert.deepEqual(k.record({ box: 3, last: 0 }, false, now), { box: 0, last: now });
const fixed = () => 0.5;
const recs = { [cs[0].id]: { box: 3, last: now }, [cs[1].id]: { box: 0, last: now - 864e5 } };
const picked = k.pickCards(cs, recs, 3, now, fixed).map((c) => c.id);
assert.equal(picked.length, 3);
assert.ok(picked.includes(cs[1].id), "a missed card that has rested comes first");
assert.ok(!picked.includes(cs[0].id), "a card just got right waits");
assert.equal(k.pickCards(cs, {}, 50, now).length, cs.length);
console.log("cards: all checks passed");
