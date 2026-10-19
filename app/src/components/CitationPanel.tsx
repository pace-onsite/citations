import { useEffect, useRef, useState } from "react";
import { formatValue } from "../lib/pointer";
import type { CitationReport, Finding, SchemaError } from "../lib/validate";
import type { Anchor, Citation, CitationSet, ResultField, Status } from "../types";

interface Props {
  fields: ResultField[];
  set: CitationSet;
  pointer: string | null;
  selectedCitationId: string | null;
  activeAnchorIndex: number;
  reports: Record<string, CitationReport>;
  schemaErrors: SchemaError[];
  onSelectCitation: (pointer: string, citation: Citation, anchorIndex?: number) => void;
  onStatus: (pointer: string, id: string, status: Status) => void;
  onNote: (pointer: string, id: string, note: string) => void;
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

const kindGlyph: Record<Anchor["kind"], string> = {
  "page-region": "▭",
  "text-span": "¶",
  "json-pointer": "{}",
  "sheet-range": "⊞",
};

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
            <div className={`target-value t-${field.valueType}`}>{formatValue(field.value)}</div>
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
      </div>

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
          onStatus={(s) => p.onStatus(p.pointer!, c.id, s)}
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
  onStatus: (s: Status) => void;
  onNote: (n: string) => void;
}) {
  const { citation: c, report, selected } = props;
  const [editingNote, setEditingNote] = useState(false);
  const worst = props.schemaErrors.length ? "error" : report?.worst ?? "info";
  const generalFindings = (report?.findings ?? []).filter((f) => f.anchorIndex === undefined);

  return (
    <article
      data-cid={c.id}
      className={`card status-${c.status} ${selected ? "selected" : ""} worst-${worst}`}
      onClick={() => !selected && props.onSelect(0)}
    >
      <header className="card-head">
        <span className={`status ${c.status}`}>{c.status}</span>
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

      {c.quote !== undefined && (
        <div className="quote">
          <span className="q">“</span>
          <span className="qt">{c.quote}</span>
          <span className="q">”</span>
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

      <ul className="anchors">
        {c.anchors.map((a, i) => {
          const af = (report?.findings ?? []).filter((f) => f.anchorIndex === i);
          const found = report?.anchorText[i];
          return (
            <li
              key={i}
              className={`anchor role-${a.role ?? "value"} ${props.activeAnchorIndex === i ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                props.onSelect(i);
              }}
            >
              <div className="anchor-line">
                <span className="glyph" title={a.kind}>{kindGlyph[a.kind]}</span>
                <span className="file">{a.file}</span>
                <span className="loc">{describeAnchor(a)}</span>
                <span className={`role role-${a.role ?? "value"}`}>{a.role ?? "value"}</span>
              </div>
              {found !== undefined && (
                <div className="found" title="text found under this anchor">
                  ↳ <span>{found.length > 160 ? found.slice(0, 160) + "…" : found}</span>
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

      <footer className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button className={`accept ${c.status === "accepted" ? "on" : ""}`} onClick={() => props.onStatus("accepted")}>
          Accept
        </button>
        <button className={`reject ${c.status === "rejected" ? "on" : ""}`} onClick={() => props.onStatus("rejected")}>
          Reject
        </button>
        {c.status !== "proposed" && (
          <button className="ghost" onClick={() => props.onStatus("proposed")}>
            Un-review
          </button>
        )}
      </footer>
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
