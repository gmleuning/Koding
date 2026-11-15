import esbuild from "esbuild";
import { builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";

const prod = process.argv[2] === "production";

// Optional: copy the built files into a vault after each build.
// Set KODING_VAULT=<vault path>, or put the vault path in a file named .vault (git-ignored).
const vaultFile = ".vault";
const vault = (process.env.KODING_VAULT || (fs.existsSync(vaultFile) ? fs.readFileSync(vaultFile, "utf8") : "")).trim();
const target = vault ? path.join(vault, ".obsidian", "plugins", "koding") : "";

const copyPlugin = {
  name: "copy-to-vault",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length || !vault) return;
      if (!fs.existsSync(vault)) {
        console.log(`vault not found, not copying: ${vault}`);
        return;
      }
      fs.mkdirSync(target, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) {
        fs.copyFileSync(f, path.join(target, f));
      }
      console.log(`copied to ${target}`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: false,
  outfile: "main.js",
  plugins: [copyPlugin],
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
