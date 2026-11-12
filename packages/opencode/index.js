// Agent Hub plugin for OpenCode, from the @theagenthub/opencode npm package.
// Needs the agenthub CLI: curl -fsSL https://get.theagenthub.app | sh
import { spawn } from "node:child_process";

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COMMAND =
  process.env.AGENTHUB_BIN ||
  [join(homedir(), ".local", "bin", "agenthub"), join(process.env.LOCALAPPDATA || homedir(), "Programs", "agenthub", "agenthub.exe")].find((f) => existsSync(f)) ||
  "agenthub";
const TIMEOUT_MS = 5000;

function notify(event, sessionID, cwd) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(COMMAND, ["notify", "--format", "text", "--event", event], {
        cwd,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        shell: process.platform === "win32",
      });
    } catch {
      return resolve("");
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd }));
  });
}

/** Runs `agenthub wait`; resolves to the text to wake the session with, or "" when it shouldn't. */
function waitForMessage(sessionID, cwd, children) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(COMMAND, ["wait"], { cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: process.platform === "win32" });
    } catch {
      return resolve("");
    }
    children.get(sessionID)?.kill();
    children.set(sessionID, child);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(""));
    child.on("close", (code) => {
      if (children.get(sessionID) === child) children.delete(sessionID);
      // An agenthub too old to know `wait` exits 2 too, but prints nothing on stdout.
      resolve(code === 2 ? out.trim() : "");
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd }));
  });
}

function partId() {
  return "prt_" + Date.now().toString(16) + Math.random().toString(36).slice(2, 12);
}

export const AgentHub = async ({ directory, client }) => {
  const started = new Set();
  const waiting = new Map();
  let presence = Promise.resolve();
  const wake = async (sessionID) => {
    const send = client?.session?.promptAsync ?? client?.session?.prompt;
    if (!send) return;
    const text = await waitForMessage(sessionID, directory, waiting);
    if (!text) return;
    try {
      await send.call(client.session, { path: { id: sessionID }, body: { parts: [{ type: "text", text }] } });
    } catch {
      /* the session is gone, or busy again */
    }
  };
  return {
    "chat.message": async (input, output) => {
      waiting.get(input.sessionID)?.kill();
      const first = !started.has(input.sessionID);
      started.add(input.sessionID);
      const text = await notify(first ? "session-start" : "prompt", input.sessionID, directory);
      const messageID = input.messageID ?? output.message?.id;
      if (!text || !messageID) return;
      output.parts.push({ id: partId(), sessionID: input.sessionID, messageID, type: "text", text, synthetic: true });
    },
    "tool.execute.after": async (input, output) => {
      const text = await notify("post-tool", input.sessionID, directory);
      if (text && typeof output.output === "string") output.output += "\n\n<agenthub>\n" + text + "\n</agenthub>";
    },
    // Presence updates don't block OpenCode, but run one at a time so "offline" can't be
    // overtaken by an earlier "idle".
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        presence = presence.then(() => notify("stop", sessionID, directory));
        // Not awaited: it waits as long as the session is idle.
        presence.then(() => wake(sessionID)).catch(() => {});
      } else if (event.type === "session.deleted") {
        waiting.get(event.properties.info.id)?.kill();
        presence = presence.then(() => notify("session-end", event.properties.info.id, directory));
      }
    },
  };
};

// OpenCode 2 loads the default export's setup() and ignores the hooks above; OpenCode 1
// reads the named export (and default.server, the same function). setup() returns early
// when OpenCode 1 calls it too.
async function setup(ctx) {
  if (!ctx?.session?.hook || !ctx.tool?.hook || !ctx.event?.subscribe) return;
  const directory = ctx.location?.directory ?? process.cwd();
  const started = new Set();
  const waiting = new Map();
  let presence = Promise.resolve();
  const wake = async (sessionID) => {
    if (typeof ctx.session.synthetic !== "function") return;
    const text = await waitForMessage(sessionID, directory, waiting);
    if (!text) return;
    try {
      await ctx.session.synthetic({ sessionID, text, description: "Agent Hub: new message", delivery: "queue", resume: true });
    } catch {
      /* the session is gone, or busy again */
    }
  };
  const wrap = (text) => "\n\n<agenthub>\n" + text + "\n</agenthub>";

  // V2 has no hidden message parts, so the notice is appended to the prompt's text.
  await ctx.session.hook("prompt", async (event) => {
    waiting.get(event.sessionID)?.kill();
    const first = !started.has(event.sessionID);
    started.add(event.sessionID);
    const text = await notify(first ? "session-start" : "prompt", event.sessionID, directory);
    if (text && event.prompt && typeof event.prompt.text === "string") event.prompt.text += wrap(text);
  });
  // The model reads a tool's result.content.
  await ctx.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed" || !Array.isArray(event.result?.content)) return;
    const text = await notify("post-tool", event.sessionID, directory);
    if (text) event.result.content.push({ type: "text", text: wrap(text).trimStart() });
  });

  const controller = new AbortController();
  (async () => {
    const types = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.deleted"];
    for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) {
      const sessionID = event.data?.sessionID;
      if (!sessionID) continue;
      const kind = event.type === "session.deleted" ? "session-end" : "stop";
      if (kind === "session-end") {
        started.delete(sessionID);
        waiting.get(sessionID)?.kill();
      }
      presence = presence.then(() => notify(kind, sessionID, directory));
      // A finished run (not one the user interrupted) waits for a hub message; not awaited.
      if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") {
        presence.then(() => wake(sessionID)).catch(() => {});
      }
    }
  })().catch(() => {});
  return () => {
    controller.abort();
    for (const child of waiting.values()) child.kill();
  };
}

export default { id: "agenthub", server: AgentHub, setup };
