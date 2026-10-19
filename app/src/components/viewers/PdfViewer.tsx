import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { getPdf } from "../../lib/pdf";
import type { PageRegionAnchor } from "../../types";

interface Props {
  caseId: string;
  file: string;
  page: number;
  onPage: (p: number) => void;
  anchors: { anchor: PageRegionAnchor; index: number }[];
  activeIndex: number;
  ghosts: PageRegionAnchor[];
}

type Zoom = "fit" | number;

/**
 * Renders one PDF page to a canvas and overlays the citation boxes. Boxes are fractions
 * of the rendered page, so the overlay is positioned in percentages and stays correct at
 * any zoom and after pdf.js applies the page's intrinsic rotation.
 */
export function PdfViewer({ caseId, file, page, onPage, anchors, activeIndex, ghosts }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [rendering, setRendering] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [showGhosts, setShowGhosts] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setErr(null);
    getPdf(caseId, file)
      .then((d) => !cancelled && setDoc(d))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [caseId, file]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Render the page when doc/page/zoom/width changes.
  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    const canvas = canvasRef.current;
    let task: RenderTask | null = null;
    let cancelled = false;
    const pageNo = Math.min(Math.max(1, page), doc.numPages);
    setRendering(true);
    doc.getPage(pageNo).then((pg) => {
      if (cancelled) return;
      const base = pg.getViewport({ scale: 1 });
      const pad = 32;
      const scale = zoom === "fit" ? Math.max(0.1, (containerWidth - pad) / base.width) : zoom;
      const vp = pg.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      setSize({ w: Math.floor(vp.width), h: Math.floor(vp.height) });
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      task = pg.render({ canvasContext: ctx, viewport: vp });
      task.promise.then(
        () => !cancelled && setRendering(false),
        () => {},
      );
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, containerWidth]);

  const pagesWithAnchors = useMemo(() => {
    const s = new Set<number>();
    anchors.forEach((a) => s.add(a.anchor.page));
    return s;
  }, [anchors]);

  // Scroll the active anchor's first box into view once rendered.
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!size) return;
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [size, activeIndex, page, file]);

  if (err) return <div className="viewer-empty error">Could not open {file}: {err}</div>;

  const numPages = doc?.numPages ?? 0;
  const onPageBoxes = anchors.filter((a) => a.anchor.page === page);
  const ghostBoxes = showGhosts ? ghosts.filter((g) => g.page === page) : [];

  return (
    <div className="pdf">
      <div className="pdf-bar">
        <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>‹</button>
        <span className="pageno">
          <input
            type="number"
            min={1}
            max={numPages || 1}
            value={page}
            onChange={(e) => onPage(Math.min(Math.max(1, Number(e.target.value) || 1), numPages || 1))}
          />
          <span>/ {numPages || "…"}</span>
        </span>
        <button onClick={() => onPage(Math.min(numPages, page + 1))} disabled={!numPages || page >= numPages}>›</button>
        {numPages > 0 && (
          <span className="page-dots">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                className={`pd ${n === page ? "on" : ""} ${pagesWithAnchors.has(n) ? "hit" : ""}`}
                onClick={() => onPage(n)}
                title={`page ${n}${pagesWithAnchors.has(n) ? " · has anchors" : ""}`}
              />
            ))}
          </span>
        )}
        <span className="spacer" />
        {anchors.length > 0 && !pagesWithAnchors.has(page) && (
          <button className="link" onClick={() => onPage([...pagesWithAnchors][0])}>
            jump to evidence (p.{[...pagesWithAnchors][0]})
          </button>
        )}
        <label className="ghost-toggle" title="outline boxes from other citations on this page">
          <input type="checkbox" checked={showGhosts} onChange={(e) => setShowGhosts(e.target.checked)} /> others
        </label>
        <span className="seg">
          <button onClick={() => setZoom((z) => (z === "fit" ? 0.75 : Math.max(0.25, +(z - 0.25).toFixed(2))))}>−</button>
          <button className={zoom === "fit" ? "on" : ""} onClick={() => setZoom("fit")}>fit</button>
          <button onClick={() => setZoom((z) => (z === "fit" ? 1.25 : Math.min(5, +(z + 0.25).toFixed(2))))}>+</button>
        </span>
        {rendering && <span className="rendering">rendering…</span>}
      </div>
      <div className="pdf-scroll" ref={containerRef}>
        <div className="page-wrap" style={size ? { width: size.w, height: size.h } : undefined}>
          <canvas ref={canvasRef} />
          {size && (
            <div className="overlay">
              {ghostBoxes.map((g, gi) =>
                g.boxes.map((b, bi) => (
                  <div
                    key={`g${gi}-${bi}`}
                    className={`hl ghost role-${g.role ?? "value"}`}
                    style={{ left: `${b.left * 100}%`, top: `${b.top * 100}%`, width: `${b.width * 100}%`, height: `${b.height * 100}%` }}
                  />
                )),
              )}
              {onPageBoxes.map(({ anchor, index }) =>
                anchor.boxes.map((b, bi) => (
                  <div
                    key={`${index}-${bi}`}
                    ref={index === activeIndex && bi === 0 ? activeRef : undefined}
                    className={`hl role-${anchor.role ?? "value"} ${index === activeIndex ? "active" : ""}`}
                    style={{ left: `${b.left * 100}%`, top: `${b.top * 100}%`, width: `${b.width * 100}%`, height: `${b.height * 100}%` }}
                    title={`anchor ${index} · box ${bi} · ${anchor.role ?? "value"}`}
                  />
                )),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
