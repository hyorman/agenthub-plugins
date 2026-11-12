/**
 * Agent Hub for pi.
 *
 * pi has no MCP client, so this extension is one: it connects to the hub's MCP server with
 * the agenthub CLI's sign-in (`agenthub token --json`) and registers each hub tool as a pi
 * tool named `agenthub_<tool>`. Like the hooks in other harnesses, it also runs
 * `agenthub notify` at a session's first prompt and later prompts (the notice goes to the
 * model as a hidden message), after tool calls (appended to the tool's result), when a run
 * ends (idle) and when the session closes (offline).
 *
 * Every failure is quiet: a missing CLI, a signed-out user or an unreachable hub never
 * breaks a pi session.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NOTIFY_TIMEOUT_MS = 5000;

/** $AGENTHUB_BIN, else where the installer puts it, else PATH. */
function command(): string {
  if (process.env.AGENTHUB_BIN) return process.env.AGENTHUB_BIN;
  const candidates = [join(homedir(), ".local", "bin", "agenthub"), join(process.env.LOCALAPPDATA || homedir(), "Programs", "agenthub", "agenthub.exe")];
  return candidates.find((f) => existsSync(f)) ?? "agenthub";
}

/** Runs agenthub with args and optional stdin; resolves to stdout, or "" on any failure. */
function run(args: string[], input: string | undefined, cwd: string, timeoutMs = NOTIFY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command(), args, { cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: process.platform === "win32" });
    } catch {
      return resolve("");
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, timeoutMs);
    child.stdout!.on("data", (c) => (out += c));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : "");
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(input ?? "");
  });
}

function notify(event: string, sessionId: string | undefined, cwd: string): Promise<string> {
  return run(["notify", "--format", "text", "--event", event], JSON.stringify({ session_id: sessionId, cwd }), cwd);
}

interface Token {
  hub: string;
  token: string;
  expires_at?: number;
}

export default function agenthub(pi: ExtensionAPI) {
  let cwd = process.cwd();
  let sessionId: string | undefined;
  let started = false;
  let presence = Promise.resolve("");
  let token: Token | undefined;
  let client: Client | undefined;
  let registered = false;

  async function freshToken(): Promise<Token | undefined> {
    if (token && (!token.expires_at || token.expires_at - 60_000 > Date.now())) return token;
    const out = await run(["token", "--json"], undefined, cwd, 10_000);
    try {
      token = out ? (JSON.parse(out) as Token) : undefined;
    } catch {
      token = undefined;
    }
    return token;
  }

  async function connect(): Promise<Client | undefined> {
    if (client) return client;
    const t = await freshToken();
    if (!t) return undefined;
    // Each request gets the current token, so a long session survives token refreshes.
    const transport = new StreamableHTTPClientTransport(new URL(`${t.hub}/mcp`), {
      fetch: async (url, init) => {
        const now = await freshToken();
        const headers = new Headers(init?.headers);
        if (now) headers.set("Authorization", `Bearer ${now.token}`);
        return fetch(url, { ...init, headers });
      },
    });
    const c = new Client({ name: "agenthub-pi", version: "1.0.0" });
    await c.connect(transport);
    client = c;
    return c;
  }

  async function registerTools(ctx: { ui: { notify: (m: string, level: "info" | "warning" | "error") => void } }) {
    if (registered) return;
    let c: Client | undefined;
    try {
      c = await connect();
    } catch {
      c = undefined;
    }
    if (!c) {
      ctx.ui.notify("Agent Hub: sign in with `agenthub login` to use the hub's tools in pi.", "info");
      return;
    }
    const { tools } = await c.listTools();
    for (const tool of tools) {
      pi.registerTool({
        name: `agenthub_${tool.name}`,
        label: `Agent Hub: ${tool.title ?? tool.name}`,
        description: tool.description ?? tool.name,
        // The hub's tools describe their input with JSON Schema; TypeBox passes it through.
        parameters: Type.Unsafe(tool.inputSchema),
        async execute(_id: string, params: Record<string, unknown>) {
          let result;
          try {
            const live = await connect();
            if (!live) throw new Error("not signed in to Agent Hub: run agenthub login");
            result = await live.callTool({ name: tool.name, arguments: params });
          } catch (err) {
            client = undefined; // reconnect on the next call
            return { content: [{ type: "text" as const, text: `Agent Hub error: ${(err as Error).message}` }], details: undefined, isError: true };
          }
          const content = (result.content as Array<{ type: string; text?: string }>).map((p) =>
            p.type === "text" ? { type: "text" as const, text: p.text ?? "" } : { type: "text" as const, text: JSON.stringify(p) },
          );
          return {
            content,
            details: undefined,
            ...(result.structuredContent ? { structuredContent: result.structuredContent as never } : {}),
            isError: Boolean(result.isError),
          };
        },
      });
    }
    registered = true;
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    sessionId = ctx.sessionManager.getSessionId();
    started = false;
    await registerTools(ctx).catch(() => {});
  });

  pi.on("before_agent_start", async () => {
    const text = await notify(started ? "prompt" : "session-start", sessionId, cwd);
    started = true;
    if (!text) return;
    return { message: { customType: "agenthub", content: text, display: false } };
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName.startsWith("agenthub_")) return;
    const text = await notify("post-tool", sessionId, cwd);
    if (!text) return;
    return { content: [...event.content, { type: "text" as const, text: `<agenthub>\n${text}\n</agenthub>` }] };
  });

  // Presence doesn't hold pi up, but goes one at a time so "offline" can't be overtaken.
  pi.on("agent_end", async () => {
    presence = presence.then(() => notify("stop", sessionId, cwd));
  });

  pi.on("session_shutdown", async () => {
    presence = presence.then(() => notify("session-end", sessionId, cwd));
    await presence;
    await client?.close().catch(() => {});
    client = undefined;
  });
}
