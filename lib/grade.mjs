// What a correction looks like. Shared by the live hook and `keeper corrections`
// (over old transcripts), so the two never disagree about what counts.
/** A paste (a file reference, JSON, a URL, mostly symbols) is not a correction. */
export function isPaste(p) {
  if (/^[@\[{<]|^https?:\/\//.test(p)) return true;
  const letters = (p.match(/[a-z]/gi) ?? []).length;
  return letters < p.length * 0.45;
}
export function gradePrompt(prompt) {
  const p = String(prompt ?? "").trim();
  if (!p || p.length > 600 || p.startsWith("/") || isPaste(p)) return null;
  const low = p.toLowerCase();
  const first = low.slice(0, 40);
  // Talk ABOUT rules is not a rule: a rule leads with an imperative or says what the rule IS.
  if (/(^|[.!?]\s+)(always|never|from now on|every time|don't ever|do not ever)\b/.test(low)
      || /\b(the|a|new|another) rule (is|should be|will be|from now)\b/.test(low)
      || /\bmake (that|this|it) a rule\b/.test(low))
    return { signal: "stated-rule", grade: "high" };
  if (/^(no[,.!\s]|nope|wait|stop|hold on|back off|that's not|that is not|thats not|wrong|not what i)/.test(first))
    return { signal: "stop", grade: "medium" };
  if (/^(i meant|i said|i asked|not that|instead|i told you|i already|again[,.]|why did you)/.test(first) || /\b(i said|i told you|i asked for|i already said)\b/.test(low))
    return { signal: "redirect", grade: "medium" };
  if (/\bback off\b/.test(low)) return { signal: "stop", grade: "medium" };
  // Not a bare "don't …" opener: "Do not use any tools" is an instruction, not a correction.
  if (/\b(you don't need to|i don't want you to|don't do that|not again)\b/.test(low))
    return { signal: "redirect", grade: "medium" };
  return null;
}

export const toks = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
export function jaccard(a, b) {
  const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}
/** A repeated instruction: ≥0.6 overlap with an earlier prompt in the same session. */
export function repeats(prompt, earlier) {
  // Recent only: over a whole conversation, short routine prompts repeat by nature.
  if (String(prompt).length < 40 || isPaste(String(prompt))) return false;
  return earlier.slice(-30).some((e) => e !== prompt && String(e).length <= 600 && jaccard(prompt, e) >= 0.6);
}

/** The human turns of a Claude Code transcript (.jsonl), in order. Tool results and wrappers stripped. */
export function humanTurns(jsonlText) {
  const out = [];
  for (const line of jsonlText.split("\n")) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "user") continue;
    const c = d.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) { if (c.some((x) => x.type === "tool_result")) continue; text = c.filter((x) => x.type === "text").map((x) => x.text).join(" "); }
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<local-command-[\s\S]*$/g, "").trim();
    // The harness speaks in the user role (notifications, command output); none of that is the user.
    if (!text || text.startsWith("[Request interrupted") || text.startsWith("<")) continue;
    out.push({ ts: d.timestamp ?? null, text });
  }
  return out;
}
