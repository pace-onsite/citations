import { useEffect, useMemo, useState } from "react";
import type { Anchor, CaseDetail, Citation, CitationSet, PageRegionAnchor } from "../types";
import { JsonDocViewer } from "./viewers/JsonDocViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { SheetViewer } from "./viewers/SheetViewer";
import { TextViewer } from "./viewers/TextViewer";

interface Props {
  caseId: string;
  detail: CaseDetail;
  set: CitationSet;
  file: string | null;
  page: number;
  onPage: (p: number) => void;
  onBrowse: (file: string) => void;
  selectedCitation: Citation | null;
  activeAnchorIndex: number;
}

const isOcr = (name: string) => /-ocr\.json$/i.test(name);

export function SourceViewer(p: Props) {
  const anchorsOnFile = useMemo(
    () => (p.selectedCitation?.anchors ?? []).map((a, i) => ({ anchor: a, index: i })).filter((x) => x.anchor.file === p.file),
    [p.selectedCitation, p.file],
  );
  const activeAnchor: Anchor | undefined = p.selectedCitation?.anchors[p.activeAnchorIndex];

  // Faint outlines for every other citation's boxes on the same PDF, for context.
  const ghostAnchors = useMemo(() => {
    const out: PageRegionAnchor[] = [];
    for (const list of Object.values(p.set.citations)) {
      for (const c of list) {
        if (c.id === p.selectedCitation?.id || c.status === "rejected") continue;
        for (const a of c.anchors) if (a.kind === "page-region" && a.file === p.file) out.push(a);
      }
    }
    return out;
  }, [p.set, p.file, p.selectedCitation?.id]);

  const filesWithAnchors = useMemo(() => {
    const s = new Set<string>();
    for (const list of Object.values(p.set.citations)) for (const c of list) for (const a of c.anchors) s.add(a.file);
    return s;
  }, [p.set]);

  const [showOcr, setShowOcr] = useState(false);
  const visibleFiles = p.detail.files.filter((f) => showOcr || !isOcr(f.name));
  const ext = p.file ? p.file.slice(p.file.lastIndexOf(".")).toLowerCase() : "";

  // CSV can be viewed as a grid (sheet-range) or raw text (text-span); follow the active anchor.
  const [csvMode, setCsvMode] = useState<"grid" | "text">("grid");
  useEffect(() => {
    if (activeAnchor?.kind === "text-span") setCsvMode("text");
    else if (activeAnchor?.kind === "sheet-range") setCsvMode("grid");
  }, [activeAnchor]);

  const sourceMeta = p.detail.sourceIndex?.files?.find((f) => f.file === p.file);

  let body: React.ReactNode;
  if (!p.file) {
    body = <div className="viewer-empty">No file selected.</div>;
  } else if (ext === ".pdf") {
    body = (
      <PdfViewer
        caseId={p.caseId}
        file={p.file}
        page={p.page}
        onPage={p.onPage}
        anchors={anchorsOnFile.filter((x) => x.anchor.kind === "page-region") as { anchor: PageRegionAnchor; index: number }[]}
        activeIndex={p.activeAnchorIndex}
        ghosts={ghostAnchors}
      />
    );
  } else if (ext === ".json") {
    body = <JsonDocViewer caseId={p.caseId} file={p.file} anchors={anchorsOnFile} activeIndex={p.activeAnchorIndex} />;
  } else if (ext === ".xlsx" || ext === ".xls" || (ext === ".csv" && csvMode === "grid")) {
    body = <SheetViewer caseId={p.caseId} file={p.file} anchors={anchorsOnFile} activeIndex={p.activeAnchorIndex} />;
  } else if ([".csv", ".txt", ".eml", ".html", ".htm", ".md", ".xml"].includes(ext)) {
    body = <TextViewer caseId={p.caseId} file={p.file} anchors={anchorsOnFile} activeIndex={p.activeAnchorIndex} />;
  } else {
    body = (
      <div className="viewer-empty">
        No viewer for <code>{p.file}</code>.{" "}
        <a href={`/cases/${encodeURIComponent(p.caseId)}/files/${encodeURIComponent(p.file)}`} target="_blank" rel="noreferrer">
          Download
        </a>
      </div>
    );
  }

  return (
    <section className="viewer">
      <div className="file-tabs" role="tablist">
        {visibleFiles.map((f) => (
          <button
            key={f.name}
            role="tab"
            aria-selected={f.name === p.file}
            className={`file-tab ${f.name === p.file ? "on" : ""} ${filesWithAnchors.has(f.name) ? "has-anchors" : ""} ${
              activeAnchor?.file === f.name ? "cited" : ""
            }`}
            onClick={() => p.onBrowse(f.name)}
            title={`${f.name} · ${(f.size / 1024).toFixed(0)} KB`}
          >
            {f.name}
          </button>
        ))}
        <label className="ocr-toggle">
          <input type="checkbox" checked={showOcr} onChange={(e) => setShowOcr(e.target.checked)} /> ocr
        </label>
      </div>
      <div className="viewer-bar">
        <span className="doc-type">{sourceMeta?.documentType ?? ext.slice(1)}</span>
        {sourceMeta?.documentName && <span className="doc-name">{sourceMeta.documentName}</span>}
        {ext === ".csv" && (
          <span className="seg">
            <button className={csvMode === "grid" ? "on" : ""} onClick={() => setCsvMode("grid")}>grid</button>
            <button className={csvMode === "text" ? "on" : ""} onClick={() => setCsvMode("text")}>text</button>
          </span>
        )}
        {p.selectedCitation && anchorsOnFile.length === 0 && (
          <span className="viewer-note">selected citation has no anchors in this file</span>
        )}
        <span className="legend">
          <i className="sw role-value" /> value <i className="sw role-label" /> label <i className="sw role-context" /> context
        </span>
      </div>
      <div className="viewer-body">{body}</div>
    </section>
  );
}
