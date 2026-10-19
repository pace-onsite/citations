import { useEffect, useMemo, useRef, useState } from "react";
import { fetchText } from "../../api";
import type { Anchor } from "../../types";

interface Props {
  caseId: string;
  file: string;
  anchors: { anchor: Anchor; index: number }[];
  activeIndex: number;
}

const WINDOW = 4000;
const BIG = 1_500_000;

/** Monospace viewer for txt/csv/eml with text-span highlights. Huge files are windowed around the active span. */
export function TextViewer({ caseId, file, anchors, activeIndex }: Props) {
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
        .filter((a): a is { anchor: Extract<Anchor, { kind: "text-span" }>; index: number } => a.anchor.kind === "text-span" && a.anchor.pointer === undefined)
        .sort((a, b) => a.anchor.start - b.anchor.start),
    [anchors],
  );

  const segments = useMemo(() => {
    if (text === null) return null;
    let from = 0;
    let to = text.length;
    let windowed = false;
    if (text.length > BIG) {
      const active = spans.find((s) => s.index === activeIndex) ?? spans[0];
      const center = active ? active.anchor.start : 0;
      from = Math.max(0, center - WINDOW);
      to = Math.min(text.length, center + WINDOW);
      windowed = true;
    }
    const out: { text: string; span?: (typeof spans)[number] }[] = [];
    let cursor = from;
    for (const s of spans) {
      const start = Math.max(s.anchor.start, from);
      const end = Math.min(s.anchor.end, to);
      if (end <= start || start < cursor) continue;
      if (start > cursor) out.push({ text: text.slice(cursor, start) });
      out.push({ text: text.slice(start, end), span: s });
      cursor = end;
    }
    if (cursor < to) out.push({ text: text.slice(cursor, to) });
    return { out, windowed, from, to };
  }, [text, spans, activeIndex]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center" });
  }, [segments, activeIndex]);

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
        {segments.out.map((seg, i) =>
          seg.span ? (
            <mark
              key={i}
              ref={seg.span.index === activeIndex ? activeRef : undefined}
              className={`hl role-${seg.span.anchor.role ?? "value"} ${seg.span.index === activeIndex ? "active" : ""}`}
              title={`anchor ${seg.span.index} [${seg.span.anchor.start}, ${seg.span.anchor.end})`}
            >
              {seg.text}
            </mark>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </pre>
    </div>
  );
}
