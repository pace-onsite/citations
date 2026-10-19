/**
 * Shared shapes for the citation extraction loop (app/server/cite/*).
 *
 * The loop never lets a model invent a location. Everything citable is first
 * turned into an EvidenceUnit with exact provenance; search and judgment only
 * ever *select* units, and anchors are derived from the selected units.
 */
import type { Anchor, Citation, CitationSet, FieldDefinition } from "../../src/types.ts";

// ---------------------------------------------------------------------------
// Evidence index
// ---------------------------------------------------------------------------

export interface OcrWord {
  text: string;
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Index into `ocr.words` of the artifact (for provenance). */
  index: number;
}

/** One visual line of OCR words on one page, rebuilt from word boxes. */
export interface OcrLine {
  kind: "ocr-line";
  id: string;
  file: string; // the PDF
  ocrFile: string;
  page: number;
  /** Words sorted left→right. */
  words: OcrWord[];
  /** Words joined with single spaces. */
  text: string;
  /** For each word, [startChar, endChar) within `text`. */
  spans: Array<[number, number]>;
  /**
   * Column segments: runs of words separated by a large horizontal gap
   * (table cells / form columns). Char ranges into `text` plus x extent.
   */
  segments: Array<{ start: number; end: number; left: number; right: number }>;
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Line index within the page (reading order). */
  lineNo: number;
}

export interface JsonLeaf {
  kind: "json-leaf";
  id: string;
  file: string;
  pointer: string;
  /** Raw leaf value. */
  value: unknown;
  /** String form used for matching. */
  text: string;
  /** Unescaped key path tokens, e.g. ["lineFacts","3","premium"]. */
  keys: string[];
  /** Pointer of the nearest enclosing object (the "row" for list-item binding). */
  parentPointer: string;
}

export interface TextLine {
  kind: "text-line";
  id: string;
  file: string;
  /** Only for JSON string fields searched as text (email bodies). */
  pointer?: string;
  text: string;
  /** UTF-16 offset of `text[0]` within the file (or within the pointed string). */
  start: number;
  lineNo: number;
}

export interface SheetCell {
  kind: "sheet-cell";
  id: string;
  file: string;
  sheet?: string; // undefined for csv
  /** 1-based */
  row: number;
  col: number;
  a1: string;
  text: string;
  /** Column header text (from the detected header row), if any. */
  header?: string;
  headerA1?: string;
  /** First non-empty cell in the row (row label), if any. */
  rowLabel?: string;
  rowLabelA1?: string;
  /** Text of the full row, for sibling binding. */
  rowText: string;
}

export type EvidenceUnit = OcrLine | JsonLeaf | TextLine | SheetCell;

export interface CaseIndex {
  caseId: string;
  files: string[];
  ocrLines: OcrLine[];
  /** ocrFile → page → lines (reading order) */
  ocrByPage: Map<string, Map<number, OcrLine[]>>;
  jsonLeaves: JsonLeaf[];
  /** file → parentPointer → leaves, for row binding */
  jsonByParent: Map<string, Map<string, JsonLeaf[]>>;
  textLines: TextLine[];
  textByFile: Map<string, TextLine[]>;
  cells: SheetCell[];
  /** file!sheet → row → cells */
  cellsByRow: Map<string, Map<number, SheetCell[]>>;
  /** Raw text of text-like files (for building anchors). */
  rawText: Map<string, string>;
  pageCount: Map<string, number>;
  buildMs: number;
  skipped: Array<{ file: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Field jobs
// ---------------------------------------------------------------------------

export type FieldClass =
  | "scalar" // ordinary value → value search
  | "composite" // several dates/parts joined into one value
  | "boolean-presence" // true/false meaning "label is followed by something"
  | "boolean-source" // true/false copied from a boolean in a JSON source
  | "blank" // "" / null / [] → label-driven discrepancy check only
  | "zero" // 0 / "$0" → cite only with strong column/label support
  | "rule-constant" // "N/A" etc. produced by a definition rule
  | "prose" // long free text, not span-citable
  | "container"; // object/array (not processed)

export interface FieldJob {
  pointer: string;
  value: unknown;
  valueType: "string" | "number" | "boolean" | "null" | "array" | "object";
  definition?: FieldDefinition;
  cls: FieldClass;
  /** Pointer of the enclosing list element, when the field lives in an array row. */
  rowPointer?: string;
  /** Sibling scalar values (string form) that identify the row. */
  rowIdentifiers: string[];
  /** Subset of rowIdentifiers that are proper keys (policy/claim numbers); when present, a row must contain one of them. */
  primaryIdentifiers: string[];
  /** Last pointer segment (field name). */
  name: string;
  /** Quoted labels from the definition, e.g. `TENANT(S):`. */
  explicitLabels: string[];
  /** Keywords from name + definition used for context scoring. */
  keywords: string[];
  /** Positional hints parsed from the definition. */
  hints: PositionHints;
  /** Search variants (normalized) for the value; `parts` for composite values. */
  variants: string[];
  parts?: string[][];
}

export interface PositionHints {
  page?: number; // "first page" → 1
  region?: "top" | "bottom" | "top-right" | "top-left" | "bottom-right" | "bottom-left";
}

// ---------------------------------------------------------------------------
// Candidates and judgment
// ---------------------------------------------------------------------------

export interface Candidate {
  id: string;
  unit: EvidenceUnit;
  /** For OCR/text matches: the matched char range in unit.text (per part). */
  ranges: Array<[number, number]>;
  /** Optional second line when a value wraps. */
  continuation?: { unit: OcrLine | TextLine; range: [number, number] };
  /** Exact source text covered by the ranges. */
  quote: string;
  matchType: "exact" | "normalized" | "partial" | "label-only";
  /** Context window shown to the judge. */
  window: string;
  /** Deterministic score in [0,1] plus the reasons behind it. */
  score: number;
  reasons: string[];
  penalties: string[];
  /** Line(s) that hold the field label near this candidate, if found. */
  labelRange?: { unit: OcrLine | TextLine; range: [number, number]; role?: "label" | "context" };
  /** Spreadsheet header / row-label cell that names this candidate's column or row. */
  labelCell?: { file: string; sheet?: string; a1: string; role?: "label" | "context" };
  /** Sibling identifier of the list row (e.g. the coverage name) that binds this candidate to its row. */
  contextRange?: { unit: OcrLine | TextLine; range: [number, number] };
  /** Does the surrounding container hold one of the row identifiers? */
  rowBound: boolean;
  /** Set when the container carries a *different* row key (e.g. another policy number). */
  rowConflict?: string;
  file: string;
  locator: string; // human-readable, e.g. "document-09.pdf p1 l12"
}

export type Decision = "cite" | "context" | "empty";

export interface Judgment {
  decision: Decision;
  selected: Array<{ id: string; role: "value" | "label" | "context" }>;
  confidence: number;
  reasoning: string;
  method: string;
  llm?: { model: string; promptTokens: number; completionTokens: number; ms: number };
}

export interface FieldTrace {
  pointer: string;
  cls: FieldClass;
  variants: string[];
  keywords: string[];
  hints: PositionHints;
  candidatesConsidered: number;
  shortlist: Array<{
    id: string;
    file: string;
    page?: number;
    locator: string;
    text: string;
    quote: string;
    matchType: Candidate["matchType"];
    score: number;
    reasons: string[];
    penalties: string[];
    selected: boolean;
    role?: "value" | "label" | "context";
  }>;
  decision: Decision;
  reasoning: string;
  method: string;
  confidence: number;
  ms: number;
  llm?: Judgment["llm"];
}

export interface RunMetrics {
  caseId: string;
  fields: number;
  processed: number;
  cited: number;
  contextOnly: number;
  empty: number;
  skipped: number;
  byClass: Record<string, number>;
  byMethod: Record<string, number>;
  candidates: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  indexMs: number;
  searchMs: number;
  totalMs: number;
  perFieldMs: { mean: number; p50: number; p95: number; max: number };
  validation?: { anchors: number; anchorsOk: number; invalidCitations: number; byProblem: Record<string, number> };
}

export interface RunResult {
  set: CitationSet;
  traces: FieldTrace[];
  metrics: RunMetrics;
}

export interface RunOptions {
  /** Only these pointers (default: every leaf). */
  pointers?: string[];
  /** Use the LLM judge for ambiguous fields when a key is configured. Default true. */
  llm?: boolean;
  /** Max citations per field. Default 3. */
  cap?: number;
  /** Run the grounding validator on the output. Default true. */
  validate?: boolean;
  model?: string;
}

export type { Anchor, Citation, CitationSet };
