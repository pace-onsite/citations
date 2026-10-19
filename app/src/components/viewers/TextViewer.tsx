import { useEffect, useMemo, useRef, useState } from "react";
import { fetchText } from "../../api";
import type { Anchor, AnchorRef } from "../../types";
import { findOccurrences, type DocumentSearchProps } from "./search";

interface Props extends DocumentSearchProps {
  caseId: string;
  file: string;
  anchors: AnchorRef[];
  activeIndex: number;
}

const WINDOW = 4000;
const BIG = 1_500_000;

/** Monospace viewer for txt/csv/eml with text-span highlights. Huge files are windowed around the active span. */
export function TextViewer({ caseId, file, anchors, activeIndex, searchQuery, activeSearchIndex, onSearchCount }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const activeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    fetchText(caseId, file)
      .then((t) => !cancelled && setText(t))
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [caseId, file]);

  const spans = useMemo(
    () =>
      anchors
        .filter((a): a is AnchorRef & { anchor: Extract<Anchor, { kind: "text-span" }> } => a.anchor.kind === "text-span" && a.anchor.pointer === undefined)
        .sort((a, b) => a.anchor.start - b.anchor.start),
    [anchors],
  );

  const searchMatches = useMemo(() => (text === null ? [] : findOccurrences(text, searchQuery)), [text, searchQuery]);

  useEffect(() => {
    onSearchCount(searchMatches.length);
  }, [searchMatches.length, onSearchCount]);

  const segments = useMemo(() => {
    if (text === null) return null;
    let from = 0;
    let to = text.length;
    let windowed = false;
    if (text.length > BIG) {
      const activeSearch = searchMatches[activeSearchIndex] ?? searchMatches[0];
      const activeAnchor = spans.find((s) => s.index === activeIndex) ?? spans[0];
      const center = activeSearch?.start ?? activeAnchor?.anchor.start ?? 0;
      from = Math.max(0, center - WINDOW);
      to = Math.min(text.length, center + WINDOW);
      windowed = true;
    }
    const boundaries = new Set([from, to]);
    for (const s of spans) {
      if (s.anchor.end > from && s.anchor.start < to) {
        boundaries.add(Math.max(from, s.anchor.start));
        boundaries.add(Math.min(to, s.anchor.end));
      }
    }
    searchMatches.forEach((match) => {
      if (match.end > from && match.start < to) {
        boundaries.add(Math.max(from, match.start));
        boundaries.add(Math.min(to, match.end));
      }
    });
    const points = [...boundaries].sort((a, b) => a - b);
    const out = points.slice(0, -1).map((start, i) => {
      const end = points[i + 1];
      return {
        start,
        text: text.slice(start, end),
        span: spans.find((s) => start >= s.anchor.start && end <= s.anchor.end),
        searchIndex: searchMatches.findIndex((match) => start >= match.start && end <= match.end),
      };
    });
    return { out, windowed, from, to };
  }, [text, spans, activeIndex, searchMatches, activeSearchIndex]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center" });
  }, [segments, activeIndex, activeSearchIndex]);

  if (err) return <div className="viewer-empty error">{err}</div>;
  if (!segments) return <div className="viewer-empty">Loading {file}…</div>;

  return (
    <div className="textview">
      {segments.windowed && (
        <div className="viewer-note">
          large file ({(text!.length / 1024).toFixed(0)} KB) — showing chars {segments.from}–{segments.to}
        </div>
      )}
      <pre>
        {segments.out.map((seg) =>
          seg.span || seg.searchIndex >= 0 ? (
            <mark
              key={seg.start}
              ref={seg.searchIndex === activeSearchIndex || (seg.searchIndex < 0 && seg.span?.index === activeIndex) ? activeRef : undefined}
              className={[
                seg.span ? `hl role-${seg.span.anchor.role ?? "value"} ${seg.span.tone ? `tone-${seg.span.tone}` : ""} ${seg.span.index === activeIndex ? "active" : ""}` : "",
                seg.searchIndex >= 0 ? `search-hit ${seg.searchIndex === activeSearchIndex ? "current" : ""}` : "",
              ].join(" ")}
              title={seg.span ? `anchor ${seg.span.index} [${seg.span.anchor.start}, ${seg.span.anchor.end})` : "Search match"}
            >
              {seg.text}
            </mark>
          ) : (
            <span key={seg.start}>{seg.text}</span>
          ),
        )}
      </pre>
    </div>
  );
}
