import { useEffect, useMemo, useRef, useState } from "react";
import type { ItemScore } from "../../lib/evalMatch";
import type { ItemReport } from "../../lib/evalValidate";
import { formatValue } from "../../lib/pointer";
import type { EvalItem, EvalSet, Expect } from "../../types";

interface Props {
  set: EvalSet;
  items: EvalItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  reports: Record<string, ItemReport>;
  scores: Record<string, ItemScore>;
}

export function EvalItemList({ set, items, selectedId, onSelect, reports, scores }: Props) {
  const [q, setQ] = useState("");
  const [expect, setExpect] = useState<Expect | "all">("all");
  const [category, setCategory] = useState("all");
  const [caseId, setCaseId] = useState("all");
  const [status, setStatus] = useState<"all" | "problems" | "unvalidated" | "failing">("all");
  const listRef = useRef<HTMLDivElement>(null);

  const cases = useMemo(() => [...new Set(items.map((i) => i.caseId))], [items]);
  const categories = useMemo(() => Object.keys(set.categories).filter((c) => items.some((i) => i.categories.includes(c))), [set, items]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) => {
      if (expect !== "all" && i.expect !== expect) return false;
      if (category !== "all" && !i.categories.includes(category)) return false;
      if (caseId !== "all" && i.caseId !== caseId) return false;
      if (status === "problems" && !(reports[i.id]?.worst === "error" || reports[i.id]?.worst === "warn")) return false;
      if (status === "unvalidated" && reports[i.id]) return false;
      if (status === "failing" && scores[i.id]?.pass !== false) return false;
      if (needle) {
        const hay = `${i.id} ${i.pointer} ${formatValue(i.value)} ${i.categories.join(" ")} ${i.notes ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [items, q, expect, category, caseId, status, reports, scores]);

  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  let lastCase = "";
  return (
    <section className="fields eval-items">
      <div className="pane-head">
        <h2>eval-set.json</h2>
        <span className="count">
          {rows.length}
          {rows.length !== items.length ? ` of ${items.length}` : ""} items
        </span>
      </div>
      <div className="field-tools">
        <input placeholder="search id, pointer, value, notes…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="field-tools">
        <select value={expect} onChange={(e) => setExpect(e.target.value as Expect | "all")} title="expect">
          <option value="all">any expect</option>
          <option value="cite">cite</option>
          <option value="context-only">context-only</option>
          <option value="empty">empty</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} title="status">
          <option value="all">any status</option>
          <option value="problems">gt problems</option>
          <option value="unvalidated">not validated</option>
          <option value="failing">failing score</option>
        </select>
      </div>
      <div className="field-tools">
        <select value={category} onChange={(e) => setCategory(e.target.value)} title="category">
          <option value="all">any category</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={caseId} onChange={(e) => setCaseId(e.target.value)} title="case">
          <option value="all">any case</option>
          {cases.map((c) => (
            <option key={c} value={c}>
              {c.slice(0, 2)}
            </option>
          ))}
        </select>
      </div>
      <div className="field-list" ref={listRef}>
        {rows.map((i) => {
          const showCase = i.caseId !== lastCase;
          lastCase = i.caseId;
          const r = reports[i.id];
          const s = scores[i.id];
          return (
            <div key={i.id}>
              {showCase && <div className="case-head">{i.caseId}</div>}
              <button data-item={i.id} className={`field leaf eval-item ${selectedId === i.id ? "selected" : ""}`} onClick={() => onSelect(i.id)} title={i.notes}>
                <span className="name">
                  <span className={`expect expect-${i.expect}`}>{i.expect}</span>
                  {i.id}
                </span>
                <span className="value">
                  <span className="ptr">{i.pointer}</span> · {i.value === "" ? "“” (empty string)" : formatValue(i.value)}
                </span>
                <span className="badges">
                  {s && s.pass !== null && <span className={`pill ${s.pass ? "ok" : "bad"}`} title={s.reasons.join("\n")}>{s.pass ? "pass" : "fail"}</span>}
                  {r ? <span className={`dot ${r.worst}`} title={`ground truth: ${r.worst}`} /> : <span className="dot pending" title="not validated" />}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      <div className="pane-foot hint">
        <kbd>j</kbd>/<kbd>k</kbd> move between items
      </div>
    </section>
  );
}
