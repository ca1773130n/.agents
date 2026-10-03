/**
 * Level 7 ("should I compact"), ported. Neither Claude Code nor Codex lets a hook or tool trigger
 * compaction or add compaction instructions (verified in both harnesses' hook docs, 2026-10-03),
 * so the tier message asks the agent to suggest `/compact` to the user, and the upstream
 * cut-point pick is folded into that message instead of the compaction prompt.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { COMPACT_QUESTIONS, decideTier, type CompactAnswers, type CompactDecision, type CompactState, type Usage } from "../vendor/src/levels/level07/should-compact.ts";
import { cutPointInstructions, cutPointQuestion, type TurnSummary } from "../vendor/src/levels/level07/pick-cut-point.ts";
import { config, decide, type SessionState } from "./jev.ts";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function tail(path: string, bytes = 1_500_000): string[] {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines; // drop the cut-off first line
  } finally {
    closeSync(fd);
  }
}

/** Tokens currently in context, read from the harness transcript. Unknown -> 0, which reads as silent. */
export function contextUsage(transcriptPath: string | null | undefined): Usage & { window: number } {
  if (!transcriptPath) return { tokens: 0, pct: 0, window: 0 };
  try {
    const lines = tail(transcriptPath);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes("usage") && !lines[i].includes("token_count")) continue;
      let o: any;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      // Codex: {"type":"event_msg","payload":{"type":"token_count","info":{last_token_usage, model_context_window}}}
      const info = o?.payload?.type === "token_count" ? o.payload.info : null;
      if (info?.last_token_usage) {
        const tokens = Number(info.last_token_usage.input_tokens ?? 0);
        const window = Number(info.model_context_window ?? 0);
        return { tokens, window, pct: window ? (tokens / window) * 100 : 0 };
      }
      // Claude Code: assistant entries carry message.usage; context = all input-side tokens.
      const u = o?.message?.usage;
      if (o?.type === "assistant" && u) {
        const tokens = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
        const window = /\[1m\]/i.test(String(o?.message?.model ?? "")) ? 1_000_000 : 200_000;
        return { tokens, window, pct: (tokens / window) * 100 };
      }
    }
  } catch { /* unreadable transcript -> unknown */ }
  return { tokens: 0, pct: 0, window: 0 };
}

function message(d: CompactDecision, usage: Usage, keep: string | null): string | null {
  const at = `${Math.round(usage.tokens / 1000)}k tokens${usage.pct ? `, ${usage.pct.toFixed(1)}% of the window` : ""}`;
  const how = `suggest the user run /compact${keep ? ` with this instruction: "${keep}"` : ""}`;
  switch (d.tier) {
    case "notice": return `[jev-compact] Context is at ${at}. ${d.reason} Compacting is optional; at a natural pause, ${how}.`;
    case "recommend": return `[jev-compact] Recommended: compact now. Context is at ${at}. ${d.reason} Finish the current step, then ${how}.`;
    case "request": return `[jev-compact] Please compact before continuing. Context is at ${at}. ${d.reason} ${how[0].toUpperCase()}${how.slice(1)} before starting new work.`;
    default: return null;
  }
}

export interface CompactVerdictOut { tier: string; reason: string; tokens: number; pct: number; message: string | null; jev_calls: number }

/** One evaluation. Free (no Jev call) whenever the answer could only be silent. */
export async function evaluateCompact(s: SessionState, transcriptPath: string | null | undefined, source: string): Promise<CompactVerdictOut> {
  const lines = config().compact_lines;
  const usage = contextUsage(transcriptPath);
  const silent = (reason: string): CompactVerdictOut => ({ tier: "silent", reason, tokens: usage.tokens, pct: usage.pct, message: null, jev_calls: 0 });
  if (s.prompts.length < 2) return silent("first request, nothing to move on from");
  if (usage.tokens < lines.notice) return silent(`below the notice line (${lines.notice} tokens)`);

  const state: CompactState = {
    current_request: clip(s.prompts.at(-1) ?? "", 600),
    previous_work: s.prompts.slice(0, -1).map((p) => clip(p, 200)).join("\n") || "(nothing before this request)",
    recent_turn: clip(s.last_assistant || "(no assistant text recorded)", 600),
    tools_this_turn: [],
  } as CompactState;
  const { answers } = await decide(source, state, COMPACT_QUESTIONS as any, { tokens: usage.tokens });
  const decision = decideTier(answers as unknown as CompactAnswers, usage, true, lines, state);
  let keep: string | null = null;
  let calls = 1;
  if (decision.tier === "recommend" || decision.tier === "request") {
    const turns: TurnSummary[] = s.prompts.map((p, i) => ({ index: i, request: clip(p, 120) }));
    const cut = await decide(`${source} cut point`, { turns } as any, cutPointQuestion(turns) as any);
    keep = cutPointInstructions(turns, cut.answers.live_from).instructions;
    calls = 2;
  }
  return { tier: decision.tier, reason: decision.reason, tokens: usage.tokens, pct: usage.pct, message: message(decision, usage, keep), jev_calls: calls };
}
