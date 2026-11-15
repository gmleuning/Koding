// Usage: node test/show-cards.mjs <quiz file>  — prints the cards Koding will show
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const out = path.join(os.tmpdir(), `koding-show-${Date.now()}.mjs`);
await esbuild.build({ entryPoints: ["src/cards.ts"], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
const k = await import(pathToFileURL(out).href);
const cards = k.parseCards(fs.readFileSync(process.argv[2], "utf8"), process.argv[2]);
for (const c of cards) console.log(`[${c.kind}] ${c.front}\n        → ${c.back}`);
