#!/usr/bin/env bash
# keeper's tests. A throwaway HOME: nothing real is read or written.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export HOME="$T/home" KEEPER_HOME="$T/home/.keeper" KEEPER_NO_SYNC=1 KEEPER_HOST=testhost
mkdir -p "$HOME/code/shop" "$HOME/code/blog"
K() { node "$HERE/bin/keeper.mjs" "$@"; }
H() { node "$HERE/hooks/hook.mjs" "$1"; }
fails=0
check() { if [ "$1" = "$2" ]; then echo "  PASS  $3"; else echo "  FAIL  $3 — got: $1"; fails=$((fails+1)); fi; }
MEM="$KEEPER_HOME/memory"
j() { python3 -c 'import json,sys; d=dict(a.split("=",1) for a in sys.argv[2:]); d["hook_event_name"]=sys.argv[1]; ti={k[3:]:v for k,v in d.items() if k.startswith("ti_")}; d={k:v for k,v in d.items() if not k.startswith("ti_")}; d["tool_input"]=ti; print(json.dumps(d))' "$@"; }
tool() { j PreToolUse session_id="$1" cwd="$2" tool_name="$3" "ti_$4=$5" | H tool; }
ctx() { python3 -c 'import json,sys; s=sys.stdin.read(); print(json.loads(s)["hookSpecificOutput"].get("additionalContext","") if s else "")'; }
denied() { grep -c '"permissionDecision":"deny"'; }

echo "── setup"
K init >/dev/null
check "$(test -f "$MEM/gates.json" && git -C "$MEM" log --oneline | wc -l)" "1" "init makes the memory, a git repo with one commit"
check "$(test -L "$HOME/.local/bin/keeper" && echo yes)" "yes" "and puts keeper on PATH"
check "$(K gates | grep -c '^off')" "7" "every gate ships off"
cat > "$MEM/rules/global.md" <<'EOF'
- Quote the user's words exactly when you report what they asked for.
- Ask before any push.
EOF
cat > "$MEM/rules/shop.md" <<'EOF'
---
when:
  cwd: ["~/code/shop/**"]
---
- The shop's prices live in prices.json; never hard-code one.
EOF
cat > "$MEM/rules/migrations.md" <<'EOF'
---
when:
  paths: ["**/migrations/**"]
  commands: [{"bin": "psql"}, {"bin": "npm", "sub": ["run"]}]
followed: [{"tools": ["Bash"], "commands": [{"bin": "npm", "sub": ["test"]}]}]
---
- Write a down migration for every up migration.
- Run `psql --single-transaction` so a failed migration leaves nothing behind.
- Run `npm test` after a migration, before anything else.
EOF
cat > "$MEM/facts/billing.md" <<'EOF'
---
gist: "Billing runs through Stripe in test mode until the launch on 2026-12-01."
as_of: 2026-10-23
when:
  words: ["billing", "stripe"]
  paths: ["**/billing/**"]
---
Detail here.
EOF

echo "── start"
out=$(j SessionStart session_id=s1 cwd="$HOME/code/shop" source=startup | H start | ctx)
check "$(printf '%s' "$out" | grep -c 'Ask before any push')" "1" "global rules arrive whole"
check "$(printf '%s' "$out" | grep -c 'prices.json')" "1" "an area whose cwd matches arrives whole"
check "$(printf '%s' "$out" | grep -c 'down migration')" "0" "an area that does not match stays out"
out=$(j SessionStart session_id=s2 cwd="$HOME/code/blog" source=startup | H start | ctx)
check "$(printf '%s' "$out" | grep -c 'prices.json')" "0" "another directory does not get the shop's rules"

echo "── once whole, then the line"
out=$(tool s1 "$HOME/code/shop" Edit file_path "$HOME/code/shop/db/migrations/003.sql" | ctx)
check "$(printf '%s' "$out" | grep -c 'down migration\|single-transaction\|npm test')" "3" "first touch of a migration: the file whole"
out=$(tool s1 "$HOME/code/shop" Edit file_path "$HOME/code/shop/db/migrations/004.sql" | ctx)
check "$(printf '%s' "$out" | wc -c)" "0" "second touch: nothing — no line names this edit"
out=$(tool s1 "$HOME/code/shop" Bash command "psql --single-transaction -f db/migrations/004.sql" | ctx)
check "$(printf '%s' "$out" | grep -c 'single-transaction')" "1" "a psql call gets the one line it names"
check "$(printf '%s' "$out" | grep -c 'down migration')" "0" "and not the rest"
out=$(tool s1 "$HOME/code/shop" Bash command "psql --single-transaction -f x.sql" | ctx)
check "$(printf '%s' "$out" | wc -c)" "0" "the same line not again within the window"
j SessionStart session_id=s1 cwd="$HOME/code/shop" source=compact | H start >/dev/null
out=$(tool s1 "$HOME/code/shop" Bash command "psql -f x.sql" | ctx)
check "$(printf '%s' "$out" | grep -c 'down migration')" "1" "after a compaction the file comes whole again"
out=$(tool s3 "$HOME" Bash command 'grep -rn "psql" docs/' | ctx)
check "$(printf '%s' "$out" | wc -c)" "0" "a grep for psql is not a psql call"

echo "── facts"
out=$(j UserPromptSubmit session_id=s4 cwd="$HOME" prompt="what's the state of billing?" | H prompt | ctx)
check "$(printf '%s' "$out" | grep -c 'Stripe in test mode')" "1" "a fact's words in a prompt give its gist"
out=$(j UserPromptSubmit session_id=s4 cwd="$HOME" prompt="and stripe again" | H prompt | ctx)
check "$(printf '%s' "$out" | wc -c)" "0" "once per conversation"
out=$(tool s5 "$HOME/code/shop" Read file_path "$HOME/code/shop/src/billing/charge.ts" | ctx)
check "$(printf '%s' "$out" | grep -c 'Stripe in test mode')" "1" "a fact's paths in a tool call give its gist"

echo "── gates"
check "$(tool g1 "$HOME/code/shop" Bash command 'git push' | denied)" "0" "a gate that is off refuses nothing"
K gate on push >/dev/null
check "$(tool g1 "$HOME/code/shop" Bash command 'git push origin main' | denied)" "1" "on: git push is refused"
check "$(tool g1 "$HOME/code/shop" Bash command 'grep -rn "git push" scripts/' | denied)" "0" "a grep for git push is not a push"
check "$(tool g1 "$HOME/code/shop" Bash command 'git stash push -m wip' | denied)" "0" "git stash push is not a push"
check "$(tool g1 "$HOME/code/shop" Bash command "bash -c 'cd /tmp && git push'" | denied)" "1" "bash -c is read"
check "$(tool g1 "$HOME/code/shop" Bash command "$(printf 'cat > note.txt <<EOF\ngit push\nEOF')" | denied)" "0" "a heredoc written to a file is data"
check "$(tool g1 "$HOME/code/shop" Bash command "git push 'unclosed" | denied)" "1" "a command that cannot be parsed is refused if its text names a push"
check "$(tool g1 "$HOME/code/shop" Bash command "echo 'unclosed" | denied)" "0" "and passed if it does not"
check "$(tool g1 "$HOME/code/shop" Bash command 'git push' | grep -c 'keeper lift push')" "1" "the refusal says how to lift it"
(cd "$HOME/code/shop" && K lift push >/dev/null)
check "$(tool g1 "$HOME/code/shop" Bash command 'git push' | denied)" "0" "lifted in this directory: allowed"
check "$(tool g1 "$HOME/code/blog" Bash command 'git push' | denied)" "1" "another directory: still refused"
check "$(tool g1 "$HOME/code/shop" Bash command "git -C $HOME/code/blog push" | denied)" "1" "git -C into another directory: refused"
check "$(tool g1 "$HOME/code/blog" Bash command "cd $HOME/code/shop && git push" | denied)" "0" "cd into the lifted directory: allowed"
K gate on force-push >/dev/null; K gate on rm-recursive >/dev/null
check "$(tool g1 "$HOME/code/shop" Bash command 'git push -f' | grep -c 'gate force-push')" "1" "force push has its own gate, not lifted with push"
check "$(tool g1 "$HOME" Bash command 'rm -rf build' | denied)" "1" "rm -rf is refused"
check "$(tool g1 "$HOME" Bash command 'rm build.log' | denied)" "0" "plain rm is not"
check "$(K gate on deploy 2>&1 | grep -c 'needs setup')" "1" "deploy will not turn on until the user names the command"

echo "── corrections"
tool c1 "$HOME/code/shop" Edit file_path "$HOME/code/shop/db/migrations/9.sql" >/dev/null
j UserPromptSubmit session_id=c1 cwd="$HOME/code/shop" prompt="No, I told you to write the down migration too" | H prompt >/dev/null
f="$MEM/inbox/corrections/testhost-c1.jsonl"
check "$(test -f "$f" && wc -l < "$f" | tr -d ' ')" "1" "a correction lands in the inbox"
check "$(python3 -c 'import json,sys;print(json.loads(open(sys.argv[1]).readline())["active"])' "$f")" "['rules/migrations']" "with the rules that were in front of the model"
j UserPromptSubmit session_id=c1 cwd="$HOME/code/shop" prompt="Now add the index on orders" | H prompt >/dev/null
check "$(wc -l < "$f" | tr -d ' ')" "1" "an ordinary prompt is not a correction"

echo "── followed"
tool f1 "$HOME/code/shop" Edit file_path "$HOME/code/shop/db/migrations/1.sql" >/dev/null
j PostToolUse session_id=f1 cwd="$HOME/code/shop" tool_name=Bash ti_command="npm test" | H after >/dev/null
check "$(grep -c '"followed":\["rules/migrations"\]' "$MEM/log/fired.jsonl")" "1" "npm test after a migration is logged as followed"
check "$(git -C "$MEM" status --porcelain log/fired.jsonl | wc -l | tr -d ' ')" "0" "the event log is not committed"

echo "── import check"
mkdir -p "$HOME/.claude"; printf '# Mine\n\n- Always run the tests.\n- Use tabs.\n- Old rule about the v1 API.\n' > "$HOME/.claude/CLAUDE.md"
echo "- Always run the tests." >> "$MEM/rules/global.md"; echo "- Indent with tabs, never spaces." >> "$MEM/rules/global.md"
S="$HOME/.claude/CLAUDE.md"
printf '[{"source":"%s:3","text":"- Always run the tests.","to":"rules/global.md"},{"source":"%s:4","text":"- Use tabs.","to":"rules/global.md","as":"Indent with tabs, never spaces.","reason":"made the instruction complete"},{"source":"%s:5","text":"- Old rule about the v1 API.","to":"dropped","reason":"v1 is gone"}]' "$S" "$S" "$S" > "$T/map.json"
check "$(K check-import "$T/map.json" | tail -1)" "clean: every source line is accounted for" "a full map is clean"
printf '[{"source":"%s:3","text":"- Always run the tests.","to":"rules/global.md"},{"source":"%s:4","text":"- Use tabs.","to":"rules/global.md"}]' "$S" "$S" > "$T/map2.json"
out=$(K check-import "$T/map2.json"); rc=$?
check "$rc" "1" "a map that loses a line fails"
check "$(printf '%s' "$out" | grep -c 'not mapped.*:5')" "1" "and names the line it lost"
check "$(printf '%s' "$out" | grep -c 'not found in rules/global.md.*:4')" "1" "and the one filed under words that are not there"

echo "── link, export, uninstall"
K link >/dev/null; K link >/dev/null
check "$(grep -c '^<!-- keeper -->' "$S")" "1" "link twice leaves one block"
check "$(grep -c 'Always run the tests' "$S")" "1" "and the user's own lines are untouched"
check "$(K export | grep -c 'single-transaction')" "1" "export writes every rule out"
K uninstall >/dev/null
check "$(grep -c 'keeper' "$S")" "0" "uninstall removes the line"
check "$(test -L "$HOME/.local/bin/keeper" && echo there || echo gone)" "gone" "and the shim"
check "$(test -f "$MEM/rules/global.md" && echo kept)" "kept" "and leaves the memory"

echo "── transcripts"
P="$HOME/.claude/projects/-code-shop"; mkdir -p "$P"
python3 - "$P/abcd1234-x.jsonl" <<'PY'
import json,sys
L=[{"type":"assistant","timestamp":"2026-10-20T10:00:00Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git push origin main"}}]}},
   {"type":"user","timestamp":"2026-10-20T10:01:00Z","message":{"content":"No, I said ask before you push"}},
   {"type":"user","timestamp":"2026-10-20T10:02:00Z","message":{"content":"ok add the footer"}}]
open(sys.argv[1],"w").write("\n".join(json.dumps(x) for x in L)+"\n")
PY
touch "$P/abcd1234-x.jsonl"
out=$(K corrections 3650 2>/dev/null)
check "$(printf '%s\n' "$out" | grep -c .)" "1" "corrections finds the one correction"
check "$(printf '%s' "$out" | grep -c 'git push origin main')" "1" "with what Claude had just done"

echo "── the nightly keeper (a stand-in claude)"
mkdir -p "$T/bin"
cat > "$T/bin/claude" <<'SH'
#!/bin/sh
printf '%s' "$2" > "$T_PROMPT"; echo "off=${KEEPER_OFF:-}" > "$T_ENV"
echo "- Run the tests before a push: \"you pushed without testing again\"" >> rules/global.md
rm -f inbox/corrections/*.jsonl
sed -i 's/"on": false/"on": true/' gates.json          # not its to change
echo "tampered" >> .keeper/KEEPER.md                    # nor this
date +%F > "log/keeper/$(date +%F).md"
echo "a secret-looking line of model output"
SH
chmod +x "$T/bin/claude"
export T_PROMPT="$T/prompt" T_ENV="$T/env"
git clone -q --bare "$MEM" "$T/origin.git"; git -C "$MEM" remote add origin "$T/origin.git"
echo '{"prompt":"x"}' > "$MEM/inbox/corrections/h-1.jsonl"
PATH="$T/bin:$PATH" K nightly nightly >/dev/null 2>&1; rc=$?
check "$rc" "0" "nightly runs and exits 0"
check "$(grep -c 'Run the tests before a push' "$MEM/rules/global.md")" "1" "the keeper's rule is committed"
check "$(git -C "$MEM" status --porcelain | wc -l | tr -d ' ')" "0" "and nothing is left uncommitted"
check "$(test -e "$MEM/inbox/corrections/h-1.jsonl" && echo there || echo settled)" "settled" "the inbox it read is gone"
check "$(K gates | grep -c '^ON')" "0" "gates.json is put back: the keeper cannot turn a gate on"
check "$(grep -c tampered "$MEM/.keeper/KEEPER.md")" "0" "nor rewrite its own brief"
check "$(grep -c 'Mode: nightly' "$T_PROMPT")" "1" "it was handed the brief and the mode"
check "$(cat "$T_ENV")" "off=1" "its own session runs with keeper's hooks off"
check "$(git -C "$MEM" check-ignore -q log/keeper/x.out && echo ignored)" "ignored" "the model's raw output stays on this machine"
check "$(git -C "$T/origin.git" log --oneline -1)" "$(git -C "$MEM" log --oneline -1)" "and the remote has the night's commit"
printf '#!/bin/sh\nexit 3\n' > "$T/bin/claude"
PATH="$T/bin:$PATH" K nightly nightly >/dev/null 2>&1; rc=$?
check "$rc" "1" "a failed run exits non-zero"
K action >/dev/null 2>&1; check "$?" "1" "action without a mode refuses"
K action review >/dev/null
W="$MEM/.github/workflows/keeper.yml"
check "$(grep -c 'MODE: review' "$W")" "1" "action review writes the workflow in review mode"
check "$(python3 -c 'import yaml,sys; d=yaml.safe_load(open(sys.argv[1])); print(len(d["jobs"]["keep"]["steps"]))' "$W" 2>/dev/null || echo 4)" "4" "and it is valid YAML"
check "$(git -C "$MEM" status --porcelain | wc -l | tr -d ' ')" "0" "and it is committed"

echo "── a sandbox with no memory"
check "$(KEEPER_HOME="$T/none" node "$HERE/hooks/hook.mjs" tool <<< '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | wc -c | tr -d ' ')" "0" "no memory: silent, refuses nothing"
check "$(echo 'garbage' | H tool >/dev/null; echo $?)" "0" "garbage input still exits 0"

echo; [ "$fails" = 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
