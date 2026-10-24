// What a Bash command actually runs, for gates.
//
// A gate that matches the command TEXT refuses a grep for "git push" and a heredoc
// that mentions commit. This reads the command the way the shell will: heredoc bodies
// are data, quotes make one word, `;` `&&` `|` split commands, and only argv[0] of
// each command is the program. What runs inline is read too: `bash -c '…'`, `$( … )`,
// and a heredoc fed to a shell. A script on disk is not opened.
//
// Fails closed: anything this cannot parse throws, and the gate refuses.
import { resolve } from "node:path";
import { homedir } from "node:os";

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time", "case", "esac", "function"]);
const MAX_DEPTH = 3;

/** heredoc bodies out of the text; returned so a body fed to a shell can still be read. */
function cutHeredocs(src) {
  const lines = src.split("\n"); const out = []; const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; out.push(line);
    const tags = [...line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w]*)\2/g)];
    for (const t of tags) {
      const strip = t[1] === "-"; const body = [];
      while (++i < lines.length) {
        const l = strip ? lines[i].replace(/^\t+/, "") : lines[i];
        if (l === t[3]) break;
        body.push(lines[i]);
      }
      bodies.push({ line: out.length - 1, body: body.join("\n") });
    }
  }
  return { text: out.join("\n"), bodies };
}

/** words of each simple command, plus the text of every $( ) and `` ` `` inside it. */
function tokenize(text) {
  const cmds = []; let words = []; let w = null; const subs = [];
  let lineNo = 0; let startLine = 0;
  const push = () => { if (w !== null) { words.push(w); w = null; } };
  const end = () => { push(); if (words.length) cmds.push({ words, line: startLine }); words = []; startLine = lineNo; };
  const grab = (i, open, close) => {        // balanced $( ... ) — returns [inner, nextIndex]
    let depth = 1, j = i, q = null;
    for (; j < text.length; j++) {
      const c = text[j];
      if (q) { if (c === "\\" && q === '"') j++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"') q = c;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) break;
    }
    if (depth) throw new Error("unbalanced");
    return [text.slice(i, j), j + 1];
  };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === "\n") { lineNo++; end(); i++; continue; }
    if (c === "\\" && text[i + 1] === "\n") { lineNo++; i += 2; continue; }
    if (c === " " || c === "\t") { push(); i++; continue; }
    if (c === "#" && w === null) { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === ";" || c === "|" || c === "(" || c === ")") { end(); i += (text[i + 1] === c && c !== "(" && c !== ")") ? 2 : 1; continue; }
    if (c === "&") {
      if (text[i + 1] === "&") { end(); i += 2; continue; }
      if (text[i + 1] === ">") { push(); i += 2; if (text[i] === ">") i++; while (text[i] === " ") i++; while (i < text.length && !/[\s;&|()]/.test(text[i])) i++; continue; }
      end(); i++; continue;
    }
    if (c === ">" || c === "<") {
      if (c === "<" && text[i + 1] === "<") {               // heredoc marker or here-string: the word after is data
        push(); i += 2; if (text[i] === "<" || text[i] === "-") i++;
        while (text[i] === " ") i++;
        let q = null; while (i < text.length && (q || !/[\s;&|()]/.test(text[i]))) { if (q ? text[i] === q : (text[i] === "'" || text[i] === '"')) q = q ? null : text[i]; i++; }
        continue;
      }
      if (w !== null && /^\d+$/.test(w)) w = null;         // 2>  — the fd number is not a word
      push(); i++; if (text[i] === ">" || text[i] === "&") i++;
      while (text[i] === " ") i++;
      if (text[i] === "(") { const [, n] = grab(i + 1, "(", ")"); i = n; continue; }
      let q = null; while (i < text.length && (q || !/[\s;&|()<>]/.test(text[i]))) { if (q ? text[i] === q : (text[i] === "'" || text[i] === '"')) q = q ? null : text[i]; i++; }
      continue;
    }
    if (c === "'") { const j = text.indexOf("'", i + 1); if (j < 0) throw new Error("open quote"); w = (w ?? "") + text.slice(i + 1, j); i = j + 1; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length) { s += text[++j]; continue; }
        if (text[j] === "$" && text[j + 1] === "(") { const [inner, n] = grab(j + 2, "(", ")"); subs.push(inner); s += "\u0000"; j = n - 1; continue; }
        if (text[j] === "`") { const k = text.indexOf("`", j + 1); if (k < 0) throw new Error("open backtick"); subs.push(text.slice(j + 1, k)); s += "\u0000"; j = k; continue; }
        s += text[j];
      }
      if (j >= text.length) throw new Error("open quote");
      w = (w ?? "") + s; i = j + 1; continue;
    }
    if (c === "$" && text[i + 1] === "(") { const [inner, n] = grab(i + 2, "(", ")"); subs.push(inner); w = (w ?? "") + "\u0000"; i = n; continue; }
    if (c === "`") { const k = text.indexOf("`", i + 1); if (k < 0) throw new Error("open backtick"); subs.push(text.slice(i + 1, k)); w = (w ?? "") + "\u0000"; i = k + 1; continue; }
    if (c === "\\") { w = (w ?? "") + (text[i + 1] ?? ""); i += 2; continue; }
    w = (w ?? "") + c; i++;
  }
  end();
  return { cmds, subs };
}

const expand = (s, vars) => s
  .replace(/^~(?=\/|$)/, homedir())
  .replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_, k) => vars[k] ?? process.env[k] ?? "");

/**
 * Every program invocation in a Bash command: [{ argv, cwd }], cwd being the
 * directory it runs in after any `cd` earlier in the same command.
 */
export function invocations(src, cwd, depth = 0, vars = {}) {
  if (depth > MAX_DEPTH) return [];
  const { text, bodies } = cutHeredocs(src);
  const { cmds, subs } = tokenize(text);
  const out = [];
  for (const s of subs) out.push(...invocations(s, cwd, depth + 1, vars));
  for (const { words, line } of cmds) {
    let a = words.slice();
    while (a.length && KEYWORDS.has(a[0])) a.shift();
    if (a[0] === "for" || a[0] === "select") continue;
    while (a.length && /^[A-Za-z_]\w*=/.test(a[0])) { const [k, ...v] = a.shift().split("="); vars[k] = expand(v.join("="), vars); }
    // prefixes that run the rest as a command
    for (let changed = true; changed && a.length;) {
      changed = false;
      const p = a[0].split("/").pop();
      if (["sudo", "command", "exec", "nohup", "builtin", "stdbuf", "env", "xargs", "nice", "ionice", "timeout", "chronic"].includes(p)) {
        a.shift(); changed = true;
        while (a.length && (a[0].startsWith("-") || /^[A-Za-z_]\w*=/.test(a[0]))) { const f = a.shift(); if (/^-(n|u|g|c|s|k|I|L|P|d)$/.test(f) && p !== "env") a.shift(); }
        if (p === "timeout" && a.length && /^\d/.test(a[0])) a.shift();
      }
    }
    if (!a.length) continue;
    a = a.map((x) => x.includes("\u0000") ? x : expand(x, vars));
    const bin = a[0].split("/").pop();
    if (bin === "cd") { cwd = resolve(cwd, a[1] ? expand(a[1], vars) : homedir()); continue; }
    out.push({ argv: a, cwd });
    if (SHELLS.has(bin)) {
      const ci = a.indexOf("-c");
      if (ci > 0 && a[ci + 1] != null) { out.push(...invocations(a[ci + 1], cwd, depth + 1, { ...vars })); continue; }
      if (a.slice(1).some((x) => !x.startsWith("-"))) continue;   // a script on disk: not opened (below)
      const b = bodies.find((h) => h.line === line);
      if (b) out.push(...invocations(b.body, cwd, depth + 1, { ...vars }));
      continue;
    }
  }
  return out;
}

// git's options that come BEFORE the subcommand and take a value
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** the subcommand of a git-like argv, and the directory it acts on (`git -C dir`). */
export function subcommand(argv, cwd) {
  let dir = cwd;
  for (let i = 1; i < argv.length; i++) {
    const x = argv[i];
    if (GIT_VALUED.has(x)) { if (x === "-C") dir = resolve(dir, argv[i + 1] ?? ""); i++; continue; }
    if (x.startsWith("-")) continue;
    return { sub: x, rest: argv.slice(i + 1), dir };
  }
  return { sub: null, rest: [], dir };
}

/** does argv carry one of these flags? "r" matches -r and any cluster like -rf; "force" matches --force. */
function hasFlag(args, flags) {
  return args.some((a) => {
    if (a === "--") return false;
    if (a.startsWith("--")) return flags.includes(a.slice(2).split("=")[0]);
    if (/^-[A-Za-z]+$/.test(a)) return [...a.slice(1)].some((c) => flags.includes(c));
    return false;
  });
}

/**
 * Does this command run something a gate names? spec = [{bin, sub?, flags?, unless?}].
 *   bin    program name (basename)
 *   sub    subcommands, git-style (`git -C dir push` -> push, acting on dir)
 *   flags  at least one of these must be present ("f", "force", "r")
 *   unless none of these args may be present ("--dry-run")
 * Returns the directories the matching invocations act in (empty = no match).
 */
export function cmdMatches(spec, command, cwd) {
  const dirs = [];
  for (const { argv, cwd: at } of invocations(command, cwd)) {
    const bin = argv[0].split("/").pop();
    for (const s of spec) {
      if (s.bin !== bin) continue;
      let rest = argv.slice(1), dir = at;
      if (s.sub) {
        const sc = subcommand(argv, at);
        if (!s.sub.includes(sc.sub)) continue;
        rest = sc.rest; dir = sc.dir;
      }
      if (Array.isArray(s.flags) && !hasFlag(rest, s.flags)) continue;
      if (Array.isArray(s.unless) && rest.some((r) => s.unless.includes(r))) continue;
      dirs.push(dir);
    }
  }
  return dirs;
}
