// Loads the built main.js against a stand-in for the Obsidian API, to catch load-time errors.
const Module = require("module");
const path = require("path");

class Base {
  constructor() {}
}
const stub = new Proxy(
  {
    Plugin: class {
      constructor() {
        this.app = {};
      }
    },
    ItemView: Base,
    Modal: Base,
    SuggestModal: Base,
    PluginSettingTab: Base,
    MarkdownView: Base,
    TFile: Base,
    TFolder: Base,
    FileSystemAdapter: Base,
    Setting: Base,
    Notice: Base,
    normalizePath: (p) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
    debounce: (fn) => fn,
    setIcon: () => {},
  },
  { get: (t, k) => (k in t ? t[k] : Base) }
);
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") return stub;
  if (request === "electron") return {};
  return load.call(this, request, ...rest);
};

const mod = require(path.resolve(__dirname, "..", "main.js"));
const Plugin = mod.default || mod;
if (typeof Plugin !== "function") throw new Error("main.js does not export a plugin class");
const p = new Plugin();
for (const m of ["onload", "onunload", "doNextAction", "sendToAI", "takeReply", "openDesk", "setupVault"]) {
  if (typeof p[m] !== "function") throw new Error("missing method " + m);
}
console.log("main.js loads and exports the plugin class");
