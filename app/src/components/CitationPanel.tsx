import { useEffect, useRef, useState } from "react";
import { formatValue } from "../lib/pointer";
import type { CitationReport, Finding, SchemaError } from "../lib/validate";
import type { Anchor, Citation, CitationSet, FieldTrace, ResultField, TraceCandidate } from "../types";

interface Props {
  fields: ResultField[];
  set: CitationSet;
  pointer: string | null;
  selectedCitationId: string | null;
  activeAnchorIndex: number;
  reports: Record<string, CitationReport>;
  schemaErrors: SchemaError[];
  onSelectCitation: (pointer: string, citation: Citation, anchorIndex?: number) => void;
  onNote: (pointer: string, id: string, note: string) => void;
  /** Agent trace for the selected field from the last run, if any. */
  trace?: FieldTrace;
  citing: null | "all" | string;
  onFindEvidence: (pointer: string) => void;
  onBrowse: (file: string, page?: number) => void;
}

export function describeAnchor(a: Anchor): string {
  switch (a.kind) {
    case "page-region":
      return `p.${a.page} · ${a.boxes.length} box${a.boxes.length === 1 ? "" : "es"}`;
    case "text-span":
      return `${a.pointer ? a.pointer + " " : ""}[${a.start}, ${a.end})`;
    case "json-pointer":
      return a.pointer;
    case "sheet-range":
      return `${a.sheet ? a.sheet + "!" : ""}${a.range}`;
  }
}

export function CitationPanel(p: Props) {
  const field = p.fields.find((f) => f.pointer === p.pointer);
  const list = p.pointer ? p.set.citations[p.pointer] : undefined;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!p.selectedCitationId) return;
    ref.current?.querySelector<HTMLElement>(`[data-cid="${CSS.escape(p.selectedCitationId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [p.selectedCitationId]);

  if (!p.pointer) {
    return <div className="citations empty">Select a field on the left.</div>;
  }

  const pointerSchemaErrors = p.schemaErrors.filter((e) => e.pointer === p.pointer && !e.citationId);

  return (
    <div className="citations" ref={ref}>
      <div className="target">
        <div className="ptr">{p.pointer}</div>
        {field ? (
          <>
            <div className="target-result">
              <span className="target-result-label">Result value</span>
              <span className="target-value">
                {field.value === "" ? <span className="blank">“” (empty string)</span> : formatValue(field.value)}
              </span>
              <span className="target-value-type">{field.definition?.type ?? field.valueType}</span>
            </div>
            {field.definition?.description && <div className="definition">{field.definition.description}</div>}
          </>
        ) : (
          <div className="finding error">This pointer does not exist in result.json.</div>
        )}
        {pointerSchemaErrors.map((e, i) => (
          <div key={i} className="finding error">
            schema: {e.message}
          </div>
        ))}
        {field && (
          <div className="target-actions">
            <button
              type="button"
              className="small find"
              disabled={p.citing !== null}
              onClick={() => p.onFindEvidence(p.pointer!)}
              title="Run the citation loop for this field only"
            >
              {p.citing === p.pointer ? "Searching…" : list?.length ? "Re-run search for this field" : "Find evidence"}
            </button>
          </div>
        )}
      </div>

      {p.trace && <TraceView trace={p.trace} onBrowse={p.onBrowse} />}

      {list === undefined && <div className="empty-note">No entry in citations.json for this field — it has not been searched.</div>}
      {list && list.length === 0 && <div className="empty-note">Recorded as <em>searched, nothing found</em> (empty array).</div>}

      {list?.map((c) => (
        <CitationCard
          key={c.id}
          pointer={p.pointer!}
          citation={c}
          field={field}
          selected={c.id === p.selectedCitationId}
          activeAnchorIndex={c.id === p.selectedCitationId ? p.activeAnchorIndex : -1}
          report={p.reports[c.id]}
          schemaErrors={p.schemaErrors.filter((e) => e.citationId === c.id)}
          onSelect={(ai) => p.onSelectCitation(p.pointer!, c, ai)}
          onNote={(n) => p.onNote(p.pointer!, c.id, n)}
        />
      ))}
    </div>
  );
}

function CitationCard(props: {
  pointer: string;
  citation: Citation;
  field?: ResultField;
  selected: boolean;
  activeAnchorIndex: number;
  report?: CitationReport;
  schemaErrors: SchemaError[];
  onSelect: (anchorIndex?: number) => void;
  onNote: (n: string) => void;
}) {
  const { citation: c, report, selected } = props;
  const [editingNote, setEditingNote] = useState(false);
  const worst = props.schemaErrors.length ? "error" : report?.worst ?? "info";
  const findings = report?.findings ?? [];
  const generalFindings = findings.filter(
    (f) => f.anchorIndex === undefined && f.code !== "boolean-field" && !(f.level === "ok" && f.code.startsWith("quote-")),
  );
  const booleanFinding = findings.some((f) => f.code === "boolean-field");
  const labelText = c.anchors
    .map((a, i) => (a.role === "label" ? report?.anchorText[i] : undefined))
    .find((text) => text !== undefined);
  const valueText = c.anchors
    .map((a, i) => (a.role !== "label" && a.role !== "context" ? report?.anchorText[i] : undefined))
    .find((text) => text !== undefined);
  const quote = c.quote;
  const quoteIsShownAsAnchor = quote !== undefined && Object.values(report?.anchorText ?? {}).some(
    (text) => normalizeEvidenceText(text) === normalizeEvidenceText(quote),
  );

  return (
    <article
      data-cid={c.id}
      className={`card ${selected ? "selected" : ""} worst-${worst}`}
      onClick={() => !selected && props.onSelect(0)}
    >
      <header className="card-head">
        <span className="cid">{c.id}</span>
        <span className="meta">
          {c.source}
          {c.method && <> · {c.method}</>}
        </span>
        {c.confidence !== undefined && (
          <span className="conf" title={`confidence ${c.confidence}`}>
            <span className="bar" style={{ width: `${Math.round(c.confidence * 100)}%` }} />
            <span className="num">{c.confidence.toFixed(2)}</span>
          </span>
        )}
      </header>

      {c.quote !== undefined && !quoteIsShownAsAnchor && (
        <div className="quote">
          <span className="quote-label">Citation quote</span>
          <span className="qt">“{c.quote}”</span>
        </div>
      )}

      {booleanFinding && props.field?.valueType === "boolean" && (
        <div className="evidence-summary">
          <div className="evidence-summary-title">How the evidence supports this result</div>
          <div>
            {props.field.value === true ? (
              <>
                The cited {labelText ? <><q>{labelText}</q> field</> : "field"}{" "}
                {valueText ? <>contains <q>{valueText}</q></> : "is present and populated"}, supporting a result of <strong>true</strong>.
              </>
            ) : (
              <>Review the cited field to confirm why the result is <strong>false</strong>.</>
            )}
          </div>
        </div>
      )}

      {generalFindings.map((f, i) => (
        <FindingRow key={i} f={f} />
      ))}
      {props.schemaErrors.map((e, i) => (
        <div key={`s${i}`} className="finding error">
          schema: {e.message}
        </div>
      ))}

      <div className="anchor-heading">Source evidence</div>
      <ul className="anchors">
        {c.anchors.map((a, i) => {
          const af = findings.filter(
            (f) => f.anchorIndex === i && !["ocr-resolves", "quote-verified", "quote-normalized"].includes(f.code),
          );
          const found = report?.anchorText[i];
          const role = a.role ?? "value";
          return (
            <li
              key={i}
              className={`anchor role-${role} ${props.activeAnchorIndex === i ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                props.onSelect(i);
              }}
            >
              <div className="anchor-line">
                <span className={`role role-${role}`}>{role === "value" ? "Value" : role === "label" ? "Label" : "Context"}</span>
                <span className="file">{a.file}</span>
                <span className="loc">{describeAnchor(a)}</span>
              </div>
              {found !== undefined && (
                <div className="found" title="Text found at this source location">
                  {found.length > 160 ? found.slice(0, 160) + "…" : found}
                </div>
              )}
              {af.map((f, j) => (
                <FindingRow key={j} f={f} compact />
              ))}
            </li>
          );
        })}
      </ul>

      {editingNote ? (
        <textarea
          className="note-edit"
          autoFocus
          defaultValue={c.note ?? ""}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            props.onNote(e.target.value);
            setEditingNote(false);
          }}
        />
      ) : (
        <div
          className={`note ${c.note ? "" : "placeholder"}`}
          onClick={(e) => {
            e.stopPropagation();
            setEditingNote(true);
          }}
        >
          {c.note || "add a reviewer note…"}
        </div>
      )}

    </article>
  );
}

function FindingRow({ f, compact }: { f: Finding; compact?: boolean }) {
  const glyph = f.level === "ok" ? "✓" : f.level === "error" ? "✕" : f.level === "warn" ? "!" : "·";
  return (
    <div className={`finding ${f.level} ${compact ? "compact" : ""}`} title={f.code}>
      <span className="glyph">{glyph}</span>
      {f.message}
    </div>
  );
}

function normalizeEvidenceText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

// ---------------------------------------------------------------------------
// Agent reasoning: what the loop searched for, what it found, why it decided.
// ---------------------------------------------------------------------------

const CLASS_LABEL: Record<string, string> = {
  scalar: "scalar value",
  composite: "composite value (several parts)",
  "boolean-presence": "presence check (true = field populated)",
  "boolean-source": "boolean from a source flag",
  blank: "blank value (looking for the empty slot)",
  zero: "zero (default or printed?)",
  "rule-constant": "rule constant",
  prose: "free text",
  container: "container",
};

function TraceView({ trace: t, onBrowse }: { trace: FieldTrace; onBrowse: (file: string, page?: number) => void }) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const decisionWord = t.decision === "cite" ? "cite" : t.decision === "context" ? "context only" : "nothing to cite";
  const rows = showAll ? t.shortlist : t.shortlist.filter((c) => c.selected || t.shortlist.indexOf(c) < 4);
  const hidden = t.shortlist.length - rows.length;
  return (
    <section className={`trace decision-${t.decision}`}>
      <header className="trace-head" onClick={() => setOpen((o) => !o)}>
        <span className="trace-title">Agent reasoning</span>
        <span className={`trace-decision d-${t.decision}`}>{decisionWord}</span>
        <span className="trace-meta">
          {t.method} · conf {t.confidence.toFixed(2)} · {t.candidatesConsidered} candidate{t.candidatesConsidered === 1 ? "" : "s"} · {t.ms}ms
          {t.llm && <> · LLM {t.llm.model} ({t.llm.promptTokens + t.llm.completionTokens} tok)</>}
        </span>
        <span className="trace-toggle">{open ? "▾" : "▸"}</span>
      </header>
      {open && (
        <>
          <p className="trace-reasoning">{t.reasoning}</p>
          <dl className="trace-search">
            <dt>Treated as</dt>
            <dd>{CLASS_LABEL[t.cls] ?? t.cls}</dd>
            {t.variants.length > 0 && (
              <>
                <dt>Searched for</dt>
                <dd>
                  {t.variants.slice(0, 6).map((v, i) => <code key={i}>{v}</code>)}
                  {t.variants.length > 6 && <span className="more">+{t.variants.length - 6} more spellings</span>}
                </dd>
              </>
            )}
            {t.keywords.length > 0 && (
              <>
                <dt>Context words</dt>
                <dd>{t.keywords.slice(0, 10).join(", ")}{t.keywords.length > 10 ? ", …" : ""}</dd>
              </>
            )}
            {(t.hints.page !== undefined || t.hints.region) && (
              <>
                <dt>Position hint</dt>
                <dd>{[t.hints.page !== undefined ? `page ${t.hints.page}` : null, t.hints.region].filter(Boolean).join(", ")}</dd>
              </>
            )}
          </dl>
          {t.shortlist.length > 0 ? (
            <ol className="shortlist">
              {rows.map((c) => (
                <ShortlistRow key={c.id} c={c} onBrowse={onBrowse} />
              ))}
            </ol>
          ) : (
            <div className="empty-note">No occurrence of the value (or its label) was found in any source file.</div>
          )}
          {hidden > 0 && (
            <button type="button" className="link" onClick={() => setShowAll(true)}>
              show {hidden} more rejected candidate{hidden === 1 ? "" : "s"}
            </button>
          )}
          {showAll && t.shortlist.length > 4 && (
            <button type="button" className="link" onClick={() => setShowAll(false)}>show fewer</button>
          )}
        </>
      )}
    </section>
  );
}

function ShortlistRow({ c, onBrowse }: { c: TraceCandidate; onBrowse: (file: string, page?: number) => void }) {
  return (
    <li
      className={`cand ${c.selected ? "selected" : "rejected"}`}
      onClick={() => onBrowse(c.file, c.page)}
      title="Show this location in the source viewer"
    >
      <div className="cand-line">
        <span className="cand-mark">{c.selected ? "★" : "·"}</span>
        <span className="cand-score">
          <span className="bar" style={{ width: `${Math.round(c.score * 100)}%` }} />
          <span className="num">{c.score.toFixed(2)}</span>
        </span>
        <span className="cand-loc">{c.locator}</span>
        {c.role && c.role !== "value" && <span className={`role role-${c.role}`}>{c.role}</span>}
        <span className="cand-match">{c.matchType}</span>
      </div>
      {c.quote && <div className="cand-quote">“{c.quote.length > 120 ? c.quote.slice(0, 120) + "…" : c.quote}”</div>}
      <ul className="cand-why">
        {c.reasons.map((r, i) => (
          <li key={`r${i}`} className="plus">+ {r}</li>
        ))}
        {c.penalties.map((r, i) => (
          <li key={`p${i}`} className="minus">− {r}</li>
        ))}
      </ul>
    </li>
  );
}
