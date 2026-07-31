# OPERATIONS.md

How to operate on this machine and in these repositories.

[AGENTS.md](./AGENTS.md) governs *how work is done* — thinking, verifying, judging.
This file governs *what to run and what never to touch*. Both apply to every agent,
in every project, regardless of harness.

---

## Processes — hard rule

**Never kill, signal, or otherwise touch a process this session did not itself
launch.** No `kill`, no signals of any kind, regardless of how stale, orphaned, or
in-the-way the process looks.

- **Never use `pkill`, `killall`, or any pattern-based kill.** A pattern cannot
  distinguish a process the agent started from one the user started. Record the PID
  of anything the session launches and only ever signal those exact PIDs. "But I
  only matched my own script name" is exactly the reasoning that ends in someone
  else's work being killed.
- **A port being occupied is not permission to free it.** If something else holds a
  port that is needed, say so and ask.
- **Anything the session starts, the session stops** — as soon as the task that
  needed it is done, not mentioned in a summary later. Prefer not starting
  long-lived servers at all.
- If a process looks orphaned or broken, report it and let the user decide. Their
  machine, their call.

### Keep a ledger, because you will forget

The rule above fails in practice for one reason: by the time the task is done,
the thing you started twenty tool calls ago is out of mind. So write it down.
Every process this session launches — background command, poll loop, watcher,
dev server, worker — gets a line: what it is, its PID, and the condition under
which it should die. Re-read that list before you say a task is finished, and
kill everything on it whose reason has passed.

Two kinds of leftover process, and the second is the dangerous one:

- **Stale — still running, no longer needed.** A poll loop waiting for a
  condition that already happened, a watcher on a file nobody is editing, a
  server started for one request. Harmless individually; they accumulate, and
  they spin for hours.
- **Stale code — still running, holding a version of the code that no longer
  exists.** A long-lived process imported its modules at startup and keeps
  executing them after the files change. Fix a bug, watch the bug keep
  happening, and lose hours before realising the running process never reloaded.
  The same applies to a credential: a process that read `.env` at import holds
  the old value until it restarts, which can lock an entire project out of its
  database.

So when you change code or config, ask what is still running that loaded the old
version, and restart it. A deploy does not do this for you.

This is not advisory. It was written after a session started `uvicorn` for a one-off
test run, left it running, and then reached for `pkill -f "uvicorn src.main:app"` to
clean up — a blast-radius decision on the user's machine that would have killed a
pre-existing process it did not own. Processes the user started may hold state,
sessions, or work that is not recoverable.

---

## Memory — hard rule

**Never drive this machine into an out-of-memory condition.**

Before starting anything memory-heavy — a large build, a test matrix, a model load,
a big data job, or several agents at once — check what is actually free:

```bash
memory_pressure | tail -2          # system-wide free percentage
vm_stat | head -3                  # pages free, at the current page size
ps -o rss=,comm= -p <pid>          # RSS of a specific process, in KB
```

While such a job runs, watch its RSS rather than assuming it is fine. If free memory
is low, run the work smaller — fewer workers, smaller batches, one job instead of
four — or say it cannot be done safely right now. Do not launch it and hope.

---

## Python — use `uv`

**In any project containing Python, use `uv`. Never invoke a `python`, `pip`, or
`venv` binary directly.**

| Instead of | Use |
| --- | --- |
| `python script.py` | `uv run script.py` |
| `pip install x` | `uv add x` |
| `pip install -r requirements.txt` | `uv sync` |
| `python -m pytest` | `uv run pytest` |
| `python -m venv .venv` | `uv venv` |

`uv` resolves against the project's own locked environment. A bare `python` picks up
whatever interpreter happens to be first on `PATH`, which is how a script silently
runs against the wrong dependencies.

---

## Use the tools that are already installed

- **codegraph** — a parsed graph of every symbol, edge, and file. Use it for
  structural questions: where something is defined, what calls it, what breaks if it
  changes. Faster and more accurate than grep, and it is already built.
- **ponytail** — use as configured for the project at hand.
- **context-mode** — route long-output commands, web fetches, and large file reads
  through it so raw output never floods the context window.
- **patina** — run it on any document written for a human to read: READMEs, design
  docs, PRs, reports. It removes the tells of machine-written prose.

---

## Git and GitHub

Treat the repository as something that must stay clean and recoverable at all times,
especially when several agents are working at once.

- **Never commit directly to `main`.** Branch for every feature or fix.
- **Use a git worktree per task.** Parallel agents in the same working tree
  overwrite each other; separate worktrees make concurrent work safe.
- **Worktrees live outside the repository**, under the same dated scratch root as
  everything else disposable:

  ```
  ~/.blackhole/<project>/<YYYY-MM-DD>/<branch-slug>/
  ```

  So a second task in `~/Developer/Projects/HypePaper` on 31 July 2026 goes in
  `~/.blackhole/HypePaper/2026-07-31/fix-merge-orphans/`:

  ```bash
  WT=~/.blackhole/HypePaper/$(date +%F)/fix-merge-orphans
  git worktree add -b fix/merge-orphans "$WT"
  # ... work, commit, push, merge ...
  git worktree remove "$WT"        # and delete the branch once merged
  ```

  Never create a worktree inside the repo directory — it gets picked up by an
  unrelated `git add -A`, confuses every path-based tool, and the dated root is
  what makes an abandoned one obvious and safe to delete later.

- **Let CI be the gate into `main`.** GitHub Actions runs the tests, the build, and
  the release. Do not hand-publish or hand-deploy what a workflow should do.
- **Commit in small, self-contained steps** with a message that explains *why* the
  change exists, not just what changed.
- **Never rewrite shared history.** No force-push to a branch anyone else may have
  pulled.
- Before merging, make sure the branch is green and actually verified — not merely
  green because nothing ran.

### Delete every worktree the moment its branch is merged

**A merged branch's worktree is garbage. Remove it in the same breath as the
merge — not later, not "once I've checked one more thing".**

```bash
git worktree remove "$WT"      # or --force if it has untracked build output
git worktree prune             # drop registrations whose directory is gone
git branch -d <branch>         # the branch too, once merged
```

This applies to *every* worktree, including the throwaway ones created just to
compare against a baseline. Those are the worst offenders: they are made in a
hurry to answer one question, the question gets answered, and nothing ever
deletes them.

**Before saying a task is done, run `git worktree list` and account for every
entry**, exactly as you already do for `git branch --no-merged main`. Anything
whose branch is merged, or which exists only to have answered a question you have
now answered, gets removed right then.

A leftover worktree is not clutter, it is a trap:

- It stays **registered in the repo**, so `git worktree list` and every
  path-based tool keep pointing at a tree nobody is maintaining.
- It holds a **stale copy of the code**, indistinguishable at a glance from
  current work. Someone — often you, days later — reads it as unmerged work and
  has to diff it line by line against `main` to prove it is superseded.
- It quietly consumes disk: each one carries a full checkout, often with its own
  `node_modules` and `.venv`.

This was written after two worktrees (`wt-head`, `wt-work`) were found still
registered in `Agented`, left by a session the day before that had used them to
compare a baseline against in-progress auto-distill work. That work had long since
merged. Proving they were disposable took reading their diff against `origin/main`
file by file — 287 lines present only in `main`, 22 present only in the worktree,
each of those 22 an earlier version of something later fixed. All of that was
wasted effort that deleting them at merge time would have made unnecessary.

### Finish a branch before starting another one

**Never leave a branch half-done to start a second one.** A branch you walked away
from is invisible: its commits are not on `main`, not on the remote, and not in the
working tree, so the work reads as *undone* — including to you, twenty tool calls
later.

The rule, in order:

1. **One task, one branch, finished.** Commit, verify, merge or push, and only then
   start the next thing. If a second task genuinely must run alongside, it gets its
   own **worktree** — that is what the worktree rule above is for.
2. **Never carry uncommitted changes across a branch switch.** `git checkout` drags
   the working tree along, so edits silently land on whichever branch you happen to
   be on. Commit them where they belong first.
3. **Never use `git stash` to move work between branches.** Stash is for a moment's
   interruption in one branch, not a transport mechanism. `stash` → `checkout` →
   `checkout -b` → `stash pop` is how work ends up on the wrong branch or lost.
4. **Never `stash` or `checkout` a working tree that background agents are writing
   to.** A workflow's agents hold no lock and get no warning: stashing the tree
   out from under a mid-flight write can lose an entire agent's work, and
   `stash pop` afterwards can conflict against files that changed while it was
   away. To merge or branch while a workflow runs, do it in a **throwaway
   worktree** (`git worktree add /tmp/merge-XXXX main`), or push the branch
   straight to the remote ref if it fast-forwards — neither touches the tree the
   agents are using. Committed on 2026-07-31 after doing exactly this during a
   12-agent run; nothing was lost only because no agent happened to write during
   the two-second window.
5. **Push every branch as soon as it has a commit.** An unpushed local branch is one
   `checkout` away from being forgotten entirely.
6. **Before saying a task is done, run `git branch --no-merged main`** and account
   for every branch listed. If one is yours and unfinished, say so explicitly.

This was written after a session created `fix/rotate-stops-processes-first`,
committed a deploy-script fix *and a correction to a handoff document* to it, then
abandoned it to start `fix/merge-orphans-watched-papers` — shuffling uncommitted
edits between the two with `git stash`. Checking out `main` made the corrected
handoff appear to revert to its wrong version, and a third file landed on a
frontend hotfix branch it had nothing to do with. The user had to ask "what about
that branch, did you merge it?" to surface work that had been sitting invisible for
the whole session. Nothing was lost, but the repository state stopped matching what
had actually been done, which is the same thing as losing it.

Branch sprawl is not untidiness. It is the agent forgetting, in a way the user has
to notice on its behalf.

---

## Do not let the codebase sprawl

**Search before you create.** Query codegraph for the symbol, the function, or the
file you are about to add. If something close already exists, extend it instead.

Specifically:

- No second copy of a helper that already exists under a different name.
- No scratch scripts, one-off test files, or `*_v2`, `*_new`, `*_fixed` variants
  left in the repository. Use a scratch directory outside the project.
- No test file that duplicates the coverage of an existing one; add the case to the
  suite that already owns that behavior.
- Delete what a change makes dead. A change is not finished while the thing it
  replaced is still sitting there.

Duplicated, unstructured code is not a style problem. It is how a codebase stops
being understandable, and it compounds fastest when agents generate it.

### Never write throwaway files into a repository

Temporary files, one-off scripts, debug output, screenshots, logs, captured
command output, exploratory notebooks — none of it belongs in the project
directory, not even briefly. It gets committed by an unrelated `git add -A`, or
it lingers until nobody remembers whether it matters.

Write them here instead, creating the directory as needed:

```
~/.blackhole/<project>/<YYYY-MM-DD>/
```

where `<project>` is the name of the working directory you are in. So work in
`~/Developer/Projects/HypePaper` on 30 July 2026 puts scratch files under
`~/.blackhole/HypePaper/2026-07-30/`. Dating them means old scratch is obvious
and safe to delete without reading it.

This applies to files you intend to delete in a moment. Those are the ones that
survive.

## Delete an artifact once it has served its purpose

**Anything created to accomplish something gets removed as soon as that thing is
accomplished**, in the same motion that finishes the work. Not in a cleanup pass
afterwards, because there is no afterwards.

Several rules above are one instance of this each: the merged worktree, the
process the session launched, the throwaway file, the thing a change made dead.
The shape never changes. Something gets made to answer one question, the question
gets answered, and then nothing deletes it, because by then the work reads as done
and attention has moved on. It holds equally for what those rules do not name — a
package installed once to smoke-test it, a container built to reproduce one bug,
build and coverage output produced to be read through once.

**Before saying a task is done, list what it created and account for every
entry**, exactly as you already do for `git worktree list` and
`git branch --no-merged main`:

```bash
git status --short                        # anything the task dropped in the repo
ls ~/.blackhole/<project>/$(date +%F)/    # today's scratch — still needed?
git worktree list                         # trees whose question is answered
```

Then say what is left and why. "Nothing left" is a fine answer, and usually the
right one, but it has to be checked rather than assumed.

Keep anything that is *evidence*: a report that was asked for, a document
recording a decision, output the user has not seen yet. The test is whether
someone will read it again, not whether it was slow to produce.

Two limits, and they outrank the rule above. Delete only inside directories this
session created, and delete nothing you are unsure about. An artifact the user
made, or chose to keep, is theirs; leftover state you did not create may be
load-bearing for something you cannot see. When in doubt, name what is still on
disk and let them decide.

This was written after a session installed a freshly published package from npm
into a dated scratch directory, purely to check that the tarball actually ran —
confirmed it did, reported the result, and left the install, the config it had
scaffolded, and two generated reports sitting on disk. The task had already been
reported as complete. Nothing removed them until the next request happened to be
this rule.

## Name and place every document you write

A document — in `docs/`, in `.planning/`, anywhere — goes in the subdirectory
that matches what it is, named:

```
<YYYY-MM-DD>-<title-slug>.md
```

So `docs/handoffs/2026-07-31-deployment-hardening.md`, not `HANDOFF.md` or
`docs/notes_final_v2.md`. The date is first because it sorts chronologically,
and a reader can tell at a glance whether they are looking at current guidance or
a record of something that happened months ago.

Two documents about the same thing, six months apart, must not compete to be the
one people read. If a new document supersedes an old one, say so in the old one
and link forward — or delete it. A stale document is worse than a missing one,
because it is trusted.
