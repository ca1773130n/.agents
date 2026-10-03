/**
 * Shared plumbing for the ported "ten levels of Jev" extensions (hooks + MCP server).
 *
 * decide() is the one way anything here calls Jev: provider forced to TypeSafe (never the
 * offline mock, whose word-overlap answers must not gate real commands), a timeout, and one
 * ledger line per call so spend stays visible. The ledger holds usage and timing, never the
 * state (it can carry file contents or commands).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JevClient } from "../vendor/src/core/client.ts";
import { validateQuestions, type Questions, type State } from "../vendor/src/core/types.ts";

export const JEV_HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000; // Jev 1.13 list price; output tokens are free
const TIMEOUT_MS = 8000;

export const hasKey = (): boolean => Boolean(process.env.TYPESAFE_API_KEY?.trim());

export interface Config {
  /** Per-feature switches, so one can be turned off without uninstalling. */
  enabled: { bash_gate: boolean; write_gate: boolean; result_screen: boolean; compact: boolean };
  /** Writes outside the repo root AND outside these roots are blocked in code (upstream: repo only). */
  allowed_write_roots: string[];
  /** Context tokens. Upstream's 6k/10k/14k were tuned for pi's tiny sandbox. */
  compact_lines: { notice: number; recommend: number; request: number };
  /** Upstream 0.7. A live-looking key in a .py scored 0.69 (2026-10-03); lower to catch borderline cases. */
  write_secret_threshold: number;
}
const DEFAULTS: Config = {
  enabled: { bash_gate: true, write_gate: true, result_screen: true, compact: true },
  allowed_write_roots: ["~/.blackhole", "~/.agents", "~/.claude-personal1", "~/.claude-personal2",
    "~/.codex-personal2", "~/.claude", "/tmp", "/private/tmp", "/private/var/folders", "$TMPDIR"],
  compact_lines: { notice: 100_000, recommend: 140_000, request: 170_000 },
  write_secret_threshold: 0.7,
};

export function config(): Config {
  let user: Partial<Config> = {};
  try { user = JSON.parse(readFileSync(join(JEV_HOME, "config.json"), "utf8")); } catch { /* defaults */ }
  return {
    enabled: { ...DEFAULTS.enabled, ...(user.enabled ?? {}) },
    allowed_write_roots: user.allowed_write_roots ?? DEFAULTS.allowed_write_roots,
    compact_lines: { ...DEFAULTS.compact_lines, ...(user.compact_lines ?? {}) },
    write_secret_threshold: user.write_secret_threshold ?? DEFAULTS.write_secret_threshold,
  };
}

export function expandRoot(root: string): string {
  const tmp = process.env.TMPDIR ?? "/tmp";
  return resolve(root.replace(/^\$TMPDIR/, tmp).replace(/^~(?=\/|$)/, homedir()));
}

let client: JevClient | undefined;
const jev = () => (client ??= new JevClient({ provider: "typesafe" }));

export function ledger(entry: Record<string, unknown>): void {
  try {
    const dir = join(JEV_HOME, "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* the ledger must never break a hook */ }
}

export interface Decision {
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  ms: number;
}

export async function decide(source: string, state: State, questions: Questions, meta: Record<string, unknown> = {}): Promise<Decision> {
  validateQuestions(questions);
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Jev timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS); });
  try {
    const result: any = await Promise.race([jev().systemOne(state, questions), timeout]);
    const ms = Math.round(performance.now() - started);
    const input = Number(result.usage?.input_tokens ?? 0);
    ledger({ source, model: result.model, input_tokens: input, output_tokens: Number(result.usage?.output_tokens ?? 0),
      usd: +(input * USD_PER_INPUT_TOKEN).toFixed(7), ms, ...meta });
    return { answers: result.answers, usage: result.usage, model: result.model, ms };
  } finally {
    clearTimeout(timer);
  }
}

/** The decide shape the vendored level code accepts. */
export const decider = (source: string, meta: Record<string, unknown> = {}) =>
  (state: State, questions: Questions) => decide(source, state, questions, meta);

/** Errors are recorded by TYPE and a clipped message; never request headers (they hold the key). */
export function recordError(source: string, err: unknown): void {
  const e = err as { name?: string; message?: string };
  ledger({ source, error: e?.name ?? "Error", message: String(e?.message ?? err).replace(/apikey_[A-Za-z0-9_]+/g, "apikey_[redacted]").slice(0, 200) });
}

// Per-session state for the compaction check: prompts so far and the last assistant turn.
export interface SessionState { cwd: string; prompts: string[]; last_assistant: string; updated: string; transcript?: string }
const statePath = (sessionId: string) => join(JEV_HOME, "state", `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
export function loadSession(sessionId: string, cwd: string): SessionState {
  try { return JSON.parse(readFileSync(statePath(sessionId), "utf8")); } catch { return { cwd, prompts: [], last_assistant: "", updated: "" }; }
}
export function saveSession(sessionId: string, s: SessionState): void {
  try {
    mkdirSync(join(JEV_HOME, "state"), { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify({ ...s, updated: new Date().toISOString() }));
  } catch { /* best effort */ }
}
export { existsSync };
