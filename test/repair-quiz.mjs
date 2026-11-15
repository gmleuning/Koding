// Usage: node repair_quiz.mjs <plugin source dir> <quiz file>
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [srcDir, quizFile] = process.argv.slice(2);
const out = path.join(os.tmpdir(), `koding-repair-${Date.now()}.mjs`);
await esbuild.build({ entryPoints: [path.join(srcDir, "src", "text.ts")], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
const t = await import(pathToFileURL(out).href);

const text = fs.readFileSync(quizFile, "utf8").replace(/\r\n/g, "\n");
const m = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/.exec(text);
const front = m ? m[1] : "";
const body = m ? m[2] : text;
fs.writeFileSync(quizFile, `${front}\n#flashcards/korean\n\n${t.repairQuiz(body)}\n`, "utf8");
console.log(fs.readFileSync(quizFile, "utf8"));
