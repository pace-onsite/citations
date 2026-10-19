import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "../../api";
import { escapeToken } from "../../lib/pointer";
import type { AnchorRef } from "../../types";
import { findOccurrences, type DocumentSearchProps } from "./search";

interface Props extends DocumentSearchProps {
  caseId: string;
  file: string;
  anchors: AnchorRef[];
  activeIndex: number;
}

interface Highlight {
  pointer: string;
  index: number;
  role: string;
  tone?: string;
  span?: { start: number; end: number };
}

interface SearchMatch {
  pointer: string;
  start: number;
  end: number;
  index: number;
}

const toneClass = (h: Highlight) => (h.tone ? `tone-${h.tone}` : "");

const TRUNCATE = 400;
const SPAN_WINDOW = 1500;

/**
 * Collapsible JSON tree. Nodes referenced by json-pointer anchors are highlighted whole;
 * text-span anchors with a `pointer` highlight a character range inside that string.
 * Giant strings (e.g. base64 attachments in email exports) are truncated unless cited.
 */
export function JsonDocViewer({ caseId, file, anchors, activeIndex, searchQuery, activeSearchIndex, onSearchCount }: Props) {
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
      anchors.flatMap(({ anchor, index, tone }) => {
        if (anchor.kind === "json-pointer") return [{ pointer: anchor.pointer, index, role: anchor.role ?? "value", tone }];
        if (anchor.kind === "text-span" && anchor.pointer !== undefined)
          return [{ pointer: anchor.pointer, index, role: anchor.role ?? "value", tone, span: { start: anchor.start, end: anchor.end } }];
        return [];
      }),
    [anchors],
  );
  const searchMatches = useMemo(() => (doc === undefined ? [] : collectSearchMatches(doc, searchQuery)), [doc, searchQuery]);

  useEffect(() => {
    onSearchCount(searchMatches.length);
  }, [searchMatches.length, onSearchCount]);

  // Every prefix of a highlighted pointer must be expanded.
  const forceOpen = useMemo(() => {
    const s = new Set<string>();
    for (const h of highlights) {
      const parts = h.pointer.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    }
    for (const match of searchMatches) {
      const parts = match.pointer.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    }
    s.add("");
    return s;
  }, [highlights, searchMatches]);

  useEffect(() => {
    const el = rootRef.current?.querySelector<HTMLElement>(".search-hit.current, .hl.active");
    el?.scrollIntoView({ block: "center" });
  }, [doc, activeIndex, highlights, activeSearchIndex, searchMatches]);

  if (err) return <div className="viewer-empty error">{err}</div>;
  if (doc === undefined) return <div className="viewer-empty">Loading {file}…</div>;

  return (
    <div className="jsondoc" ref={rootRef}>
      <Node
        value={doc}
        pointer=""
        depth={0}
        highlights={highlights}
        forceOpen={forceOpen}
        activeIndex={activeIndex}
        searchMatches={searchMatches}
        activeSearchIndex={activeSearchIndex}
        last
      />
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
  searchMatches: SearchMatch[];
  activeSearchIndex: number;
  keyName?: string;
  last: boolean;
}) {
  const { value, pointer } = p;
  // Prefer the active highlight when several anchors point at the same node.
  const hits = p.highlights.filter((h) => h.pointer === pointer);
  const hit = hits.find((h) => h.index === p.activeIndex) ?? hits[0];
  const [open, setOpen] = useState(p.depth < 1 || p.forceOpen.has(pointer));
  useEffect(() => {
    if (p.forceOpen.has(pointer)) setOpen(true);
  }, [p.forceOpen, pointer]);

  const comma = p.last ? "" : ",";
  const keyEl = p.keyName !== undefined ? <span className="k">{JSON.stringify(p.keyName)}: </span> : null;
  const wholeClass = hit && !hit.span ? `hl role-${hit.role} ${toneClass(hit)} ${hit.index === p.activeIndex ? "active" : ""}` : "";

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
                searchMatches={p.searchMatches}
                activeSearchIndex={p.activeSearchIndex}
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
        <StringValue
          value={value}
          hit={hit}
          activeIndex={p.activeIndex}
          wholeClass={wholeClass}
          searchMatches={p.searchMatches.filter((match) => match.pointer === pointer)}
          activeSearchIndex={p.activeSearchIndex}
        />
        {comma}
      </div>
    );
  }

  return (
    <div className="jl" style={{ ["--d" as string]: p.depth }}>
      {keyEl}
      <PrimitiveValue
        value={JSON.stringify(value)}
        className={`prim t-${value === null ? "null" : typeof value} ${wholeClass}`}
        searchMatches={p.searchMatches.filter((match) => match.pointer === pointer)}
        activeSearchIndex={p.activeSearchIndex}
      />
      {comma}
    </div>
  );
}

function StringValue({
  value,
  hit,
  activeIndex,
  wholeClass,
  searchMatches,
  activeSearchIndex,
}: {
  value: string;
  hit?: Highlight;
  activeIndex: number;
  wholeClass: string;
  searchMatches: SearchMatch[];
  activeSearchIndex: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const span = hit?.span;

  if (searchMatches.length) {
    const active = searchMatches.find((match) => match.index === activeSearchIndex) ?? searchMatches[0];
    const windowed = value.length > SPAN_WINDOW * 2 && !expanded;
    const from = windowed ? Math.max(0, active.start - SPAN_WINDOW) : 0;
    const to = windowed ? Math.min(value.length, active.end + SPAN_WINDOW) : value.length;
    return (
      <span className={`str ${wholeClass}`}>
        "{from > 0 && <span className="ellipsis" onClick={() => setExpanded(true)}>…{from} chars…</span>}
        <SearchText value={value} from={from} to={to} matches={searchMatches} activeSearchIndex={activeSearchIndex} />
        {to < value.length && <span className="ellipsis" onClick={() => setExpanded(true)}>…{value.length - to} chars…</span>}"
      </span>
    );
  }

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
        <mark className={`hl role-${hit!.role} ${toneClass(hit!)} ${active ? "active" : ""}`} title={`[${span.start}, ${span.end})`}>
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

function PrimitiveValue({
  value,
  className,
  searchMatches,
  activeSearchIndex,
}: {
  value: string;
  className: string;
  searchMatches: SearchMatch[];
  activeSearchIndex: number;
}) {
  return (
    <span className={className}>
      {searchMatches.length ? (
        <SearchText value={value} from={0} to={value.length} matches={searchMatches} activeSearchIndex={activeSearchIndex} />
      ) : value}
    </span>
  );
}

function SearchText({
  value,
  from,
  to,
  matches,
  activeSearchIndex,
}: {
  value: string;
  from: number;
  to: number;
  matches: SearchMatch[];
  activeSearchIndex: number;
}) {
  const visible = matches.filter((match) => match.end > from && match.start < to);
  const parts: React.ReactNode[] = [];
  let cursor = from;
  visible.forEach((match) => {
    if (match.start > cursor) parts.push(<span key={`t-${cursor}`} className="raw">{escapeVisible(value.slice(cursor, match.start))}</span>);
    parts.push(
      <mark key={`m-${match.index}`} className={`search-hit ${match.index === activeSearchIndex ? "current" : ""}`}>
        {escapeVisible(value.slice(match.start, match.end))}
      </mark>,
    );
    cursor = match.end;
  });
  if (cursor < to) parts.push(<span key={`t-${cursor}`} className="raw">{escapeVisible(value.slice(cursor, to))}</span>);
  return <>{parts}</>;
}

function collectSearchMatches(doc: unknown, query: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const visit = (value: unknown, pointer: string) => {
    if (value !== null && typeof value === "object") {
      const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>);
      entries.forEach(([key, child]) => visit(child, `${pointer}/${escapeToken(key)}`));
      return;
    }
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    findOccurrences(text, query).forEach(({ start, end }) => {
      matches.push({ pointer, start, end, index: matches.length });
    });
  };
  visit(doc, "");
  return matches;
}

/** Keep newlines visible as real line breaks but show other control chars escaped. */
function escapeVisible(s: string): string {
  return s.replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}
