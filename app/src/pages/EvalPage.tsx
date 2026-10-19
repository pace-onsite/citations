import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { EvalExplainer } from "../components/eval/EvalExplainer";
import { EvalItemList } from "../components/eval/EvalItemList";
import { PageNav, pageHref } from "../components/PageNav";
import { SourceViewer } from "../components/SourceViewer";
import { scoreItem, type Group, type ItemScore } from "../lib/evalMatch";
import { validateEvalItem, type ItemReport } from "../lib/evalValidate";
import type { AnchorRef, CaseDetail, CitationSet, EvalItem, EvalResponse } from "../types";

/** Index space for the viewer: ground-truth anchors first, then produced anchors from citations.json. */
export interface EvalAnchorRef extends AnchorRef {
  origin: { kind: "truth"; group: Group; entryIndex: number; anchorIndex: number } | { kind: "produced"; citationId: string; anchorIndex: number };
}

export function buildAnchorRefs(item: EvalItem, produced: CitationSet | null): EvalAnchorRef[] {
  const refs: EvalAnchorRef[] = [];
  let index = 0;
  for (const group of ["acceptable", "requiredContext", "secondary", "forbidden"] as Group[]) {
    (item[group] ?? []).forEach((ev, entryIndex) => {
      ev.anchors.forEach((anchor, anchorIndex) => {
        refs.push({ anchor, index: index++, tone: group, origin: { kind: "truth", group, entryIndex, anchorIndex } });
      });
    });
  }
  for (const c of produced?.citations[item.pointer] ?? []) {
    c.anchors.forEach((anchor, anchorIndex) => {
      refs.push({ anchor, index: index++, origin: { kind: "produced", citationId: c.id, anchorIndex } });
    });
  }
  return refs;
}

export function EvalPage() {
  const [evalRes, setEvalRes] = useState<EvalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(() => new URLSearchParams(location.search).get("item"));
  const [details, setDetails] = useState<Record<string, CaseDetail>>({});
  const [citations, setCitations] = useState<Record<string, CitationSet | null>>({});
  const [reports, setReports] = useState<Record<string, ItemReport>>({});
  const [validatingAll, setValidatingAll] = useState<{ done: number; total: number } | null>(null);
  const [sel, setSel] = useState<{ anchorIndex: number; file: string | null; page: number }>({ anchorIndex: 0, file: null, page: 1 });
  const detailPromises = useRef(new Map<string, Promise<CaseDetail>>());
  const citationPromises = useRef(new Map<string, Promise<CitationSet | null>>());

  useEffect(() => {
    api.evalSet().then(setEvalRes).catch((e) => setError(String(e)));
  }, []);

  const items = evalRes?.data.items ?? [];
  const item = useMemo(() => items.find((i) => i.id === itemId) ?? null, [items, itemId]);

  // Default to the first item once loaded.
  useEffect(() => {
    if (evalRes && !item && items.length) setItemId(items[0].id);
  }, [evalRes, item, items]);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("page", "eval");
    if (itemId) url.searchParams.set("item", itemId);
    history.replaceState(null, "", url);
  }, [itemId]);

  const loadCase = useCallback((caseId: string) => {
    let p = detailPromises.current.get(caseId);
    if (!p) {
      p = api.caseDetail(caseId).then((d) => {
        setDetails((prev) => ({ ...prev, [caseId]: d }));
        return d;
      });
      detailPromises.current.set(caseId, p);
    }
    let c = citationPromises.current.get(caseId);
    if (!c) {
      c = api.citations(caseId).then((r) => {
        const set = r.origin === "case" ? r.data : null;
        setCitations((prev) => ({ ...prev, [caseId]: set }));
        return set;
      });
      citationPromises.current.set(caseId, c);
    }
    return Promise.all([p, c]).then(([d]) => d);
  }, []);

  const validateOne = useCallback(
    async (it: EvalItem) => {
      if (!evalRes) return;
      try {
        const d = await loadCase(it.caseId);
        const r = await validateEvalItem(it, evalRes.data, d);
        setReports((prev) => ({ ...prev, [it.id]: r }));
      } catch (e) {
        setReports((prev) => ({
          ...prev,
          [it.id]: { itemId: it.id, findings: [{ level: "error", code: "case-unreadable", message: String(e) }], evidence: [], worst: "error" },
        }));
      }
    },
    [evalRes, loadCase],
  );

  // Load + validate the selected item; reset viewer to its first acceptable anchor.
  useEffect(() => {
    if (!item) return;
    const first = buildAnchorRefs(item, null)[0];
    setSel({ anchorIndex: 0, file: first?.anchor.file ?? null, page: first?.anchor.kind === "page-region" ? first.anchor.page : 1 });
    if (!reports[item.id]) void validateOne(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, validateOne]);

  // Once the case files are known, fall back to the first file if the item has no anchors.
  const detail = item ? details[item.caseId] : undefined;
  useEffect(() => {
    if (detail && !sel.file) setSel((s) => ({ ...s, file: detail.files.find((f) => f.ext === ".pdf")?.name ?? detail.files[0]?.name ?? null }));
  }, [detail, sel.file]);

  const validateAll = useCallback(async () => {
    setValidatingAll({ done: 0, total: items.length });
    for (let i = 0; i < items.length; i++) {
      await validateOne(items[i]);
      setValidatingAll({ done: i + 1, total: items.length });
    }
    setValidatingAll(null);
  }, [items, validateOne]);

  const produced = item ? citations[item.caseId] ?? null : null;
  const refs = useMemo(() => (item ? buildAnchorRefs(item, produced) : []), [item, produced]);
  const score: ItemScore | null = useMemo(() => (item ? scoreItem(item, produced?.citations[item.pointer]) : null), [item, produced]);

  const scores = useMemo(() => {
    const out: Record<string, ItemScore> = {};
    for (const it of items) {
      const set = citations[it.caseId];
      if (set === undefined) continue;
      out[it.id] = scoreItem(it, set?.citations[it.pointer]);
    }
    return out;
  }, [items, citations]);

  const selectAnchor = useCallback(
    (index: number) => {
      const ref = refs.find((r) => r.index === index);
      if (!ref) return;
      setSel({ anchorIndex: index, file: ref.anchor.file, page: ref.anchor.kind === "page-region" ? ref.anchor.page : 1 });
    },
    [refs],
  );

  // j/k to move between items.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.key !== "j" && e.key !== "k") return;
      const idx = items.findIndex((i) => i.id === itemId);
      const next = items[Math.min(items.length - 1, Math.max(0, idx + (e.key === "j" ? 1 : -1)))];
      if (next) setItemId(next.id);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, itemId]);

  const validated = Object.keys(reports).length;
  const problems = Object.values(reports).filter((r) => r.worst === "error").length;
  const warned = Object.values(reports).filter((r) => r.worst === "warn").length;
  const scored = Object.values(scores).filter((s) => s.pass !== null);
  const passed = scored.filter((s) => s.pass).length;

  return (
    <div className="app eval-page">
      <header className="header">
        <div className="brand">
          <span className="wordmark">Citation Workbench</span>
          <span className="sub">eval set · ground truth review</span>
        </div>
        <PageNav page="eval" />
        {evalRes && (
          <div className="origin origin-case" title={evalRes.path}>
            eval set
            <code>{evalRes.path}</code>
          </div>
        )}
        <div className="header-right">
          <div className="metrics">
            <Metric label="items" value={items.length} />
            <Metric label="validated" value={validatingAll ? `${validatingAll.done}/${validatingAll.total}` : validated} />
            <Metric label="gt errors" value={problems} tone={problems ? "bad" : undefined} hint="items whose ground truth no longer matches the fixtures" />
            <Metric label="gt warnings" value={warned} tone={warned ? "warn" : undefined} />
            <Metric label="scored" value={scored.length} hint="items whose case has a citations.json entry for the pointer" />
            <Metric label="pass" value={scored.length ? `${passed}/${scored.length}` : "–"} tone={scored.length ? (passed === scored.length ? "ok" : "warn") : undefined} />
          </div>
          <div className="actions">
            <button className="primary" onClick={validateAll} disabled={!evalRes || validatingAll !== null}>
              {validatingAll ? "Validating…" : "Validate all"}
            </button>
          </div>
        </div>
      </header>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {evalRes ? (
        <main className="workbench">
          <EvalItemList set={evalRes.data} items={items} selectedId={itemId} onSelect={setItemId} reports={reports} scores={scores} />
          {item && detail ? (
            <SourceViewer
              caseId={item.caseId}
              detail={detail}
              file={sel.file}
              page={sel.page}
              onPage={(page) => setSel((s) => ({ ...s, page }))}
              onBrowse={(file) => setSel((s) => ({ ...s, file, page: 1 }))}
              anchors={refs}
              activeIndex={sel.anchorIndex}
              emptyNote="no ground-truth or produced anchors in this file"
              legend={
                <>
                  <span className="legend-sep" />
                  <i className="sw tone-acceptable" /> acceptable <i className="sw tone-secondary" /> secondary <i className="sw tone-forbidden" /> forbidden{" "}
                  <i className="sw role-value" /> produced
                </>
              }
            />
          ) : (
            <section className="viewer">
              <div className="viewer-empty">{item ? `Loading ${item.caseId}…` : "Select an item"}</div>
            </section>
          )}
          <aside className="right">
            {item ? (
              <EvalExplainer
                set={evalRes.data}
                item={item}
                report={reports[item.id]}
                score={score}
                produced={produced}
                refs={refs}
                activeIndex={sel.anchorIndex}
                onSelectAnchor={selectAnchor}
                onRevalidate={() => validateOne(item)}
                reviewHref={pageHref("review", { case: item.caseId })}
              />
            ) : (
              <div className="citations empty">Select an item.</div>
            )}
          </aside>
        </main>
      ) : (
        <main className="workbench loading">Loading eval set…</main>
      )}
    </div>
  );
}

function Metric({ label, value, tone, hint }: { label: string; value: string | number; tone?: "ok" | "bad" | "warn" | "pending"; hint?: string }) {
  return (
    <div className={`metric ${tone ?? ""}`} title={hint}>
      <span className="val">{value}</span>
      <span className="key">{label}</span>
    </div>
  );
}
