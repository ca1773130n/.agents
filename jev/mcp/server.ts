#!/usr/bin/env node
/**
 * MCP server (stdio, no dependencies) porting the tool-side pi extensions of
 * github.com/disler/ten-levels-of-jev to Claude Code and Codex:
 *
 *   L7  should_i_compact                               the compaction verdict on demand
 *   L8  ask_jev_file_bool / _choice / _score           a judgment about one file, never the file
 *   L9  ask_jev_files, pick_first_file                 many files, one call each, in parallel
 *   L10 ask_jev                                        own state + paths + a gated command
 *
 * Not ported: compact_now — neither harness lets a tool trigger compaction; the L7 message asks
 * the agent to suggest /compact instead. Every call is recorded in ~/.agents/jev/logs.
 */
import { exec } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BLOCK_NOTICE, gateBashCommand } from "../vendor/src/levels/level06/index.ts";
import { askFileBool, askFileChoice, askFileScore, FileStateError } from "../vendor/src/levels/level08/index.ts";
import { askFiles, pickFirstFile } from "../vendor/src/levels/level09/index.ts";
import { ASK_JEV_DESCRIPTION, AskStateError, assembleState, parseQuestions, type CommandOutput } from "../vendor/src/levels/level10/index.ts";
import { decide, decider, hasKey, JEV_HOME, recordError, type SessionState } from "../lib/jev.ts";
import { evaluateCompact } from "../lib/compact.ts";

const NUDGE =
  "You have ask_jev and the ask_jev_file tools (TypeSafe's Jev). When you need a classification, a risk score, or a yes or no " +
  "with a confidence, prefer them over reasoning it out yourself. Give them paths or a command instead of pasting content. " +
  "They answer in about 300 ms and cost almost nothing.";
const WHEN =
  "Use this for a judgment about what a file does or contains, without reading it into your context. " +
  "Write the question against `content`, which is the file's text. Use the read tool instead when you need the code itself, to edit or quote it. " +
  "Exact lookups, does this string appear, how many lines, belong to grep, not here.";
const QUESTION_SCHEMA =
  'questions_json is a JSON object keyed by question id. Three types. ' +
  'noul: {"type":"noul","instructions":"Does `content` ...?","criteria":{"true":"...","false":"..."}} returns a probability of yes. ' +
  'choice: {"type":"choice","instructions":"Which ... is `content`?","criteria":{"option_a":"when it applies","option_b":"...","other":"none of the above"}} returns one of your keys plus confidence, up to 255 options. ' +
  'score: {"type":"score","instructions":"How ... is `content`?","criteria":["lowest situation","...","highest situation"]} returns a position on your levels, two to ten of them. ' +
  "Write every question against `content`, the file's text; `path` is also in the state. Ask every question you might need in one block, it is one call per file either way.";
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS = [
  { name: "ask_jev_file_bool", description: `Yes or no about one file. Returns { path, answer, noul } where noul is the probability of yes, 0 to 1. ${WHEN}`,
    inputSchema: obj({ path: str("File path, relative to the working directory or absolute"),
      question: str("A yes or no question about `content`, for example: Does `content` validate authentication tokens?"),
      yes: str("What counts as yes"), no: str("What counts as no") }, ["path", "question"]) },
  { name: "ask_jev_file_choice", description: `Pick one option about one file. Returns { path, choice, confidence, probabilities }. The choice is always one of your options; an "other" option is added if you leave none. ${WHEN}`,
    inputSchema: obj({ path: str("File path, relative to the working directory or absolute"), question: str("The question, for example: Which layer is `content`?"),
      options: { type: "object", additionalProperties: { type: "string" }, description: "Option name to a one line description of when it applies. Up to 255." } }, ["path", "question", "options"]) },
  { name: "ask_jev_file_score", description: `A position on a scale you define, about one file. Returns { path, score, top, nearest, confidence, legend }. Levels are ordered low to high, two to ten of them, each a described situation. ${WHEN}`,
    inputSchema: obj({ path: str("File path, relative to the working directory or absolute"), question: str("The question, for example: How risky is a refactor of `content`?"),
      levels: { type: "array", items: { type: "string" }, description: "Ordered low to high, each level a situation" } }, ["path", "question", "levels"]) },
  { name: "ask_jev_files", description:
      "Ask the same typed questions of many files at once without reading any of them. Code expands globs and directories, drops node_modules, .git, binaries, and files over the budget, caps the list at 255, then makes one Jev call per file in parallel. " +
      "Returns { results: [{ path, answers }], skipped: [{ path, reason }], calls }. " + QUESTION_SCHEMA + " Use read when you need a file's code; use grep for exact strings.",
    inputSchema: obj({ paths_or_globs: { type: "array", items: { type: "string" }, description: 'Files, directories, or globs, for example ["src/**/*.ts"] or ["src/http"]' },
      questions_json: str("The question block as a JSON string"), recursive: { type: "boolean", description: "For directories: include every file below them. Default false." } }, ["paths_or_globs", "questions_json"]) },
  { name: "pick_first_file", description:
      "After ask_jev_files, choose which of a list of files to open first for a goal. One Choice keyed by path, so the pick is always a real file. Returns { path | null, confidence, probabilities }. Pass a short note per path if you have one.",
    inputSchema: obj({ question: str("The goal, for example: Which file should I open first to fix the proration bug?"),
      candidates: { type: "array", items: obj({ path: { type: "string" }, note: { type: "string" } }, ["path"]), description: "Paths, with an optional one line note each" } }, ["question", "candidates"]) },
  { name: "ask_jev", description: ASK_JEV_DESCRIPTION,
    inputSchema: obj({ questions_json: str("The question block, a JSON object keyed by question id"),
      state: str("Your own state: plain text, or a JSON object as a string. Short. Not for pasting files or output."),
      paths: { type: "array", items: { type: "string" }, description: 'Files or globs for code to read into files["path"]. Up to 20 files.' },
      command: str("A command for code to run in the working directory; its result goes into output. Runs through the bash gate and must only read.") }, ["questions_json"]) },
  { name: "should_i_compact", description:
      "Ask whether now is a good moment to compact the conversation. Returns a tier (silent, notice, recommend, request), the reason, the context size, and the message to act on. Cheap; free when the context is small.",
    inputSchema: obj({}, []) },
];

function runCommand(command: string, cwd: string): Promise<CommandOutput> {
  return new Promise((done) => {
    exec(command, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_CHARS * 4, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? null : 0;
      done({ command, exit_code: code, stdout: String(stdout).slice(0, MAX_OUTPUT_CHARS), stderr: String(stderr).slice(0, MAX_OUTPUT_CHARS) });
    });
  });
}

/** The newest session state recorded by the hook for this working directory. */
function currentSession(cwd: string): SessionState | null {
  try {
    const dir = join(JEV_HOME, "state");
    let best: { s: SessionState; t: number } | null = null;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const s: SessionState = JSON.parse(readFileSync(p, "utf8"));
      const t = statSync(p).mtimeMs;
      if (s.cwd === cwd && (!best || t > best.t)) best = { s, t };
    }
    return best?.s ?? null;
  } catch { return null; }
}

async function call(name: string, a: any): Promise<unknown> {
  const cwd = process.cwd();
  if (!hasKey()) throw new Error("TYPESAFE_API_KEY is not set in this agent's environment; Jev tools are unavailable.");
  switch (name) {
    case "ask_jev_file_bool": return askFileBool(a.path, a.question, cwd, { yes: a.yes, no: a.no }, decider(name, { path: a.path }));
    case "ask_jev_file_choice": return askFileChoice(a.path, a.question, a.options, cwd, decider(name, { path: a.path }));
    case "ask_jev_file_score": return askFileScore(a.path, a.question, a.levels, cwd, decider(name, { path: a.path }));
    case "ask_jev_files": return askFiles(a.paths_or_globs, a.questions_json, cwd, { recursive: a.recursive ?? false, decide: decider(name) as any });
    case "pick_first_file": return pickFirstFile(a.question, a.candidates, decider(name) as any);
    case "ask_jev": {
      const questions = parseQuestions(a.questions_json);
      const run = async (command: string, dir: string) => {
        const gate = await gateBashCommand(command, dir, decider("ask_jev command gate"));
        if (gate.block) throw new AskStateError(`ask_jev: the command was refused by the bash gate: ${gate.reason}. ${BLOCK_NOTICE} ask_jev commands should only read.`);
        return runCommand(command, dir);
      };
      const { state, summary } = await assembleState({ state: a.state, paths: a.paths, command: a.command }, cwd, run);
      const r = await decide(name, state, questions, { summary });
      return { answers: r.answers, state_summary: summary, usage: r.usage, model: r.model };
    }
    case "should_i_compact": {
      const s = currentSession(cwd);
      if (!s) return { tier: "silent", reason: "no session state for this directory yet (the UserPromptSubmit hook records it)", message: null };
      return evaluateCompact(s, s.transcript, name);
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let req: any;
  try { req = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notifications (initialized, cancelled) need no reply
  try {
    if (method === "initialize") {
      return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} }, serverInfo: { name: "jev", version: "1.0.0" }, instructions: NUDGE } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try {
        const result = await call(params?.name, params?.arguments ?? {});
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      } catch (err: any) {
        recordError(`mcp ${params?.name}`, err);
        const text = err instanceof FileStateError || err instanceof AskStateError ? err.message : `${params?.name} error: ${err?.message ?? err}`;
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
      }
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (err: any) {
    recordError("mcp", err);
    return send({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } });
  }
});
