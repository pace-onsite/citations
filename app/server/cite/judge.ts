/**
 * Judgment: turn a ranked candidate list into a decision.
 *
 * Deterministic rules handle the clear cases (unique strong match, nothing
 * found, blanks, booleans). Ambiguous scalar fields — several plausible
 * locations, or a weak top score — go to a small LLM judge *if* a key is
 * configured (OPENAI_API_KEY). The judge only picks candidate ids; it never
 * produces a location. Without a key, the deterministic ranking is used and
 * the reasoning says so.
 */
import type { Candidate, FieldJob, Judgment } from "./types.ts";

export interface JudgeOptions {
  llm: boolean;
  cap: number;
  model?: string;
}

const PRICES: Record<string, { in: number; out: number }> = {
  // USD per 1M tokens
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1-nano": { in: 0.1, out: 0.4 },
  "gpt-4.1": { in: 2, out: 8 },
};
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICES[model] ?? { in: 0.5, out: 1.5 };
  return (promptTokens * p.in + completionTokens * p.out) / 1e6;
}

export const llmConfigured = () => Boolean(process.env.OPENAI_API_KEY);

const summarize = (c: Candidate) => `${c.locator}: "${c.quote.length > 50 ? c.quote.slice(0, 50) + "…" : c.quote}" (${c.score.toFixed(2)})`;

export async function judge(job: FieldJob, candidates: Candidate[], opts: JudgeOptions): Promise<Judgment> {
  switch (job.cls) {
    case "container":
      return { decision: "empty", selected: [], confidence: 1, reasoning: "Container value; its leaves are cited individually.", method: "skip" };
    case "prose":
      return { decision: "empty", selected: [], confidence: 0.5, reasoning: "Free-text value; not citable by span matching. Review the narrative source manually.", method: "skip:prose" };
    case "rule-constant":
      return { decision: "empty", selected: [], confidence: 0.7, reasoning: `"${String(job.value)}" is produced by a rule in the field definition, not read from a document.`, method: "rule-constant" };
    case "blank":
      return judgeBlank(job, candidates);
    case "boolean-presence":
      return judgeBooleanPresence(job, candidates);
    case "boolean-source":
      return judgeTop(job, candidates, { threshold: 0.6, method: "json-boolean", cap: 1 });
    case "zero":
      return judgeZero(job, candidates, opts);
    default:
      return judgeScalar(job, candidates, opts);
  }
}

// ---------------------------------------------------------------------------

function judgeTop(job: FieldJob, cands: Candidate[], o: { threshold: number; method: string; cap: number }): Judgment {
  const top = cands[0];
  if (!top || top.score < o.threshold) {
    return { decision: "empty", selected: [], confidence: top ? 1 - top.score : 0.8, reasoning: top ? `Best candidate ${summarize(top)} is below the ${o.threshold} threshold: ${[...top.penalties, ...top.reasons].join("; ")}.` : "No source location matches this value.", method: o.method };
  }
  const picked = pickDistinct(cands.filter((c) => c.score >= Math.max(o.threshold, top.score - 0.15)), o.cap);
  return { decision: "cite", selected: picked.map((c) => ({ id: c.id, role: "value" as const })), confidence: top.score, reasoning: explain(picked, cands), method: o.method };
}

function explain(picked: Candidate[], all: Candidate[]): string {
  const parts: string[] = [];
  for (const c of picked) parts.push(`${c.locator}: ${c.reasons.join("; ")}${c.penalties.length ? ` (but: ${c.penalties.join("; ")})` : ""}.`);
  const rejected = all.filter((c) => !picked.includes(c)).slice(0, 3);
  const floor = picked.length ? Math.min(...picked.map((c) => c.score)) : 1;
  const why = (c: Candidate) => {
    if (c.penalties.length) return c.penalties[0];
    if (c.score >= floor - 0.011) return picked.some((p) => p.file === c.file && p.locator.split(" ")[1] === c.locator.split(" ")[1]) ? "same page already cited" : "over the citation cap";
    return "weaker context";
  };
  if (rejected.length) parts.push(`Rejected ${all.length - picked.length} other occurrence${all.length - picked.length === 1 ? "" : "s"}, e.g. ${rejected.map((c) => `${c.locator} (${why(c)})`).join("; ")}.`);
  return parts.join(" ");
}

/** Best candidate per file (and per page for PDFs), highest first, capped. */
function pickDistinct(cands: Candidate[], cap: number): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of [...cands].sort((a, b) => b.score - a.score)) {
    const key = c.unit.kind === "ocr-line" ? `${c.file}#${c.unit.page}` : c.file;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= cap) break;
  }
  return out;
}

const hasContextSupport = (c: Candidate) => Boolean(c.labelRange) || c.rowBound || c.reasons.some((r) => /^(label|key|column header|boolean key|preceded by related)/.test(r));

async function judgeScalar(job: FieldJob, cands: Candidate[], opts: JudgeOptions): Promise<Judgment> {
  if (!cands.length) return { decision: "empty", selected: [], confidence: 0.8, reasoning: `"${String(job.value)}" was not found in any source file (searched ${job.variants.length} spelling variant${job.variants.length === 1 ? "" : "s"}).`, method: "search:none" };
  const top = cands[0];
  const strong = cands.filter((c) => c.score >= 0.45);
  const closeRivals = cands.filter((c) => c !== top && c.score >= top.score - 0.1 && !sameSpot(c, top));
  const manyOccurrences = cands.length > 6 && !hasContextSupport(top);
  const ambiguous = top.score < 0.7 || (closeRivals.length > 0 && !hasContextSupport(top)) || manyOccurrences;

  if (ambiguous && opts.llm && llmConfigured()) {
    const j = await llmJudge(job, strong.length ? strong.slice(0, 8) : cands.slice(0, 8), opts);
    if (j) return j;
  }

  if (top.score >= 0.7) {
    // Co-cite other locations only when they are nearly as strong as the best one.
    const picked = pickDistinct(cands.filter((c) => c.score >= Math.max(0.6, top.score - 0.1)), opts.cap);
    return { decision: "cite", selected: picked.map((c) => ({ id: c.id, role: "value" as const })), confidence: top.score, reasoning: explain(picked, cands), method: top.matchType === "exact" ? "exact+context" : "normalized+context" };
  }
  if (top.score >= 0.45) {
    // Weak: cite only the single best location and say so.
    const picked = hasContextSupport(top) ? pickDistinct(cands.filter((c) => c.score >= top.score - 0.05), opts.cap) : [top];
    return {
      decision: "cite",
      selected: picked.map((c) => ({ id: c.id, role: "value" as const })),
      confidence: top.score,
      reasoning: `Low confidence. ${explain(picked, cands)}${manyOccurrences ? ` The value appears ${cands.length} times; none of the occurrences carries the field label, so the choice is by position only.` : ""}${ambiguous && opts.llm && !llmConfigured() ? " (LLM judge unavailable: no OPENAI_API_KEY.)" : ""}`,
      method: "weak-match",
    };
  }
  return { decision: "empty", selected: [], confidence: 1 - top.score, reasoning: `Found ${cands.length} occurrence${cands.length === 1 ? "" : "s"} but none in a credible context. Best: ${summarize(top)} — ${top.penalties.join("; ") || "no supporting label"}.`, method: "search:rejected" };
}

const sameSpot = (a: Candidate, b: Candidate) => a.file === b.file && a.unit.id === b.unit.id;

async function judgeZero(job: FieldJob, cands: Candidate[], opts: JudgeOptions): Promise<Judgment> {
  const supported = cands.filter((c) => hasContextSupport(c) && c.score >= 0.55);
  if (supported.length) {
    if (opts.llm && llmConfigured() && supported.length > 1 && !supported[0].rowBound) {
      const j = await llmJudge(job, supported.slice(0, 8), opts);
      if (j) return j;
    }
    const best = supported[0].score;
    const picked = pickDistinct(supported.filter((c) => c.score >= best - 0.05), Math.min(2, opts.cap));
    return { decision: "cite", selected: picked.map((c) => ({ id: c.id, role: "value" as const })), confidence: best, reasoning: `Zero is printed in the source under a matching label. ${explain(picked, cands)}`, method: "zero:explicit" };
  }
  const def = job.definition?.description ?? "";
  const isDefault = /if (empty|not available|unavailable|missing|none|blank)/i.test(def) || /display \$?0|return \$?0/i.test(def);
  return {
    decision: "empty",
    selected: [],
    confidence: 0.8,
    reasoning: isDefault
      ? `Zero is the definition's default ("${def.match(/if[^.]{0,80}/i)?.[0] ?? "if empty, 0"}"); ${cands.length} zero cell${cands.length === 1 ? "" : "s"} nearby but none under this field's label, so there is no positive evidence to cite.`
      : `Found ${cands.length} zero${cands.length === 1 ? "" : "s"} but none under a label or column header that identifies this field; a random zero is not evidence.`,
    method: "zero:default",
  };
}

function judgeBlank(job: FieldJob, cands: Candidate[]): Judgment {
  const withValue = cands.filter((c) => c.matchType !== "label-only" && c.quote.trim() && c.score >= 0.6);
  if (withValue.length) {
    const picked = pickDistinct(withValue, 3);
    return {
      decision: "context",
      selected: picked.flatMap((c) => [{ id: c.id, role: "context" as const }]),
      confidence: picked[0].score,
      reasoning: `Result is blank, but the source has a value here: ${picked.map((c) => `${c.locator} shows "${c.quote.length > 40 ? c.quote.slice(0, 40) + "…" : c.quote}"`).join("; ")}. Flagged as a discrepancy for the reviewer; not cited as support.`,
      method: "blank:discrepancy",
    };
  }
  const labelOnly = cands.find((c) => c.matchType === "label-only");
  return {
    decision: "empty",
    selected: [],
    confidence: 0.8,
    reasoning: labelOnly
      ? `Blank is consistent with the source: the label was found at ${labelOnly.locator} with nothing after it.`
      : `Blank; no source document carries a "${job.explicitLabels[0] ?? job.pointer.split("/").pop()}" field, so there is nothing to cite.`,
    method: labelOnly ? "blank:present-empty" : "blank:absent",
  };
}

function judgeBooleanPresence(job: FieldJob, cands: Candidate[]): Judgment {
  const want = job.value === true;
  const top = cands[0];
  if (!top) return { decision: "empty", selected: [], confidence: 0.6, reasoning: `Label "${job.explicitLabels[0] ?? ""}" not found in any source.`, method: "boolean:label-missing" };
  const hasValue = top.matchType !== "label-only" && top.quote.trim() !== "";
  if (want && hasValue) {
    return { decision: "cite", selected: [{ id: top.id, role: "value" }], confidence: top.score, reasoning: `${top.reasons.join("; ")}. The field is populated, which is what "true" means for this presence check.`, method: "boolean:presence" };
  }
  if (!want && !hasValue) {
    return { decision: "cite", selected: [{ id: top.id, role: "label" }], confidence: top.score, reasoning: `${top.reasons.join("; ")}. The slot is empty, which is what "false" means for this presence check.`, method: "boolean:absence" };
  }
  return {
    decision: "context",
    selected: [{ id: top.id, role: "context" }],
    confidence: 0.5,
    reasoning: want
      ? `Result is true but the label at ${top.locator} has nothing after it. Flagged for review.`
      : `Result is false but the label at ${top.locator} is followed by "${top.quote.slice(0, 60)}". Flagged as a discrepancy.`,
    method: "boolean:discrepancy",
  };
}

// ---------------------------------------------------------------------------
// LLM judge (OpenAI-compatible chat completions; JSON output)
// ---------------------------------------------------------------------------

async function llmJudge(job: FieldJob, cands: Candidate[], opts: JudgeOptions): Promise<Judgment | null> {
  const model = opts.model ?? process.env.CITE_MODEL ?? "gpt-4o-mini";
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const t0 = performance.now();
  const sys =
    "You verify citations for an insurance review. You are given ONE field from a structured result (its JSON pointer, value, and the definition that explains where the value should come from) and a short list of candidate source locations with surrounding text. Choose the candidate ids whose text actually IS this field's value in the correct context (right label, right row/entity, right document section). Repeated literals in the wrong place are not evidence. If no candidate is credible, select none. Never invent locations. Reply with JSON only: {\"selected\":[{\"id\":string,\"role\":\"value\"}],\"decision\":\"cite\"|\"empty\",\"confidence\":number,\"reasoning\":string}. Keep reasoning to two sentences a reviewer can read.";
  const user = JSON.stringify(
    {
      field: { pointer: job.pointer, value: job.value, type: job.definition?.type ?? job.valueType, definition: job.definition?.description ?? null, rowSiblings: job.rowIdentifiers.slice(0, 8) },
      candidates: cands.map((c) => ({ id: c.id, location: c.locator, matched: c.quote, matchType: c.matchType, context: c.window.slice(0, 600), heuristics: { score: c.score, for: c.reasons, against: c.penalties } })),
    },
    null,
    0,
  );
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
    const parsed = JSON.parse(data.choices[0]?.message.content ?? "{}") as { selected?: Array<{ id: string; role?: string }>; decision?: string; confidence?: number; reasoning?: string };
    const valid = new Set(cands.map((c) => c.id));
    const selected = (parsed.selected ?? []).filter((s) => valid.has(s.id)).slice(0, opts.cap).map((s) => ({ id: s.id, role: "value" as const }));
    const ms = Math.round(performance.now() - t0);
    const llm = { model, promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0, ms };
    return {
      decision: selected.length ? "cite" : "empty",
      selected,
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      reasoning: `[${model}] ${parsed.reasoning ?? "(no reasoning returned)"}`,
      method: `llm:${model}`,
      llm,
    };
  } catch (err) {
    // Fall back to deterministic ranking; record the failure in the reasoning via the caller.
    console.warn(`llm judge failed for ${job.pointer}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
