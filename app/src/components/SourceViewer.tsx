import { useEffect, useMemo, useState } from "react";
import type { Anchor, AnchorRef, CaseDetail, PageRegionAnchor } from "../types";
import { JsonDocViewer } from "./viewers/JsonDocViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { SheetViewer } from "./viewers/SheetViewer";
import { TextViewer } from "./viewers/TextViewer";

interface Props {
  caseId: string;
  detail: CaseDetail;
  file: string | null;
  page: number;
  onPage: (p: number) => void;
  onBrowse: (file: string) => void;
  /** Anchors to draw (across all files; the viewer filters to the active file). */
  anchors: AnchorRef[];
  activeIndex: number;
  /** Faint outlines for context (e.g. other citations' boxes). */
  ghosts?: PageRegionAnchor[];
  /** Files that have any anchors, for the tab dots. Defaults to the files in `anchors`. */
  filesWithAnchors?: Set<string>;
  /** Shown in the bar when the active selection has nothing in this file. */
  emptyNote?: string;
  /** Extra legend entries (eval page adds acceptable/secondary/forbidden). */
  legend?: React.ReactNode;
}

const isOcr = (name: string) => /-ocr\.json$/i.test(name);

/**
 * Picks a viewer for the active file and hands it the anchors that live in that file.
 * Shared by the review page (citation anchors) and the eval page (ground-truth anchors).
 */
export function SourceViewer(p: Props) {
  const anchorsOnFile = useMemo(() => p.anchors.filter((x) => x.anchor.file === p.file), [p.anchors, p.file]);
  const activeAnchor: Anchor | undefined = p.anchors.find((a) => a.index === p.activeIndex)?.anchor;
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCount, setSearchCount] = useState(0);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);

  const filesWithAnchors = useMemo(() => p.filesWithAnchors ?? new Set(p.anchors.map((a) => a.anchor.file)), [p.filesWithAnchors, p.anchors]);

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
  const hasSearch = searchQuery.trim().length > 0;
  const moveSearch = (direction: 1 | -1) => {
    if (!searchCount) return;
    setActiveSearchIndex((current) => (current + direction + searchCount) % searchCount);
  };

  useEffect(() => {
    setSearchCount(0);
    setActiveSearchIndex(0);
  }, [p.file]);

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
        anchors={anchorsOnFile.filter((x): x is AnchorRef & { anchor: PageRegionAnchor } => x.anchor.kind === "page-region")}
        activeIndex={p.activeIndex}
        ghosts={(p.ghosts ?? []).filter((g) => g.file === p.file)}
        searchQuery={searchQuery}
        activeSearchIndex={activeSearchIndex}
        onSearchCount={setSearchCount}
      />
    );
  } else if (ext === ".json") {
    body = (
      <JsonDocViewer
        caseId={p.caseId}
        file={p.file}
        anchors={anchorsOnFile}
        activeIndex={p.activeIndex}
        searchQuery={searchQuery}
        activeSearchIndex={activeSearchIndex}
        onSearchCount={setSearchCount}
      />
    );
  } else if (ext === ".xlsx" || ext === ".xls" || (ext === ".csv" && csvMode === "grid")) {
    body = (
      <SheetViewer
        caseId={p.caseId}
        file={p.file}
        anchors={anchorsOnFile}
        activeIndex={p.activeIndex}
        searchQuery={searchQuery}
        activeSearchIndex={activeSearchIndex}
        onSearchCount={setSearchCount}
      />
    );
  } else if ([".csv", ".txt", ".eml", ".html", ".htm", ".md", ".xml", ""].includes(ext)) {
    body = (
      <TextViewer
        caseId={p.caseId}
        file={p.file}
        anchors={anchorsOnFile}
        activeIndex={p.activeIndex}
        searchQuery={searchQuery}
        activeSearchIndex={activeSearchIndex}
        onSearchCount={setSearchCount}
      />
    );
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
        <span className="doc-type">{sourceMeta?.documentType ?? (ext ? ext.slice(1) : "file")}</span>
        {sourceMeta?.documentName && <span className="doc-name">{sourceMeta.documentName}</span>}
        {ext === ".csv" && (
          <span className="seg">
            <button className={csvMode === "grid" ? "on" : ""} onClick={() => setCsvMode("grid")}>grid</button>
            <button className={csvMode === "text" ? "on" : ""} onClick={() => setCsvMode("text")}>text</button>
          </span>
        )}
        {p.emptyNote && anchorsOnFile.length === 0 && <span className="viewer-note">{p.emptyNote}</span>}
        <search className="doc-search">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchCount(0);
              setActiveSearchIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                moveSearch(e.shiftKey ? -1 : 1);
                e.preventDefault();
              } else if (e.key === "Escape") {
                setSearchQuery("");
              }
            }}
            placeholder="Search document…"
            aria-label="Search within document"
          />
          {hasSearch && <span className="search-count">{searchCount ? `${activeSearchIndex + 1} / ${searchCount}` : "No matches"}</span>}
          <button type="button" onClick={() => moveSearch(-1)} disabled={!searchCount} aria-label="Previous match" title="Previous match (Shift+Enter)">↑</button>
          <button type="button" onClick={() => moveSearch(1)} disabled={!searchCount} aria-label="Next match" title="Next match (Enter)">↓</button>
        </search>
        <span className="legend">
          <i className="sw role-value" /> value <i className="sw role-label" /> label <i className="sw role-context" /> context
          {p.legend}
        </span>
      </div>
      <div className="viewer-body">{body}</div>
    </section>
  );
}
