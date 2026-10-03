/** Offline checks: no Jev call is made by anything in this file (no network, no spend). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOME = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(HOME, "hooks/hook.ts");
const SERVER = join(HOME, "mcp/server.ts");

function hook(input: object, env: Record<string, string | undefined>) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout.trim() };
}

test("apply_patch sections become one write per file, new content only", async () => {
  const { patchFiles } = await import(join(HOME, "lib/patch.ts"));
  const patch = "*** Begin Patch\n*** Add File: a.ts\n+line one\n+line two\n*** Update File: b.ts\n@@\n-old\n+new\n*** Delete File: c.ts\n*** End Patch";
  assert.deepEqual(patchFiles(patch), [{ path: "a.ts", content: "line one\nline two" }, { path: "b.ts", content: "new" }]);
});

test("no key: the hook does nothing, even for a destructive command", () => {
  const r = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/tmp" }, { TYPESAFE_API_KEY: "" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("a write outside the repo and every allowed root is denied in code, before any Jev call", () => {
  const r = hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/etc/jev-test-file", content: "x" }, cwd: HOME },
    { TYPESAFE_API_KEY: "apikey_offline_test_never_sent" });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /outside the repo and the allowed roots/);
});

test("an empty-content write inside an allowed root needs no Jev call and passes", () => {
  const r = hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/tmp/jev-empty", content: "" }, cwd: "/tmp" },
    { TYPESAFE_API_KEY: "apikey_offline_test_never_sent" });
  assert.equal(r.stdout, "");
});

function mcp(messages: object[], env: Record<string, string | undefined>): Promise<any[]> {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env } });
    const replies: any[] = [];
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      if (replies.length === messages.filter((m: any) => m.id !== undefined).length) { p.kill(); done(replies); }
    });
    p.on("error", fail);
    for (const m of messages) p.stdin.write(JSON.stringify(m) + "\n");
  });
}

test("MCP: handshake, seven tools, and a clear error without a key", async () => {
  const [init, list, call] = await mcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_jev_file_bool", arguments: { path: "x", question: "Is `content` code?" } } },
  ], { TYPESAFE_API_KEY: "" });
  assert.equal(init.result.serverInfo.name, "jev");
  assert.match(init.result.instructions, /prefer them over reasoning/);
  assert.deepEqual(list.result.tools.map((t: any) => t.name).sort(),
    ["ask_jev", "ask_jev_file_bool", "ask_jev_file_choice", "ask_jev_file_score", "ask_jev_files", "pick_first_file", "should_i_compact"]);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /TYPESAFE_API_KEY is not set/);
});
