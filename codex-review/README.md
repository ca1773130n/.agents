# codex-review — background security review on Codex

Replaces the LLM review of `security-guidance@claude-plugins-official`, which ran as Claude Agent SDK
sessions and spent Claude quota. The plugin is disabled in `~/.claude-personal1` and
`~/.claude-personal2`; these hooks do the same job on `~/.codex-personal2`.

- **Triggers** (both Claude homes' `settings.json`): `Stop` / `SubagentStop` when the working tree has
  code changes, and `PostToolUse` after `git commit` / `git push` (incl. `git -C … commit/push`).
- **Contract**: `asyncRewake` — runs in the background; exit 2 with findings on stderr wakes Claude,
  anything else is silent. Its own failures never wake Claude; they go to `logs/`.
- **Review**: the plugin's two passes (investigate, then adversarial refute) with its own prompts and
  schemas, rendered into `prompts.json` from its `review_api.py` (Apache-2.0, see
  `LICENSE.security-guidance`). Model call: `codex exec --sandbox read-only --ephemeral` with
  `CODEX_HOME=~/.codex-personal2`, using that home's default model.
- **Cost guards**: each diff/commit is reviewed once (`state/`), one review per repo at a time,
  docs-only changes skipped, Jev hooks disabled inside the review.

Optional `config.json`: `{ "codex_home": "~/.codex-personal2", "model": "gpt-5.6-luna" }`.
