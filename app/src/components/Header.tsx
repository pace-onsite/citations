import { useMemo } from "react";
import { isLeaf } from "../lib/pointer";
import type { CitationReport, SchemaError } from "../lib/validate";
import type { CaseDetail, CaseSummary, CitationSet, CitationsResponse, ResultField, RunMetrics } from "../types";
import { PageNav } from "./PageNav";

interface Props {
  cases: CaseSummary[];
  caseId: string | null;
  onSelectCase: (id: string) => void;
  detail: CaseDetail | null;
  set: CitationSet | null;
  loaded: CitationsResponse | null;
  fields: ResultField[];
  reports: Record<string, CitationReport>;
  schemaErrors: SchemaError[];
  validating: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onRevert: () => void;
  /** Last citation-loop run for this case (cost / latency / outcome). */
  runMetrics: RunMetrics | null;
  citing: null | "all" | string;
  llmStatus: { configured: boolean; model: string } | null;
  onGenerate: () => void;
}

export function computeMetrics(fields: ResultField[], set: CitationSet | null, reports: Record<string, CitationReport>, schemaErrors: SchemaError[]) {
  const leaves = fields.filter(isLeaf);
  const leafSet = new Set(leaves.map((f) => f.pointer));
  let cited = 0;
  let searchedEmpty = 0;
  let total = 0;
  let invalid = 0;
  let warned = 0;
  let orphan = 0;
  if (set) {
    for (const [ptr, list] of Object.entries(set.citations)) {
      if (!leafSet.has(ptr) && !fields.some((f) => f.pointer === ptr)) orphan++;
      if (list.length === 0) searchedEmpty++;
      else if (leafSet.has(ptr)) cited++;
      for (const c of list) {
        total++;
        const r = reports[c.id];
        if (r?.worst === "error") invalid++;
        else if (r?.worst === "warn") warned++;
      }
    }
  }
  const schemaErrorCitations = new Set(schemaErrors.map((e) => e.citationId).filter(Boolean));
  return {
    leaves: leaves.length,
    cited,
    coverage: leaves.length ? cited / leaves.length : 0,
    searchedEmpty,
    total,
    invalid: invalid + [...schemaErrorCitations].filter((id) => !reports[id as string] || reports[id as string].worst !== "error").length,
    warned,
    orphan,
  };
}

export function Header(p: Props) {
  const m = useMemo(() => computeMetrics(p.fields, p.set, p.reports, p.schemaErrors), [p.fields, p.set, p.reports, p.schemaErrors]);
  const origin = p.loaded?.origin;

  return (
    <header className="header">
      <div className="brand">
        <span className="wordmark">Citation Workbench</span>
        <span className="sub">field-level evidence review</span>
      </div>
      <PageNav page="review" />

      <label className="case-picker">
        <span className="lbl">Case</span>
        <select value={p.caseId ?? ""} onChange={(e) => p.onSelectCase(e.target.value)}>
          {p.cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}
              {c.hasCitations ? "  ● citations.json" : "  · no citations"}
            </option>
          ))}
        </select>
      </label>

      {p.loaded && (
        <div className={`origin origin-${origin}`} title={p.loaded.path}>
          {origin === "case" ? "citations file" : "no file yet — saving creates"}
          <code>{p.loaded.path}</code>
        </div>
      )}

      <div className="header-right">
      <div className="metrics">
        <Metric label="coverage" value={`${Math.round(m.coverage * 100)}%`} hint={`${m.cited} of ${m.leaves} leaf fields have ≥1 citation`} />
        <Metric label="citations" value={m.total} hint={`${m.searchedEmpty} field${m.searchedEmpty === 1 ? "" : "s"} recorded as searched-nothing-found`} />
        <Metric label="invalid" value={p.validating ? "…" : m.invalid} tone={m.invalid ? "bad" : undefined} hint="schema errors or anchors that fail to resolve" />
        <Metric label="warnings" value={p.validating ? "…" : m.warned} tone={m.warned ? "warn" : undefined} hint="anchors that match only after normalization, or quotes that need a human eye" />
        {m.orphan > 0 && <Metric label="orphan ptrs" value={m.orphan} tone="bad" hint="pointers in citations.json that do not exist in result.json" />}
      </div>

      {p.runMetrics && (
        <div className="metrics run" title="Last citation-loop run (server-side): fields processed, wall time, candidates scored, LLM judge usage">
          <Metric label="run" value={`${p.runMetrics.cited}/${p.runMetrics.processed}`} hint={`${p.runMetrics.cited} cited · ${p.runMetrics.contextOnly} context-only · ${p.runMetrics.empty} empty`} />
          <Metric label="latency" value={fmtMs(p.runMetrics.totalMs)} hint={`index ${p.runMetrics.indexMs}ms · search+judge ${p.runMetrics.searchMs}ms · per field p50 ${p.runMetrics.perFieldMs.p50}ms, p95 ${p.runMetrics.perFieldMs.p95}ms`} />
          <Metric label="candidates" value={p.runMetrics.candidates} hint="occurrences scored across all fields" />
          <Metric
            label="llm"
            value={p.runMetrics.llmCalls ? `${p.runMetrics.llmCalls} · $${p.runMetrics.estimatedCostUsd.toFixed(4)}` : "0"}
            tone={p.runMetrics.llmCalls ? undefined : "pending"}
            hint={p.runMetrics.llmCalls ? `${p.runMetrics.promptTokens} prompt + ${p.runMetrics.completionTokens} completion tokens` : p.llmStatus?.configured ? "no field needed the LLM judge" : "deterministic only — set OPENAI_API_KEY to enable the LLM judge for ambiguous fields"}
          />
        </div>
      )}

      <div className="actions">
        <button
          className="ghost generate"
          onClick={p.onGenerate}
          disabled={!p.detail || p.citing !== null}
          title={p.llmStatus?.configured ? `Run the citation loop on every field (LLM judge: ${p.llmStatus.model})` : "Run the citation loop on every field (deterministic judge; no OPENAI_API_KEY set)"}
        >
          {p.citing === "all" ? "Finding evidence…" : p.citing ? "Working…" : m.total ? "Regenerate citations" : "Generate citations"}
        </button>
        {p.dirty && (
          <button className="ghost" onClick={p.onRevert} disabled={p.saving}>
            Revert
          </button>
        )}
        <button className="primary" onClick={p.onSave} disabled={!p.dirty || p.saving || !p.set}>
          {p.saving ? "Saving…" : p.dirty ? "Save citations.json" : "Saved"}
        </button>
      </div>
      </div>
    </header>
  );
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

function Metric({ label, value, tone, hint }: { label: string; value: string | number; tone?: "ok" | "bad" | "warn" | "pending"; hint?: string }) {
  return (
    <div className={`metric ${tone ?? ""}`} title={hint}>
      <span className="val">{value}</span>
      <span className="key">{label}</span>
    </div>
  );
}
