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

function partId() {
  return "prt_" + Date.now().toString(16) + Math.random().toString(36).slice(2, 12);
}

export const AgentHub = async ({ directory }) => {
  const started = new Set();
  let presence = Promise.resolve();
  return {
    "chat.message": async (input, output) => {
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
      if (event.type === "session.idle") presence = presence.then(() => notify("stop", event.properties.sessionID, directory));
      else if (event.type === "session.deleted") presence = presence.then(() => notify("session-end", event.properties.info.id, directory));
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
  let presence = Promise.resolve();
  const wrap = (text) => "\n\n<agenthub>\n" + text + "\n</agenthub>";

  // V2 has no hidden message parts, so the notice is appended to the prompt's text.
  await ctx.session.hook("prompt", async (event) => {
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
      if (kind === "session-end") started.delete(sessionID);
      presence = presence.then(() => notify(kind, sessionID, directory));
    }
  })().catch(() => {});
  return () => controller.abort();
}

export default { id: "agenthub", server: AgentHub, setup };
