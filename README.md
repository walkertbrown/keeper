# keeper

Rules for Claude Code that hold.

A long CLAUDE.md gets read once at the top of a conversation and then drifts out of
attention. keeper keeps your rules in small files and puts each one in front of Claude
**at the moment it applies**: the rules for a project when you open it, the rules for
migrations when Claude touches a migration, the line about pushing when Claude is about
to push. When you correct Claude, keeper writes the correction down, and a nightly
keeper turns repeated corrections into rules, in your own words.

For the few rules that must never be broken, keeper has **gates**. They stop a tool
call before it runs. All of them ship off.

## Install

Needs Claude Code, Node 18 or newer, and git.

```
/plugin marketplace add <owner>/keeper
/plugin install keeper
```

Start a new conversation and run `/keeper status`. The first time, Claude runs
`keeper init`: that creates your memory at `~/.keeper/memory` (a git repo) and puts
`keeper` on your PATH (in `~/.local/bin`). Then run:

```
/keeper import
```

Claude reads your CLAUDE.md files and memory, sorts every line into keeper, and runs
`keeper check-import` to prove no line was lost. Your old files are left alone.

## What you'll use

| | |
|---|---|
| `/keeper import` | bring your existing rules in, losing nothing |
| `/keeper report` | which rules you've had to repeat, from your past transcripts |
| `/keeper remember <what>` | write a rule or a fact down now |
| `keeper status` | what is in memory, which gates are on |
| `keeper gates` / `keeper gate on <id>` | see and turn on gates |
| `keeper lift <id>` | open a gate in this folder for 4 hours, when you've said yes |

## Your memory

```
~/.keeper/memory/
  rules/global.md        how to work, everywhere (always loaded; keep it short)
  rules/<area>.md        how to work in one area; `when:` says when it loads
  facts/<name>.md        what is true; the one-line gist is what Claude sees
  gates.json             the gates, all off until you turn one on
  inbox/                 corrections waiting for the nightly keeper
  log/keeper/            what the keeper decided each night, and why
```

Everything is plain markdown. Edit it by hand whenever you like.

## The nightly keeper

Something has to read the corrections and settle them. That's the keeper: a Claude
session that runs once a night against your memory, following `nightly/KEEPER.md`.
It writes a rule only when you've made the same point more than once, or made it
strongly, and it quotes your words beside every rule in its log. On Sundays it audits
its own week and writes down its mistakes in `log/keeper/LESSONS.md`, which it reads
first every night after that.

Run it in one of two places:

- **On this machine:** `keeper schedule` prints a crontab line (2:30 AM). It uses your
  Claude Code login. Try it once by hand first with `keeper nightly`.
- **On GitHub:** put your memory in a **private** repo (`keeper init <repo-url>`), then
  `keeper action review` (each night's changes arrive as a pull request you merge or
  close) or `keeper action auto` (it commits directly). The command tells you which
  secret to add.

The keeper can't change your gates or its own instructions. The runner puts those back
whatever it does.

## Several machines

Give your memory a private git remote (`keeper init <url>`). keeper pulls when a
conversation starts and pushes corrections when one ends, in the background.

## Leaving

```
keeper export ~/keeper-export.md    # all your rules and facts as one CLAUDE.md-style file
keeper uninstall                    # removes keeper's line from ~/.claude/CLAUDE.md and the shim
/plugin uninstall keeper
```

Your memory stays where it is.

## Not yet

No Windows. No forgetting old rules automatically. No measuring whether a rule actually
changed behaviour against a control. See SPEC.md.

MIT licence.
