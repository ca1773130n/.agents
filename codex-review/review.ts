#!/usr/bin/env node
/**
 * Background security review on Codex (~/.codex-personal2) instead of Claude.
 *
 * Replaces the LLM review of security-guidance@claude-plugins-official, which ran
 * its reviews as Claude Agent SDK sessions and spent Claude quota (disabled 2026-10-03).
 * Same triggers (Stop / SubagentStop after changes; PostToolUse after `git commit` / `git push`),
 * same asyncRewake contract (exit 2 + findings on stderr wakes Claude; anything else is silent),
 * same two passes (investigate, then adversarial refute) with the plugin's own prompts and
 * schemas (prompts.json, rendered from its Apache-2.0 review_api.py). Only the model call changed:
 * `codex exec --sandbox read-only --ephemeral` under CODEX_HOME=~/.codex-personal2.
 *
 * Never wakes Claude for its own failures: errors exit 0 and go to logs/.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = dirname(fileURLToPath(import.meta.url));
const P = JSON.parse(readFileSync(join(HOME, "prompts.json"), "utf8"));
const CFG = (() => { try { return JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")); } catch { return {}; } })();
const CODEX_HOME = (CFG.codex_home ?? "~/.codex-personal2").replace(/^~/, homedir());
const MODEL: string | undefined = CFG.model; // unset = the codex home's own default
const MAX_DIFF_CHARS = 60_000;
const CODEX_TIMEOUT_MS = 15 * 60_000;
const CODE_EXT = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift", ".scala", ".sh", ".bash", ".zsh", ".sql", ".tf", ".yaml", ".yml", ".toml",
  ".json", ".html", ".plist", ".dockerfile", ".gradle", ".ps1"]);

const log = (o: Record<string, unknown>) => {
  try {
    mkdirSync(join(HOME, "logs"), { recursive: true });
    appendFileSync(join(HOME, "logs", `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
  } catch { /* never break the hook */ }
};
const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const isCode = (p: string) => CODE_EXT.has(extname(p).toLowerCase()) || /(^|\/)(Dockerfile|Makefile|justfile)$/.test(p);

interface Change { key: string; files: string[]; diffs: [string, string][] }

function splitDiff(diff: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of diff.split(/^diff --git /m).slice(1)) {
    const m = part.match(/^a\/(\S+) b\/(\S+)/);
    if (m) out.push([m[2], "diff --git " + part]);
  }
  return out;
}

function workingChange(repo: string): Change | null {
  const tracked = git(repo, ["diff", "HEAD", "--no-color", "--no-ext-diff"]);
  const untracked = git(repo, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).filter(isCode).slice(0, 30);
  const diffs = splitDiff(tracked);
  for (const f of untracked) {
    try {
      const body = readFileSync(join(repo, f), "utf8").slice(0, 20_000);
      diffs.push([f, `new file ${f}\n` + body.split("\n").map((l) => "+" + l).join("\n")]);
    } catch { /* unreadable or binary */ }
  }
  const code = diffs.filter(([f]) => isCode(f));
  if (!code.length) return null;
  const key = "wt:" + createHash("sha256").update(code.map(([, d]) => d).join("\n")).digest("hex").slice(0, 24);
  return { key, files: code.map(([f]) => f), diffs: code };
}

function commitChange(repo: string): Change | null {
  const sha = git(repo, ["rev-parse", "HEAD"]).trim();
  const diff = git(repo, ["show", "--format=", "--no-color", "--no-ext-diff", sha]);
  const code = splitDiff(diff).filter(([f]) => isCode(f));
  return code.length ? { key: "commit:" + sha, files: code.map(([f]) => f), diffs: code } : null;
}

function capDiffs(diffs: [string, string][]): string {
  let used = 0;
  const parts: string[] = [];
  for (const [f, d] of diffs) {
    const room = MAX_DIFF_CHARS - used;
    if (room <= 200) { parts.push(`=== DIFF: ${f} === (omitted: diff budget reached)`); continue; }
    const body = d.length > room ? d.slice(0, room) + "\n… (truncated)" : d;
    parts.push(`=== DIFF: ${f} ===\n${body}`);
    used += body.length;
  }
  return parts.join("\n\n");
}

function codex(repo: string, prompt: string, schema: object): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "codex-review-"));
  const schemaPath = join(dir, "schema.json");
  const outPath = join(dir, "out.json");
  writeFileSync(schemaPath, JSON.stringify(strict(schema)));
  const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "-C", repo,
    "--output-schema", schemaPath, "-o", outPath, ...(MODEL ? ["-m", MODEL] : []), "-"];
  const env = { ...process.env, CODEX_HOME };
  delete env.TYPESAFE_API_KEY; // no Jev hooks spending inside the review
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { env, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("codex review timed out")); }, CODEX_TIMEOUT_MS);
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`codex exited ${code}: ${err.trim().split("\n").at(-1) ?? ""}`);
        resolve(JSON.parse(readFileSync(outPath, "utf8")));
      } catch (e) { reject(e); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    child.stdin.end(prompt);
  });
}

/** Codex structured output is strict: every object closed, every property required. Optional -> nullable. */
function strict(schema: any): any {
  if (Array.isArray(schema)) return schema.map(strict);
  if (!schema || typeof schema !== "object") return schema;
  const out: any = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, strict(v)]));
  if (out.type === "object" && out.properties) {
    const req = new Set<string>(out.required ?? []);
    for (const [k, v] of Object.entries<any>(out.properties)) {
      if (!req.has(k)) out.properties[k] = { ...v, type: [].concat(v.type ?? "string", "null") };
    }
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

const SEVERITY = ["critical", "high", "medium"]; // the plugin's validated default keeps mediums

function format(findings: any[]): string {
  const byFile = new Map<string, any[]>();
  for (const v of findings) byFile.set(v.filePath ?? "unknown", [...(byFile.get(v.filePath ?? "unknown") ?? []), v]);
  const lines = ["Security Review (Codex): Potential vulnerabilities detected", "", `Affected files: ${[...byFile.keys()].join(", ")}`,
    "The following issues were flagged by automated security review. Address each, or briefly note why it doesn't apply. " +
    "Valid reasons to proceed without changes: the user explicitly asked for this and you've already surfaced the security " +
    "tradeoffs, or the pattern isn't actually exploitable in this context. Do not dismiss findings solely because the " +
    "service is internal-only — internal services are common SSRF/IDOR targets:", ""];
  let n = 1;
  for (const [f, vs] of byFile) {
    lines.push(`  ${f}:`);
    for (const v of vs) {
      lines.push(`    ${n++}. [${String(v.severity ?? "medium").toUpperCase()}] [${v.category ?? "Unknown"}] ${v.vulnerableCode ?? "N/A"}`);
      lines.push(`       Suggested fix: ${v.fix ?? "N/A"}`, "");
    }
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const event = String(input.hook_event_name ?? "");
  const cwd = String(input.cwd ?? process.cwd());
  let repo: string;
  try { repo = git(cwd, ["rev-parse", "--show-toplevel"]).trim(); } catch { return 0; } // not a git repo
  const isCommitHook = event === "PostToolUse";
  const change = isCommitHook ? commitChange(repo) : workingChange(repo);
  if (!change) return 0;

  const id = createHash("sha256").update(repo).digest("hex").slice(0, 16);
  const stateDir = join(HOME, "state");
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, `${id}.json`);
  const lockPath = join(stateDir, `${id}.lock`);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { reviewed: [] as string[] };
  if (state.reviewed.includes(change.key)) return 0;
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8"));
    try { process.kill(pid, 0); return 0; } catch { /* stale lock */ }
  }
  writeFileSync(lockPath, String(process.pid));
  const started = Date.now();
  try {
    const diffText = capDiffs(change.diffs);
    const investigate = P.investigate_system + "\n\n" + P.investigate_user
      .replace("  - @@FILE_LIST@@", change.files.slice(0, 50).map((f) => `  - ${f}`).join("\n"))
      .replace("=== DIFF: @@FILE@@ ===\n@@DIFF_BODY@@", diffText);
    const found = (await codex(repo, investigate, P.findings_schema))?.findings ?? [];
    let candidates = found.filter((v: any) => SEVERITY.includes(String(v.severity ?? "medium").toLowerCase()));
    let survivors = candidates;
    if (candidates.length) {
      candidates = candidates.map((v: any, idx: number) => ({ idx, in_diff: true, ...v }));
      const refute = P.refute_system + "\n\n" + P.refute_user
        .replace(JSON.stringify([{ "@@CANDIDATES@@": 1 }], null, 2), JSON.stringify(candidates, null, 2))
        .replace("@@DIFF@@", diffText.slice(0, 8000));
      const verdict = await codex(repo, refute, P.survived_schema);
      const keep = new Set<number>(verdict?.survived ?? []);
      survivors = candidates.filter((c: any) => keep.has(c.idx));
    }
    state.reviewed = [...state.reviewed, change.key].slice(-200);
    writeFileSync(statePath, JSON.stringify(state));
    log({ repo, event, key: change.key, files: change.files.length, found: found.length, kept: candidates.length, survived: survivors.length, secs: Math.round((Date.now() - started) / 1000) });
    if (!survivors.length) return 0;
    process.stderr.write(format(survivors.map(({ idx, in_diff, ...v }: any) => v)) + "\n");
    return 2; // asyncRewake: wake Claude with the findings
  } catch (e: any) {
    log({ repo, event, key: change.key, error: String(e?.message ?? e).slice(0, 300) });
    return 0;
  } finally {
    rmSync(lockPath, { force: true });
  }
}

main().then((code) => process.exit(code), (e) => { log({ error: String(e?.message ?? e).slice(0, 300) }); process.exit(0); });
