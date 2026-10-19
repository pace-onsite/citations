// Mirrors schema/citations.schema.json (citations/v1).

export type Role = "value" | "label" | "context";
export type Status = "proposed" | "accepted" | "rejected";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageRegionAnchor {
  kind: "page-region";
  file: string;
  page: number;
  boxes: Rect[];
  role?: Role;
  provenance?: {
    ocrFile?: string;
    chunkIndex?: number;
    blockIndex?: number;
    wordIndexes?: number[];
  };
}

export interface TextSpanAnchor {
  kind: "text-span";
  file: string;
  pointer?: string;
  start: number;
  end: number;
  role?: Role;
}

export interface JsonPointerAnchor {
  kind: "json-pointer";
  file: string;
  pointer: string;
  role?: Role;
}

export interface SheetRangeAnchor {
  kind: "sheet-range";
  file: string;
  sheet?: string;
  range: string;
  role?: Role;
}

export type Anchor = PageRegionAnchor | TextSpanAnchor | JsonPointerAnchor | SheetRangeAnchor;

export interface Citation {
  id: string;
  status: Status;
  source: "auto" | "manual";
  method?: string;
  confidence?: number;
  quote?: string;
  note?: string;
  createdAt?: string;
  anchors: Anchor[];
}

export interface CitationSet {
  schemaVersion: "citations/v1";
  caseId: string;
  generatedAt?: string;
  citations: Record<string, Citation[]>;
}

// ---- API shapes -------------------------------------------------------------

export interface CaseSummary {
  id: string;
  caseTitle: string;
  reviewType: string | null;
  resultType: string | null;
  sourceFileCounts: Record<string, number> | null;
  /** test-cases/<id>/citations.json exists. */
  hasCitations: boolean;
}

export interface SourceFile {
  name: string;
  size: number;
  ext: string;
}

export interface FieldDefinition {
  path: string;
  name: string;
  type: string;
  description?: string;
  itemType?: string;
}

export interface CaseDetail {
  id: string;
  result: unknown;
  /** Exact UTF-8 contents of the case's result.json file. */
  resultRaw: string;
  resultDefinition: { fields?: FieldDefinition[] } | null;
  sourceIndex: {
    files?: Array<{
      documentName?: string;
      documentType?: string;
      file: string;
      ocrArtifact?: string | null;
      renderedPdf?: string | null;
    }>;
  } | null;
  metadata: Record<string, unknown> | null;
  files: SourceFile[];
}

export interface CitationsResponse {
  /** `case` = loaded from test-cases/<id>/citations.json; `none` = file absent, empty set in memory. */
  origin: "case" | "none";
  /** Repo-relative path of the citations file (where saves go). */
  path: string;
  data: CitationSet;
}

// ---- Citation loop (POST /api/cases/:id/cite) -------------------------------

/** One candidate the loop looked at for a field, with the reasons behind its score. */
export interface TraceCandidate {
  id: string;
  file: string;
  page?: number;
  locator: string;
  text: string;
  quote: string;
  matchType: "exact" | "normalized" | "partial" | "label-only";
  score: number;
  reasons: string[];
  penalties: string[];
  selected: boolean;
  role?: "value" | "label" | "context";
}

/** What the agent did for one field: how it classified it, what it searched for, what it found, and why it decided. */
export interface FieldTrace {
  pointer: string;
  cls: string;
  variants: string[];
  keywords: string[];
  hints: { page?: number; region?: string };
  candidatesConsidered: number;
  shortlist: TraceCandidate[];
  decision: "cite" | "context" | "empty";
  reasoning: string;
  method: string;
  confidence: number;
  ms: number;
  llm?: { model: string; promptTokens: number; completionTokens: number; ms: number };
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
}

export interface CiteResponse {
  set: CitationSet;
  traces: FieldTrace[];
  metrics: RunMetrics;
  llm: { requested: boolean; configured: boolean; model: string };
}

// ---- UI-side derived shapes ------------------------------------------------

export interface ResultField {
  pointer: string;
  value: unknown;
  valueType: "string" | "number" | "boolean" | "null" | "array" | "object";
  depth: number;
  definition?: FieldDefinition;
}

/** How an anchor should be drawn by the viewers, beyond its role. */
export type AnchorTone = "acceptable" | "requiredContext" | "secondary" | "forbidden";

/** One anchor handed to the source viewers, with a stable index for selection. */
export interface AnchorRef {
  anchor: Anchor;
  index: number;
  tone?: AnchorTone;
}

// ---- eval set (eval/eval-set.schema.json) ------------------------------------

export type Expect = "cite" | "context-only" | "empty";

export interface Evidence {
  label: string;
  quote?: string;
  anchors: Anchor[];
}

export interface EvalItem {
  id: string;
  caseId: string;
  pointer: string;
  value: unknown;
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
  schemaVersion: "citation-eval/v1";
  description?: string;
  anchorSchema?: string;
  expectations: Record<Expect, string>;
  categories: Record<string, string>;
  items: EvalItem[];
}

export interface EvalResponse {
  path: string;
  data: EvalSet;
}
