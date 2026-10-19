import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "../../api";
import { escapeToken } from "../../lib/pointer";
import type { Anchor } from "../../types";

interface Props {
  caseId: string;
  file: string;
  anchors: { anchor: Anchor; index: number }[];
  activeIndex: number;
}

interface Highlight {
  pointer: string;
  index: number;
  role: string;
  span?: { start: number; end: number };
}

const TRUNCATE = 400;
const SPAN_WINDOW = 1500;

/**
 * Collapsible JSON tree. Nodes referenced by json-pointer anchors are highlighted whole;
 * text-span anchors with a `pointer` highlight a character range inside that string.
 * Giant strings (e.g. base64 attachments in email exports) are truncated unless cited.
 */
export function JsonDocViewer({ caseId, file, anchors, activeIndex }: Props) {
  const [doc, setDoc] = useState<unknown>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(undefined);
    setErr(null);
    fetchJson(caseId, file)
      .then((d) => !cancelled && setDoc(d))
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [caseId, file]);

  const highlights: Highlight[] = useMemo(
    () =>
      anchors.flatMap(({ anchor, index }) => {
        if (anchor.kind === "json-pointer") return [{ pointer: anchor.pointer, index, role: anchor.role ?? "value" }];
        if (anchor.kind === "text-span" && anchor.pointer !== undefined)
          return [{ pointer: anchor.pointer, index, role: anchor.role ?? "value", span: { start: anchor.start, end: anchor.end } }];
        return [];
      }),
    [anchors],
  );

  // Every prefix of a highlighted pointer must be expanded.
  const forceOpen = useMemo(() => {
    const s = new Set<string>();
    for (const h of highlights) {
      const parts = h.pointer.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    }
    s.add("");
    return s;
  }, [highlights]);

  useEffect(() => {
    const el = rootRef.current?.querySelector<HTMLElement>(".hl.active");
    el?.scrollIntoView({ block: "center" });
  }, [doc, activeIndex, highlights]);

  if (err) return <div className="viewer-empty error">{err}</div>;
  if (doc === undefined) return <div className="viewer-empty">Loading {file}…</div>;

  return (
    <div className="jsondoc" ref={rootRef}>
      <Node value={doc} pointer="" depth={0} highlights={highlights} forceOpen={forceOpen} activeIndex={activeIndex} last />
    </div>
  );
}

function Node(p: {
  value: unknown;
  pointer: string;
  depth: number;
  highlights: Highlight[];
  forceOpen: Set<string>;
  activeIndex: number;
  keyName?: string;
  last: boolean;
}) {
  const { value, pointer } = p;
  const hit = p.highlights.find((h) => h.pointer === pointer);
  const [open, setOpen] = useState(p.depth < 1 || p.forceOpen.has(pointer));
  useEffect(() => {
    if (p.forceOpen.has(pointer)) setOpen(true);
  }, [p.forceOpen, pointer]);

  const comma = p.last ? "" : ",";
  const keyEl = p.keyName !== undefined ? <span className="k">{JSON.stringify(p.keyName)}: </span> : null;
  const wholeClass = hit && !hit.span ? `hl role-${hit.role} ${hit.index === p.activeIndex ? "active" : ""}` : "";

  if (value !== null && typeof value === "object") {
    const isArr = Array.isArray(value);
    const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
    const [o, c] = isArr ? ["[", "]"] : ["{", "}"];
    if (entries.length === 0) {
      return (
        <div className="jl" style={{ ["--d" as string]: p.depth }}>
          {keyEl}
          <span className={wholeClass}>{o + c}</span>
          {comma}
        </div>
      );
    }
    return (
      <div className={`jn ${wholeClass}`}>
        <div className="jl" style={{ ["--d" as string]: p.depth }}>
          <button className="disc" onClick={() => setOpen(!open)} aria-label={open ? "collapse" : "expand"}>
            {open ? "▾" : "▸"}
          </button>
          {keyEl}
          <span className="b">{o}</span>
          {!open && (
            <span className="fold" onClick={() => setOpen(true)}>
              {" "}
              {entries.length} {isArr ? "items" : "keys"} {c}
              {comma}
            </span>
          )}
        </div>
        {open && (
          <>
            {entries.map(([k, v], i) => (
              <Node
                key={k}
                value={v}
                pointer={`${pointer}/${escapeToken(k)}`}
                depth={p.depth + 1}
                highlights={p.highlights}
                forceOpen={p.forceOpen}
                activeIndex={p.activeIndex}
                keyName={isArr ? undefined : k}
                last={i === entries.length - 1}
              />
            ))}
            <div className="jl" style={{ ["--d" as string]: p.depth }}>
              <span className="b">{c}</span>
              {comma}
            </div>
          </>
        )}
      </div>
    );
  }

  if (typeof value === "string") {
    return (
      <div className="jl" style={{ ["--d" as string]: p.depth }}>
        {keyEl}
        <StringValue value={value} hit={hit} activeIndex={p.activeIndex} wholeClass={wholeClass} />
        {comma}
      </div>
    );
  }

  return (
    <div className="jl" style={{ ["--d" as string]: p.depth }}>
      {keyEl}
      <span className={`prim t-${value === null ? "null" : typeof value} ${wholeClass}`}>{JSON.stringify(value)}</span>
      {comma}
    </div>
  );
}

function StringValue({ value, hit, activeIndex, wholeClass }: { value: string; hit?: Highlight; activeIndex: number; wholeClass: string }) {
  const [expanded, setExpanded] = useState(false);
  const span = hit?.span;

  if (span) {
    // Show the span with context; window very long strings.
    const big = value.length > SPAN_WINDOW * 2;
    const from = big && !expanded ? Math.max(0, span.start - SPAN_WINDOW) : 0;
    const to = big && !expanded ? Math.min(value.length, span.end + SPAN_WINDOW) : value.length;
    const s = Math.max(span.start, from);
    const e = Math.min(span.end, to);
    const active = hit!.index === activeIndex;
    return (
      <span className="str">
        "{from > 0 && <span className="ellipsis" onClick={() => setExpanded(true)}>…{from} chars…</span>}
        <span className="raw">{escapeVisible(value.slice(from, s))}</span>
        <mark className={`hl role-${hit!.role} ${active ? "active" : ""}`} title={`[${span.start}, ${span.end})`}>
          {escapeVisible(value.slice(s, e))}
        </mark>
        <span className="raw">{escapeVisible(value.slice(e, to))}</span>
        {to < value.length && <span className="ellipsis" onClick={() => setExpanded(true)}>…{value.length - to} chars…</span>}"
      </span>
    );
  }

  if (value.length > TRUNCATE && !expanded && !hit) {
    return (
      <span className="str">
        "<span className="raw">{escapeVisible(value.slice(0, TRUNCATE))}</span>
        <span className="ellipsis" onClick={() => setExpanded(true)}>
          …{value.length - TRUNCATE} more chars
        </span>
        "
      </span>
    );
  }
  return <span className={`str ${wholeClass}`}>"{<span className="raw">{escapeVisible(value)}</span>}"</span>;
}

/** Keep newlines visible as real line breaks but show other control chars escaped. */
function escapeVisible(s: string): string {
  return s.replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}
