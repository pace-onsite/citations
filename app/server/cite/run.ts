/**
 * The citation loop for one case:
 *
 *   index sources once → for each result leaf: triage → search → judge →
 *   anchors → (validate) → metrics.
 *
 * Returns a citations/v1 set plus a per-field trace (the reasoning the UI
 * shows) and run metrics (latency, LLM cost, validator results).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FieldDefinition } from "../../src/types.ts";
import { validateCitationSet } from "../validateCitations.ts";
import { anchorsFor } from "./anchors.ts";
import { buildJobs } from "./fields.ts";
import { buildIndex } from "./index.ts";
import { estimateCost, judge } from "./judge.ts";
import { searchCandidates } from "./search.ts";
import type { Candidate, Citation, CitationSet, FieldJob, FieldTrace, RunMetrics, RunOptions, RunResult } from "./types.ts";

const slug = (p: string) => p.replace(/^\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "root";

export async function citeCase(repoRoot: string, caseId: string, opts: RunOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  const caseDir = path.join(repoRoot, "test-cases", caseId);
  const [resultRaw, defRaw] = await Promise.all([
    fs.readFile(path.join(caseDir, "result.json"), "utf8"),
    fs.readFile(path.join(caseDir, "result-definition.json"), "utf8").catch(() => "null"),
  ]);
  const result = JSON.parse(resultRaw) as unknown;
  const definitions = ((JSON.parse(defRaw) as { fields?: FieldDefinition[] } | null)?.fields ?? []) as FieldDefinition[];

  const index = await buildIndex(repoRoot, caseId);
  const jobs = buildJobs(result, definitions, opts.pointers);
  const cap = opts.cap ?? 3;
  const useLlm = opts.llm ?? true;

  const set: CitationSet = { schemaVersion: "citations/v1", caseId, generatedAt: new Date().toISOString(), citations: {} };
  const traces: FieldTrace[] = [];
  const byClass: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  const fieldMs: number[] = [];
  let candidatesTotal = 0, llmCalls = 0, promptTokens = 0, completionTokens = 0, cost = 0;
  let cited = 0, contextOnly = 0, empty = 0, skipped = 0;
  const tSearch = performance.now();

  // Where have other rows of the same list been cited? Rows of one table live
  // together, so a row with no usable sibling identifier (e.g. its only sibling
  // is 0) can still be bound to the right document/page.
  const listLocations = new Map<string, Map<string, number>>();
  const locationKey = (c: Candidate) => (c.unit.kind === "ocr-line" ? `${c.file} p${c.unit.page}` : c.unit.kind === "sheet-cell" ? `${c.file}!${c.unit.sheet ?? ""}` : c.file);
  const listKey = (job: FieldJob) => (job.rowPointer ? job.pointer.replace(/\/(0|[1-9][0-9]*)(?=\/|$)/g, "/*") : null);

  for (const job of jobs) {
    const tf = performance.now();
    byClass[job.cls] = (byClass[job.cls] ?? 0) + 1;
    if (job.cls === "container") { skipped++; continue; }

    const cands = searchCandidates(index, job);
    candidatesTotal += cands.length;
    const lk = listKey(job);
    if (lk && listLocations.has(lk)) {
      const seen = listLocations.get(lk)!;
      const [dominant, n] = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
      for (const c of cands) {
        if (locationKey(c) === dominant) { c.score = Math.min(1, c.score + 0.2); c.reasons.push(`${n} other value${n === 1 ? "" : "s"} of this list already found at ${dominant}`); }
      }
      cands.sort((a, b) => b.score - a.score);
    }
    const j = await judge(job, cands, { llm: useLlm, cap, model: opts.model });
    if (lk && j.decision === "cite") {
      const seen = listLocations.get(lk) ?? listLocations.set(lk, new Map()).get(lk)!;
      for (const s of j.selected) {
        const c = cands.find((x) => x.id === s.id);
        if (c && s.role === "value") seen.set(locationKey(c), (seen.get(locationKey(c)) ?? 0) + 1);
      }
    }
    if (j.llm) { llmCalls++; promptTokens += j.llm.promptTokens; completionTokens += j.llm.completionTokens; cost += estimateCost(j.llm.model, j.llm.promptTokens, j.llm.completionTokens); }

    const byId = new Map(cands.map((c) => [c.id, c]));
    const citations: Citation[] = [];
    j.selected.forEach((sel, i) => {
      const c = byId.get(sel.id);
      if (!c) return;
      const anchors = anchorsFor(c, sel.role);
      if (!anchors.length) return;
      const citation: Citation = {
        id: `auto-${slug(job.pointer)}-${i + 1}`,
        status: "proposed",
        source: "auto",
        method: j.method,
        confidence: Math.round(Math.min(1, Math.max(0, sel.role === "value" ? c.score : j.confidence)) * 100) / 100,
        note: j.reasoning,
        createdAt: set.generatedAt,
        anchors,
      };
      if (sel.role === "value" && c.quote) citation.quote = c.quote;
      citations.push(citation);
    });
    set.citations[job.pointer] = citations;
    byMethod[j.method] = (byMethod[j.method] ?? 0) + 1;
    if (j.decision === "cite" && citations.length) cited++;
    else if (j.decision === "context" && citations.length) contextOnly++;
    else empty++;

    const ms = Math.round((performance.now() - tf) * 10) / 10;
    fieldMs.push(ms);
    traces.push(trace(job, cands, j, ms));
  }
  const searchMs = Math.round(performance.now() - tSearch);

  const metrics: RunMetrics = {
    caseId,
    fields: jobs.length,
    processed: jobs.length - skipped,
    cited,
    contextOnly,
    empty,
    skipped,
    byClass,
    byMethod,
    candidates: candidatesTotal,
    llmCalls,
    promptTokens,
    completionTokens,
    estimatedCostUsd: Math.round(cost * 1e5) / 1e5,
    indexMs: index.buildMs,
    searchMs,
    totalMs: 0,
    perFieldMs: stats(fieldMs),
  };

  if (opts.validate ?? true) {
    const report = await validateCitationSet(repoRoot, set);
    metrics.validation = { anchors: report.summary.anchors, anchorsOk: report.summary.anchorsOk, invalidCitations: report.summary.invalidCitations, byProblem: report.summary.byProblem };
  }
  metrics.totalMs = Math.round(performance.now() - t0);
  return { set, traces, metrics };
}

function trace(job: FieldJob, cands: Candidate[], j: Awaited<ReturnType<typeof judge>>, ms: number): FieldTrace {
  const sel = new Map(j.selected.map((s) => [s.id, s.role]));
  const shortlist = cands.slice(0, 8).map((c) => ({
    id: c.id,
    file: c.file,
    page: c.unit.kind === "ocr-line" ? c.unit.page : undefined,
    locator: c.locator,
    text: c.unit.kind === "sheet-cell" ? c.unit.rowText.slice(0, 160) : c.unit.text.slice(0, 160),
    quote: c.quote,
    matchType: c.matchType,
    score: c.score,
    reasons: c.reasons,
    penalties: c.penalties,
    selected: sel.has(c.id),
    role: sel.get(c.id),
  }));
  // make sure every selected candidate is visible even if ranked below 8
  for (const s of j.selected) if (!shortlist.some((x) => x.id === s.id)) {
    const c = cands.find((x) => x.id === s.id);
    if (c) shortlist.push({ id: c.id, file: c.file, page: c.unit.kind === "ocr-line" ? c.unit.page : undefined, locator: c.locator, text: c.unit.kind === "sheet-cell" ? c.unit.rowText.slice(0, 160) : c.unit.text.slice(0, 160), quote: c.quote, matchType: c.matchType, score: c.score, reasons: c.reasons, penalties: c.penalties, selected: true, role: s.role });
  }
  return {
    pointer: job.pointer,
    cls: job.cls,
    variants: job.variants.slice(0, 12),
    keywords: job.keywords,
    hints: job.hints,
    candidatesConsidered: cands.length,
    shortlist,
    decision: j.decision,
    reasoning: j.reasoning,
    method: j.method,
    confidence: j.confidence,
    ms,
    llm: j.llm,
  };
}

function stats(xs: number[]): RunMetrics["perFieldMs"] {
  if (!xs.length) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
