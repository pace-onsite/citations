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
  hasOutput: boolean;
  hasExample: boolean;
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
  origin: "output" | "example" | "none";
  path: string;
  data: CitationSet;
}

// ---- UI-side derived shapes ------------------------------------------------

export interface ResultField {
  pointer: string;
  value: unknown;
  valueType: "string" | "number" | "boolean" | "null" | "array" | "object";
  depth: number;
  definition?: FieldDefinition;
}

/** Where the viewer should be looking. */
export interface ViewTarget {
  file: string;
  anchor?: Anchor;
  citationId?: string;
}
