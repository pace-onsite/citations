import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import * as XLSX from "xlsx";
import { fetchBuffer, fetchJson, fetchText } from "../api";
import type { Anchor, CaseDetail, Citation, CitationSet } from "../types";
import { parseCsv, parseRange } from "./a1";
import { getPdf } from "./pdf";
import { parsePointer, resolvePointer } from "./pointer";

// ---------------------------------------------------------------------------
// Layer 1: JSON-schema validation (structural)
// ---------------------------------------------------------------------------

export interface SchemaError {
  instancePath: string;
  message: string;
  /** Citation this error belongs to, when the path reaches into `/citations/<ptr>/<idx>`. */
  citationId?: string;
  pointer?: string;
}

type Validator = ReturnType<Ajv2020["compile"]>;
let compiled: Validator | null = null;
const anchorValidators = new Map<string, Validator>();

const anchorDefByKind: Record<string, string> = {
  "page-region": "PageRegionAnchor",
  "text-span": "TextSpanAnchor",
  "json-pointer": "JsonPointerAnchor",
  "sheet-range": "SheetRangeAnchor",
};

export function compileSchema(schema: Record<string, unknown>) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  compiled = ajv.compile(schema);
  // Per-kind validators so anchor errors can be reported against the branch the producer meant,
  // instead of the union of all four oneOf branches.
  const id = typeof schema.$id === "string" ? schema.$id : "";
  anchorValidators.clear();
  for (const [kind, def] of Object.entries(anchorDefByKind)) {
    const v = ajv.getSchema(`${id}#/$defs/${def}`);
    if (v) anchorValidators.set(kind, v as Validator);
  }
}

function locateError(err: ErrorObject, set: CitationSet): Pick<SchemaError, "citationId" | "pointer"> {
  // instancePath looks like /citations/~1policy_number/0/anchors/1/boxes/0/left
  const m = err.instancePath.match(/^\/citations\/([^/]+)(?:\/(\d+))?/);
  if (!m) return {};
  const pointer = m[1].replace(/~1/g, "/").replace(/~0/g, "~");
  const idx = m[2] !== undefined ? Number(m[2]) : undefined;
  const cit = idx !== undefined ? set.citations[pointer]?.[idx] : undefined;
  return { pointer, citationId: cit?.id };
}

const formatMessage = (e: ErrorObject, instancePath = e.instancePath) =>
  `${instancePath || "/"} ${e.message ?? ""}${
    e.params && "additionalProperty" in e.params ? ` (${String(e.params.additionalProperty)})` : ""
  }`;

export function validateSchema(set: CitationSet): SchemaError[] {
  if (!compiled) return [];
  const ok = compiled(set);
  if (ok || !compiled.errors) return [];
  const seen = new Set<string>();
  const out: SchemaError[] = [];
  const push = (instancePath: string, message: string, e: ErrorObject) => {
    if (seen.has(message)) return;
    seen.add(message);
    out.push({ instancePath, message, ...locateError({ ...e, instancePath }, set) });
  };

  // Errors inside an anchor come from every oneOf branch. When the anchor declares a known
  // kind, re-validate it against just that branch and report those errors instead.
  const handledAnchors = new Set<string>();
  for (const e of compiled.errors) {
    const m = e.instancePath.match(/^(\/citations\/([^/]+)\/(\d+)\/anchors\/(\d+))(\/|$)/);
    if (m) {
      const anchorPath = m[1];
      if (handledAnchors.has(anchorPath)) continue;
      const pointer = m[2].replace(/~1/g, "/").replace(/~0/g, "~");
      const anchor = set.citations[pointer]?.[Number(m[3])]?.anchors?.[Number(m[4])] as { kind?: unknown } | undefined;
      const v = typeof anchor?.kind === "string" ? anchorValidators.get(anchor.kind) : undefined;
      if (v) {
        handledAnchors.add(anchorPath);
        if (!v(anchor) && v.errors) {
          for (const ae of v.errors) {
            if (ae.keyword === "const") continue;
            push(anchorPath + ae.instancePath, formatMessage(ae, anchorPath + ae.instancePath), ae);
          }
        }
        continue;
      }
      if (e.keyword === "const") continue; // unknown kind → keep branch errors so the user sees why nothing matched
    }
    if (e.keyword === "oneOf") continue;
    push(e.instancePath, formatMessage(e), e);
  }
  if (out.length === 0 && compiled.errors.length) {
    const e = compiled.errors[0];
    out.push({ instancePath: e.instancePath, message: `${e.instancePath} ${e.message}`, ...locateError(e, set) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layer 2: semantic validation (does the anchor really point at the quote?)
// ---------------------------------------------------------------------------

export type Level = "error" | "warn" | "ok" | "info";

export interface Finding {
  level: Level;
  code: string;
  message: string;
  anchorIndex?: number;
}

export interface CitationReport {
  citationId: string;
  pointer: string;
  findings: Finding[];
  /** Text actually found under each anchor, for display next to the quote. */
  anchorText: Record<number, string>;
  worst: Level;
}

const levelRank: Record<Level, number> = { error: 3, warn: 2, info: 1, ok: 0 };
export const worstOf = (levels: Level[]): Level =>
  levels.reduce<Level>((acc, l) => (levelRank[l] > levelRank[acc] ? l : acc), "ok");

/** Loose normalization used to compare quote ↔ value (`$812.36` ~ `812.36`). */
export function normalizeLoose(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9/.\-]/g, "");
}

/** The better (less severe) of two comparison outcomes. */
const worstOfBest = (a: Level, b: Level): Level => (levelRank[a] <= levelRank[b] ? a : b);

function compareText(found: string, expected: string): Level {
  if (found === expected) return "ok";
  if (found.trim() === expected.trim()) return "ok";
  if (normalizeLoose(found) === normalizeLoose(expected)) return "warn";
  return "error";
}

const isValueRole = (a: Anchor) => (a.role ?? "value") === "value";

const describeMismatch = (found: string, expected: string) =>
  `text under anchor is ${JSON.stringify(trunc(found))}, quote is ${JSON.stringify(trunc(expected))}`;
const trunc = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);

async function checkPageRegion(
  caseId: string,
  a: Extract<Anchor, { kind: "page-region" }>,
  i: number,
  citation: Citation,
  files: Set<string>,
): Promise<{ findings: Finding[]; text?: string }> {
  const findings: Finding[] = [];
  if (!files.has(a.file)) {
    findings.push({ level: "error", code: "missing-file", message: `file ${a.file} is not in this case`, anchorIndex: i });
    return { findings };
  }
  for (const [bi, b] of a.boxes.entries()) {
    if (b.left + b.width > 1.01 || b.top + b.height > 1.01) {
      findings.push({ level: "error", code: "box-out-of-page", message: `box ${bi} extends past the page edge`, anchorIndex: i });
    }
  }
  try {
    const pdf = await getPdf(caseId, a.file);
    if (a.page > pdf.numPages) {
      findings.push({ level: "error", code: "page-out-of-range", message: `page ${a.page} but ${a.file} has ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}`, anchorIndex: i });
    }
  } catch (e) {
    findings.push({ level: "error", code: "pdf-unreadable", message: `could not open ${a.file}: ${(e as Error).message}`, anchorIndex: i });
  }

  // Audit against the OCR artifact when provenance is present.
  let text: string | undefined;
  const prov = a.provenance;
  if (prov?.ocrFile && prov.wordIndexes?.length) {
    if (!files.has(prov.ocrFile)) {
      findings.push({ level: "warn", code: "missing-ocr", message: `provenance.ocrFile ${prov.ocrFile} not in case`, anchorIndex: i });
    } else {
      try {
        const ocr = (await fetchJson(caseId, prov.ocrFile)) as { ocr?: { words?: Array<{ text: string; bbox: { page: number; original_page?: number; left: number; top: number; width: number; height: number } }> } };
        const words = ocr.ocr?.words ?? [];
        const pdfPageOf = (b: { page: number; original_page?: number }) =>
          Number.isInteger(b.original_page) && b.original_page! >= 1 ? b.original_page! : b.page;
        const picked = prov.wordIndexes.map((w) => words[w]);
        if (picked.some((w) => !w)) {
          findings.push({ level: "error", code: "bad-word-index", message: `provenance.wordIndexes reference words that do not exist in ${prov.ocrFile}`, anchorIndex: i });
        } else {
          text = picked.map((w) => w.text).join(" ");
          const wrongPage = picked.filter((w) => pdfPageOf(w.bbox) !== a.page);
          if (wrongPage.length) {
            findings.push({ level: "error", code: "word-page-mismatch", message: `OCR words are on PDF page ${pdfPageOf(wrongPage[0].bbox)}, anchor says page ${a.page}`, anchorIndex: i });
          }
          // Every box should overlap at least one of the provenance words.
          for (const [bi, b] of a.boxes.entries()) {
            const overlaps = picked.some((w) => {
              const wb = w.bbox;
              return wb.left < b.left + b.width && wb.left + wb.width > b.left && wb.top < b.top + b.height && wb.top + wb.height > b.top;
            });
            if (!overlaps) {
              findings.push({ level: "warn", code: "box-word-disjoint", message: `box ${bi} does not overlap any of its provenance words`, anchorIndex: i });
            }
          }
        }
      } catch (e) {
        findings.push({ level: "warn", code: "ocr-unreadable", message: `could not read ${prov.ocrFile}: ${(e as Error).message}`, anchorIndex: i });
      }
    }
  }
  if (text !== undefined && citation.quote !== undefined && isValueRole(a)) {
    const lvl = compareText(text, citation.quote);
    if (lvl === "error") {
      // Multi-anchor citations split a quote across anchors; only flag when the OCR text isn't even a substring.
      const contained = normalizeLoose(citation.quote).includes(normalizeLoose(text));
      findings.push({
        level: contained ? "info" : "warn",
        code: contained ? "quote-partial" : "quote-ocr-mismatch",
        message: contained ? `OCR words ${JSON.stringify(trunc(text))} are part of the quote` : describeMismatch(text, citation.quote),
        anchorIndex: i,
      });
    } else if (lvl === "warn") {
      findings.push({ level: "info", code: "quote-normalized", message: `OCR text matches quote after normalization`, anchorIndex: i });
    } else {
      findings.push({ level: "ok", code: "quote-verified", message: `OCR text under box equals quote`, anchorIndex: i });
    }
  } else if (text !== undefined) {
    findings.push({ level: "ok", code: "ocr-resolves", message: `OCR words under box: ${JSON.stringify(trunc(text))}`, anchorIndex: i });
  } else if (findings.length === 0) {
    findings.push({ level: "info", code: "visual-only", message: `no OCR provenance; box must be checked visually`, anchorIndex: i });
  }
  return { findings, text };
}

async function checkTextSpan(
  caseId: string,
  a: Extract<Anchor, { kind: "text-span" }>,
  i: number,
  citation: Citation,
  files: Set<string>,
): Promise<{ findings: Finding[]; text?: string }> {
  const findings: Finding[] = [];
  if (!files.has(a.file)) {
    findings.push({ level: "error", code: "missing-file", message: `file ${a.file} is not in this case`, anchorIndex: i });
    return { findings };
  }
  let hay: string;
  try {
    if (a.pointer !== undefined) {
      const doc = await fetchJson(caseId, a.file);
      const r = resolvePointer(doc, a.pointer);
      if (!r.found) {
        findings.push({ level: "error", code: "pointer-missing", message: `pointer ${a.pointer} not found in ${a.file} (failed at ${r.failedAt})`, anchorIndex: i });
        return { findings };
      }
      if (typeof r.value !== "string") {
        findings.push({ level: "error", code: "pointer-not-string", message: `pointer ${a.pointer} is a ${typeof r.value}, text-span needs a string`, anchorIndex: i });
        return { findings };
      }
      hay = r.value;
    } else {
      hay = await fetchText(caseId, a.file);
    }
  } catch (e) {
    findings.push({ level: "error", code: "file-unreadable", message: `could not read ${a.file}: ${(e as Error).message}`, anchorIndex: i });
    return { findings };
  }
  if (a.end > hay.length) {
    findings.push({ level: "error", code: "span-out-of-range", message: `span ends at ${a.end} but text is ${hay.length} chars`, anchorIndex: i });
    return { findings };
  }
  if (a.end <= a.start) {
    findings.push({ level: "error", code: "span-empty", message: `end must be greater than start`, anchorIndex: i });
    return { findings };
  }
  const text = hay.slice(a.start, a.end);
  if (citation.quote !== undefined && isValueRole(a)) {
    const lvl = compareText(text, citation.quote);
    const multi = citation.anchors.filter(isValueRole).length > 1;
    const part = lvl === "error" && multi && text.trim().length > 0 && normalizeLoose(citation.quote).includes(normalizeLoose(text));
    if (part) {
      // Multi-span citations write the quote as the pieces joined with " ... "; each span covers one piece.
      findings.push({ level: "ok", code: "quote-partial", message: `span ${JSON.stringify(trunc(text))} is one piece of the quote`, anchorIndex: i });
    } else if (lvl === "error") findings.push({ level: "error", code: "quote-mismatch", message: describeMismatch(text, citation.quote), anchorIndex: i });
    else if (lvl === "warn") findings.push({ level: "warn", code: "quote-normalized", message: `span text matches quote only after normalization`, anchorIndex: i });
    else findings.push({ level: "ok", code: "quote-verified", message: `span text equals quote`, anchorIndex: i });
  } else {
    findings.push({ level: "ok", code: "span-resolves", message: `span resolves to ${JSON.stringify(trunc(text))}`, anchorIndex: i });
  }
  return { findings, text };
}

async function checkJsonPointer(
  caseId: string,
  a: Extract<Anchor, { kind: "json-pointer" }>,
  i: number,
  citation: Citation,
  files: Set<string>,
): Promise<{ findings: Finding[]; text?: string }> {
  const findings: Finding[] = [];
  if (!files.has(a.file)) {
    findings.push({ level: "error", code: "missing-file", message: `file ${a.file} is not in this case`, anchorIndex: i });
    return { findings };
  }
  let doc: unknown;
  try {
    doc = await fetchJson(caseId, a.file);
  } catch (e) {
    findings.push({ level: "error", code: "file-unreadable", message: `could not parse ${a.file}: ${(e as Error).message}`, anchorIndex: i });
    return { findings };
  }
  const r = resolvePointer(doc, a.pointer);
  if (!r.found) {
    findings.push({ level: "error", code: "pointer-missing", message: `pointer ${a.pointer} not found in ${a.file} (failed at ${r.failedAt})`, anchorIndex: i });
    return { findings };
  }
  const text = typeof r.value === "string" ? r.value : JSON.stringify(r.value);
  if (citation.quote !== undefined && isValueRole(a)) {
    const lvl = compareText(text, citation.quote);
    if (lvl === "error") findings.push({ level: "error", code: "quote-mismatch", message: describeMismatch(text, citation.quote), anchorIndex: i });
    else if (lvl === "warn") findings.push({ level: "warn", code: "quote-normalized", message: `value matches quote only after normalization`, anchorIndex: i });
    else findings.push({ level: "ok", code: "quote-verified", message: `JSON value equals quote`, anchorIndex: i });
  } else {
    findings.push({ level: "ok", code: "pointer-resolves", message: `pointer resolves to ${JSON.stringify(trunc(text))}`, anchorIndex: i });
  }
  return { findings, text };
}

const wbCache = new Map<string, Promise<XLSX.WorkBook>>();
export function getWorkbook(caseId: string, file: string): Promise<XLSX.WorkBook> {
  const key = `${caseId}/${file}`;
  let p = wbCache.get(key);
  if (!p) {
    p = fetchBuffer(caseId, file).then((buf) => XLSX.read(buf, { type: "array" }));
    wbCache.set(key, p);
  }
  return p;
}

async function checkSheetRange(
  caseId: string,
  a: Extract<Anchor, { kind: "sheet-range" }>,
  i: number,
  citation: Citation,
  files: Set<string>,
): Promise<{ findings: Finding[]; text?: string }> {
  const findings: Finding[] = [];
  if (!files.has(a.file)) {
    findings.push({ level: "error", code: "missing-file", message: `file ${a.file} is not in this case`, anchorIndex: i });
    return { findings };
  }
  const range = parseRange(a.range);
  if (!range) {
    findings.push({ level: "error", code: "bad-range", message: `cannot parse range ${a.range}`, anchorIndex: i });
    return { findings };
  }
  const isCsv = /\.csv$/i.test(a.file);
  const cells: string[] = []; // formatted text (what the grid shows)
  const raw: string[] = []; // underlying values (what producers reading the workbook XML see)
  try {
    if (isCsv) {
      if (a.sheet) findings.push({ level: "warn", code: "csv-has-sheet", message: `sheet is set on a CSV anchor`, anchorIndex: i });
      const { rows } = parseCsv(await fetchText(caseId, a.file));
      for (let r = range.start.row; r <= range.end.row; r++) {
        for (let c = range.start.col; c <= range.end.col; c++) {
          const v = rows[r - 1]?.[c - 1];
          if (v === undefined) {
            findings.push({ level: "error", code: "cell-missing", message: `cell ${a.range} is outside the CSV (${rows.length} rows)`, anchorIndex: i });
            return { findings };
          }
          cells.push(v);
        }
      }
    } else {
      const wb = await getWorkbook(caseId, a.file);
      if (!a.sheet) {
        findings.push({ level: "error", code: "sheet-required", message: `sheet is required for ${a.file}`, anchorIndex: i });
        return { findings };
      }
      const ws = wb.Sheets[a.sheet];
      if (!ws) {
        findings.push({ level: "error", code: "sheet-missing", message: `no sheet ${JSON.stringify(a.sheet)} (have ${wb.SheetNames.join(", ")})`, anchorIndex: i });
        return { findings };
      }
      for (let r = range.start.row; r <= range.end.row; r++) {
        for (let c = range.start.col; c <= range.end.col; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })] as XLSX.CellObject | undefined;
          if (!cell) {
            findings.push({ level: "error", code: "cell-missing", message: `cell ${XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })} is empty in sheet ${a.sheet}`, anchorIndex: i });
            return { findings };
          }
          cells.push((cell.w ?? String(cell.v ?? "")).trim());
          raw.push(cell.v instanceof Date ? cell.v.toISOString() : String(cell.v ?? ""));
        }
      }
    }
  } catch (e) {
    findings.push({ level: "error", code: "file-unreadable", message: `could not read ${a.file}: ${(e as Error).message}`, anchorIndex: i });
    return { findings };
  }
  const text = cells.join(" | ");
  const rawText = raw.join(" | ");
  if (citation.quote !== undefined && isValueRole(a)) {
    // Either the formatted text or the raw value may be what the producer quoted ("$0.00" vs 0).
    const lvl = worstOfBest(compareText(text, citation.quote), isCsv ? "error" : compareText(rawText, citation.quote));
    const fragment = lvl === "error" && citation.quote.length >= 8 && normalizeLoose(text).includes(normalizeLoose(citation.quote));
    if (fragment) {
      // A cell is the smallest sheet-range unit, so quoting part of a long cell is legitimate — but flag it.
      findings.push({ level: "warn", code: "quote-fragment", message: `quote is a fragment of a longer cell (${text.length} chars): ${JSON.stringify(trunc(text))}`, anchorIndex: i });
    } else if (lvl === "error") findings.push({ level: "error", code: "quote-mismatch", message: describeMismatch(text, citation.quote), anchorIndex: i });
    else if (lvl === "warn") findings.push({ level: "warn", code: "quote-normalized", message: `cell matches quote only after normalization`, anchorIndex: i });
    else findings.push({ level: "ok", code: "quote-verified", message: isCsv || compareText(text, citation.quote) === "ok" ? `cell text equals quote` : `raw cell value equals quote (displays as ${JSON.stringify(text)})`, anchorIndex: i });
  } else {
    findings.push({ level: "ok", code: "cell-resolves", message: `cell resolves to ${JSON.stringify(trunc(text))}`, anchorIndex: i });
  }
  return { findings, text };
}

/** Does the quote plausibly support the result value? Purely textual heuristic. */
export function quoteSupportsValue(quote: string | undefined, value: unknown): Finding {
  if (quote === undefined) return { level: "info", code: "no-quote", message: "no quote recorded; rely on anchors" };
  if (typeof value === "boolean") return { level: "info", code: "boolean-field", message: "boolean field — citation shows the label/presence that drives the flag" };
  if (value === null || typeof value === "object") return { level: "info", code: "container", message: "container value; citations usually belong on the leaves" };
  const v = normalizeLoose(String(value));
  const q = normalizeLoose(quote);
  if (v.length === 0) return { level: "warn", code: "empty-value", message: "result value is empty" };
  if (q === v) return { level: "ok", code: "quote-equals-value", message: "quote equals the result value" };
  if (q.includes(v)) return { level: "ok", code: "quote-contains-value", message: "quote contains the result value" };
  if (typeof value === "number" && Number(q.replace(/[^0-9.\-]/g, "")) === value) return { level: "ok", code: "quote-numeric-match", message: "quote parses to the same number" };
  const dv = parseDateLoose(String(value));
  if (dv) {
    const dq = datesIn(quote);
    if (dq.includes(dv)) return { level: "ok", code: "quote-date-match", message: `quote contains the same date (${dv}) in a different format` };
  }
  if (typeof value === "string" && sameNameTokens(value, quote)) return { level: "ok", code: "quote-name-order", message: "quote is the same name in a different order" };
  return { level: "warn", code: "quote-indirect", message: "quote does not literally contain the value — verify the transformation" };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE_RE =
  /\b(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s][\d:.]+Z?)?\b|\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b|\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b|\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g;

/** Every date mentioned in `s`, normalized to YYYY-MM-DD (US month-first for numeric forms). */
function datesIn(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(DATE_RE)) {
    let y: number, mo: number, d: number;
    if (m[1]) [y, mo, d] = [+m[1], +m[2], +m[3]];
    else if (m[4]) [mo, d, y] = [+m[4], +m[5], +m[6] < 100 ? 2000 + +m[6] : +m[6]];
    else if (m[7]) [mo, d, y] = [MONTHS.indexOf(m[7].slice(0, 3).toLowerCase()) + 1, +m[8], +m[9]];
    else [d, mo, y] = [+m[10], MONTHS.indexOf(m[11].slice(0, 3).toLowerCase()) + 1, +m[12]];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

function parseDateLoose(s: string): string | undefined {
  const all = datesIn(s.trim());
  return all.length === 1 && s.trim().replace(DATE_RE, "").trim().length === 0 ? all[0] : undefined;
}

/** "Hope, Jesse" ≈ "Jesse Hope": same word multiset, 2–4 tokens. */
function sameNameTokens(a: string, b: string): boolean {
  const tok = (s: string) => s.toLowerCase().split(/[^\p{L}'’.-]+/u).filter(Boolean).sort();
  const ta = tok(a), tb = tok(b);
  return ta.length >= 2 && ta.length <= 4 && ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

export async function validateCitation(
  caseId: string,
  pointer: string,
  citation: Citation,
  detail: CaseDetail,
): Promise<CitationReport> {
  const files = new Set(detail.files.map((f) => f.name));
  const findings: Finding[] = [];
  const anchorText: Record<number, string> = {};

  const target = resolvePointer(detail.result, pointer);
  if (!target.found) {
    findings.push({ level: "error", code: "result-pointer-missing", message: `${pointer} does not exist in result.json` });
  } else {
    findings.push(quoteSupportsValue(citation.quote, target.value));
  }
  try {
    parsePointer(pointer);
  } catch {
    findings.push({ level: "error", code: "bad-pointer", message: `${pointer} is not a valid JSON pointer` });
  }

  const results = await Promise.all(
    citation.anchors.map(async (a, i) => {
      switch (a.kind) {
        case "page-region":
          return checkPageRegion(caseId, a, i, citation, files);
        case "text-span":
          return checkTextSpan(caseId, a, i, citation, files);
        case "json-pointer":
          return checkJsonPointer(caseId, a, i, citation, files);
        case "sheet-range":
          return checkSheetRange(caseId, a, i, citation, files);
        default:
          return { findings: [{ level: "error" as Level, code: "unknown-kind", message: `unknown anchor kind ${(a as { kind: string }).kind}`, anchorIndex: i }] };
      }
    }),
  );
  results.forEach((r, i) => {
    findings.push(...r.findings);
    if (r.text !== undefined) anchorText[i] = r.text;
  });

  return { citationId: citation.id, pointer, findings, anchorText, worst: worstOf(findings.map((f) => f.level)) };
}
