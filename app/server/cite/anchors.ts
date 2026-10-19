/**
 * Deterministic anchor construction: selected candidates → citations/v1 anchors.
 * OCR word boxes are merged per line; text offsets come straight from the index.
 */
import type { Anchor, PageRegionAnchor, Rect, Role, TextSpanAnchor } from "../../src/types.ts";
import type { Candidate, OcrLine, OcrWord, TextLine } from "./types.ts";

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

function boxFor(words: OcrWord[]): Rect {
  const left = Math.min(...words.map((w) => w.left));
  const top = Math.min(...words.map((w) => w.top));
  const right = Math.min(1, Math.max(...words.map((w) => w.left + w.width)));
  const bottom = Math.min(1, Math.max(...words.map((w) => w.top + w.height)));
  return { left: r5(left), top: r5(top), width: r5(Math.max(0.001, right - left)), height: r5(Math.max(0.001, bottom - top)) };
}

/** Words of a line whose char span overlaps [s,e). */
function wordsIn(line: OcrLine, range: [number, number]): OcrWord[] {
  const out: OcrWord[] = [];
  line.spans.forEach(([ws, we], i) => {
    if (ws < range[1] && range[0] < we) out.push(line.words[i]);
  });
  return out.length ? out : line.words;
}

function pageRegion(line: OcrLine, ranges: Array<[number, number]>, role?: Role): PageRegionAnchor {
  const words = ranges.length ? ranges.flatMap((r) => wordsIn(line, r)) : line.words;
  const a: PageRegionAnchor = {
    kind: "page-region",
    file: line.file,
    page: line.page,
    boxes: ranges.length > 1 ? ranges.map((r) => boxFor(wordsIn(line, r))) : [boxFor(words)],
    provenance: { ocrFile: line.ocrFile, wordIndexes: [...new Set(words.map((w) => w.index))].sort((a, b) => a - b) },
  };
  if (role && role !== "value") a.role = role;
  return a;
}

function textSpan(line: TextLine, range: [number, number], role?: Role): TextSpanAnchor {
  const a: TextSpanAnchor = { kind: "text-span", file: line.file, start: line.start + range[0], end: line.start + range[1] };
  if (line.pointer) a.pointer = line.pointer;
  if (role && role !== "value") a.role = role;
  return a;
}

/** Anchors for one selected candidate. Value anchor(s) first, then its label anchor if any. */
export function anchorsFor(c: Candidate, role: Role): Anchor[] {
  const out: Anchor[] = [];
  const u = c.unit;
  switch (u.kind) {
    case "ocr-line": {
      if (!c.ranges.length && c.continuation?.unit.kind === "ocr-line") {
        // Value lives entirely on the next line (label-only line above it).
        out.push(pageRegion(c.continuation.unit, [c.continuation.range], role));
        break;
      }
      const main = pageRegion(u, c.ranges, role);
      if (c.continuation && c.continuation.unit.kind === "ocr-line") {
        const cont = pageRegion(c.continuation.unit, [c.continuation.range], role);
        if (cont.page === main.page) {
          main.boxes.push(...cont.boxes);
          main.provenance!.wordIndexes = [...new Set([...(main.provenance!.wordIndexes ?? []), ...(cont.provenance!.wordIndexes ?? [])])].sort((a, b) => a - b);
        } else out.push(cont);
      }
      out.unshift(main);
      break;
    }
    case "text-line": {
      if (c.ranges.length) for (const r of c.ranges) out.push(textSpan(u, r, role));
      else if (!c.continuation) out.push(textSpan(u, [0, u.text.length], role));
      if (c.continuation && c.continuation.unit.kind === "text-line") out.push(textSpan(c.continuation.unit, c.continuation.range, role));
      break;
    }
    case "json-leaf": {
      if (c.ranges.length && typeof u.value === "string") {
        for (const r of c.ranges) {
          const a: TextSpanAnchor = { kind: "text-span", file: u.file, pointer: u.pointer, start: r[0], end: r[1] };
          if (role !== "value") a.role = role;
          out.push(a);
        }
      } else {
        out.push(role === "value" ? { kind: "json-pointer", file: u.file, pointer: u.pointer } : { kind: "json-pointer", file: u.file, pointer: u.pointer, role });
      }
      break;
    }
    case "sheet-cell": {
      const a: Anchor = { kind: "sheet-range", file: u.file, range: u.a1 };
      if (u.sheet !== undefined) a.sheet = u.sheet;
      if (role !== "value") a.role = role;
      out.push(a);
      break;
    }
  }
  // Label anchor (always role label) when the candidate located one.
  if (c.labelRange) {
    const lu = c.labelRange.unit;
    const lr = c.labelRange.role ?? "label";
    if (lu.kind === "ocr-line") out.push(pageRegion(lu, [c.labelRange.range], lr));
    else out.push(textSpan(lu, c.labelRange.range, lr));
  }
  if (c.labelCell) {
    const a: Anchor = { kind: "sheet-range", file: c.labelCell.file, range: c.labelCell.a1, role: c.labelCell.role ?? "label" };
    if (c.labelCell.sheet !== undefined) a.sheet = c.labelCell.sheet;
    out.push(a);
  }
  // Row context (the sibling identifier that binds a list item to its row).
  if (c.contextRange && role !== "context") {
    const cu = c.contextRange.unit;
    const a = cu.kind === "ocr-line" ? pageRegion(cu, [c.contextRange.range], "context") : textSpan(cu, c.contextRange.range, "context");
    if (a.kind !== "page-region" || a.boxes.length) out.push(a);
  }
  return out;
}
