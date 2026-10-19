/**
 * Scores a run of generated `citations/v1` files against eval/eval-set.json using
 * the matching and pass rules documented in eval/README.md.
 *
 *   npx -y tsx scripts/score-eval.ts --run <directory>
 *       [--category <tag>]... [--case <case-id>]... [--baseline <report.json>]
 *       [--json] [--output <report.json>]
 *
 * The run directory holds one candidate file per case named `<caseId>.citations.json`.
 * A missing file, a missing JSON Pointer, or a missing citation array is scored as an
 * empty citation list. Citations with `status: "rejected"` are ignored for pass/fail
 * and counted separately.
 *
 * Per anchor, the scorer:
 *   1. checks the shape (and the whole file against schema/citations.schema.json);
 *   2. verifies the anchor resolves to source content via app/server/validateCitations.ts,
 *      with an OCR-artifact fallback for page regions on PDFs without a text layer;
 *   3. matches it against the item's acceptable / secondary / forbidden evidence.
 *
 * Exit codes: 0 = no failed items (or no baseline regression when --baseline is given);
 * 1 = failed items / regression; 2 = usage or runtime error.
 *
 * Pure matching/scoring functions are exported so scripts/score-eval.test.ts can unit
 * test them with in-memory fixtures.
 */
import * as fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  jsonPointerGet,
  validateCitationSet,
  type AnchorCheck,
  type Problem as ValidatorProblem,
} from "../app/server/validateCitations.ts";
import type {
  Anchor,
  Citation,
  CitationSet,
  JsonPointerAnchor,
  PageRegionAnchor,
  Rect,
  Role,
  SheetRangeAnchor,
  TextSpanAnchor,
} from "../app/src/types.ts";

// ---------------------------------------------------------------------------
// Eval-set shapes (mirrors eval/eval-set.schema.json)
// ---------------------------------------------------------------------------

export type Expect = "cite" | "context-only" | "empty";
export type CoreBucket = "acceptable" | "secondary" | "forbidden";
export type Bucket = CoreBucket | "requiredContext";
export const BUCKETS: readonly CoreBucket[] = ["acceptable", "secondary", "forbidden"];
export const EXPECTS: readonly Expect[] = ["cite", "context-only", "empty"];

export interface Evidence {
  label: string;
  quote?: string;
  anchors: Anchor[];
}

export interface EvalItem {
  id: string;
  caseId: string;
  pointer: string;
  value?: unknown;
  fieldType?: string;
  fieldDefinition?: string;
  categories: string[];
  expect: Expect;
  minAcceptableMatches?: number;
  minRequiredContextMatches?: number;
  acceptable: Evidence[];
  requiredContext?: Evidence[];
  secondary: Evidence[];
  forbidden: Evidence[];
  notes?: string;
}

export interface EvalSet {
  schemaVersion: string;
  expectations: Record<string, string>;
  categories: Record<string, string>;
  items: EvalItem[];
}

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

export type FailureCode =
  | "forbidden-match"
  | "missing-acceptable"
  | "missing-required-context"
  | "insufficient-multi-citation-recall"
  | "unmatched-value-anchor"
  | "unexpected-value-for-empty"
  | "invalid-anchor"
  | "schema-invalid";

export const FAILURE_CODES: readonly FailureCode[] = [
  "forbidden-match",
  "missing-acceptable",
  "missing-required-context",
  "insufficient-multi-citation-recall",
  "unmatched-value-anchor",
  "unexpected-value-for-empty",
  "invalid-anchor",
  "schema-invalid",
];

/** Validator problems plus the scorer's own codes. */
export type AnchorProblem = ValidatorProblem | "validator-error";

/**
 * Problems that make an anchor unusable. `value-mismatch` is deliberately absent because
 * it is a heuristic from validateCitations (for example, it flags "Hope, Jesse" vs "Jesse Hope").
 * It is reported, never fatal.
 */
export const FATAL_PROBLEMS: ReadonlySet<string> = new Set<AnchorProblem>([
  "schema",
  "missing-file",
  "unresolvable",
  "empty-region",
  "quote-mismatch",
  "validator-error",
]);

export interface AnchorValidation {
  problems: AnchorProblem[];
  detail?: string;
  resolved?: string | null;
}

export interface AnchorRef {
  citationId: string;
  citationIndex: number;
  anchorIndex: number;
  kind: string;
  role: Role;
  location: string;
}

export interface EvidenceHit {
  bucket: Bucket;
  evidenceIndex: number;
  label: string;
  gtAnchorIndex: number;
  score: number;
  detail: string;
}

export type Classification = "acceptable" | "secondary" | "forbidden" | "unmatched" | "invalid";

export interface AnchorResult extends AnchorRef {
  classification: Classification;
  matches: EvidenceHit[];
}

export interface EvidenceMatch {
  bucket: Bucket;
  evidenceIndex: number;
  label: string;
  matchedBy: Array<AnchorRef & { gtAnchorIndex: number; score: number; detail: string }>;
}

export interface AnchorProblemRecord extends AnchorRef {
  problems: AnchorProblem[];
  fatal: boolean;
  detail?: string;
}

export interface ItemResult {
  id: string;
  caseId: string;
  pointer: string;
  expect: Expect;
  categories: string[];
  minAcceptableMatches: number;
  minRequiredContextMatches: number;
  pass: boolean;
  failureReasons: FailureCode[];
  citations: {
    total: number;
    scored: number;
    rejected: number;
    valueAnchors: number;
    labelContextAnchors: number;
  };
  acceptableEntries: number;
  /** Size of the maximum one-citation-to-one-entry matching over `acceptable`. */
  distinctAcceptableMatches: number;
  requiredContextEntries: number;
  distinctRequiredContextMatches: number;
  matchedAcceptable: EvidenceMatch[];
  matchedRequiredContext: EvidenceMatch[];
  matchedSecondary: EvidenceMatch[];
  forbiddenMatches: EvidenceMatch[];
  unmatchedValueAnchors: AnchorRef[];
  anchors: AnchorResult[];
  validationProblems: AnchorProblemRecord[];
  schemaErrors: string[];
}

export interface Slice {
  items: number;
  passed: number;
  failed: number;
  passRate: number | null;
}

export interface FileReport {
  caseId: string;
  file: string;
  status: "loaded" | "missing" | "unreadable" | "schema-invalid";
  items: number;
  problems: string[];
  schemaErrors: string[];
  extraPointers: number;
}

export interface ScoreReport {
  schemaVersion: "citation-eval-report/v1";
  scoredAt: string;
  run: { directory: string; files: FileReport[] };
  evalSet: { path: string; schemaVersion: string; totalItems: number };
  filters: { category: string[]; case: string[] };
  summary: {
    items: number;
    passed: number;
    failed: number;
    passRate: number | null;
    byExpect: Record<string, Slice>;
    byCategory: Record<string, Slice>;
    byFileType: Record<string, Slice>;
    anchors: {
      value: number;
      labelContext: number;
      acceptable: number;
      secondary: number;
      forbidden: number;
      unmatched: number;
      invalid: number;
      precision: number | null;
    };
    forbidden: { itemsWithHit: number; itemHitRate: number | null; anchorHits: number };
    emptyFields: { items: number; abstained: number; abstentionRate: number | null };
    multiCitation: {
      items: number;
      acceptableEntries: number;
      matchedEntries: number;
      recall: number | null;
      meanItemRecall: number | null;
    };
    manyOccurrences: {
      items: number;
      citations: number;
      valueAnchors: number;
      meanCitationsPerItem: number | null;
      maxCitationsPerItem: number;
      perItem: Array<{ id: string; citations: number; valueAnchors: number; distinctAcceptableMatches: number; acceptableEntries: number }>;
    };
    citations: { total: number; scored: number; rejected: number };
    validation: {
      filesLoaded: number;
      filesMissing: number;
      filesUnreadable: number;
      filesSchemaInvalid: number;
      anchorsWithProblems: number;
      fatalAnchors: number;
      byProblem: Record<string, number>;
    };
    failureReasons: Record<string, number>;
  };
  items: ItemResult[];
  baseline?: BaselineComparison;
}

export interface RateDelta {
  baseline: number | null;
  current: number | null;
  delta: number | null;
}

export interface BaselineComparison {
  path: string;
  baselineScoredAt?: string;
  comparedItems: number;
  onlyInBaseline: string[];
  onlyInCurrent: string[];
  overall: RateDelta;
  byExpect: Record<string, RateDelta>;
  byCategory: Record<string, RateDelta>;
  newlyFailing: Array<{ id: string; failureReasons: FailureCode[] }>;
  newlyPassing: string[];
  newForbiddenMatches: Array<{ id: string; label: string }>;
  regression: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const ROLES: readonly Role[] = ["value", "label", "context"];
const A1_RANGE = /^([A-Z]{1,3})([1-9][0-9]*)(?::([A-Z]{1,3})([1-9][0-9]*))?$/;
const JSON_POINTER = /^(\/([^/~]|~0|~1)*)*$/;

export const roleOf = (a: { role?: Role }): Role => a.role ?? "value";
export const isValueRole = (a: { role?: Role }) => roleOf(a) === "value";

/** Tolerance for threshold comparisons on floating-point areas (0.25 × 0.024 is not exactly 3 × 0.002). */
const EPS = 1e-9;
const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den);
const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
const fmt = (n: number, d = 3) => Number(n.toFixed(d));

export function describeAnchor(a: Anchor): string {
  switch (a.kind) {
    case "page-region": return `${a.file} p${a.page} (${a.boxes.length} box${a.boxes.length === 1 ? "" : "es"})`;
    case "text-span": return `${a.file}${a.pointer ?? ""}[${a.start}:${a.end}]`;
    case "json-pointer": return `${a.file}${a.pointer}`;
    case "sheet-range": return `${a.file}!${a.sheet ?? ""}!${a.range}`;
  }
}

const isRect = (r: unknown): r is Rect =>
  isRecord(r) && isFiniteNumber(r.left) && isFiniteNumber(r.top) && isFiniteNumber(r.width) && isFiniteNumber(r.height) &&
  r.width > 0 && r.height > 0;

/**
 * Structural check that is a little stricter than "is an object": anchors that fail it
 * cannot be matched or resolved and are reported as schema problems. The full JSON
 * Schema check happens separately on the whole file.
 */
export function isPlausibleAnchor(a: unknown): a is Anchor {
  if (!isRecord(a) || typeof a.file !== "string" || a.file.length === 0) return false;
  if (a.role !== undefined && !ROLES.includes(a.role as Role)) return false;
  switch (a.kind) {
    case "page-region":
      return /\.pdf$/i.test(a.file) && Number.isInteger(a.page) && (a.page as number) >= 1 &&
        Array.isArray(a.boxes) && a.boxes.length > 0 && a.boxes.every(isRect);
    case "text-span":
      return isNonNegInt(a.start) && isNonNegInt(a.end) && (a.end as number) > (a.start as number) &&
        (a.pointer === undefined || (typeof a.pointer === "string" && JSON_POINTER.test(a.pointer)));
    case "json-pointer":
      return /\.json$/i.test(a.file) && typeof a.pointer === "string" && JSON_POINTER.test(a.pointer);
    case "sheet-range":
      return /\.(xlsx?|csv)$/i.test(a.file) && typeof a.range === "string" && A1_RANGE.test(a.range) &&
        (a.sheet === undefined || typeof a.sheet === "string");
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Geometry: rectangle unions
// ---------------------------------------------------------------------------

export interface UnionStats {
  areaA: number;
  areaB: number;
  intersection: number;
  union: number;
}

/**
 * Exact areas of union(A), union(B), union(A) ∩ union(B) and union(A) ∪ union(B) by
 * coordinate compression: every grid cell induced by the rectangle edges is either
 * fully inside or fully outside each rectangle, so testing the cell centre is exact.
 */
export function rectUnionStats(a: Rect[], b: Rect[]): UnionStats {
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const r of [...a, ...b]) {
    xs.add(r.left); xs.add(r.left + r.width);
    ys.add(r.top); ys.add(r.top + r.height);
  }
  const X = [...xs].sort((p, q) => p - q);
  const Y = [...ys].sort((p, q) => p - q);
  const contains = (r: Rect, cx: number, cy: number) =>
    cx > r.left && cx < r.left + r.width && cy > r.top && cy < r.top + r.height;
  const stats: UnionStats = { areaA: 0, areaB: 0, intersection: 0, union: 0 };
  for (let i = 0; i < X.length - 1; i++) {
    const w = X[i + 1]! - X[i]!;
    if (w <= 0) continue;
    const cx = (X[i]! + X[i + 1]!) / 2;
    for (let j = 0; j < Y.length - 1; j++) {
      const h = Y[j + 1]! - Y[j]!;
      if (h <= 0) continue;
      const cy = (Y[j]! + Y[j + 1]!) / 2;
      const inA = a.some((r) => contains(r, cx, cy));
      const inB = b.some((r) => contains(r, cx, cy));
      if (!inA && !inB) continue;
      const area = w * h;
      if (inA) stats.areaA += area;
      if (inB) stats.areaB += area;
      if (inA && inB) stats.intersection += area;
      stats.union += area;
    }
  }
  return stats;
}

export const unionArea = (rects: Rect[]) => rectUnionStats(rects, []).areaA;

// ---------------------------------------------------------------------------
// Anchor matching (eval/README.md "Matching a produced anchor to a ground-truth anchor")
// ---------------------------------------------------------------------------

export interface MatchResult {
  score: number;
  detail: string;
}

export interface MatchContext {
  /** Length (UTF-16 code units) of the JSON string at file/pointer, if it is a string. */
  jsonStringLength?: (file: string, pointer: string) => number | undefined;
}

/** Same file + page; IoU of unions ≥ 0.5, or coverage ≥ 80 % with produced area ≤ 3× GT area. */
export function matchPageRegion(produced: PageRegionAnchor, gt: PageRegionAnchor): MatchResult | null {
  if (produced.file !== gt.file || produced.page !== gt.page) return null;
  const s = rectUnionStats(produced.boxes, gt.boxes);
  if (s.areaB <= 0 || s.areaA <= 0 || s.union <= 0) return null;
  const iou = s.intersection / s.union;
  const coverage = s.intersection / s.areaB;
  const areaRatio = s.areaA / s.areaB;
  const detail = `IoU ${fmt(iou)}, covers ${fmt(coverage)} of GT, area ×${fmt(areaRatio, 2)}`;
  if (iou >= 0.5 - EPS) return { score: iou, detail };
  if (coverage >= 0.8 - EPS && areaRatio <= 3 + EPS) return { score: iou, detail: `${detail} (coverage fallback)` };
  return null;
}

/** Same file + pointer (both absent counts as same); overlap ≥ 50 % of GT; produced ≤ 2× GT length. */
export function matchTextSpan(produced: TextSpanAnchor, gt: TextSpanAnchor): MatchResult | null {
  if (produced.file !== gt.file || produced.pointer !== gt.pointer) return null;
  const gtLen = gt.end - gt.start;
  const pLen = produced.end - produced.start;
  if (gtLen <= 0 || pLen <= 0) return null;
  const overlap = Math.max(0, Math.min(produced.end, gt.end) - Math.max(produced.start, gt.start));
  if (overlap * 2 < gtLen || pLen > 2 * gtLen) return null;
  const span = Math.max(produced.end, gt.end) - Math.min(produced.start, gt.start);
  return { score: overlap / span, detail: `overlap ${overlap}/${gtLen}, produced length ${pLen}` };
}

/** Same file + identical pointer; or a text-span on the same pointer that covers the whole string. */
export function matchJsonPointer(produced: Anchor, gt: JsonPointerAnchor, ctx: MatchContext = {}): MatchResult | null {
  if (produced.file !== gt.file) return null;
  if (produced.kind === "json-pointer") {
    return produced.pointer === gt.pointer ? { score: 1, detail: "identical pointer" } : null;
  }
  if (produced.kind === "text-span" && produced.pointer === gt.pointer) {
    const len = ctx.jsonStringLength?.(gt.file, gt.pointer);
    if (len !== undefined && len > 0 && produced.start <= 0 && produced.end >= len) {
      return { score: 1, detail: `text-span covers the whole string (${len} code units)` };
    }
  }
  return null;
}

export interface CellRange { c0: number; r0: number; c1: number; r1: number }

const colToIndex = (col: string) => [...col].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

export function parseA1Range(range: string): CellRange | null {
  const m = A1_RANGE.exec(range);
  if (!m) return null;
  const c0 = colToIndex(m[1]!), r0 = Number(m[2]) - 1;
  const c1 = m[3] ? colToIndex(m[3]) : c0, r1 = m[4] ? Number(m[4]) - 1 : r0;
  return { c0: Math.min(c0, c1), c1: Math.max(c0, c1), r0: Math.min(r0, r1), r1: Math.max(r0, r1) };
}

export const cellCount = (r: CellRange) => (r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1);

/** Same file + sheet; GT cell(s) inside the produced range; produced range ≤ 4 cells. */
export function matchSheetRange(produced: SheetRangeAnchor, gt: SheetRangeAnchor): MatchResult | null {
  if (produced.file !== gt.file || (produced.sheet ?? undefined) !== (gt.sheet ?? undefined)) return null;
  const p = parseA1Range(produced.range);
  const g = parseA1Range(gt.range);
  if (!p || !g) return null;
  const cells = cellCount(p);
  if (cells > 4) return null;
  if (g.c0 < p.c0 || g.c1 > p.c1 || g.r0 < p.r0 || g.r1 > p.r1) return null;
  return { score: cellCount(g) / cells, detail: `${gt.range} inside ${produced.range} (${cells} cell${cells === 1 ? "" : "s"})` };
}

export function matchAnchor(produced: Anchor, gt: Anchor, ctx: MatchContext = {}): MatchResult | null {
  switch (gt.kind) {
    case "page-region": return produced.kind === "page-region" ? matchPageRegion(produced, gt) : null;
    case "text-span": return produced.kind === "text-span" ? matchTextSpan(produced, gt) : null;
    case "json-pointer": return matchJsonPointer(produced, gt, ctx);
    case "sheet-range": return produced.kind === "sheet-range" ? matchSheetRange(produced, gt) : null;
    default: return null;
  }
}

/** Anchors of an evidence entry that a produced anchor is judged against: value-role ones, or all if there are none. */
export function judgedAnchors(ev: Evidence): Array<{ index: number; anchor: Anchor }> {
  const all = ev.anchors.map((anchor, index) => ({ index, anchor }));
  const value = all.filter((x) => isValueRole(x.anchor));
  return value.length ? value : all;
}

export function matchEvidence(produced: Anchor, ev: Evidence, ctx: MatchContext = {}): (MatchResult & { gtAnchorIndex: number }) | null {
  let best: (MatchResult & { gtAnchorIndex: number }) | null = null;
  for (const { index, anchor } of judgedAnchors(ev)) {
    const m = matchAnchor(produced, anchor, ctx);
    if (m && (!best || m.score > best.score)) best = { ...m, gtAnchorIndex: index };
  }
  return best;
}

/** Label/context anchors stored beside a value. They are the field the value sits in. */
export function localContextAnchors(ev: Evidence): Array<{ index: number; anchor: Anchor }> {
  return ev.anchors
    .map((anchor, index) => ({ index, anchor }))
    .filter((x) => roleOf(x.anchor) === "label" || roleOf(x.anchor) === "context");
}

/**
 * A value hit counts as that evidence only when the same citation also covers the
 * label or context around it. One box that overlaps both the value and the label
 * is enough. Entries with no local context are judged on the value alone.
 */
export function citationCoversLocalContext(anchors: readonly Anchor[], ev: Evidence, ctx: MatchContext = {}): boolean {
  const context = localContextAnchors(ev);
  if (!context.length) return true;
  return anchors.some((produced) => context.some(({ anchor }) => matchAnchor(produced, anchor, ctx)));
}

// ---------------------------------------------------------------------------
// Maximum bipartite matching (Kuhn) — one citation can support at most one acceptable entry
// ---------------------------------------------------------------------------

export function maximumBipartiteMatching(leftCount: number, rightCount: number, edge: (l: number, r: number) => boolean): number {
  const matchOfRight = new Array<number>(rightCount).fill(-1);
  const tryAssign = (l: number, seen: boolean[]): boolean => {
    for (let r = 0; r < rightCount; r++) {
      if (seen[r] || !edge(l, r)) continue;
      seen[r] = true;
      if (matchOfRight[r] === -1 || tryAssign(matchOfRight[r]!, seen)) { matchOfRight[r] = l; return true; }
    }
    return false;
  };
  let size = 0;
  for (let l = 0; l < leftCount; l++) if (tryAssign(l, new Array<boolean>(rightCount).fill(false))) size++;
  return size;
}

// ---------------------------------------------------------------------------
// Item scoring (eval/README.md "Pass rules per expect")
// ---------------------------------------------------------------------------

export interface ScoreContext extends MatchContext {
  /** Validation outcome for a candidate anchor (by citation index within the pointer's list, anchor index). */
  validation?: (citationIndex: number, anchorIndex: number) => AnchorValidation | undefined;
  /** Schema errors that affect this item (file-level errors or errors localized to this pointer). */
  schemaErrors?: string[];
}

export function scoreItem(item: EvalItem, rawCitations: unknown, ctx: ScoreContext = {}): ItemResult {
  const schemaErrors = [...(ctx.schemaErrors ?? [])];
  const citations: unknown[] = Array.isArray(rawCitations) ? rawCitations : [];
  if (rawCitations !== undefined && !Array.isArray(rawCitations)) {
    schemaErrors.push(`/citations${item.pointer} is not an array (treated as empty)`);
  }

  const anchors: AnchorResult[] = [];
  const validationProblems: AnchorProblemRecord[] = [];
  const scoredCitationIndexes: number[] = [];
  let rejected = 0;

  citations.forEach((c, ci) => {
    if (!isRecord(c)) { schemaErrors.push(`/citations${item.pointer}/${ci} is not an object`); return; }
    if (c.status === "rejected") { rejected++; return; }
    scoredCitationIndexes.push(ci);
    const citationId = typeof c.id === "string" && c.id ? c.id : `#${ci}`;
    const rawAnchors: unknown[] = Array.isArray(c.anchors) ? c.anchors : [];
    if (rawAnchors.length === 0) schemaErrors.push(`/citations${item.pointer}/${ci} (${citationId}) has no anchors`);
    const plausible = rawAnchors.filter(isPlausibleAnchor);

    rawAnchors.forEach((a, ai) => {
      const base = { citationId, citationIndex: ci, anchorIndex: ai };
      if (!isPlausibleAnchor(a)) {
        const kind = isRecord(a) && typeof a.kind === "string" ? a.kind : "unknown";
        const ref: AnchorRef = { ...base, kind, role: "value", location: "(malformed anchor)" };
        anchors.push({ ...ref, classification: "invalid", matches: [] });
        validationProblems.push({ ...ref, problems: ["schema"], fatal: true, detail: "anchor does not have a recognised citations/v1 shape" });
        return;
      }
      const ref: AnchorRef = { ...base, kind: a.kind, role: roleOf(a), location: describeAnchor(a) };
      const matches: EvidenceHit[] = [];
      for (const bucket of BUCKETS) {
        item[bucket].forEach((ev, evidenceIndex) => {
          const m = matchEvidence(a, ev, ctx);
          if (m) matches.push({ bucket, evidenceIndex, label: ev.label, gtAnchorIndex: m.gtAnchorIndex, score: fmt(m.score, 4), detail: m.detail });
        });
      }
      (item.requiredContext ?? []).forEach((ev, evidenceIndex) => {
        const m = matchEvidence(a, ev, ctx);
        if (m) matches.push({ bucket: "requiredContext", evidenceIndex, label: ev.label, gtAnchorIndex: m.gtAnchorIndex, score: fmt(m.score, 4), detail: m.detail });
      });
      // Drop acceptable hits whose surrounding label/context this citation never covers.
      for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i]!;
        if (m.bucket !== "acceptable") continue;
        const ev = item.acceptable[m.evidenceIndex];
        if (ev && !citationCoversLocalContext(plausible, ev, ctx)) matches.splice(i, 1);
      }
      const has = (b: Bucket) => matches.some((m) => m.bucket === b);
      const classification: Classification = has("forbidden") ? "forbidden" : has("acceptable") ? "acceptable" : has("secondary") ? "secondary" : "unmatched";
      anchors.push({ ...ref, classification, matches });

      const v = ctx.validation?.(ci, ai);
      if (v?.problems.length) {
        validationProblems.push({ ...ref, problems: v.problems, fatal: v.problems.some((p) => FATAL_PROBLEMS.has(p)), detail: v.detail });
      }
    });
  });

  const judged = anchors.filter((a) => a.classification !== "invalid");
  const valueAnchors = judged.filter((a) => a.role === "value");

  // Evidence-level views -----------------------------------------------------
  const collect = (bucket: Bucket, pool: AnchorResult[]): EvidenceMatch[] => {
    const byEvidence = new Map<number, EvidenceMatch>();
    for (const a of pool) {
      for (const m of a.matches) {
        if (m.bucket !== bucket) continue;
        let em = byEvidence.get(m.evidenceIndex);
        if (!em) { em = { bucket, evidenceIndex: m.evidenceIndex, label: m.label, matchedBy: [] }; byEvidence.set(m.evidenceIndex, em); }
        const { classification: _c, matches: _m, ...ref } = a;
        em.matchedBy.push({ ...ref, gtAnchorIndex: m.gtAnchorIndex, score: m.score, detail: m.detail });
      }
    }
    return [...byEvidence.values()].sort((x, y) => x.evidenceIndex - y.evidenceIndex);
  };
  const matchedAcceptableByValue = collect("acceptable", valueAnchors);
  const matchedRequiredContext = collect("requiredContext", judged.filter((a) => a.role === "context"));
  const matchedSecondary = collect("secondary", valueAnchors);
  const forbiddenMatches = collect("forbidden", valueAnchors);
  const unmatchedValueAnchors: AnchorRef[] = valueAnchors
    .filter((a) => a.classification === "unmatched")
    .map(({ classification: _c, matches: _m, ...ref }) => ref);

  // Distinct acceptable entries: each scored citation may support at most one entry.
  const acceptableHit = (ci: number, ei: number) =>
    valueAnchors.some((a) => a.citationIndex === ci && a.matches.some((m) => m.bucket === "acceptable" && m.evidenceIndex === ei));
  const distinctAcceptableMatches = maximumBipartiteMatching(
    scoredCitationIndexes.length, item.acceptable.length,
    (l, r) => acceptableHit(scoredCitationIndexes[l]!, r),
  );
  const requiredContext = item.requiredContext ?? [];
  const distinctRequiredContextMatches = matchedRequiredContext.length;

  // Pass rules ---------------------------------------------------------------
  const reasons = new Set<FailureCode>();
  if (schemaErrors.length || validationProblems.some((p) => p.problems.includes("schema"))) reasons.add("schema-invalid");
  if (validationProblems.some((p) => p.fatal && !p.problems.includes("schema"))) reasons.add("invalid-anchor");
  if (forbiddenMatches.length) reasons.add("forbidden-match");
  const minAcceptableMatches = item.minAcceptableMatches ?? 1;
  const minRequiredContextMatches = requiredContext.length ? (item.minRequiredContextMatches ?? 1) : 0;
  switch (item.expect) {
    case "cite":
      if (distinctAcceptableMatches === 0) reasons.add("missing-acceptable");
      else if (distinctAcceptableMatches < minAcceptableMatches) reasons.add("insufficient-multi-citation-recall");
      if (distinctRequiredContextMatches < minRequiredContextMatches) reasons.add("missing-required-context");
      if (unmatchedValueAnchors.length) reasons.add("unmatched-value-anchor");
      break;
    case "context-only":
      if (unmatchedValueAnchors.length) reasons.add("unmatched-value-anchor");
      break;
    case "empty":
      if (valueAnchors.length) reasons.add("unexpected-value-for-empty");
      break;
  }

  const failureReasons = FAILURE_CODES.filter((c) => reasons.has(c));
  return {
    id: item.id,
    caseId: item.caseId,
    pointer: item.pointer,
    expect: item.expect,
    categories: [...item.categories],
    minAcceptableMatches,
    minRequiredContextMatches,
    pass: failureReasons.length === 0,
    failureReasons,
    citations: {
      total: citations.length,
      scored: scoredCitationIndexes.length,
      rejected,
      valueAnchors: valueAnchors.length,
      labelContextAnchors: judged.length - valueAnchors.length,
    },
    acceptableEntries: item.acceptable.length,
    distinctAcceptableMatches,
    requiredContextEntries: requiredContext.length,
    distinctRequiredContextMatches,
    matchedAcceptable: matchedAcceptableByValue,
    matchedRequiredContext,
    matchedSecondary,
    forbiddenMatches,
    unmatchedValueAnchors,
    anchors,
    validationProblems,
    schemaErrors,
  };
}

// ---------------------------------------------------------------------------
// Report aggregation
// ---------------------------------------------------------------------------

export function slice(results: ItemResult[]): Slice {
  const passed = results.filter((r) => r.pass).length;
  return { items: results.length, passed, failed: results.length - passed, passRate: rate(passed, results.length) };
}

const sortedUnique = (xs: string[]) => [...new Set(xs)].sort();

export function summarize(results: ItemResult[], files: FileReport[]): ScoreReport["summary"] {
  const overall = slice(results);
  const byExpect: Record<string, Slice> = {};
  for (const e of EXPECTS) byExpect[e] = slice(results.filter((r) => r.expect === e));
  const byCategory: Record<string, Slice> = {};
  for (const c of sortedUnique(results.flatMap((r) => r.categories))) byCategory[c] = slice(results.filter((r) => r.categories.includes(c)));
  const byFileType: Record<string, Slice> = {};
  for (const [c, s] of Object.entries(byCategory)) if (c.startsWith("file:")) byFileType[c] = s;

  const allAnchors = results.flatMap((r) => r.anchors);
  const valueAnchors = allAnchors.filter((a) => a.role === "value" && a.classification !== "invalid");
  const count = (c: Classification) => valueAnchors.filter((a) => a.classification === c).length;
  const acceptable = count("acceptable"), secondary = count("secondary"), forbidden = count("forbidden"), unmatched = count("unmatched");

  const emptyItems = results.filter((r) => r.expect === "empty");
  const abstained = emptyItems.filter((r) => r.citations.valueAnchors === 0).length;
  const multi = results.filter((r) => r.categories.includes("multi-citation"));
  const multiEntries = multi.reduce((n, r) => n + r.acceptableEntries, 0);
  const multiMatched = multi.reduce((n, r) => n + Math.min(r.distinctAcceptableMatches, r.acceptableEntries), 0);
  const itemRecalls = multi.filter((r) => r.acceptableEntries > 0).map((r) => r.distinctAcceptableMatches / r.acceptableEntries);

  const many = results.filter((r) => r.categories.includes("many-occurrences"));
  const manyCitations = many.reduce((n, r) => n + r.citations.scored, 0);

  const problems = results.flatMap((r) => r.validationProblems);
  const byProblem: Record<string, number> = {};
  for (const p of problems) for (const code of p.problems) byProblem[code] = (byProblem[code] ?? 0) + 1;

  const failureReasons: Record<string, number> = {};
  for (const code of FAILURE_CODES) {
    const n = results.filter((r) => r.failureReasons.includes(code)).length;
    if (n) failureReasons[code] = n;
  }

  return {
    ...overall,
    byExpect,
    byCategory,
    byFileType,
    anchors: {
      value: valueAnchors.length,
      labelContext: allAnchors.filter((a) => a.role !== "value" && a.classification !== "invalid").length,
      acceptable, secondary, forbidden, unmatched,
      invalid: allAnchors.filter((a) => a.classification === "invalid").length,
      precision: rate(acceptable + secondary, valueAnchors.length),
    },
    forbidden: {
      itemsWithHit: results.filter((r) => r.forbiddenMatches.length > 0).length,
      itemHitRate: rate(results.filter((r) => r.forbiddenMatches.length > 0).length, results.length),
      anchorHits: forbidden,
    },
    emptyFields: { items: emptyItems.length, abstained, abstentionRate: rate(abstained, emptyItems.length) },
    multiCitation: {
      items: multi.length,
      acceptableEntries: multiEntries,
      matchedEntries: multiMatched,
      recall: rate(multiMatched, multiEntries),
      meanItemRecall: itemRecalls.length ? itemRecalls.reduce((a, b) => a + b, 0) / itemRecalls.length : null,
    },
    manyOccurrences: {
      items: many.length,
      citations: manyCitations,
      valueAnchors: many.reduce((n, r) => n + r.citations.valueAnchors, 0),
      meanCitationsPerItem: rate(manyCitations, many.length),
      maxCitationsPerItem: many.reduce((m, r) => Math.max(m, r.citations.scored), 0),
      perItem: many.map((r) => ({
        id: r.id, citations: r.citations.scored, valueAnchors: r.citations.valueAnchors,
        distinctAcceptableMatches: r.distinctAcceptableMatches, acceptableEntries: r.acceptableEntries,
      })),
    },
    citations: {
      total: results.reduce((n, r) => n + r.citations.total, 0),
      scored: results.reduce((n, r) => n + r.citations.scored, 0),
      rejected: results.reduce((n, r) => n + r.citations.rejected, 0),
    },
    validation: {
      filesLoaded: files.filter((f) => f.status === "loaded" || f.status === "schema-invalid").length,
      filesMissing: files.filter((f) => f.status === "missing").length,
      filesUnreadable: files.filter((f) => f.status === "unreadable").length,
      filesSchemaInvalid: files.filter((f) => f.status === "schema-invalid").length,
      anchorsWithProblems: problems.length,
      fatalAnchors: problems.filter((p) => p.fatal).length,
      byProblem,
    },
    failureReasons,
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

type BaselineLike = { scoredAt?: string; items: Array<Pick<ItemResult, "id" | "pass" | "expect" | "categories"> & { forbiddenMatches?: Array<{ label: string }>; failureReasons?: FailureCode[] }> };

export function isReportLike(v: unknown): v is BaselineLike {
  return isRecord(v) && Array.isArray(v.items) &&
    v.items.every((i) => isRecord(i) && typeof i.id === "string" && typeof i.pass === "boolean" && Array.isArray(i.categories));
}

export function compareWithBaseline(baseline: BaselineLike, current: ScoreReport, baselinePath: string): BaselineComparison {
  const baseById = new Map(baseline.items.map((i) => [i.id, i]));
  const curById = new Map(current.items.map((i) => [i.id, i]));
  const common = current.items.filter((i) => baseById.has(i.id)).map((i) => i.id);
  const commonSet = new Set(common);

  const rateOf = (items: Array<{ pass: boolean }>): number | null => rate(items.filter((i) => i.pass).length, items.length);
  const delta = (b: Array<{ pass: boolean }>, c: Array<{ pass: boolean }>): RateDelta => {
    const rb = rateOf(b), rc = rateOf(c);
    return { baseline: rb, current: rc, delta: rb === null || rc === null ? null : rc - rb };
  };
  const baseCommon = baseline.items.filter((i) => commonSet.has(i.id));
  const curCommon = current.items.filter((i) => commonSet.has(i.id));

  const byExpect: Record<string, RateDelta> = {};
  for (const e of EXPECTS) byExpect[e] = delta(baseCommon.filter((i) => i.expect === e), curCommon.filter((i) => i.expect === e));
  const byCategory: Record<string, RateDelta> = {};
  for (const c of sortedUnique(curCommon.flatMap((i) => i.categories))) {
    byCategory[c] = delta(baseCommon.filter((i) => i.categories.includes(c)), curCommon.filter((i) => i.categories.includes(c)));
  }

  const newlyFailing = curCommon.filter((i) => !i.pass && baseById.get(i.id)!.pass).map((i) => ({ id: i.id, failureReasons: i.failureReasons }));
  const newlyPassing = curCommon.filter((i) => i.pass && !baseById.get(i.id)!.pass).map((i) => i.id);
  const newForbiddenMatches: Array<{ id: string; label: string }> = [];
  for (const i of curCommon) {
    const before = new Set((baseById.get(i.id)!.forbiddenMatches ?? []).map((f) => f.label));
    for (const label of sortedUnique(i.forbiddenMatches.map((f) => f.label))) if (!before.has(label)) newForbiddenMatches.push({ id: i.id, label });
  }

  return {
    path: baselinePath,
    baselineScoredAt: baseline.scoredAt,
    comparedItems: common.length,
    onlyInBaseline: baseline.items.filter((i) => !curById.has(i.id)).map((i) => i.id),
    onlyInCurrent: current.items.filter((i) => !baseById.has(i.id)).map((i) => i.id),
    overall: delta(baseCommon, curCommon),
    byExpect,
    byCategory,
    newlyFailing,
    newlyPassing,
    newForbiddenMatches,
    regression: newlyFailing.length > 0 || newForbiddenMatches.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Schema error localisation
// ---------------------------------------------------------------------------

export interface SchemaErrorRecord {
  message: string;
  /** "all" = affects every item in the file; a pointer = only that item; null = file-level note only. */
  affects: "all" | { pointer: string } | null;
}

const unescapePointerToken = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~");

export function classifySchemaError(e: { instancePath: string; keyword: string; message?: string; params?: Record<string, unknown> }): SchemaErrorRecord {
  const extra = e.params && typeof e.params.additionalProperty === "string" ? ` (${e.params.additionalProperty})`
    : e.params && typeof e.params.propertyName === "string" ? ` (${JSON.stringify(e.params.propertyName)})` : "";
  const message = `${e.instancePath || "/"} ${e.message ?? e.keyword}${extra}`;
  const seg = e.instancePath.split("/");
  if (seg.length >= 3 && seg[1] === "citations") return { message, affects: { pointer: unescapePointerToken(seg[2]!) } };
  if (e.instancePath === "/citations" && e.keyword === "propertyNames") return { message, affects: null };
  return { message, affects: "all" };
}

// ---------------------------------------------------------------------------
// Quote consistency (relaxed; see header comment)
// ---------------------------------------------------------------------------

const normText = (s: string) => s.replace(/[\s$,]+/g, "").toLowerCase();
const tokens = (s: string) => s.toLowerCase().split(/\s+/).map((t) => t.replace(/[$,]/g, "")).filter(Boolean);
const asNumber = (s: string) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);

/**
 * Is `quote` consistent with the text actually under the anchor? Accepts exact matches,
 * containment either way (pdf.js text-layer interpolation clips glyphs at box edges;
 * composite quotes span several anchors), token-set containment (OCR word order), and
 * numeric equality (formatted "$0.00" vs raw "0" in spreadsheets).
 */
export function quoteConsistent(resolved: string, quote: string): boolean {
  const nr = normText(resolved), nq = normText(quote);
  if (nr === nq) return true;
  if (!nr || !nq) return false;
  if (nr.includes(nq) || nq.includes(nr)) return true;
  const tr = tokens(resolved), tq = tokens(quote);
  if (tr.length && tq.length) {
    const sr = new Set(tr), sq = new Set(tq);
    if (tr.every((t) => sq.has(t)) || tq.every((t) => sr.has(t))) return true;
  }
  const a = asNumber(nr), b = asNumber(nq);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

// ---------------------------------------------------------------------------
// Case sources (OCR fallback + JSON string lengths)
// ---------------------------------------------------------------------------

interface OcrWord { text: string; bbox: { left: number; top: number; width: number; height: number; page: number; original_page?: number } }
interface SourceIndex { files?: Array<{ file: string; ocrArtifact?: string | null; renderedPdf?: string | null }> }

class CaseSources {
  private sourceIndexP?: Promise<SourceIndex | null>;
  private ocr = new Map<string, Promise<OcrWord[] | null>>();
  private json = new Map<string, Promise<unknown>>();
  constructor(private caseDir: string) {}

  private safe(name: string) {
    if (name.includes("..") || name.includes("/") || name.includes("\\")) throw new Error(`unsafe file name ${name}`);
    return path.join(this.caseDir, "files", name);
  }

  private sourceIndex(): Promise<SourceIndex | null> {
    this.sourceIndexP ??= fs.readFile(path.join(this.caseDir, "source-index.json"), "utf8").then((s) => JSON.parse(s) as SourceIndex, () => null);
    return this.sourceIndexP;
  }

  /** OCR words for a PDF, or null when there is no usable artifact (rendered spreadsheets use cell units). */
  ocrWords(pdfFile: string): Promise<OcrWord[] | null> {
    let p = this.ocr.get(pdfFile);
    if (!p) {
      p = (async () => {
        const idx = await this.sourceIndex();
        const entries = idx?.files ?? [];
        if (entries.some((f) => f.renderedPdf === pdfFile)) return null;
        const artifact = entries.find((f) => f.file === pdfFile)?.ocrArtifact ?? pdfFile.replace(/\.pdf$/i, "-ocr.json");
        try {
          const doc = JSON.parse(await fs.readFile(this.safe(artifact), "utf8")) as { ocr?: { words?: OcrWord[] } };
          return doc.ocr?.words ?? null;
        } catch {
          return null;
        }
      })();
      this.ocr.set(pdfFile, p);
    }
    return p;
  }

  async ocrTextUnder(a: PageRegionAnchor): Promise<string | null> {
    const words = await this.ocrWords(a.file);
    if (!words) return null;
    const inside = (cx: number, cy: number) => a.boxes.some((b) => cx >= b.left && cx <= b.left + b.width && cy >= b.top && cy <= b.top + b.height);
    const picked: string[] = [];
    for (const w of words) {
      if (!w.bbox) continue;
      const page = Number.isInteger(w.bbox.original_page) && w.bbox.original_page! >= 1 ? w.bbox.original_page! : w.bbox.page;
      if (page !== a.page) continue;
      if (inside(w.bbox.left + w.bbox.width / 2, w.bbox.top + w.bbox.height / 2)) picked.push(w.text);
    }
    return picked.join(" ");
  }

  async jsonStringLength(file: string, pointer: string): Promise<number | undefined> {
    let p = this.json.get(file);
    if (!p) {
      p = fs.readFile(this.safe(file), "utf8").then((s) => JSON.parse(s.replace(/^\uFEFF/, "")) as unknown, () => undefined);
      this.json.set(file, p);
    }
    const doc = await p;
    if (doc === undefined) return undefined;
    try {
      const v = jsonPointerGet(doc, pointer);
      return typeof v === "string" ? v.length : undefined;
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Loading + validating one candidate file
// ---------------------------------------------------------------------------

type SchemaValidator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; keyword: string; message?: string; params?: Record<string, unknown> }> | null };

interface LoadedCase {
  report: FileReport;
  raw: Record<string, unknown> | null;
  schemaErrors: SchemaErrorRecord[];
  /** `${pointer}\0${citationIndex}\0${anchorIndex}` → validation outcome. */
  validation: Map<string, AnchorValidation>;
  /** `${file}\0${pointer}` → JSON string length. */
  jsonStringLengths: Map<string, number | undefined>;
  validatorError?: string;
}

const vkey = (pointer: string, ci: number, ai: number) => `${pointer}\0${ci}\0${ai}`;
const lkey = (file: string, pointer: string) => `${file}\0${pointer}`;

async function loadCase(
  repoRoot: string,
  runDir: string,
  caseId: string,
  pointers: string[],
  schema: object,
  validateSchema: SchemaValidator,
): Promise<LoadedCase> {
  const file = path.join(runDir, `${caseId}.citations.json`);
  const report: FileReport = { caseId, file, status: "loaded", items: pointers.length, problems: [], schemaErrors: [], extraPointers: 0 };
  const loaded: LoadedCase = { report, raw: null, schemaErrors: [], validation: new Map(), jsonStringLengths: new Map() };

  if (!existsSync(file)) {
    report.status = "missing";
    report.problems.push("candidate file not found; every item in this case is scored as an empty citation list");
    return loaded;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    report.status = "unreadable";
    report.problems.push(`cannot parse JSON: ${err instanceof Error ? err.message : String(err)}`);
    loaded.schemaErrors.push({ message: "file is not valid JSON", affects: "all" });
    report.schemaErrors.push("file is not valid JSON");
    return loaded;
  }
  if (!isRecord(parsed)) {
    report.status = "schema-invalid";
    loaded.schemaErrors.push({ message: "/ must be an object", affects: "all" });
    report.schemaErrors.push("/ must be an object");
    return loaded;
  }
  loaded.raw = parsed;

  if (!validateSchema(parsed)) {
    report.status = "schema-invalid";
    const seen = new Set<string>();
    for (const e of validateSchema.errors ?? []) {
      const rec = classifySchemaError(e);
      if (seen.has(rec.message)) continue;
      seen.add(rec.message);
      loaded.schemaErrors.push(rec);
      report.schemaErrors.push(rec.message);
    }
  }
  if (parsed.caseId !== caseId) {
    report.problems.push(`caseId ${JSON.stringify(parsed.caseId)} does not match file name; scored against ${caseId}`);
  }
  const citations = isRecord(parsed.citations) ? parsed.citations : {};
  const wanted = new Set(pointers);
  report.extraPointers = Object.keys(citations).filter((k) => !wanted.has(k)).length;

  // Sanitised copy for the grounding validator: in-scope pointers, non-rejected citations,
  // structurally plausible anchors only (so malformed input cannot crash the resolver).
  const sanitized: CitationSet = { schemaVersion: "citations/v1", caseId, citations: {} };
  const anchorIndexMap = new Map<string, number[]>(); // `${pointer}\0${ci}` → original anchor indexes
  const textSpansWithPointer: TextSpanAnchor[] = [];
  const pageRegions: Array<{ key: string; anchor: PageRegionAnchor; quote?: string }> = [];
  for (const pointer of pointers) {
    const list = citations[pointer];
    if (!Array.isArray(list)) continue;
    const out: Citation[] = [];
    list.forEach((c, ci) => {
      if (!isRecord(c) || c.status === "rejected" || !Array.isArray(c.anchors)) return;
      const keep: Anchor[] = [];
      const idxs: number[] = [];
      c.anchors.forEach((a, ai) => {
        if (!isPlausibleAnchor(a)) return;
        keep.push(a);
        idxs.push(ai);
        if (a.kind === "text-span" && a.pointer !== undefined) textSpansWithPointer.push(a);
        if (a.kind === "page-region") pageRegions.push({ key: vkey(pointer, ci, ai), anchor: a, quote: typeof c.quote === "string" ? c.quote : undefined });
      });
      if (!keep.length) return;
      anchorIndexMap.set(`${pointer}\0${ci}`, idxs);
      out.push({
        id: String(ci),
        status: c.status === "accepted" ? "accepted" : "proposed",
        source: "auto",
        ...(typeof c.quote === "string" ? { quote: c.quote } : {}),
        anchors: keep,
      });
    });
    if (out.length) sanitized.citations[pointer] = out;
  }

  const sources = new CaseSources(path.join(repoRoot, "test-cases", caseId));
  for (const a of textSpansWithPointer) {
    const k = lkey(a.file, a.pointer!);
    if (!loaded.jsonStringLengths.has(k)) loaded.jsonStringLengths.set(k, await sources.jsonStringLength(a.file, a.pointer!));
  }

  if (!Object.keys(sanitized.citations).length) return loaded;

  let checks: AnchorCheck[];
  try {
    checks = (await validateCitationSet(repoRoot, sanitized, { schema })).checks;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    loaded.validatorError = msg;
    report.problems.push(`grounding validator failed: ${msg}`);
    for (const [k, idxs] of anchorIndexMap) {
      const [pointer, ci] = k.split("\0");
      for (const ai of idxs) loaded.validation.set(vkey(pointer!, Number(ci), ai), { problems: ["validator-error"], detail: msg, resolved: null });
    }
    return loaded;
  }

  for (const ch of checks) {
    const idxs = anchorIndexMap.get(`${ch.path}\0${ch.citationId}`);
    const ai = idxs?.[ch.anchorIndex];
    if (ai === undefined) continue;
    const key = vkey(ch.path, Number(ch.citationId), ai);
    let problems = [...ch.problems];
    let resolved: string | null = ch.resolved;
    let detail = ch.detail;

    const pr = pageRegions.find((p) => p.key === key);
    if (pr && (problems.includes("empty-region") || problems.includes("quote-mismatch"))) {
      // pdf.js has no text layer for scanned PDFs and interpolates glyph positions on the
      // rest; the OCR artifact is what the ground truth was derived from, so consult it.
      const ocrText = await sources.ocrTextUnder(pr.anchor);
      if (ocrText?.trim()) {
        if (problems.includes("empty-region")) {
          problems = problems.filter((p) => p !== "empty-region");
          resolved = ocrText;
          if (pr.quote !== undefined && ch.role === "value" && !quoteConsistent(ocrText, pr.quote)) {
            problems.push("quote-mismatch");
            detail = `OCR text ${JSON.stringify(ocrText.slice(0, 80))} != quote ${JSON.stringify(pr.quote.slice(0, 80))}`;
          }
        } else if (pr.quote !== undefined && (quoteConsistent(ch.resolved ?? "", pr.quote) || quoteConsistent(ocrText, pr.quote))) {
          problems = problems.filter((p) => p !== "quote-mismatch");
        }
      }
    } else if (problems.includes("quote-mismatch") && ch.quote !== undefined && ch.resolved !== null && quoteConsistent(ch.resolved, ch.quote)) {
      problems = problems.filter((p) => p !== "quote-mismatch");
    }
    if (!problems.length) detail = undefined;
    loaded.validation.set(key, { problems, detail, resolved });
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

const padR = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const sliceStr = (s: Slice) => `${s.passed}/${s.items}${s.items ? ` (${pct(s.passRate)})` : ""}`;
const refStr = (a: AnchorRef) => `citation ${a.citationId} anchor ${a.anchorIndex} [${a.role} ${a.kind} ${a.location}]`;

export function formatHuman(report: ScoreReport): string {
  const s = report.summary;
  const L: string[] = [];
  L.push(`score-eval  run=${report.run.directory}`);
  const filt = [...report.filters.category.map((c) => `category=${c}`), ...report.filters.case.map((c) => `case=${c}`)];
  L.push(`eval set: ${report.evalSet.path} (${s.items} of ${report.evalSet.totalItems} items${filt.length ? `; filters ${filt.join(", ")}` : ""})`);
  const v = s.validation;
  L.push(`candidate files: ${v.filesLoaded} loaded, ${v.filesMissing} missing, ${v.filesUnreadable} unreadable, ${v.filesSchemaInvalid} schema-invalid`);
  for (const f of report.run.files) {
    for (const p of f.problems) L.push(`  ! ${f.caseId}: ${p}`);
    for (const e of f.schemaErrors.slice(0, 8)) L.push(`  ! ${f.caseId}: schema ${e}`);
    if (f.schemaErrors.length > 8) L.push(`  ! ${f.caseId}: … ${f.schemaErrors.length - 8} more schema error(s)`);
  }
  L.push("");
  L.push(`PASS ${s.passed}/${s.items} (${pct(s.passRate)})   failed ${s.failed}`);
  L.push(`  by expect:     ${EXPECTS.map((e) => `${e} ${sliceStr(s.byExpect[e]!)}`).join("   ")}`);
  L.push(`  by file type:  ${Object.entries(s.byFileType).map(([k, sl]) => `${k.slice(5)} ${sliceStr(sl)}`).join("   ") || "n/a"}`);
  const a = s.anchors;
  L.push(`  value anchors: ${a.value} (acceptable ${a.acceptable}, secondary ${a.secondary}, forbidden ${a.forbidden}, unmatched ${a.unmatched}); precision ${pct(a.precision)}; label/context anchors ${a.labelContext}${a.invalid ? `; malformed ${a.invalid}` : ""}`);
  L.push(`  forbidden hits: ${s.forbidden.anchorHits} anchor(s) on ${s.forbidden.itemsWithHit} item(s) (${pct(s.forbidden.itemHitRate)} of items)`);
  L.push(`  empty-field abstention: ${s.emptyFields.abstained}/${s.emptyFields.items} (${pct(s.emptyFields.abstentionRate)})`);
  L.push(`  multi-citation recall: ${s.multiCitation.matchedEntries}/${s.multiCitation.acceptableEntries} acceptable entries (${pct(s.multiCitation.recall)}) over ${s.multiCitation.items} item(s); mean per item ${pct(s.multiCitation.meanItemRecall)}`);
  const mo = s.manyOccurrences;
  L.push(`  many-occurrences: ${mo.items} item(s), ${mo.citations} citation(s) (mean ${mo.meanCitationsPerItem === null ? "n/a" : mo.meanCitationsPerItem.toFixed(1)}/item, max ${mo.maxCitationsPerItem})`);
  L.push(`  citations: ${s.citations.scored} scored, ${s.citations.rejected} rejected (ignored)`);
  const byProblem = Object.entries(v.byProblem).map(([k, n]) => `${k} ${n}`).join(", ");
  L.push(`  validation: ${v.anchorsWithProblems} anchor(s) with problems, ${v.fatalAnchors} fatal${byProblem ? ` (${byProblem})` : ""}`);
  L.push("");
  L.push("by category:");
  const cats = Object.entries(s.byCategory);
  const width = Math.max(10, ...cats.map(([k]) => k.length)) + 2;
  for (let i = 0; i < cats.length; i += 2) {
    const cell = ([k, sl]: [string, Slice]) => `${padR(k, width)}${padR(sliceStr(sl), 16)}`;
    L.push(`  ${cell(cats[i]!)}${cats[i + 1] ? cell(cats[i + 1]!) : ""}`.trimEnd());
  }

  const failed = report.items.filter((r) => !r.pass);
  L.push("");
  if (!failed.length) L.push("Failed items: none");
  else {
    L.push(`Failed items (${failed.length}), grouped by reason:`);
    for (const code of FAILURE_CODES) {
      const items = failed.filter((r) => r.failureReasons.includes(code));
      if (!items.length) continue;
      L.push(`  ${code} (${items.length})`);
      for (const r of items) {
        L.push(`    ${r.id}  [${r.expect}]${r.failureReasons.length > 1 ? `  also: ${r.failureReasons.filter((c) => c !== code).join(", ")}` : ""}`);
        for (const line of failureDetails(r, code).slice(0, 6)) L.push(`        ${line}`);
      }
    }
  }

  if (report.baseline) {
    const b = report.baseline;
    L.push("");
    L.push(`Baseline: ${b.path}${b.baselineScoredAt ? ` (scored ${b.baselineScoredAt})` : ""} — ${b.comparedItems} common item(s)` +
      `${b.onlyInBaseline.length ? `, ${b.onlyInBaseline.length} only in baseline` : ""}${b.onlyInCurrent.length ? `, ${b.onlyInCurrent.length} only in current` : ""}`);
    const d = (x: RateDelta) => `${pct(x.baseline)} → ${pct(x.current)}${x.delta === null ? "" : ` (${x.delta >= 0 ? "+" : ""}${(x.delta * 100).toFixed(1)} pt)`}`;
    L.push(`  overall: ${d(b.overall)}`);
    L.push(`  by expect: ${EXPECTS.map((e) => `${e} ${d(b.byExpect[e]!)}`).join("   ")}`);
    const changed = Object.entries(b.byCategory).filter(([, x]) => x.delta !== null && Math.abs(x.delta) > 1e-9);
    if (changed.length) for (const [k, x] of changed) L.push(`  ${padR(k, width)}${d(x)}`);
    else L.push("  by category: no changes");
    L.push(`  newly failing (${b.newlyFailing.length}): ${b.newlyFailing.map((x) => `${x.id} [${x.failureReasons.join(", ")}]`).join("; ") || "none"}`);
    L.push(`  newly passing (${b.newlyPassing.length}): ${b.newlyPassing.join(", ") || "none"}`);
    L.push(`  new forbidden matches (${b.newForbiddenMatches.length}): ${b.newForbiddenMatches.map((x) => `${x.id} → "${x.label}"`).join("; ") || "none"}`);
    L.push(`  ${b.regression ? "REGRESSION" : "no regression"}`);
  }
  return L.join("\n");
}

function failureDetails(r: ItemResult, code: FailureCode): string[] {
  switch (code) {
    case "forbidden-match":
      return r.forbiddenMatches.flatMap((f) => f.matchedBy.map((m) => `${refStr(m)} → forbidden "${f.label}" (${m.detail})`));
    case "unmatched-value-anchor":
      return r.unmatchedValueAnchors.map((u) => `${refStr(u)} matches nothing`);
    case "missing-acceptable":
      return [`0 of ${r.acceptableEntries} acceptable entries matched by value anchors; ${r.citations.scored} citation(s), ${r.citations.valueAnchors} value anchor(s)` +
        (r.matchedSecondary.length ? `; secondary only: ${r.matchedSecondary.map((m) => `"${m.label}"`).join(", ")}` : "")];
    case "missing-required-context":
      return [`${r.distinctRequiredContextMatches} of ${r.minRequiredContextMatches} required context entries matched by role=context anchors (${r.requiredContextEntries} available)`,
        ...r.matchedRequiredContext.map((m) => `matched context "${m.label}" via ${m.matchedBy.map(refStr).join("; ")}`)];
    case "insufficient-multi-citation-recall":
      return [`${r.distinctAcceptableMatches} distinct acceptable entr${r.distinctAcceptableMatches === 1 ? "y" : "ies"} matched, ${r.minAcceptableMatches} required (${r.acceptableEntries} available)`,
        ...r.matchedAcceptable.map((m) => `matched "${m.label}" via ${m.matchedBy.map(refStr).join("; ")}`)];
    case "unexpected-value-for-empty":
      return r.anchors.filter((a) => a.role === "value" && a.classification !== "invalid").map((a) => `${refStr(a)} is a value anchor (${a.classification})`);
    case "invalid-anchor":
      return r.validationProblems.filter((p) => p.fatal && !p.problems.includes("schema")).map((p) => `${refStr(p)}: ${p.problems.join(", ")}${p.detail ? ` — ${p.detail}` : ""}`);
    case "schema-invalid":
      return [...r.schemaErrors, ...r.validationProblems.filter((p) => p.problems.includes("schema")).map((p) => `${refStr(p)}: ${p.detail ?? "malformed"}`)];
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliOptions {
  run: string;
  category: string[];
  case: string[];
  baseline?: string;
  json: boolean;
  output?: string;
  help: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { run: "", category: [], case: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--run": o.run = next(); break;
      case "--category": o.category.push(next()); break;
      case "--case": o.case.push(next()); break;
      case "--baseline": o.baseline = next(); break;
      case "--output": o.output = next(); break;
      case "--json": o.json = true; break;
      case "--help": case "-h": o.help = true; break;
      default: throw new UsageError(`unknown argument ${a}`);
    }
  }
  if (!o.help && !o.run) throw new UsageError("--run <directory> is required");
  return o;
}

const USAGE = `usage: npx -y tsx scripts/score-eval.ts --run <directory> [options]

  --run <dir>            directory with <caseId>.citations.json candidate files
  --category <tag>       only items with this category (repeatable; all must match)
  --case <case-id>       only items from this case (repeatable; any may match)
  --baseline <report>    compare against a prior --output report; exit 1 on regression
  --json                 print only the JSON report on stdout
  --output <report>      also write the JSON report to this file
  --help                 show this message

exit codes: 0 ok, 1 failed items (no baseline) or regression (baseline), 2 usage/runtime error`;

export async function scoreRun(opts: {
  repoRoot: string;
  runDir: string;
  evalSetPath?: string;
  category?: string[];
  case?: string[];
}): Promise<ScoreReport> {
  const evalSetPath = opts.evalSetPath ?? path.join(opts.repoRoot, "eval", "eval-set.json");
  const evalSet = JSON.parse(await fs.readFile(evalSetPath, "utf8")) as EvalSet;
  if (evalSet.schemaVersion !== "citation-eval/v1") throw new UsageError(`${evalSetPath}: unsupported schemaVersion ${evalSet.schemaVersion}`);

  const categories = opts.category ?? [];
  const cases = opts.case ?? [];
  for (const c of categories) {
    if (!(c in evalSet.categories)) throw new UsageError(`unknown category ${JSON.stringify(c)}; known: ${Object.keys(evalSet.categories).sort().join(", ")}`);
  }
  const knownCases = new Set(evalSet.items.map((i) => i.caseId));
  for (const c of cases) {
    if (!knownCases.has(c)) throw new UsageError(`unknown case ${JSON.stringify(c)}; known: ${[...knownCases].sort().join(", ")}`);
  }
  const items = evalSet.items.filter((i) => categories.every((c) => i.categories.includes(c)) && (!cases.length || cases.includes(i.caseId)));
  if (!items.length) throw new UsageError("no eval items match the given filters");

  const schema = JSON.parse(await fs.readFile(path.join(opts.repoRoot, "schema", "citations.schema.json"), "utf8")) as object;
  const req = createRequire(path.join(opts.repoRoot, "app", "package.json"));
  const Ajv2020 = (req("ajv/dist/2020.js") as { default: new (o: object) => { compile(s: object): SchemaValidator } }).default;
  const addFormats = (req("ajv-formats") as { default: (ajv: unknown) => void }).default;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);

  const byCase = new Map<string, EvalItem[]>();
  for (const it of items) byCase.set(it.caseId, [...(byCase.get(it.caseId) ?? []), it]);

  const results: ItemResult[] = [];
  const files: FileReport[] = [];
  for (const [caseId, caseItems] of [...byCase].sort(([a], [b]) => a.localeCompare(b))) {
    const loaded = await loadCase(opts.repoRoot, opts.runDir, caseId, caseItems.map((i) => i.pointer), schema, validateSchema);
    files.push(loaded.report);
    const citations = loaded.raw && isRecord(loaded.raw.citations) ? loaded.raw.citations : {};
    for (const item of caseItems) {
      const schemaErrors = loaded.schemaErrors
        .filter((e) => e.affects === "all" || (e.affects !== null && e.affects.pointer === item.pointer))
        .map((e) => e.message);
      results.push(scoreItem(item, citations[item.pointer], {
        schemaErrors,
        validation: (ci, ai) => loaded.validation.get(vkey(item.pointer, ci, ai)),
        jsonStringLength: (file, pointer) => loaded.jsonStringLengths.get(lkey(file, pointer)),
      }));
    }
  }
  const order = new Map(evalSet.items.map((i, n) => [i.id, n]));
  results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

  return {
    schemaVersion: "citation-eval-report/v1",
    scoredAt: new Date().toISOString(),
    run: { directory: opts.runDir, files },
    evalSet: { path: evalSetPath, schemaVersion: evalSet.schemaVersion, totalItems: evalSet.items.length },
    filters: { category: categories, case: cases },
    summary: summarize(results, files),
    items: results,
  };
}

async function main(argv: string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return 2;
  }
  if (opts.help) { console.log(USAGE); return 0; }

  if (opts.json) {
    // Only the report may reach stdout; divert any incidental logging (e.g. pdf.js) to stderr.
    console.log = (...args: unknown[]) => console.error(...args);
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runDir = path.resolve(opts.run);
  if (!existsSync(runDir)) throw new UsageError(`run directory not found: ${runDir}`);

  const report = await scoreRun({ repoRoot, runDir, category: opts.category, case: opts.case });

  if (opts.baseline) {
    let baseline: unknown;
    try {
      baseline = JSON.parse(await fs.readFile(opts.baseline, "utf8"));
    } catch (err) {
      throw new UsageError(`cannot read baseline ${opts.baseline}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isReportLike(baseline)) throw new UsageError(`${opts.baseline} is not a score-eval report (expected an items[] array with id/pass/categories)`);
    report.baseline = compareWithBaseline(baseline, report, path.resolve(opts.baseline));
  }

  const json = JSON.stringify(report, null, 2);
  if (opts.output) {
    await fs.mkdir(path.dirname(path.resolve(opts.output)), { recursive: true });
    await fs.writeFile(opts.output, json + "\n", "utf8");
  }
  // Await the flush: stdout writes to a pipe are asynchronous and process.exit() would truncate them.
  const write = (s: string) => new Promise<void>((resolve, reject) => process.stdout.write(s, (err) => (err ? reject(err) : resolve())));
  if (opts.json) await write(json + "\n");
  else await write(formatHuman(report) + "\n" + (opts.output ? `\nreport written to ${opts.output}\n` : ""));

  if (report.baseline) return report.baseline.regression ? 1 : 0;
  return report.summary.failed > 0 ? 1 : 0;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof UsageError ? err.message : err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(2);
    },
  );
}
