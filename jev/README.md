# jev — ten-levels-of-jev extensions for Claude Code and Codex

Ports of the six pi extensions from <https://github.com/disler/ten-levels-of-jev> (vendored decision
code in `vendor/`, unchanged, MIT). Installed 2026-10-03 into `~/.claude-personal1`,
`~/.claude-personal2` and `~/.codex-personal2`. Uses `TYPESAFE_API_KEY` (exported in `~/.zshrc`).

| Upstream (pi) | Here | Where it runs |
|---|---|---|
| `jev-guard` L6 bash gate | `hooks/hook.ts` PreToolUse `Bash` | blocks irreversible/destructive commands |
| `jev-guard` L6 write gate | PreToolUse `Write\|Edit\|MultiEdit\|NotebookEdit` / Codex `apply_patch` | path rule in code + Jev credential check |
| `jev-guard` L6 result screen | PostToolUse `Read\|Bash` | banner via `additionalContext` when output instructs the agent |
| `jev-compact` L7 | UserPromptSubmit (+ Stop, PostCompact bookkeeping) | tier message suggesting `/compact` |
| `ask-jev-file` L8, `ask-jev-files` L9, `ask-jev` L10 | `mcp/server.ts` (MCP server `jev`) | `ask_jev_file_*`, `ask_jev_files`, `pick_first_file`, `ask_jev`, `should_i_compact` |
| `report` | `logs/YYYY-MM-DD.jsonl` | one line per Jev call: source, tokens, usd, ms (never the state) |

Deliberate differences from upstream:

- **Write gate paths**: upstream blocks every write outside the repo. Here a write is allowed inside
  the repo root, the session scratchpad, or `allowed_write_roots` (`config.json`, defaults include
  `~/.blackhole`, `/tmp`, the agent config dirs, `~/.agents`).
- **Compaction**: neither harness lets a hook/tool trigger compaction or edit its instructions, so
  `compact_now` is not ported; the tier message asks the agent to suggest `/compact`, with the
  upstream cut-point pick folded in. Context thresholds are 100k/140k/170k tokens (upstream 6k/10k/14k
  was tuned for pi's sandbox). No Jev call happens below the notice line.
- **Fail open**: errors, timeouts (8 s) or a missing key let the tool call proceed.

## Configure / disable

`config.json` (optional) overrides any of:

```json
{ "enabled": { "bash_gate": true, "write_gate": true, "result_screen": true, "compact": true },
  "write_secret_threshold": 0.7,
  "compact_lines": { "notice": 100000, "recommend": 140000, "request": 170000 },
  "allowed_write_roots": ["~/.blackhole", "/tmp"] }
```

Remove entirely: delete the `hooks/hook.ts` entries from each `settings.json` (backups:
`settings.json.bak-jev-20261003`), `~/.codex-personal2/hooks.json`, and `claude mcp remove jev --scope user` /
`codex mcp remove jev` per home.

## Spend

```bash
cat ~/.agents/jev/logs/*.jsonl | node -e 'let n=0,u=0;require("readline").createInterface({input:process.stdin}).on("line",l=>{const o=JSON.parse(l);if(o.usd){n++;u+=o.usd}}).on("close",()=>console.log(n,"calls, $"+u.toFixed(4)))'
```

## Tests

`node --test test/offline.test.ts` — offline only, no Jev calls.
