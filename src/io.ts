import { App, FileSystemAdapter, TFile, TFolder, normalizePath } from "obsidian";
import { spawn } from "child_process";
import * as nodePath from "path";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Start a local program and wait for it. Rejects if it cannot start or exits with an error. */
export function run(cmd: string, args: string[], timeoutMs = 0): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const viaShell = /\.(cmd|bat)$/i.test(cmd);
    let child;
    try {
      child = spawn(viaShell ? `"${cmd}"` : cmd, viaShell ? args.map((a) => `"${a}"`) : args, {
        shell: viaShell,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${nodePath.basename(cmd)} took too long and was stopped`));
      }, timeoutMs);
    }
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(e.code === "ENOENT" ? new Error(`“${cmd}” was not found. Check its path in the settings.`) : e);
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${nodePath.basename(cmd)} failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`));
    });
  });
}

export function absPath(app: App, vaultPath: string): string {
  const base = (app.vault.adapter as FileSystemAdapter).getBasePath();
  return nodePath.join(base, ...normalizePath(vaultPath).split("/"));
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
  const path = normalizePath(folder);
  if (!path || path === "/") return;
  if (app.vault.getAbstractFileByPath(path) instanceof TFolder) return;
  if (await app.vault.adapter.exists(path)) return;
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (parent) await ensureFolder(app, parent);
  try {
    await app.vault.createFolder(path);
  } catch {
    /* created meanwhile */
  }
}

export function parentOf(path: string): string {
  const p = normalizePath(path);
  return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
}

export function baseOf(path: string): string {
  const p = normalizePath(path);
  return p.slice(p.lastIndexOf("/") + 1);
}

export async function readText(app: App, path: string): Promise<string> {
  const p = normalizePath(path);
  const f = app.vault.getAbstractFileByPath(p);
  if (f instanceof TFile) return (await app.vault.read(f)).replace(/\r\n/g, "\n");
  if (await app.vault.adapter.exists(p)) return (await app.vault.adapter.read(p)).replace(/\r\n/g, "\n");
  return "";
}

export async function writeText(app: App, path: string, text: string): Promise<void> {
  const p = normalizePath(path);
  const f = app.vault.getAbstractFileByPath(p);
  if (f instanceof TFile) {
    await app.vault.modify(f, text);
    return;
  }
  await ensureFolder(app, parentOf(p));
  if (await app.vault.adapter.exists(p)) await app.vault.adapter.write(p, text);
  else await app.vault.create(p, text);
}

/** Change a Markdown file through a function of its text. */
export async function editText(app: App, path: string, fn: (text: string) => string): Promise<void> {
  const p = normalizePath(path);
  const f = app.vault.getAbstractFileByPath(p);
  if (f instanceof TFile) {
    await app.vault.process(f, (t) => fn(t.replace(/\r\n/g, "\n")));
    return;
  }
  await writeText(app, p, fn(await readText(app, p)));
}

/** A path in `folder` that is not taken yet: "name.ext", "name 2.ext", … */
export async function freePath(app: App, folder: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let path = normalizePath(`${folder}/${name}`);
  for (let i = 2; await app.vault.adapter.exists(path); i++) path = normalizePath(`${folder}/${stem} ${i}${ext}`);
  return path;
}

export async function movePath(app: App, from: string, to: string): Promise<void> {
  const a = normalizePath(from);
  const b = normalizePath(to);
  await ensureFolder(app, parentOf(b));
  const f = app.vault.getAbstractFileByPath(a);
  if (f) await app.vault.rename(f, b);
  else await app.vault.adapter.rename(a, b);
}

export async function listFiles(app: App, folder: string): Promise<string[]> {
  const p = normalizePath(folder);
  if (!(await app.vault.adapter.exists(p))) return [];
  return (await app.vault.adapter.list(p)).files;
}

export function resourceUrl(app: App, path: string): string {
  return app.vault.adapter.getResourcePath(normalizePath(path));
}

export function markdownFilesUnder(app: App, folder: string): TFile[] {
  const p = normalizePath(folder);
  return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(p + "/"));
}
