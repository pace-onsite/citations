import { useState } from "react";
import type { Group, ItemScore } from "../../lib/evalMatch";
import type { ItemReport } from "../../lib/evalValidate";
import { formatValue } from "../../lib/pointer";
import type { Finding } from "../../lib/validate";
import type { CitationSet, EvalItem, EvalSet, Evidence } from "../../types";
import type { EvalAnchorRef } from "../../pages/EvalPage";
import { describeAnchor } from "../CitationPanel";

interface Props {
  set: EvalSet;
  item: EvalItem;
  report?: ItemReport;
  score: ItemScore | null;
  produced: CitationSet | null;
  refs: EvalAnchorRef[];
  activeIndex: number;
  onSelectAnchor: (index: number) => void;
  onRevalidate: () => void;
  reviewHref: string;
}

const kindGlyph: Record<string, string> = { "page-region": "▭", "text-span": "¶", "json-pointer": "{}", "sheet-range": "⊞" };

const groupTitle: Record<Group, { title: string; blurb: string }> = {
  acceptable: { title: "Acceptable", blurb: "Ground truth. A produced citation that lands here is right." },
  requiredContext: { title: "Required context", blurb: "Must be matched by an anchor explicitly marked role=context, in addition to the value evidence." },
  secondary: { title: "Secondary", blurb: "Not wrong, not sufficient alone (derived CSV exports, over-wide boxes). Neither a pass nor a false positive." },
  forbidden: { title: "Forbidden", blurb: "Known distractors. A value-role anchor that lands here is a false positive." },
};

function explainExpect(item: EvalItem): string {
  const need = item.minAcceptableMatches ?? 1;
  const contextNeed = item.requiredContext?.length ? (item.minRequiredContextMatches ?? 1) : 0;
  switch (item.expect) {
    case "cite": {
      const valueRule = need > 1
        ? `The run must cite this value in at least ${need} different places: ${need} distinct acceptable entries below must each be matched by a value-role anchor. Any forbidden match, or a value-role anchor that matches nothing, fails.`
        : `The run must cite this value: at least one acceptable entry below must be matched by a value-role anchor. Any forbidden match, or a value-role anchor that matches nothing, fails.`;
      return contextNeed
        ? `${valueRule} It must also match at least ${contextNeed} required-context ${contextNeed === 1 ? "entry" : "entries"} with role=context.`
        : valueRule;
    }
    case "context-only":
      return "The value is defaulted, derived, or produced by a rule — nothing in the sources says it verbatim. The run may leave the list empty, or cite only the context that drives the value. A value-role anchor that does not match acceptable/secondary evidence fails.";
    case "empty":
      return "There is nothing to cite. The run must not produce any value-role anchor. Label/context anchors on the acceptable entries are tolerated; anything forbidden is a false positive.";
  }
}

export function EvalExplainer(p: Props) {
  const { item, set } = p;
  const requiredContext = item.requiredContext ?? [];
  const kinds = [...new Set([...item.acceptable, ...requiredContext].flatMap((e) => e.anchors.map((a) => a.kind)))];
  const files = [...new Set([...item.acceptable, ...requiredContext, ...item.secondary].flatMap((e) => e.anchors.map((a) => a.file)))];

  return (
    <div className="citations explainer">
      <div className="target">
        <div className="ptr">
          <span className="item-id">{item.id}</span>
          <a className="case-link" href={p.reviewHref} title="open this case on the review page">
            {item.caseId} ↗
          </a>
        </div>
        <div className="ptr">{item.pointer}</div>
        <div className={`target-value t-${typeof item.value}`}>
          {item.value === "" ? <span className="blank">“” (empty string)</span> : formatValue(item.value)}
        </div>
        <div className="definition">
          {item.fieldType && <span className="type-chip">{item.fieldType}</span>}
          {item.fieldDefinition || <em>no field definition</em>}
        </div>
      </div>

      <section className="exp-block">
        <h3>
          Expected: <span className={`expect expect-${item.expect}`}>{item.expect}</span>
          {item.expect === "cite" && (item.minAcceptableMatches ?? 1) > 1 && <span className="need">≥ {item.minAcceptableMatches} matches</span>}
        </h3>
        <p>{explainExpect(item)}</p>
        <details>
          <summary>rule text from eval-set.json</summary>
          <p className="rule">{set.expectations[item.expect]}</p>
        </details>
        {item.expect === "cite" && (
          <p className="summary-line">
            Evidence lives in {files.length} file{files.length === 1 ? "" : "s"} ({files.join(", ")}) as {kinds.join(", ")} anchors.
          </p>
        )}
      </section>

      {item.notes && (
        <section className="exp-block">
          <h3>Why this item is here</h3>
          <p className="notes">{item.notes}</p>
        </section>
      )}

      <section className="exp-block">
        <h3>Edge cases exercised</h3>
        <ul className="cats">
          {item.categories.map((c) => (
            <li key={c}>
              <span className={`cat ${c.startsWith("file:") ? "cat-file" : c.startsWith("distractor:") ? "cat-distractor" : ""}`}>{c}</span>
              <span className="cat-desc">{set.categories[c] ?? <em className="finding error">not in the taxonomy</em>}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="exp-block">
        <h3>
          Ground truth vs fixtures
          <button className="link" onClick={p.onRevalidate}>
            re-check
          </button>
        </h3>
        {p.report ? (
          <>
            {p.report.findings.map((f, i) => (
              <FindingRow key={i} f={f} />
            ))}
            <div className="gt-summary">
              {(["acceptable", "requiredContext", "secondary", "forbidden"] as Group[]).map((g) => {
                const evs = p.report!.evidence.filter((e) => e.group === g);
                if (!evs.length) return null;
                const bad = evs.filter((e) => e.report.worst === "error").length;
                const warn = evs.filter((e) => e.report.worst === "warn").length;
                return (
                  <span key={g} className={`pill ${bad ? "bad" : warn ? "pending" : "ok"}`}>
                    {g}: {evs.length - bad - warn}/{evs.length} ok
                  </span>
                );
              })}
            </div>
          </>
        ) : (
          <div className="finding info">checking anchors against the case files…</div>
        )}
      </section>

      {(["acceptable", "requiredContext", "secondary", "forbidden"] as Group[]).map((group) => {
        const evidence = item[group] ?? [];
        return evidence.length ? (
          <section key={group} className={`exp-block group-${group}`}>
            <h3>
              {groupTitle[group].title} <span className="count">{evidence.length}</span>
            </h3>
            <p className="blurb">{groupTitle[group].blurb}</p>
            {evidence.map((ev, entryIndex) => (
              <EvidenceCard
                key={entryIndex}
                group={group}
                entryIndex={entryIndex}
                ev={ev}
                refs={p.refs}
                report={p.report?.evidence.find((e) => e.group === group && e.entryIndex === entryIndex)?.report}
                activeIndex={p.activeIndex}
                onSelectAnchor={p.onSelectAnchor}
                matched={p.score?.verdicts.some((v) => v.match?.group === group && v.match.entryIndex === entryIndex) ?? false}
              />
            ))}
          </section>
        ) : null;
      })}

      <section className="exp-block">
        <h3>
          Current citations.json
          {p.score && p.score.pass !== null && <span className={`pill ${p.score.pass ? "ok" : "bad"}`}>{p.score.pass ? "pass" : "fail"}</span>}
        </h3>
        {p.produced === null ? (
          <div className="finding info">· {item.caseId} has no citations.json yet — nothing to score.</div>
        ) : (
          <>
            {p.score?.reasons.map((r, i) => (
              <div key={i} className={`finding ${p.score!.pass === false && i === 0 ? "error" : "info"}`}>
                · {r}
              </div>
            ))}
            {p.score && p.score.verdicts.length > 0 && (
              <ul className="verdicts">
                {p.score.verdicts.map((v, i) => {
                  const ref = p.refs.find((r) => r.origin.kind === "produced" && r.origin.citationId === v.citationId && r.origin.anchorIndex === v.anchorIndex);
                  const cls = v.match ? `m-${v.match.group}` : v.valueRole ? "m-unmatched" : "m-ignored";
                  return (
                    <li key={i} className={`verdict ${cls} ${ref && ref.index === p.activeIndex ? "active" : ""}`} onClick={() => ref && p.onSelectAnchor(ref.index)}>
                      <span className="glyph">{kindGlyph[v.anchor.kind]}</span>
                      <span className="cid">{v.citationId}</span>
                      <span className="loc">
                        {v.anchor.file} {describeAnchor(v.anchor)}
                      </span>
                      <span className={`role role-${v.anchor.role ?? "value"}`}>{v.anchor.role ?? "value"}</span>
                      <span className="outcome">
                        {v.match ? `→ ${v.match.group}: ${v.match.label}` : v.valueRole ? "→ matches nothing" : "→ label/context, not judged"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function EvidenceCard(props: {
  group: Group;
  entryIndex: number;
  ev: Evidence;
  refs: EvalAnchorRef[];
  report?: import("../../lib/validate").CitationReport;
  activeIndex: number;
  onSelectAnchor: (index: number) => void;
  matched: boolean;
}) {
  const { ev, group, entryIndex, report } = props;
  const [open, setOpen] = useState(true);
  const worst = report?.worst ?? "info";
  const general = (report?.findings ?? []).filter((f) => f.anchorIndex === undefined);
  return (
    <article className={`card evidence tone-${group} worst-${worst} ${props.matched ? "matched" : ""}`}>
      <header className="card-head" onClick={() => setOpen(!open)}>
        <span className="label">{ev.label}</span>
        {props.matched && <span className="pill ok">matched</span>}
        {worst === "error" && <span className="pill bad">drift</span>}
        {worst === "warn" && <span className="pill pending">check</span>}
      </header>
      {ev.quote !== undefined && (
        <div className="quote">
          <span className="q">“</span>
          <span className="qt">{ev.quote}</span>
          <span className="q">”</span>
        </div>
      )}
      {open && (
        <>
          {general.map((f, i) => (
            <FindingRow key={i} f={f} />
          ))}
          <ul className="anchors">
            {ev.anchors.map((a, anchorIndex) => {
              const ref = props.refs.find((r) => r.origin.kind === "truth" && r.origin.group === group && r.origin.entryIndex === entryIndex && r.origin.anchorIndex === anchorIndex);
              const af = (report?.findings ?? []).filter((f) => f.anchorIndex === anchorIndex);
              const found = report?.anchorText[anchorIndex];
              return (
                <li
                  key={anchorIndex}
                  className={`anchor role-${a.role ?? "value"} ${ref && ref.index === props.activeIndex ? "active" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (ref) props.onSelectAnchor(ref.index);
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
        </>
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
