// Agent Hub plugin for Amp. Copy it to ~/.config/amp/plugins/ (or a repo's .amp/plugins/).
// Needs the agenthub CLI: curl -fsSL https://get.theagenthub.app | sh
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND =
  process.env.AGENTHUB_BIN ||
  [join(homedir(), ".local", "bin", "agenthub"), join(process.env.LOCALAPPDATA || homedir(), "Programs", "agenthub", "agenthub.exe")].find((f) => existsSync(f)) ||
  "agenthub";
const TIMEOUT_MS = 5000;

export const description = "Agent Hub: teammates' agents' messages in your threads, and an idle thread wakes for their requests.";

/** Runs agenthub; resolves to its exit code and stdout, or code -1 on any failure. */
function run(args, input, cwd, timeoutMs, onChild) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(COMMAND, args, { cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: process.platform === "win32" });
    } catch {
      return resolve({ code: -1, out: "" });
    }
    onChild?.(child);
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : undefined;
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, out: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.trim() });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export default function agenthub(amp) {
  let cwd = process.cwd();
  try {
    const root = amp.system?.workspaceRoot ? String(amp.system.workspaceRoot) : "";
    if (root) cwd = root.startsWith("file:") ? fileURLToPath(root) : root;
  } catch {}
  const started = new Set();
  const waiting = new Map();
  const stopWaiting = (id) => {
    waiting.get(id)?.kill();
    waiting.delete(id);
  };
  const notify = async (event, id, extra) => {
    const { out } = await run(["notify", "--format", "amp", "--event", event], JSON.stringify({ session_id: id, cwd, ...extra }), cwd, TIMEOUT_MS);
    return out;
  };
  const say = async (id, content, steer) => {
    try {
      await amp.threads.get(id).appendUserMessage({ type: "user-message", content }, steer ? { steer: true } : undefined);
    } catch (e) {
      amp.logger?.log?.("agenthub: couldn't add to thread " + id + ": " + e);
    }
  };
  const wake = async (id) => {
    const { code, out } = await run(["wait"], JSON.stringify({ session_id: id, cwd }), cwd, 0, (child) => {
      stopWaiting(id);
      waiting.set(id, child);
    });
    // An agenthub too old to know `wait` exits 2 too, but prints nothing on stdout.
    if (code === 2 && out) await say(id, out, false);
  };

  amp.on("agent.start", async (event) => {
    const id = event.thread?.id;
    if (!id) return;
    stopWaiting(id);
    const first = !started.has(id);
    started.add(id);
    const text = await notify(first ? "session-start" : "prompt", id);
    return text ? { message: { content: text, display: false } } : undefined;
  });

  amp.on("tool.result", async (event) => {
    const id = event.thread?.id;
    if (!id) return;
    const text = await notify("post-tool", id);
    if (!text) return;
    if (typeof event.output === "string") return { status: event.status, output: event.output + "\n\n" + text };
    await say(id, text, true);
  });

  amp.on("agent.end", async (event) => {
    const id = event.thread?.id;
    if (!id) return;
    // A cancelled turn isn't kept going, and doesn't start a waiter.
    const out = await notify("stop", id, { status: event.status });
    if (out) {
      try {
        const r = JSON.parse(out);
        if (r.decision === "block" && r.reason) return { action: "continue", userMessage: r.reason };
      } catch {}
    }
    if (event.status !== "cancelled") void wake(id);
  });

  amp.onDispose?.(() => {
    for (const child of waiting.values()) child.kill();
    waiting.clear();
  });
}
