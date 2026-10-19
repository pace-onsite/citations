import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { CitationPanel } from "./components/CitationPanel";
import { FieldList } from "./components/FieldList";
import { Header } from "./components/Header";
import { JsonView } from "./components/JsonView";
import { RawResultView } from "./components/RawResultView";
import { SourceViewer } from "./components/SourceViewer";
import { flattenResult, isLeaf } from "./lib/pointer";
import { compileSchema, validateCitation, validateSchema, type CitationReport, type SchemaError } from "./lib/validate";
import type { Anchor, AnchorRef, CaseDetail, CaseSummary, Citation, CitationSet, CitationsResponse, FieldTrace, PageRegionAnchor, RunMetrics } from "./types";

export type RightTab = "review" | "result" | "json";

export interface Selection {
  pointer: string | null;
  citationId: string | null;
  anchorIndex: number;
  /** File the viewer is showing; may differ from the anchor's file when the reviewer browses. */
  file: string | null;
  page: number;
}

export function App() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [loaded, setLoaded] = useState<CitationsResponse | null>(null);
  const [set, setSet] = useState<CitationSet | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schemaReady, setSchemaReady] = useState(false);
  const [reports, setReports] = useState<Record<string, CitationReport>>({});
  const [validating, setValidating] = useState(false);
  const [tab, setTab] = useState<RightTab>("review");
  const [sel, setSel] = useState<Selection>({ pointer: null, citationId: null, anchorIndex: 0, file: null, page: 1 });
  // ---- citation loop (agent) state ----
  const [traces, setTraces] = useState<Record<string, FieldTrace>>({});
  const [runMetrics, setRunMetrics] = useState<RunMetrics | null>(null);
  /** null = idle; "all" = whole case; otherwise the pointer being searched. */
  const [citing, setCiting] = useState<null | "all" | string>(null);
  const [llmStatus, setLlmStatus] = useState<{ configured: boolean; model: string } | null>(null);

  // ---- bootstrap -----------------------------------------------------------
  useEffect(() => {
    api.schema().then((s) => {
      compileSchema(s);
      setSchemaReady(true);
    }).catch((e) => setError(String(e)));
    api.citeStatus().then(setLlmStatus).catch(() => setLlmStatus({ configured: false, model: "" }));
    api.cases().then((cs) => {
      setCases(cs);
      const params = new URLSearchParams(location.search);
      const wanted = params.get("case");
      const first = cs.find((c) => c.id === wanted) ?? cs.find((c) => c.hasCitations) ?? cs[0];
      if (first) setCaseId(first.id);
    }).catch((e) => setError(String(e)));
  }, []);

  // ---- load case -------------------------------------------------------------
  useEffect(() => {
    if (!caseId) return;
    let cancelled = false;
    setDetail(null);
    setSet(null);
    setLoaded(null);
    setReports({});
    setDirty(false);
    setError(null);
    setTraces({});
    setRunMetrics(null);
    setCiting(null);
    const url = new URL(location.href);
    url.searchParams.set("case", caseId);
    history.replaceState(null, "", url);
    Promise.all([api.caseDetail(caseId), api.citations(caseId)])
      .then(([d, c]) => {
        if (cancelled) return;
        setDetail(d);
        setLoaded(c);
        setSet(c.data);
        const pointers = Object.keys(c.data.citations);
        const firstPtr = pointers.find((p) => c.data.citations[p].length > 0) ?? pointers[0] ?? null;
        const firstCit = firstPtr ? c.data.citations[firstPtr][0] : undefined;
        const a = firstCit?.anchors[0];
        setSel({
          pointer: firstPtr,
          citationId: firstCit?.id ?? null,
          anchorIndex: 0,
          file: a?.file ?? d.files.find((f) => f.ext === ".pdf")?.name ?? d.files[0]?.name ?? null,
          page: a?.kind === "page-region" ? a.page : 1,
        });
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  // ---- derived -----------------------------------------------------------------
  const fields = useMemo(
    () => (detail ? flattenResult(detail.result, detail.resultDefinition?.fields ?? []) : []),
    [detail],
  );

  const schemaErrors: SchemaError[] = useMemo(() => (set && schemaReady ? validateSchema(set) : []), [set, schemaReady]);

  // ---- semantic validation (runs once per case load; status edits don't change anchors) ----
  useEffect(() => {
    if (!detail || !loaded || !caseId) return;
    let cancelled = false;
    setValidating(true);
    const jobs: Promise<CitationReport>[] = [];
    for (const [ptr, list] of Object.entries(loaded.data.citations)) {
      for (const c of list) jobs.push(validateCitation(caseId, ptr, c, detail));
    }
    Promise.allSettled(jobs).then((rs) => {
      if (cancelled) return;
      const next: Record<string, CitationReport> = {};
      rs.forEach((r) => {
        if (r.status === "fulfilled") next[r.value.citationId] = r.value;
      });
      setReports(next);
      setValidating(false);
    });
    return () => {
      cancelled = true;
    };
  }, [detail, loaded, caseId]);

  // ---- actions -------------------------------------------------------------------
  const updateCitation = useCallback((pointer: string, id: string, patch: Partial<Citation>) => {
    setSet((prev) => {
      if (!prev) return prev;
      const list = prev.citations[pointer];
      if (!list) return prev;
      return {
        ...prev,
        citations: {
          ...prev.citations,
          [pointer]: list.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        },
      };
    });
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!caseId || !set) return;
    setSaving(true);
    try {
      const r = await api.saveCitations(caseId, { ...set, generatedAt: set.generatedAt });
      setDirty(false);
      setLoaded((prev) => (prev ? { ...prev, origin: "case", path: r.path } : prev));
      setCases((cs) => cs.map((c) => (c.id === caseId ? { ...c, hasCitations: true } : c)));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [caseId, set]);

  const revert = useCallback(() => {
    if (loaded) {
      setSet(loaded.data);
      setDirty(false);
    }
  }, [loaded]);

  /**
   * Run the citation loop (whole case, or one field) and merge the proposals:
   * auto citations for the processed pointers are replaced, manual ones kept.
   * The per-field traces are what the Review panel shows as "agent reasoning".
   */
  const generate = useCallback(
    async (pointers?: string[]) => {
      if (!caseId || !detail || citing) return;
      setCiting(pointers?.length === 1 ? pointers[0] : "all");
      setError(null);
      try {
        const r = await api.cite(caseId, { pointers, llm: true });
        setTraces((prev) => {
          const next = pointers ? { ...prev } : {};
          for (const t of r.traces) next[t.pointer] = t;
          return next;
        });
        setRunMetrics((prev) => (pointers && prev ? { ...prev, ...r.metrics, fields: prev.fields, processed: prev.processed } : r.metrics));
        setSet((prev) => {
          const base: CitationSet = prev ?? { schemaVersion: "citations/v1", caseId, citations: {} };
          const citations = { ...base.citations };
          for (const [ptr, list] of Object.entries(r.set.citations)) {
            const manual = (citations[ptr] ?? []).filter((c) => c.source === "manual");
            citations[ptr] = [...manual, ...list];
          }
          return { ...base, generatedAt: r.set.generatedAt, citations };
        });
        setDirty(true);
        // Validate the new citations in the browser like loaded ones.
        const jobs: Promise<CitationReport>[] = [];
        for (const [ptr, list] of Object.entries(r.set.citations)) for (const c of list) jobs.push(validateCitation(caseId, ptr, c, detail));
        const rs = await Promise.allSettled(jobs);
        setReports((prev) => {
          const next = { ...prev };
          rs.forEach((x) => { if (x.status === "fulfilled") next[x.value.citationId] = x.value; });
          return next;
        });
        // Keep the selection on something that exists; jump to the new evidence for a single-field run.
        if (pointers?.length === 1) {
          const first = r.set.citations[pointers[0]]?.[0];
          const a = first?.anchors[0];
          setSel((s) => ({ ...s, pointer: pointers[0], citationId: first?.id ?? null, anchorIndex: 0, file: a?.file ?? s.file, page: a?.kind === "page-region" ? a.page : s.page }));
        } else {
          setSel((s) => {
            const list = s.pointer ? r.set.citations[s.pointer] : undefined;
            const first = list?.[0];
            const a = first?.anchors[0];
            return first ? { ...s, citationId: first.id, anchorIndex: 0, file: a?.file ?? s.file, page: a?.kind === "page-region" ? a.page : s.page } : s;
          });
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setCiting(null);
      }
    },
    [caseId, detail, citing],
  );

  const selectField = useCallback(
    (pointer: string) => {
      const list = set?.citations[pointer] ?? [];
      const c = list[0];
      const a = c?.anchors[0];
      setSel((s) => ({
        pointer,
        citationId: c?.id ?? null,
        anchorIndex: 0,
        file: a?.file ?? s.file,
        page: a?.kind === "page-region" ? a.page : s.page,
      }));
    },
    [set],
  );

  const selectCitation = useCallback((pointer: string, citation: Citation, anchorIndex = 0) => {
    const a: Anchor | undefined = citation.anchors[anchorIndex];
    setSel((s) => ({
      pointer,
      citationId: citation.id,
      anchorIndex,
      file: a?.file ?? s.file,
      page: a?.kind === "page-region" ? a.page : s.page,
    }));
  }, []);

  const browseFile = useCallback((file: string) => {
    setSel((s) => ({ ...s, file, page: 1 }));
  }, []);
  const setPage = useCallback((page: number) => setSel((s) => ({ ...s, page })), []);

  // keyboard: j/k = next/prev field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (!set || !sel.pointer) return;
      const leaves = fields.filter(isLeaf);
      const idx = leaves.findIndex((f) => f.pointer === sel.pointer);
      if (e.key === "j" || e.key === "k") {
        const next = leaves[Math.min(leaves.length - 1, Math.max(0, idx + (e.key === "j" ? 1 : -1)))];
        if (next) selectField(next.pointer);
        e.preventDefault();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fields, sel, set, selectField]);

  const selectedCitation: Citation | null = useMemo(() => {
    if (!set || !sel.pointer || !sel.citationId) return null;
    return set.citations[sel.pointer]?.find((c) => c.id === sel.citationId) ?? null;
  }, [set, sel.pointer, sel.citationId]);

  const viewerAnchors: AnchorRef[] = useMemo(
    () => (selectedCitation?.anchors ?? []).map((anchor, index) => ({ anchor, index })),
    [selectedCitation],
  );

  // Faint outlines for every other citation's boxes, for context.
  const ghosts: PageRegionAnchor[] = useMemo(() => {
    if (!set) return [];
    const out: PageRegionAnchor[] = [];
    for (const list of Object.values(set.citations)) {
      for (const c of list) {
        if (c.id === selectedCitation?.id) continue;
        for (const a of c.anchors) if (a.kind === "page-region") out.push(a);
      }
    }
    return out;
  }, [set, selectedCitation?.id]);

  const filesWithAnchors = useMemo(() => {
    const s = new Set<string>();
    if (set && sel.pointer) {
      for (const citation of set.citations[sel.pointer] ?? []) {
        for (const anchor of citation.anchors) s.add(anchor.file);
      }
    }
    return s;
  }, [set, sel.pointer]);

  return (
    <div className="app">
      <Header
        cases={cases}
        caseId={caseId}
        onSelectCase={setCaseId}
        detail={detail}
        set={set}
        loaded={loaded}
        fields={fields}
        reports={reports}
        schemaErrors={schemaErrors}
        validating={validating}
        dirty={dirty}
        saving={saving}
        onSave={save}
        onRevert={revert}
        runMetrics={runMetrics}
        citing={citing}
        llmStatus={llmStatus}
        onGenerate={() => generate()}
      />
      {error && (
        <div className="banner error" role="alert">
          {error}
          <button type="button" className="link" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}
      {detail && set ? (
        <main className="workbench">
          <FieldList
            fields={fields}
            set={set}
            reports={reports}
            selectedPointer={sel.pointer}
            onSelect={selectField}
          />
          <SourceViewer
            caseId={detail.id}
            detail={detail}
            file={sel.file}
            page={sel.page}
            onPage={setPage}
            onBrowse={browseFile}
            anchors={viewerAnchors}
            activeIndex={sel.anchorIndex}
            ghosts={ghosts}
            filesWithAnchors={filesWithAnchors}
            emptyNote={selectedCitation ? "selected citation has no anchors in this file" : undefined}
          />
          <aside className="right">
            <div className="tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "review"} className={tab === "review" ? "on" : ""} onClick={() => setTab("review")}>
                Review
              </button>
              <button type="button" role="tab" aria-selected={tab === "result"} className={tab === "result" ? "on" : ""} onClick={() => setTab("result")}>
                result.json
              </button>
              <button type="button" role="tab" aria-selected={tab === "json"} className={tab === "json" ? "on" : ""} onClick={() => setTab("json")}>
                citations.json
                {schemaErrors.length > 0 && <span className="pill err">{schemaErrors.length}</span>}
              </button>
            </div>
            {tab === "review" ? (
              <CitationPanel
                fields={fields}
                set={set}
                pointer={sel.pointer}
                selectedCitationId={sel.citationId}
                activeAnchorIndex={sel.anchorIndex}
                reports={reports}
                schemaErrors={schemaErrors}
                onSelectCitation={selectCitation}
                onNote={(ptr, id, note) => updateCitation(ptr, id, { note })}
                trace={sel.pointer ? traces[sel.pointer] : undefined}
                citing={citing}
                onFindEvidence={(ptr) => generate([ptr])}
                onBrowse={(file, page) => setSel((s) => ({ ...s, file, page: page ?? (file === s.file ? s.page : 1) }))}
              />
            ) : tab === "result" ? (
              <RawResultView key={detail.id} caseId={detail.id} raw={detail.resultRaw} />
            ) : (
              <JsonView set={set} loaded={loaded} selectedPointer={sel.pointer} schemaErrors={schemaErrors} onSelectPointer={selectField} />
            )}
          </aside>
        </main>
      ) : (
        <main className="workbench loading">{caseId ? "Loading case…" : "Pick a case"}</main>
      )}
    </div>
  );
}
