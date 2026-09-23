---
name: repo-context-workflow
description: Read and apply local repository rules, memory files, code indexes, handoff notes, and search conventions before codebase analysis or edits. Use when working inside a project that keeps repo-specific instructions in files such as AGENTS.md, docs/ProjectMemory.md, docs/CodeIndex.md, docs/AgentHandoff.md, worklogs, architecture notes, or similar local context files.
---

# Repo Context Workflow

## Purpose

Use the repository's own context before making assumptions. Treat local rules, project memory, code indexes, and handoff notes as navigation aids, then verify behavior against the current files before answering or editing.

## Startup Workflow

1. Find and read local agent rules first. Prefer `AGENTS.md`; also check for similarly scoped files such as `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`, or explicit agent instructions in project docs.
2. Find and read project memory files when present:
   - `docs/ProjectMemory.md` for stable architecture, long-lived conventions, and hidden constraints.
   - `docs/CodeIndex.md` for low-token entry points and task-specific search commands.
   - `docs/AgentHandoff.md` for recent risks, unresolved work, and regression points.
   - `docs/AgentWorklog.md` only when the handoff or task requires historical tracing; search it with `rg` instead of reading it wholesale.
3. If the project uses different names, search for files or headings containing `memory`, `handoff`, `worklog`, `architecture`, `code index`, `agent`, `rules`, or `conventions`.
4. Before asking the user where code lives, search the repository. Ask only when multiple plausible targets remain or the missing detail is product intent.

## Search Workflow

- Prefer `rg` and `rg --files` for file and text search.
- Start from the code index or documented entry points, then search precise symbols: class names, event names, enum values, serialized field names, route names, config keys, and user-provided phrases.
- Use `--line-number` for code references.
- Quote shell patterns that contain special characters, especially `|` in PowerShell; use `--fixed-strings` when literal matching is safer.
- Do not treat memory as proof. When memory and code disagree, trust current code and note the stale memory if it affects the task.

## Editing Workflow

- Keep edits scoped to the requested behavior and the repository's existing patterns.
- Preserve user changes. Do not revert unrelated edits or clean up files outside the task.
- Avoid generated, cache, build, vendored, scene, prefab, binary, or asset files unless local rules and the user explicitly allow those edits.
- Preserve file encoding. When editing files with non-ASCII text, check for mojibake before finishing.
- Prefer structured APIs, typed data, and existing helper utilities over ad hoc parsing.

## Memory Updates

- Follow the repository's own memory policy after non-trivial work.
- Put durable architecture, stable entry points, hidden constraints, and recurring rules in long-term memory files.
- Put current risks, manual follow-ups, validation gaps, and next-agent handoff notes in handoff files.
- Put chronological implementation history in worklogs only when the repository asks for it.
- Do not duplicate large histories into long-term memory; summarize the reusable rule and link or reference the historical source when needed.

## Validation

- Run the narrowest useful validation available for the change.
- If project-level validation is known to be noisy, use targeted checks and state the remaining manual verification clearly.
- For UI, game, asset, or editor-driven behavior, include the required manual preview or editor validation when command-line tests cannot prove the behavior.
