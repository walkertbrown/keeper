---
description: keeper — import your rules, report which ones get broken, remember something, or show status
argument-hint: import | report | remember <what> | status
---

The user ran `/keeper $ARGUMENTS`. keeper's command line is `keeper` (if it is not on PATH,
`node ${CLAUDE_PLUGIN_ROOT}/bin/keeper.mjs`; if that path does not resolve, find it with
`find ~/.claude/plugins -path '*keeper/bin/keeper.mjs'`). Memory is in `~/.keeper/memory`. If
`keeper status` says there is no memory yet, run `keeper init` first.

## The format you write in

- `rules/global.md`: how to work, everywhere. One `- ` line per rule, at most 140
  characters, always loaded. Keep it to the rules that apply in every project; at most 40.
- `rules/<area>.md`: how to work in one area (a project, a tool, a kind of task).
  Frontmatter, then one `- ` line per rule:
  ```
  ---
  when:
    cwd: ["~/code/shop/**"]
    paths: ["**/migrations/**"]
    commands: [{"bin": "git", "sub": ["push"]}, {"bin": "deploy.sh"}]
  followed: [{"tools": ["Bash"], "commands": [{"bin": "npm", "sub": ["test"]}]}]
  ---
  - Run the tests before any push; CI is slow to tell you.
  ```
  `cwd`: the file loads whole at the start of a conversation opened there. `paths` and
  `commands`: it loads whole the first time a tool call touches them, and after that only
  the line that names what the call touched. Values are JSON. Leave out what doesn't apply.
  `followed` is the tool call that shows the rules were obeyed; leave it out if no call could.
- `facts/<slug>.md`: what is true. Frontmatter `gist:` (one sentence that states the fact
  itself, not its subject), `as_of: YYYY-MM-DD`, and `when:` with `words` (in the user's
  message) and/or `paths`. The body holds detail and is read only on demand.
- Keep the user's wording. A rule they wrote is never shortened until its instruction
  is gone, and never softened.

## import

Bring the user's existing rules into keeper without losing a line.

1. Read every source: `~/.claude/CLAUDE.md`, each `CLAUDE.md` in their projects
   (`~/.claude/projects/` names the directories they work in; check each for a
   `CLAUDE.md` and `.claude/CLAUDE.md`), and every `.md` in `~/.claude/projects/*/memory/`.
   List them for the user with line counts before sorting.
2. Sort every line: a rule that applies everywhere → `rules/global.md`; a rule for one
   project or tool → `rules/<area>.md` with the `when` that matches it; a fact → `facts/`;
   headings, blank lines and code fences are structure, not content. Something
   project-specific stays in that project's `CLAUDE.md` if the user prefers; ask once.
3. Write a map file `~/.keeper/import-map.json`: one entry per source line,
   `{"source": "<path>:<line>", "text": "<the line>", "to": "<file>" | "dropped"}`, plus
   `"as"` and `"reason"` if you reworded it, `"reason"` if you dropped it (a duplicate,
   out of date, not a rule). Never drop a line just to make the list shorter.
4. Run `keeper check-import ~/.keeper/import-map.json`. Fix every problem it prints and
   run it again until it says clean. Show the user the dropped and reworded lines.
5. Do not edit or delete the sources. Tell the user that their old files will still load
   too until they remove them. Ask whether to run `keeper link` (adds one line to
   `~/.claude/CLAUDE.md` saying where the memory is). If they use Claude Code's auto
   memory, ask whether to turn it off (`"autoMemoryEnabled": false` in
   `~/.claude/settings.json`) so the same rules don't load twice.
6. Commit: `git -C ~/.keeper/memory add -A && git -C ~/.keeper/memory commit -m "import"`.

## report

Find where the user had to correct Claude on something a rule already said.

1. Run `keeper corrections 60 > ~/.keeper/corrections.jsonl`. Each line is something
   the user said that reads as a correction, with the last tool calls before it.
2. Read the rules (`rules/global.md`, `rules/*.md`). For each correction, decide whether
   a rule already covered it. Most corrections are about the task ("wrong file"), not a
   rule; skip those.
3. Report, most broken first: the rule, how many times, and the user's own words
   quoted for two or three of them. Then corrections that came back three or more times
   with no rule behind them: those are rules to add.
4. For a rule broken three or more times that a gate could enforce (`keeper gates`),
   offer the gate. Turn one on only on the user's yes: `keeper gate on <id>`.

## remember <what>

Write it in: a rule to `global.md` or the right area file, a fact to `facts/`. Use their
words. Check first that nothing already says it; if something does, improve that line
instead of adding a second. Commit it.

## status

Run `keeper status` and say what it shows in plain words.
