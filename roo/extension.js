"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/roo/src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var vscode = __toESM(require("vscode"));

// plugins/roo/src/bridge.ts
var import_node_child_process = require("node:child_process");
function run(command2, args, input, cwd, timeoutMs, onChild) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = (0, import_node_child_process.spawn)(command2, args, { cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: process.platform === "win32" });
    } catch {
      return resolve({ code: -1, out: "" });
    }
    onChild?.(child);
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : void 0;
    child.stdout.on("data", (c) => out += c);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, out: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.trim() });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
  });
}
function connectRoo(api, opts) {
  const waiting = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  const stopWaiting = (id) => {
    for (const [task, child] of waiting) {
      if (id && task !== id) continue;
      child.kill();
      waiting.delete(task);
    }
  };
  const payload = (extra = {}) => JSON.stringify({ cwd: opts.cwd(), ...extra });
  const notify = (event, extra) => {
    const cwd = opts.cwd();
    if (!cwd) return Promise.resolve({ code: -1, out: "" });
    return run(opts.command, ["notify", "--format", "roo", "--event", event], payload(extra), cwd, 5e3);
  };
  const isCurrent = (taskId) => {
    const stack = api.getCurrentTaskStack();
    return stack[stack.length - 1] === taskId;
  };
  const send = async (taskId, text) => {
    if (!isCurrent(taskId)) return;
    try {
      await api.sendMessage(text);
    } catch (e) {
      opts.log?.(`agenthub: couldn't send to task ${taskId}: ${e}`);
    }
  };
  const onStarted = (taskId) => {
    if (typeof taskId !== "string") return;
    stopWaiting();
    seen.add(taskId);
  };
  const onBusy = (taskId) => {
    if (typeof taskId === "string") stopWaiting(taskId);
  };
  const onCompleted = async (taskId) => {
    if (typeof taskId !== "string") return;
    seen.add(taskId);
    const { out } = await notify("stop");
    if (out) {
      try {
        const r = JSON.parse(out);
        if (r.decision === "block" && r.reason) return void await send(taskId, r.reason);
      } catch {
      }
    }
    const cwd = opts.cwd();
    if (!cwd) return;
    const { code, out: text } = await run(opts.command, ["wait"], payload(), cwd, 0, (child) => {
      stopWaiting(taskId);
      waiting.set(taskId, child);
    });
    if (code === 2 && text) await send(taskId, text);
  };
  const onAborted = async (taskId) => {
    if (typeof taskId !== "string") return;
    stopWaiting(taskId);
    await notify("stop", { status: "aborted" });
  };
  const listeners = [
    ["taskStarted", onStarted],
    ["taskAskResponded", onBusy],
    ["taskUnpaused", onBusy],
    ["taskCompleted", onCompleted],
    ["taskAborted", onAborted]
  ];
  for (const [event, fn] of listeners) api.on(event, fn);
  return async () => {
    for (const [event, fn] of listeners) api.off?.(event, fn);
    stopWaiting();
    if (seen.size) await notify("session-end");
  };
}

// plugins/roo/src/extension.ts
var ROO_IDS = ["RooVeterinaryInc.roo-cline"];
var disconnect;
function command() {
  const configured = vscode.workspace.getConfiguration("agenthub").get("command");
  if (configured) return configured;
  const candidates = [(0, import_node_path.join)((0, import_node_os.homedir)(), ".local", "bin", "agenthub"), (0, import_node_path.join)(process.env.LOCALAPPDATA || (0, import_node_os.homedir)(), "Programs", "agenthub", "agenthub.exe")];
  return candidates.find((f) => (0, import_node_fs.existsSync)(f)) ?? "agenthub";
}
async function activate(context) {
  const out = vscode.window.createOutputChannel("Agent Hub");
  context.subscriptions.push(out);
  const roo = ROO_IDS.map((id) => vscode.extensions.getExtension(id)).find(Boolean);
  if (!roo) return out.appendLine("Roo Code isn't installed, so there's nothing to connect.");
  const api = roo.isActive ? roo.exports : await roo.activate();
  if (!api?.on || !api.sendMessage) return out.appendLine("Roo Code didn't share its API.");
  disconnect = connectRoo(api, {
    command: command(),
    cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    log: (line) => out.appendLine(line)
  });
  out.appendLine("Connected to Roo Code: idle tasks wake for hub requests.");
}
async function deactivate() {
  await disconnect?.();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
