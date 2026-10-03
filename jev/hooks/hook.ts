#!/usr/bin/env node
/**
 * One hook entry point for Claude Code and Codex (both use the same hooks.json event/output
 * shapes). Ports of the pi extensions from github.com/disler/ten-levels-of-jev:
 *
 *   PreToolUse   Bash                       -> L6 bash gate (vendored, unchanged)
 *                Write|Edit|MultiEdit|NotebookEdit (Claude), apply_patch (Codex)
 *                                           -> L6 write gate: path rule in code, credential check by Jev
 *   PostToolUse  Read|Bash                  -> L6 result screen: banner via additionalContext
 *   UserPromptSubmit                        -> L7 should-I-compact tier message via additionalContext
 *   Stop / PostCompact                      -> bookkeeping for L7 (no output, no Jev call)
 *
 * FAIL OPEN: any error, timeout, or missing TYPESAFE_API_KEY lets the tool call proceed. With no
 * key (e.g. launchd workers that run codex) the hook exits before doing anything.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { BLOCK_NOTICE, gateBashCommand, gateWrite, screenToolResult, WRITE_QUESTIONS, type WriteGateAnswers } from "../vendor/src/levels/level06/index.ts";
import { config, decide, decider, expandRoot, hasKey, loadSession, recordError, saveSession } from "../lib/jev.ts";
import { evaluateCompact } from "../lib/compact.ts";
import { patchFiles } from "../lib/patch.ts";

type Input = Record<string, any>;
const out = (o: unknown) => process.stdout.write(JSON.stringify(o));
const deny = (reason: string) => out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const context = (event: string, text: string) => out({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

function repoRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

/** Upstream blocks anything outside the repo. Here: the repo root or a configured root. */
function writeAllowed(path: string, cwd: string, extraRoots: string[]): boolean {
  const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const roots = [repoRoot(cwd), ...config().allowed_write_roots.map(expandRoot), ...extraRoots.filter(Boolean).map((r) => resolve(r))];
  return roots.some((root) => {
    const rel = relative(root, target);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

function writesOf(input: Input): { path: string; content: string }[] {
  const t = input.tool_input ?? {};
  if (input.tool_name === "apply_patch") return patchFiles(String(t.command ?? t.patch ?? ""));
  const path = String(t.file_path ?? t.notebook_path ?? t.path ?? "");
  const content = t.content ?? t.new_string ?? t.new_source
    ?? (Array.isArray(t.edits) ? t.edits.map((e: any) => e?.new_string ?? "").join("\n") : "");
  return path ? [{ path, content: String(content ?? "") }] : [];
}

function textOf(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) value.forEach((v) => textOf(v, acc));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => textOf(v, acc));
  return acc;
}

async function preToolUse(input: Input, harness: string) {
  const cfg = config().enabled;
  const cwd = String(input.cwd ?? process.cwd());
  if (input.tool_name === "Bash" && cfg.bash_gate) {
    const raw = input.tool_input?.command;
    const command = Array.isArray(raw) ? raw.join(" ") : String(raw ?? "");
    if (!command.trim()) return;
    const d = await gateBashCommand(command, cwd, decider("PreToolUse Bash", { harness }));
    if (d.block) deny(`jev-guard blocked this command: ${d.reason}. ${BLOCK_NOTICE}`);
    return;
  }
  if (/^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/.test(String(input.tool_name)) && cfg.write_gate) {
    for (const w of writesOf(input)) {
      if (!writeAllowed(w.path, cwd, [input.scratchpad_dir])) {
        return deny(`jev-guard blocked this write: outside the repo and the allowed roots (${w.path}). Allowed roots are in ~/.agents/jev/config.json. ${BLOCK_NOTICE}`);
      }
      if (!w.content.trim()) continue;
      const state = { path: w.path, content: w.content.length > 4000 ? w.content.slice(0, 4000) + "\n…" : w.content };
      const { answers } = await decide(`PreToolUse ${input.tool_name}`, state, WRITE_QUESTIONS as any, { harness });
      const d = gateWrite(answers as unknown as WriteGateAnswers, config().write_secret_threshold);
      if (d.block) return deny(`jev-guard blocked this ${input.tool_name}: ${d.reason}. ${BLOCK_NOTICE}`);
    }
  }
}

async function postToolUse(input: Input, harness: string) {
  if (!config().enabled.result_screen || !/^(Read|Bash)$/.test(String(input.tool_name))) return;
  const text = textOf(input.tool_response).join("\n");
  if (!text.trim()) return;
  const d = await screenToolResult(String(input.tool_name), text, decider(`PostToolUse ${input.tool_name}`, { harness }));
  if (d.flag && d.banner) context("PostToolUse", d.banner);
}

function lastAssistantFromTranscript(path: string | undefined): string {
  if (!path) return "";
  try {
    const lines = readFileSync(path, "utf8").split("\n").slice(-400);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (o?.type === "assistant") {
          const t = textOf(o.message?.content?.filter?.((c: any) => c?.type === "text")).join("\n").trim();
          if (t) return t;
        }
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return "";
}

async function main() {
  const raw = readFileSync(0, "utf8");
  if (!hasKey()) return; // no key: nothing to do, nothing to spend
  const input: Input = JSON.parse(raw);
  const harness = input.turn_id !== undefined ? "codex" : "claude";
  const event = String(input.hook_event_name ?? "");
  const session = String(input.session_id ?? "unknown");
  const cwd = String(input.cwd ?? process.cwd());
  try {
    if (event === "PreToolUse") return await preToolUse(input, harness);
    if (event === "PostToolUse") return await postToolUse(input, harness);
    if (event === "UserPromptSubmit") {
      if (!config().enabled.compact) return;
      const s = loadSession(session, cwd);
      s.prompts.push(String(input.prompt ?? "").slice(0, 2000));
      s.prompts = s.prompts.slice(-40);
      if (input.transcript_path) s.transcript = String(input.transcript_path);
      saveSession(session, s);
      const v = await evaluateCompact(s, input.transcript_path, "UserPromptSubmit compact");
      if (v.message) context("UserPromptSubmit", v.message);
      return;
    }
    if (event === "Stop") {
      const s = loadSession(session, cwd);
      s.last_assistant = String(input.last_assistant_message ?? lastAssistantFromTranscript(input.transcript_path)).slice(0, 2000);
      saveSession(session, s);
      return;
    }
    if (event === "PostCompact") {
      const s = loadSession(session, cwd);
      s.prompts = s.prompts.slice(-1); // earlier requests now live only in the summary
      saveSession(session, s);
    }
  } catch (err) {
    recordError(`${event} ${input.tool_name ?? ""}`.trim(), err); // fail open
  }
}

main().catch((err) => recordError("hook", err)).finally(() => process.exit(0));
