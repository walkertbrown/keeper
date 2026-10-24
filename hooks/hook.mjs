#!/usr/bin/env node
// keeper's one hook. Mode is argv[2]: start | prompt | tool | after | end.
// Contract: no dependencies, no network (git sync is detached), no model, exit 0.
// The one thing it ever blocks is a tool call an enabled gate refuses.
import { readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { MEM, STATE, HOST, tilde, hasMemory, globalRules, areas, facts, gates, anyGlob, loadSession, saveSession, isLifted } from "../lib/memory.mjs";
import { cmdMatches } from "../lib/shell.mjs";
import { gradePrompt, humanTurns, repeats } from "../lib/grade.mjs";

const MODE = process.argv[2];
const WINDOW = 25;          // tool events before the same line may be given again
const MAX_WHOLE = 3;        // area files given whole on one tool call
const MAX_LINES = 2;        // lines given on one tool call
const MAX_FACTS = 3;

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
if (process.env.KEEPER_OFF || !hasMemory()) process.exit(0);   // KEEPER_OFF: the keeper's own nightly session

const SID = typeof input.session_id === "string" ? input.session_id.replace(/[^\w-]/g, "") : "";
const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
const tool = input.tool_name ?? null;
const ti = input.tool_input ?? {};
const command = tool === "Bash" && typeof ti.command === "string" ? ti.command : null;
const filePath = ti.file_path ?? ti.notebook_path ?? ti.path ?? null;

let state = loadSession(SID);
if (MODE === "start" && ["compact", "clear"].includes(input.source)) state = loadSession("");   // the model no longer holds what it was given
const context = [];
const out = { ts: new Date().toISOString(), host: HOST, session: SID.slice(0, 8), event: MODE };
const log = (o) => { try { mkdirSync(join(MEM, "log"), { recursive: true }); appendFileSync(join(MEM, "log", "fired.jsonl"), JSON.stringify(o) + "\n"); } catch {} };

/** does this call match a `when` (paths / commands / tools)? Returns the cue that matched, and the terms it named. */
function matchCall(when) {
  if (anyGlob(when.paths, filePath)) {
    const terms = [];
    for (const g of when.paths) for (const seg of String(g).replace(/^~\//, "").split("/")) if (seg.length >= 4 && !/[*?]/.test(seg)) terms.push(seg);
    return { cue: "paths", terms };
  }
  if (Array.isArray(when.commands) && command) {
    try {
      if (cmdMatches(when.commands, command, cwd).length) {
        const hit = when.commands.filter((c) => { try { return cmdMatches([c], command, cwd).length; } catch { return false; } });
        return { cue: "commands", terms: hit.flatMap((c) => [c.bin, ...(c.sub ?? [])]) };
      }
    } catch {}
  }
  if (Array.isArray(when.tools) && when.tools.includes(tool)) return { cue: "tools", terms: [] };
  return null;
}

/** the bullet lines of a rule file this action names: a matched term, or a `code` span found in the action. */
function linesFor(area, terms) {
  const action = `${command ?? ""} ${filePath ?? ""}`.toLowerCase();
  const found = [];
  area.body.split("\n").forEach((line, i) => {
    if (!line.startsWith("- ")) return;
    const l = line.toLowerCase();
    const byTerm = terms.some((t) => t.length >= 3 && new RegExp(`\\b${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(l));
    const byCode = [...line.matchAll(/`([^`]{4,})`/g)].some((c) => action.includes(c[1].toLowerCase()));
    if (byTerm || byCode) found.push({ key: `${area.id}:${i + 1}`, line });
  });
  return found;
}
const giveFact = (f) => { context.push(`[keeper] known: ${f.gist}${f.as_of ? ` (as of ${f.as_of})` : ""} — ${f.id}.md`); state.facts[f.id] = state.n; };

// ── start: global whole, area files whose cwd matches whole
if (MODE === "start") {
  const g = globalRules();
  if (g) context.push(`[keeper] rules/global — how to work, everywhere\n${g.trim()}`);
  const given = [];
  for (const a of areas()) if (anyGlob(a.when.cwd, cwd)) { context.push(`[keeper] ${a.id}\n${a.body}`); state.whole[a.id] = state.n; given.push(a.id); }
  if (given.length) out.whole = given;
  if (input.source === "startup") { sync("pull"); sweep(); }
}

// ── prompt: facts whose words are in it, once a conversation; capture a correction
if (MODE === "prompt" && typeof input.prompt === "string") {
  const prompt = input.prompt.trim();
  const low = prompt.toLowerCase();
  const said = facts().filter((f) => !(f.id in state.facts) && Array.isArray(f.when.words) &&
    f.when.words.some((w) => new RegExp(`\\b${String(w).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(low))).slice(0, MAX_FACTS);
  for (const f of said) giveFact(f);
  if (said.length) out.facts = said.map((f) => f.id);

  let { signal, grade } = gradePrompt(prompt) ?? {};
  if (!signal && input.transcript_path && prompt.length <= 600) {
    const earlier = humanTurns(tail(input.transcript_path, 512 * 1024)).map((t) => t.text).filter((t) => t !== prompt);
    if (repeats(prompt, earlier)) { signal = "repeated"; grade = "high"; }
  }
  if (signal) {
    // what was in front of the model: files given whole, and lines given in the last 10 tool events
    const active = [...new Set([...Object.keys(state.whole), ...Object.entries(state.lines).filter(([, n]) => state.n - n <= 10).map(([k]) => k.replace(/:\d+$/, ""))])];
    const ep = { ts: out.ts, host: HOST, session: out.session, grade, signal, prompt: prompt.slice(0, 240), cwd: tilde(cwd), active };
    try {
      mkdirSync(join(MEM, "inbox", "corrections"), { recursive: true });
      appendFileSync(join(MEM, "inbox", "corrections", `${HOST}-${out.session || "unknown"}.jsonl`), JSON.stringify(ep) + "\n");
    } catch {}
    out.corrected = active; out.grade = grade;
  }
}

// ── tool: gates first, then rules and facts for this call
let deny = null;
if (MODE === "tool") {
  out.tool = tool;
  for (const g of gates()) {
    if (!g.on || !(g.tools ?? ["Bash"]).includes(tool)) continue;
    let dirs = [];
    if (Array.isArray(g.cmd) && command) {
      try { dirs = cmdMatches(g.cmd, command, cwd); }
      catch { if (textFallback(g.cmd, command)) { dirs = [cwd]; out.parse = "fallback"; } }
    }
    if (!dirs.length && anyGlob(g.paths, filePath)) dirs = [cwd];
    if (!dirs.length) continue;
    if (dirs.every((d) => isLifted(g.id, d))) { out.lifted = g.id; continue; }
    deny = g; break;
  }
  if (deny) out.denied = deny.id;
  else {
    const matched = [];
    for (const a of areas()) { const m = matchCall(a.when); if (m) matched.push({ a, ...m }); }
    const whole = matched.filter((m) => !(m.a.id in state.whole)).slice(0, MAX_WHOLE);
    for (const { a } of whole) { context.push(`[keeper] ${a.id}\n${a.body}`); state.whole[a.id] = state.n; }
    if (whole.length) out.whole = whole.map((m) => m.a.id);
    const lines = [];
    for (const m of matched) {
      if (whole.includes(m) || m.cue === "tools") continue;
      for (const l of linesFor(m.a, m.terms)) {
        if (lines.length >= MAX_LINES) break;
        if (l.key in state.lines && state.n - state.lines[l.key] < WINDOW) continue;
        lines.push(l); state.lines[l.key] = state.n;
      }
    }
    if (lines.length) { context.push(lines.map((l) => `[keeper] ${l.key.replace(/:\d+$/, "")}: ${l.line.slice(2)}`).join("\n")); out.lines = lines.map((l) => l.key); }
    const fs = facts().filter((f) => !(f.id in state.facts) && anyGlob(f.when.paths, filePath)).slice(0, MAX_FACTS);
    for (const f of fs) giveFact(f);
    if (fs.length) out.facts = fs.map((f) => f.id);
  }
  state.n++;
}

// ── after: a rule file this conversation was given, and the call shows it was obeyed
if (MODE === "after") {
  const followed = [];
  state.followed ??= {};
  for (const a of areas()) {
    if (!(a.id in state.whole) || !a.followed || a.id in state.followed) continue;
    if (a.followed.some((f) => (!f.tools || f.tools.includes(tool)) && matchCall({ paths: f.paths, commands: f.commands, tools: f.paths || f.commands ? null : f.tools }))) {
      followed.push(a.id); state.followed[a.id] = state.n;
    }
  }
  if (followed.length) out.followed = followed;
}

// ── end: send the inbox home
if (MODE === "end") sync("push");

saveSession(SID, state);
if (Object.keys(out).length > 4) log(out);

if (deny) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: `[keeper] gate ${deny.id}: ${deny.say ?? "this needs the user's go-ahead."} If the user has said yes for this, run \`keeper lift ${deny.id}\` as its own command, then run this again.` } }));
} else if (context.length) {
  const ev = { start: "SessionStart", prompt: "UserPromptSubmit", tool: "PreToolUse" }[MODE];
  if (ev) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: context.join("\n\n") } }));
}
process.exit(0);

/** the command could not be parsed: refuse if its text names the program and subcommand (closed, not open). */
function textFallback(spec, cmd) {
  const word = (w) => new RegExp(`(^|[^\\w-])${String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(cmd);
  return spec.some((s) => word(s.bin) && (!s.sub || s.sub.some(word)));
}

function tail(path, bytes) {
  try { const fd = openSync(path, "r"); const size = fstatSync(fd).size; const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len); closeSync(fd); return buf.toString("utf8"); } catch { return ""; }
}

/** git sync of the memory repo, detached so no hook ever waits on the network. Only when a remote is set. */
function sync(dir) {
  if (process.env.KEEPER_NO_SYNC || !existsSync(join(MEM, ".git"))) return;
  const sh = dir === "pull"
    ? `git rev-parse -q @{u} >/dev/null 2>&1 && git pull --rebase --autostash -q`
    : `git remote | grep -q . || exit 0; git add inbox; git diff --cached --quiet || git commit -qm "keeper: inbox from ${HOST}"; { git rev-parse -q @{u} >/dev/null 2>&1 && git pull --rebase --autostash -q || true; } && git push -q -u origin HEAD`;
  try { spawn("sh", ["-c", sh], { cwd: MEM, detached: true, stdio: "ignore" }).unref(); } catch {}
}

/** session state older than a week is dead weight. */
function sweep() {
  try {
    const d = join(STATE, "sessions");
    for (const f of readdirSync(d)) { const p = join(d, f); if (Date.now() - statSync(p).mtimeMs > 7 * 864e5) unlinkSync(p); }
  } catch {}
}
