// Where keeper's memory lives and how its files are read. No dependencies.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, basename } from "node:path";

export const HOME = homedir();
export const ROOT = process.env.KEEPER_HOME || join(HOME, ".keeper");
export const MEM = process.env.KEEPER_MEMORY || join(ROOT, "memory");
export const STATE = join(ROOT, "state");
export const HOST = (process.env.KEEPER_HOST || hostname().split(".")[0]).toLowerCase().replace(/[^\w-]/g, "");

export const tilde = (p) => String(p ?? "").replace(HOME, "~");
export const untilde = (p) => String(p ?? "").replace(/^~(?=\/|$)/, HOME);

/**
 * Frontmatter, a strict small subset of YAML so there is no parser to install:
 *   key: plain text            key: ["json", "array"]           key: {"json": "object"}
 *   when:                      (one level of nesting, same value forms)
 *     cwd: ["~/work/**"]
 */
export function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {}; let parent = null;
  for (const raw of m[1].split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const nested = /^\s+/.test(raw);
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(raw); if (!kv) continue;
    const [, k, v] = kv;
    const val = value(v);
    if (nested && parent) meta[parent][k] = val;
    else if (v.trim() === "") { meta[k] = {}; parent = k; }
    else { meta[k] = val; parent = null; }
  }
  return { meta, body: text.slice(m[0].length) };
}
function value(v) {
  v = v.trim();
  if (/^[\[{"]/.test(v)) { try { return JSON.parse(v); } catch {} }
  return v;
}

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const mdIn = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; } };

/** rules/global.md, whole. */
export const globalRules = () => read(join(MEM, "rules", "global.md"));

/** every area rule file: {id, when, followed, body} — id is "rules/<name>". */
export function areas() {
  return mdIn(join(MEM, "rules")).filter((f) => f !== "global.md").map((f) => {
    const { meta, body } = parse(read(join(MEM, "rules", f)) ?? "");
    return { id: `rules/${basename(f, ".md")}`, when: meta.when ?? {}, followed: Array.isArray(meta.followed) ? meta.followed : null, body: body.trim() };
  });
}

/** every open fact: {id, gist, when}. A fact with closed: set is history, not memory. */
export function facts() {
  return mdIn(join(MEM, "facts")).map((f) => {
    const { meta } = parse(read(join(MEM, "facts", f)) ?? "");
    return { id: `facts/${basename(f, ".md")}`, gist: meta.gist ?? "", as_of: meta.as_of ?? "", when: meta.when ?? {}, closed: meta.closed };
  }).filter((x) => !x.closed && x.gist);
}

export function gates() {
  try { return JSON.parse(read(join(MEM, "gates.json"))).gates ?? []; } catch { return []; }
}

/** ~ expanded, ** any depth, * one segment, ? one char. A trailing /** also matches the dir itself. */
export function globRe(g) {
  const s = untilde(g);
  const conv = (t) => {
    let re = "";
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === "*" && t[i + 1] === "*") { re += ".*"; i++; }
      else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return re;
  };
  return s.endsWith("/**") ? new RegExp(`^${conv(s.slice(0, -3))}(/.*)?$`) : new RegExp(`^${conv(s)}$`);
}
export const anyGlob = (globs, p) => !!p && Array.isArray(globs) && globs.some((g) => globRe(g).test(p));

// ── session state: what this conversation has already been given
export function loadSession(id) {
  const blank = { whole: {}, lines: {}, facts: {}, n: 0 };
  if (!id) return blank;
  try { return { ...blank, ...JSON.parse(readFileSync(join(STATE, "sessions", `${id}.json`), "utf8")) }; } catch { return blank; }
}
export function saveSession(id, s) {
  if (!id) return;
  try { mkdirSync(join(STATE, "sessions"), { recursive: true }); writeFileSync(join(STATE, "sessions", `${id}.json`), JSON.stringify(s)); } catch {}
}

// ── lifts: a gate opened for one directory, for a while
export function lifts() {
  try { return JSON.parse(readFileSync(join(STATE, "lifts.json"), "utf8")).filter((l) => Date.parse(l.until) > Date.now()); } catch { return []; }
}
export const isLifted = (id, dir) => lifts().some((l) => l.id === id && (dir === l.dir || dir.startsWith(l.dir + "/")));

export const hasMemory = () => existsSync(join(MEM, "rules"));
