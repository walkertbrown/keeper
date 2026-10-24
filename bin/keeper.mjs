#!/usr/bin/env node
// keeper's command line. `keeper help` lists what it does.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync, lstatSync, readlinkSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { HOME, ROOT, MEM, STATE, tilde, untilde, parse, areas, facts, gates, lifts } from "../lib/memory.mjs";
import { gradePrompt, humanTurns } from "../lib/grade.mjs";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...args] = process.argv.slice(2);
const git = (...a) => execFileSync("git", ["-C", MEM, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const die = (m) => { console.error(m); process.exit(1); };
const MARK = ["<!-- keeper -->", "<!-- /keeper -->"];
const IGNORE = "log/fired.jsonl\nlog/keeper/*.out\n";   // what stays on this machine

// Gates ship off. Each one is turned on by the user, by name.
const CATALOG = [
  { id: "push", on: false, say: "pushing needs the user's yes each time.", cmd: [{ bin: "git", sub: ["push"], unless: ["--dry-run", "-n"] }] },
  { id: "commit", on: false, say: "committing needs the user's yes each time.", cmd: [{ bin: "git", sub: ["commit"], unless: ["--dry-run"] }] },
  { id: "force-push", on: false, say: "a force push rewrites shared history.", cmd: [{ bin: "git", sub: ["push"], flags: ["f", "force", "force-with-lease"] }] },
  { id: "rm-recursive", on: false, say: "a recursive delete needs the user's yes.", cmd: [{ bin: "rm", flags: ["r", "R", "recursive"] }] },
  { id: "kill-pattern", on: false, say: "kill by process id, never by name or pattern.", cmd: [{ bin: "pkill" }, { bin: "killall" }] },
  { id: "deploy", on: false, say: "deploying needs the user's yes each time.", cmd: [] },
  { id: "protected-files", on: false, say: "these files are edited only by the user.", tools: ["Write", "Edit", "NotebookEdit"], paths: [] },
];

const HELP = `keeper — rules that hold

  keeper init [git-remote-url]   create the memory at ${tilde(MEM)} (and link a private remote)
  keeper status                  what is in memory, which gates are on, what is lifted
  keeper gates                   the gate catalog
  keeper gate on|off <id>        turn a gate on or off
  keeper lift <id> [hours]       open a gate for THIS directory (default 4 hours); run it on its own
  keeper corrections [days]      corrections found in your past Claude Code transcripts (default 60 days)
  keeper check-import <map.json> prove an import lost nothing
  keeper link | unlink           add or remove keeper's one line in ~/.claude/CLAUDE.md
  keeper nightly [audit]         run the keeper now on this machine (needs \`claude\`); Sundays add the audit
  keeper schedule                the crontab line that runs it every night at 2:30 AM
  keeper action review|auto      run it on GitHub instead: review opens a pull request, auto commits
  keeper export [file]           write all rules and facts as one CLAUDE.md-style file
  keeper uninstall               remove keeper's CLAUDE.md line and shim; the memory stays`;

switch (cmd) {
  case "init": init(args[0]); break;
  case "status": status(); break;
  case "gates": for (const g of gatesFile().gates) console.log(`${g.on ? "ON " : "off"}  ${g.id.padEnd(16)} ${g.say}${needsSetup(g) ? "  (needs setup: name the command or paths in gates.json)" : ""}`); break;
  case "gate": gate(args[0], args[1]); break;
  case "lift": lift(args[0], Number(args[1] ?? 4)); break;
  case "corrections": corrections(Number(args[0] ?? 60)); break;
  case "check-import": checkImport(args[0]); break;
  case "link": link(true); break;
  case "unlink": link(false); break;
  case "nightly": nightly(args[0]); break;
  case "schedule": schedule(); break;
  case "action": action(args[0]); break;
  case "export": exportAll(args[0]); break;
  case "uninstall": uninstall(); break;
  default: console.log(HELP); if (cmd && cmd !== "help") process.exit(1);
}

function init(remote) {
  for (const d of ["rules", "facts", "inbox/corrections", "log"]) mkdirSync(join(MEM, d), { recursive: true });
  const put = (p, s) => { if (!existsSync(join(MEM, p))) writeFileSync(join(MEM, p), s); };
  put("rules/global.md", "");
  put("gates.json", JSON.stringify({ gates: CATALOG }, null, 1) + "\n");
  put(".gitignore", IGNORE);
  put("README.md", `# keeper memory\n\nrules/global.md is always loaded. rules/<area>.md loads when its \`when:\` matches.\nfacts/ hold what is true. gates.json holds the gates. inbox/ is what the keeper settles nightly.\n`);
  if (!existsSync(join(MEM, ".git"))) {
    git("init", "-q");
    // a machine with no git identity still gets a working memory; the user's own identity wins when set
    try { git("config", "user.email"); } catch { git("config", "user.name", "keeper"); git("config", "user.email", "keeper@localhost"); }
    git("add", "-A"); git("commit", "-qm", "keeper: new memory");
  }
  if (remote) { try { git("remote", "add", "origin", remote); } catch { git("remote", "set-url", "origin", remote); } console.log(`remote set; first push: git -C ${tilde(MEM)} push -u origin HEAD`); }
  // a `keeper` on PATH, so the model and the user can run it from anywhere
  const bin = join(HOME, ".local", "bin"); mkdirSync(bin, { recursive: true });
  const shim = join(bin, "keeper");
  try { if (lstatSync(shim).isSymbolicLink()) unlinkSync(shim); } catch {}
  if (!existsSync(shim)) symlinkSync(join(PLUGIN, "bin", "keeper.mjs"), shim);
  console.log(`memory at ${tilde(MEM)}; \`keeper\` at ${tilde(shim)}${process.env.PATH?.split(":").includes(bin) ? "" : ` (add ${tilde(bin)} to PATH)`}`);
}

function status() {
  if (!existsSync(join(MEM, "rules"))) die("no memory yet: keeper init");
  const g = (readFileSync(join(MEM, "rules", "global.md"), "utf8").match(/^- /gm) ?? []).length;
  const a = areas(); const f = facts();
  console.log(`global rules  ${g}\narea files    ${a.length} (${a.reduce((n, x) => n + (x.body.match(/^- /gm) ?? []).length, 0)} rules; ${a.filter((x) => x.followed).length} measurable)\nfacts         ${f.length}`);
  console.log(`gates on      ${gates().filter((x) => x.on).map((x) => x.id).join(", ") || "none"}`);
  for (const l of lifts()) console.log(`lifted        ${l.id} in ${tilde(l.dir)} until ${new Date(l.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  let waiting = 0; try { for (const x of readdirSync(join(MEM, "inbox", "corrections"))) waiting += readFileSync(join(MEM, "inbox", "corrections", x), "utf8").split("\n").filter(Boolean).length; } catch {}
  console.log(`inbox         ${waiting} correction(s) waiting for the keeper`);
}

function gatesFile() { try { return JSON.parse(readFileSync(join(MEM, "gates.json"), "utf8")); } catch { return { gates: CATALOG }; } }
function needsSetup(g) { return (Array.isArray(g.cmd) && !g.cmd.length && !g.paths?.length) || (g.paths && !g.paths.length && !g.cmd); }
function gate(onoff, id) {
  if (!["on", "off"].includes(onoff) || !id) die("keeper gate on|off <id>");
  const f = gatesFile(); const g = f.gates.find((x) => x.id === id); if (!g) die(`no gate ${id}; see keeper gates`);
  if (onoff === "on" && needsSetup(g)) die(`${id} needs setup first: in ${tilde(join(MEM, "gates.json"))} give it ${g.paths ? '"paths": ["~/project/.env"]' : '"cmd": [{"bin": "deploy.sh"}]'}`);
  g.on = onoff === "on"; writeFileSync(join(MEM, "gates.json"), JSON.stringify(f, null, 1) + "\n");
  console.log(`${id} ${onoff}`);
}

function lift(id, hours) {
  if (!id) die("keeper lift <id> [hours]");
  if (!gates().some((g) => g.id === id)) die(`no gate ${id}`);
  const dir = process.cwd();
  const all = lifts().filter((l) => !(l.id === id && l.dir === dir));
  const until = new Date(Date.now() + hours * 36e5);
  all.push({ id, dir, until: until.toISOString() });
  mkdirSync(STATE, { recursive: true }); writeFileSync(join(STATE, "lifts.json"), JSON.stringify(all, null, 1));
  console.log(`lifted ${id} for ${tilde(dir)} until ${until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
}

/** every correction in the user's own transcripts: what they said, and what Claude had just done. */
function corrections(days) {
  const base = join(HOME, ".claude", "projects"); const since = Date.now() - days * 864e5;
  let n = 0;
  for (const proj of safeDir(base)) for (const f of safeDir(join(base, proj)).filter((x) => x.endsWith(".jsonl"))) {
    const p = join(base, proj, f); if (statSync(p).mtimeMs < since) continue;
    const text = readFileSync(p, "utf8");
    const lastTool = toolsBefore(text);
    for (const t of humanTurns(text)) {
      const g = gradePrompt(t.text); if (!g || (t.ts && Date.parse(t.ts) < since)) continue;
      console.log(JSON.stringify({ ts: t.ts, project: proj, session: f.slice(0, 8), ...g, said: t.text.slice(0, 300), after: lastTool(t.ts) }));
      n++;
    }
  }
  console.error(`${n} correction(s) in the last ${days} days`);
}
function toolsBefore(text) {
  const calls = [];
  for (const line of text.split("\n")) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant" || !Array.isArray(d.message?.content)) continue;
    for (const c of d.message.content) if (c.type === "tool_use") calls.push({ ts: d.timestamp, what: `${c.name}: ${String(c.input?.command ?? c.input?.file_path ?? c.input?.description ?? "").slice(0, 160)}` });
  }
  return (ts) => calls.filter((c) => !ts || c.ts < ts).slice(-3).map((c) => c.what);
}
function safeDir(d) { try { return readdirSync(d); } catch { return []; } }

/**
 * The import map: [{ source: "path:line", text, to, reason? , as? }].
 *   to     "rules/global.md" | "rules/<area>.md" | "facts/<slug>.md" | "dropped"
 *   as     the wording it was filed under, when it was not kept verbatim
 *   reason required for "dropped", and for "as"
 * Every non-blank, non-heading line of every source file must be in the map, and every
 * line that went somewhere must be found there. What fails is printed; exit 1.
 */
function checkImport(mapPath) {
  if (!mapPath) die("keeper check-import <map.json>");
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const norm = (s) => String(s).toLowerCase().replace(/^[\s>*-]+|\d+\.\s+/g, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  const problems = [];
  const sources = [...new Set(map.map((m) => m.source.replace(/:\d+$/, "")))];
  for (const src of sources) {
    const lines = readFileSync(untilde(src), "utf8").split("\n");
    let fm = lines[0] === "---";
    lines.forEach((l, i) => {
      if (fm) { if (i > 0 && l === "---") fm = false; return; }
      if (!norm(l) || /^#|^```|^<!--|^---$/.test(l.trim())) return;
      if (!map.some((m) => m.source === `${src}:${i + 1}`)) problems.push(`not mapped  ${src}:${i + 1}  ${l.trim().slice(0, 100)}`);
    });
  }
  for (const m of map) {
    if (m.to === "dropped") { if (!m.reason) problems.push(`dropped with no reason  ${m.source}`); continue; }
    if (m.as && !m.reason) problems.push(`reworded with no reason  ${m.source}`);
    let dest = ""; try { dest = norm(readFileSync(join(MEM, m.to), "utf8")); } catch { problems.push(`missing file  ${m.to}  (from ${m.source})`); continue; }
    if (!dest.includes(norm(m.as ?? m.text))) problems.push(`not found in ${m.to}  ${m.source}  ${String(m.as ?? m.text).slice(0, 80)}`);
  }
  const dropped = map.filter((m) => m.to === "dropped"), reworded = map.filter((m) => m.as);
  console.log(`${map.length} lines from ${sources.length} file(s): ${map.length - dropped.length} kept (${reworded.length} reworded), ${dropped.length} dropped`);
  for (const m of dropped) console.log(`  dropped   ${m.text.slice(0, 90)}  — ${m.reason}`);
  for (const m of reworded) console.log(`  reworded  ${m.text.slice(0, 60)}  →  ${m.as.slice(0, 60)}  — ${m.reason}`);
  if (problems.length) { console.log(`\nNOT CLEAN — ${problems.length} problem(s):`); for (const p of problems) console.log("  " + p); process.exit(1); }
  console.log("\nclean: every source line is accounted for");
}

function link(on) {
  const p = join(HOME, ".claude", "CLAUDE.md");
  let s = existsSync(p) ? readFileSync(p, "utf8") : "";
  const re = new RegExp(`\\n?${MARK[0]}[\\s\\S]*?${MARK[1]}\\n?`, "g");
  s = s.replace(re, "\n").replace(/\n{3,}$/, "\n\n");
  if (on) s = s.replace(/\s*$/, "\n\n") + `${MARK[0]}\nYour rules and facts are kept by keeper in ${tilde(MEM)}. They arrive when they apply; you do not need to read them up front. To remember something new, use /keeper remember.\n${MARK[1]}\n`;
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s.replace(/^\n+/, ""));
  console.log(on ? `linked in ${tilde(p)}` : `unlinked from ${tilde(p)}`);
}

/** put the keeper's brief and runner into the memory repo, committed, so the Action and cron run the same thing */
function installRunner() {
  if (!existsSync(join(MEM, ".git"))) die("no memory yet: keeper init");
  mkdirSync(join(MEM, ".keeper"), { recursive: true });
  for (const f of ["KEEPER.md", "run.sh"]) writeFileSync(join(MEM, ".keeper", f), readFileSync(join(PLUGIN, "nightly", f)), { mode: 0o755 });
  const gi = join(MEM, ".gitignore"); const have = existsSync(gi) ? readFileSync(gi, "utf8").split("\n").filter(Boolean) : [];
  writeFileSync(gi, [...new Set([...have, ...IGNORE.trim().split("\n")])].join("\n") + "\n");
  git("add", ".keeper", ".gitignore");
  try { git("diff", "--cached", "--quiet"); } catch { git("commit", "-qm", "keeper: runner updated"); }
}

function nightly(which) {
  installRunner();
  const run = (m) => { try { execFileSync("sh", [join(MEM, ".keeper", "run.sh"), m], { stdio: "inherit" }); return true; } catch { return false; } };
  let ok = which === "audit" ? run("audit") : run("nightly") && (new Date().getDay() !== 0 || run("audit"));
  try {
    if (git("remote").trim()) {
      let upstream = true; try { git("rev-parse", "@{u}"); } catch { upstream = false; }
      if (upstream) git("pull", "--rebase", "--autostash", "-q");
      git("push", "-q", "-u", "origin", "HEAD");
    }
  } catch (e) { ok = false; console.error(`push failed: ${String(e.stderr ?? e).trim()}`); }
  process.exit(ok ? 0 : 1);
}

function schedule() {
  const node = process.execPath;
  let claude = ""; try { claude = execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim(); } catch {}
  if (!claude) die("`claude` is not on PATH here; the nightly run needs Claude Code installed.");
  const path = [...new Set([dirname(node), dirname(claude), "/usr/bin", "/bin"])].join(":");
  console.log(`Add this line to your crontab (\`crontab -e\`):\n\n30 2 * * * PATH=${path} ${node} ${join(PLUGIN, "bin", "keeper.mjs")} nightly >> ${join(ROOT, "nightly.log")} 2>&1\n`);
  console.log(`It runs at 2:30 AM on this machine's clock and uses your Claude Code login. Run it once by hand first: keeper nightly`);
}

function action(mode) {
  if (!["review", "auto"].includes(mode)) die("keeper action review|auto\n  review: each night's changes arrive as a pull request you merge or close\n  auto:   the keeper commits straight to your memory");
  installRunner();
  mkdirSync(join(MEM, ".github", "workflows"), { recursive: true });
  writeFileSync(join(MEM, ".github", "workflows", "keeper.yml"), readFileSync(join(PLUGIN, "nightly", "workflow.yml"), "utf8").replaceAll("__MODE__", mode));
  git("add", ".github"); try { git("diff", "--cached", "--quiet"); } catch { git("commit", "-qm", `keeper: nightly on GitHub (${mode})`); }
  let remote = ""; try { remote = git("remote", "get-url", "origin").trim(); } catch {}
  console.log(`Workflow written and committed (${mode}).${remote ? "" : "\nThere is no remote yet: make a PRIVATE GitHub repo, then  keeper init <its url>  and push."}
Then, on GitHub, in the memory repo's Settings:
  1. Secrets and variables → Actions → add ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN, from \`claude setup-token\`).${mode === "review" ? "\n  2. Actions → General → allow GitHub Actions to create pull requests." : ""}
Push (git -C ${tilde(MEM)} push), then run it once from the Actions tab to see it work.`);
}

function exportAll(file) {
  let s = `# Rules and facts (exported from keeper ${new Date().toISOString().slice(0, 10)})\n\n## Everywhere\n\n${readFileSync(join(MEM, "rules", "global.md"), "utf8").trim()}\n`;
  for (const a of areas()) s += `\n## ${a.id.replace("rules/", "")}${a.when.cwd ? ` (in ${a.when.cwd.join(", ")})` : ""}\n\n${a.body}\n`;
  const f = facts(); if (f.length) s += `\n## Facts\n\n${f.map((x) => `- ${x.gist}${x.as_of ? ` (as of ${x.as_of})` : ""}`).join("\n")}\n`;
  if (file) { writeFileSync(file, s); console.log(`wrote ${file}`); } else process.stdout.write(s);
}

function uninstall() {
  link(false);
  const shim = join(HOME, ".local", "bin", "keeper");
  try { if (lstatSync(shim).isSymbolicLink() && readlinkSync(shim).startsWith(PLUGIN)) { unlinkSync(shim); console.log(`removed ${tilde(shim)}`); } } catch {}
  console.log(`\nYour memory stays at ${tilde(MEM)}. To keep your rules as one CLAUDE.md, do this BEFORE the last step:\n  node ${tilde(join(PLUGIN, "bin", "keeper.mjs"))} export ~/keeper-export.md\nLast step, in Claude Code: /plugin uninstall keeper\nIf you set up \`keeper schedule\`, remove its crontab line too.`);
}
