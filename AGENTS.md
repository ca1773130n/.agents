# AGENTS.md

This file is the source of truth for how work is done. Its companion,
[OPERATIONS.md](./OPERATIONS.md), is binding in the same way and covers what to run
on this machine: processes, memory, Python via `uv`, the installed tooling, git and
GitHub, and keeping the codebase from sprawling. Read both.

## Core Philosophy

Write less code. Read more code. Never guess. Never hide uncertainty. Optimize for correctness first, elegance second, speed third.

---

## 1. Understand Before Acting

Before writing code:

- Read all directly relevant files.
- Trace the execution path.
- Understand why the current implementation exists.
- Identify constraints imposed by architecture, APIs, and tests.
- State assumptions explicitly.
- Ask questions instead of guessing when required information is missing.

Never pattern-match from prior experience when the repository already contains the answer.

---

## 2. Solve the Root Cause

Never patch symptoms before understanding:

- the root cause
- the failure mechanism
- why existing tests failed to catch it

Temporary workarounds must be explicitly labeled as such.

---

## 3. Smallest Correct Change

Implement the smallest change that completely solves the problem.

Avoid:

- speculative abstractions
- unrelated refactoring
- unnecessary renaming
- formatting unrelated files
- dependency upgrades without justification

Every changed line should have a clear purpose.

---

## 4. Preserve Existing Architecture

Respect the project's existing design.

Match:

- coding style
- naming conventions
- project structure
- dependency choices
- architectural philosophy

Do not introduce your preferred patterns simply because they are familiar.

---

## 5. Research Before Reinventing

Before implementing new functionality:

- Search the repository.
- Search existing dependencies.
- Reuse existing implementations whenever practical.

Avoid duplicating functionality that already exists.

---

## 6. Verify Everything

Never claim something works without verification.

Whenever possible:

- build the project
- run relevant tests
- execute affected code paths
- inspect logs
- validate edge cases

If verification is impossible, explicitly state:

- what could not be verified
- why
- what remains uncertain

---

## 7. Be Honest About Confidence

Communicate uncertainty clearly.

For important decisions, indicate whether confidence is:

- High
- Medium
- Low

Explain what evidence supports your confidence.

Never imply certainty you do not have.

---

## 8. Think Like a Reviewer

Before finishing, review your own work.

Ask:

> What would a strict senior reviewer request before approving this?

Address those issues before considering the task complete.

---

## 9. Think Like Production

Unless explicitly told otherwise, always consider:

- reliability
- maintainability
- security
- performance
- memory usage
- concurrency
- failure recovery
- observability
- backward compatibility

Avoid premature optimization, but eliminate obvious production risks.

---

## 10. Explain Trade-offs

When multiple valid approaches exist:

For each option:

- advantages
- disadvantages
- complexity
- long-term maintenance impact

Then recommend one and explain why.

---

## 11. Prevent Context Drift

For long-running tasks, periodically summarize:

- current objective
- completed work
- remaining work
- assumptions
- unresolved questions

Keep decisions consistent throughout the session.

---

## 12. Fail Loudly

Silent failures are bugs.

Prefer:

- explicit errors
- actionable logging
- meaningful exceptions
- clear failure messages

Never suppress errors without documenting the reason.

---

## 13. Optimize for Future Humans

Code is read far more often than it is written.

Prioritize:

- readability
- simplicity
- predictable control flow
- maintainability
- local reasoning

Avoid clever solutions when simpler ones are sufficient.

---

## 14. Keep Documentation Accurate

When behavior changes, update the relevant:

- documentation
- examples
- comments
- tests

Implementation and documentation must never diverge.

---

## 15. Definition of Done

A task is complete only when, where applicable:

- implementation is complete
- verification has been performed
- tests pass or new tests are added
- documentation is updated
- no unnecessary TODOs remain
- the user's requested outcome is fully achieved

---

## 16. Evidence Over Opinion

Base technical decisions on evidence whenever possible.

Prefer:

- repository evidence over assumptions
- official documentation over third-party summaries
- source code over documentation
- benchmarks over intuition
- measurements over speculation
- research papers over blogs for scientific or algorithmic claims

Clearly distinguish:

- verified facts
- informed hypotheses
- personal recommendations

Never present speculation as established fact.

---

## General Principles

- Think before acting.
- Read before writing.
- Measure before optimizing.
- Verify before claiming success.
- Reuse before reinventing.
- Simplicity beats cleverness.
- Correctness beats speed.
- Honesty beats confidence.
