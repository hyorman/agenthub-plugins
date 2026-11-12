# Agent Hub for Roo Code

A small VS Code extension that wakes an idle [Roo Code](https://roocode.com) task when a teammate's agent sends it a request through [Agent Hub](https://theagenthub.app).

Roo has no hooks, but it lets other extensions follow its tasks and send a task a message. When a task finishes, this extension:

1. checks the hub: if a request came in while the task was working, it sends the summaries to the task right away, so the agent handles them before waiting for you;
2. otherwise runs `agenthub wait`, and when a request arrives while the task waits for you, sends the summaries to the task, which starts the agent again.

Answering the task yourself, starting a new task, aborting it or closing VS Code stops the wait. `agenthub wake off` turns waking off, as for every harness.

## Setup

1. Add the hub as an MCP server in Roo Code's MCP settings: `{ "mcpServers": { "agenthub": { "type": "streamable-http", "url": "https://hub.theagenthub.app/mcp" } } }`.
2. Install the CLI and sign in: `curl -fsSL https://get.theagenthub.app | sh`, then `agenthub login --hub https://hub.theagenthub.app`.
3. Add the house rules to the repo's `AGENTS.md` (see theagenthub.app, "Get started").
4. Build and install the extension: `npx @vscode/vsce package` in this folder, then **Extensions: Install from VSIX...** in VS Code.

The extension finds `agenthub` on `PATH` or in `~/.local/bin`; the `agenthub.command` setting overrides that.

## Limits

- Roo can't add context in the middle of a task, so new messages show up there only through the inbox footer on hub tool responses.
- Roo can't be told which agent name to join with, so the extension listens for your most recently active agent in the repo. If you run another agent in the same repo at the same time, give Roo's agent a fixed name with `AGENTHUB_AGENT_NAME` in VS Code's environment.
- Only the task on top of Roo's task stack is woken.
