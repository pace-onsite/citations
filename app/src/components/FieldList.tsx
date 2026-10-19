import { useEffect, useMemo, useRef, useState } from "react";
import { formatValue, isLeaf } from "../lib/pointer";
import type { CitationReport, Level } from "../lib/validate";
import { worstOf } from "../lib/validate";
import type { CitationSet, ResultField } from "../types";

interface Props {
  fields: ResultField[];
  set: CitationSet;
  reports: Record<string, CitationReport>;
  selectedPointer: string | null;
  onSelect: (pointer: string) => void;
}

type Filter = "all" | "cited" | "uncited" | "problems";

export function FieldList({ fields, set, reports, selectedPointer, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return fields.filter((f) => {
      if (needle && !f.pointer.toLowerCase().includes(needle) && !formatValue(f.value).toLowerCase().includes(needle)) return false;
      if (filter === "all") return true;
      const list = set.citations[f.pointer] ?? [];
      if (!isLeaf(f)) return false;
      if (filter === "cited") return list.length > 0;
      if (filter === "uncited") return list.length === 0;
      if (filter === "problems") return list.some((c) => reports[c.id]?.worst === "error" || reports[c.id]?.worst === "warn");
      return true;
    });
  }, [fields, set, reports, filter, q]);

  // Pointers that appear in citations.json but not in result.json.
  const orphans = useMemo(() => Object.keys(set.citations).filter((p) => !fields.some((f) => f.pointer === p)), [set, fields]);

  useEffect(() => {
    if (!selectedPointer) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-ptr="${CSS.escape(selectedPointer)}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [selectedPointer]);

  return (
    <section className="fields">
      <div className="pane-head">
        <h2>result.json</h2>
        <span className="count">{fields.filter(isLeaf).length} fields</span>
      </div>
      <div className="field-tools">
        <input placeholder="filter pointer or value…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">all</option>
          <option value="cited">cited</option>
          <option value="uncited">uncited</option>
          <option value="problems">problems</option>
        </select>
      </div>
      <div className="field-list" ref={listRef}>
        {rows.map((f) => {
          const list = set.citations[f.pointer];
          const leaf = isLeaf(f);
          const levels = (list ?? []).map((c) => reports[c.id]?.worst ?? "info");
          const worst: Level | null = list && list.length ? worstOf(levels) : null;
          const name = f.pointer.split("/").pop() ?? f.pointer;
          return (
            <button
              key={f.pointer}
              data-ptr={f.pointer}
              className={`field ${leaf ? "leaf" : "branch"} ${selectedPointer === f.pointer ? "selected" : ""} ${list === undefined && leaf ? "uncited" : ""}`}
              style={{ ["--depth" as string]: f.depth }}
              onClick={() => onSelect(f.pointer)}
              title={f.definition?.description || f.pointer}
            >
              <span className="name">
                {/^\d+$/.test(name) ? <span className="idx">[{name}]</span> : name}
                {f.definition?.type && <span className="type">{f.definition.type}</span>}
              </span>
              {leaf && (
                <span className={`value t-${f.valueType}`}>
                  {f.value === "" ? <span className="blank">“” (empty string)</span> : formatValue(f.value)}
                </span>
              )}
              {leaf && (
                <span className="badges">
                  {list !== undefined && list.length === 0 && <span className="pill none" title="searched, nothing found">∅</span>}
                  {list && list.length > 0 && <span className="pill pending">{list.length}</span>}
                  {worst && worst !== "ok" && worst !== "info" && <span className={`dot ${worst}`} title={`validation: ${worst}`} />}
                </span>
              )}
            </button>
          );
        })}
        {orphans.length > 0 && (
          <>
            <div className="orphan-head">in citations.json but not in result.json</div>
            {orphans.map((p) => (
              <button key={p} data-ptr={p} className={`field leaf orphan ${selectedPointer === p ? "selected" : ""}`} onClick={() => onSelect(p)}>
                <span className="name">{p}</span>
                <span className="badges">
                  <span className="dot error" />
                </span>
              </button>
            ))}
          </>
        )}
      </div>
      <div className="pane-foot hint">
        <kbd>j</kbd>/<kbd>k</kbd> move
      </div>
    </section>
  );
}
