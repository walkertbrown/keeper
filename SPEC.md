# keeper — spec

A Claude Code plugin that makes the rules you give Claude hold. Draft of 2026-10-23.

## The problem it answers

Rules in CLAUDE.md and memory files are loaded at the start of a conversation and then
ignored at the moment they matter. Hours later, about to push, the model is not holding
the line that said "ask before you push". keeper does three things a pile of notes can't:

1. **Delivers a rule at the moment it applies.** It comes up at the tool call it
   governs, not at the top of a long list.
2. **Gates.** A few rules refuse the action before it runs, whether or not anything was
   read.
3. **Measures.** For every rule, it logs whether it was delivered, followed, or
   corrected, so "does this work" has an answer.

## Memory: three kinds, kept apart

```
~/.keeper/memory/            a git repo the user owns (private remote optional)
  rules/global.md            how to work, everywhere. One line each, <=140 chars. Always loaded.
  rules/<area>.md            how to work in one area. Frontmatter `when:` says when it applies.
  facts/<slug>.md            what is true. A one-line `gist` that carries the fact itself.
  gates.json                 rules that refuse. Off until the user turns one on.
  inbox/                     corrections captured, proposals waiting for the keeper.
  log/                       fired.jsonl (local, gitignored), keeper logs (committed).
```

`when:` cues: `cwd` (globs), `paths` (globs a tool touches), `commands` (a program and
subcommand actually invoked, parsed, not text-matched), `words` (in the user's prompt;
facts only). Optional `followed:` says what tool call shows the rule was obeyed.

## Delivery (hooks, no network, no model, always exit 0)

- **Session start:** global.md whole, plus each area file whose `cwd` matches. If a root
  `MEMORY.md` exists in an auto-memory dir, it is reported, never silently loaded twice.
- **Before a tool call:** gates first. Then an area file matched by path or command comes
  in **whole the first time in a conversation**, and after that only the line the action
  names. A fact's gist comes up once per conversation, when its paths or words come up.
- **After a tool call:** `followed` is logged when the call matches the file's `followed:`.
- **On a prompt:** a correction ("no, wait", "I told you", "from now on…") is logged to
  inbox/ with the rules that were in front of the model at the time.

## Gates

Off by default. A catalog the user turns on one by one: push, commit, force-push,
`rm -rf` outside the repo, kill by pattern, deploy (user names the script). A gate reads
the parsed command: a grep for "git push" is not a push. When it can't parse the command,
it refuses (fails closed). `keeper lift <gate>` opens it for this directory for 4 hours,
and only as its own command.

## Getting in: import, report, offer

- **`/keeper import`** (a slash command, so the user's own Claude does the sorting):
  reads `~/.claude/CLAUDE.md`, project `CLAUDE.md` files and `~/.claude/projects/*/memory`,
  and sorts each line into global, an area, or a fact. Then `keeper check-import` proves
  **nothing was lost**: every source line is mapped to where it went, or listed as
  dropped with a reason, and the user sees that list. Sources are never edited. keeper
  adds one line to CLAUDE.md pointing at itself, and uninstall removes it.
- **`/keeper report`**: reads the user's own past transcripts and finds where they
  corrected Claude on something a rule already said. Output: which rules were broken,
  how often, with the user's own words quoted.
- **Gates offered from the report:** a rule broken three or more times that a gate could
  enforce is offered as a gate. Nothing turns on without the user's yes.

## The nightly keeper

Settles inbox/: turns repeated or strong corrections into rules (quoting the user's
words), files facts, merges duplicates, writes `followed:` or notes that a rule can't be
measured. Never deletes a rule the user wrote; never removes one by out-shouting it.
Two ways to run it, the user's choice:

- **GitHub Action** on the private memory repo, nightly. **Review mode:** opens a PR
  the user merges or closes. **Auto mode:** commits. Needs an Anthropic API key or
  Claude Code OAuth token as a repo secret. The plugin pulls at session start and pushes
  inbox/ at session end.
- **Local:** the same prompt run by `claude -p` from cron/launchd, no GitHub.

A weekly audit pass reviews the keeper's own decisions and writes LESSONS.md.

## Out

`keeper uninstall` removes the plugin, its CLAUDE.md line and its hooks, and leaves the
memory repo in place. `keeper export` writes everything back into one CLAUDE.md.

## Not in v1

Rule decay and the control test (measurement is logged from day one; the comparison
comes later), a viewer UI, Windows.

## Requirements

Claude Code, Node 18+, git. GitHub only for the Action.
