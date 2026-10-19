/**
 * Citation validator: checks that a CitationSet (schema/citations.schema.json)
 * is (1) schema-valid and (2) *grounded* — every anchor resolves to real text in
 * its source file, that text matches the citation's `quote`, and the quote
 * plausibly supports the result value it is attached to.
 *
 * This is the source of the "invalid citation count" metric. It has no UI
 * dependency and is used both by the CLI (app/scripts/validate-citations.ts)
 * and, later, by the dev-server API.
 *
 * Resolution strategy per anchor kind:
 *   page-region  → pdf.js text layer of the PDF (same engine the UI renders
 *                  with). Characters whose centre falls inside a box are
 *                  collected. pdf.js yields text *segments*, not glyph boxes, so
 *                  character x-positions are interpolated proportionally across
 *                  each segment; this is accurate to roughly half a character.
 *   text-span    → UTF-16 slice of the file text or of the JSON string at
 *                  `pointer`.
 *   json-pointer → RFC 6901 walk; value is stringified.
 *   sheet-range  → SheetJS; xlsx/xls use the formatted cell text, csv raw text.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as XLSX from "xlsx";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Anchor, Citation, CitationSet, PageRegionAnchor, Rect } from "../src/types.ts";

export type Problem =
  | "schema"
  | "missing-file"
  | "unresolvable"
  | "empty-region"
  | "quote-mismatch"
  | "value-mismatch";

export interface AnchorCheck {
  path: string;
  citationId: string;
  status: Citation["status"];
  anchorIndex: number;
  kind: Anchor["kind"];
  role: "value" | "label" | "context";
  /** Human-readable location, e.g. `document-09.pdf p1 (1 box)` or `document-09.xlsx!Summary!C7`. */
  location: string;
  /** Text the anchor actually points at in the source, or null if it could not be resolved. */
  resolved: string | null;
  quote: string | undefined;
  resultValue: unknown;
  problems: Problem[];
  detail?: string;
}

export interface ValidationReport {
  caseId: string;
  schemaValid: boolean;
  schemaErrors: ErrorObject[];
  checks: AnchorCheck[];
  summary: {
    fields: number;
    fieldsWithCitations: number;
    citations: number;
    anchors: number;
    anchorsOk: number;
    invalidCitations: number;
    byKind: Record<string, { total: number; ok: number }>;
    byProblem: Record<Problem, number>;
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function validateCitationSet(
  repoRoot: string,
  set: CitationSet,
  opts: { schema?: object } = {},
): Promise<ValidationReport> {
  const schema =
    opts.schema ??
    (JSON.parse(
      await fs.readFile(path.join(repoRoot, "schema", "citations.schema.json"), "utf8"),
    ) as object);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const schemaValid = validate(set) as boolean;
  const schemaErrors = validate.errors ?? [];

  const caseDir = path.join(repoRoot, "test-cases", set.caseId);
  const filesDir = path.join(caseDir, "files");
  const result = JSON.parse(await fs.readFile(path.join(caseDir, "result.json"), "utf8")) as unknown;

  const ctx = new SourceContext(filesDir);
  const checks: AnchorCheck[] = [];

  for (const [ptr, citations] of Object.entries(set.citations)) {
    let resultValue: unknown;
    try {
      resultValue = jsonPointerGet(result, ptr);
    } catch {
      resultValue = undefined;
    }
    for (const c of citations) {
      for (let i = 0; i < c.anchors.length; i++) {
        checks.push(await checkAnchor(ctx, ptr, c, i, resultValue));
      }
    }
  }
  await ctx.dispose();

  return { caseId: set.caseId, schemaValid, schemaErrors, checks, summary: summarize(set, checks) };
}

function summarize(set: CitationSet, checks: AnchorCheck[]): ValidationReport["summary"] {
  const byKind: Record<string, { total: number; ok: number }> = {};
  const byProblem: Record<Problem, number> = {
    schema: 0, "missing-file": 0, unresolvable: 0, "empty-region": 0, "quote-mismatch": 0, "value-mismatch": 0,
  };
  const badCitations = new Set<string>();
  let anchorsOk = 0;
  for (const ch of checks) {
    const k = (byKind[ch.kind] ??= { total: 0, ok: 0 });
    k.total++;
    if (ch.problems.length === 0) { k.ok++; anchorsOk++; }
    else { badCitations.add(`${ch.path}#${ch.citationId}`); for (const p of ch.problems) byProblem[p]++; }
  }
  const entries = Object.values(set.citations);
  return {
    fields: entries.length,
    fieldsWithCitations: entries.filter((a) => a.length > 0).length,
    citations: entries.reduce((n, a) => n + a.length, 0),
    anchors: checks.length,
    anchorsOk,
    invalidCitations: badCitations.size,
    byKind,
    byProblem,
  };
}

// ---------------------------------------------------------------------------
// Per-anchor check
// ---------------------------------------------------------------------------

async function checkAnchor(
  ctx: SourceContext,
  ptr: string,
  c: Citation,
  i: number,
  resultValue: unknown,
): Promise<AnchorCheck> {
  const a = c.anchors[i];
  const role = a.role ?? "value";
  const check: AnchorCheck = {
    path: ptr, citationId: c.id, status: c.status, anchorIndex: i, kind: a.kind, role,
    location: describe(a), resolved: null, quote: c.quote, resultValue, problems: [],
  };

  let resolved: string;
  try {
    resolved = await ctx.resolve(a);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check.problems.push(/ENOENT|no such file/i.test(msg) ? "missing-file" : "unresolvable");
    check.detail = msg;
    return check;
  }
  check.resolved = resolved;

  if (resolved.trim() === "") {
    check.problems.push(a.kind === "page-region" ? "empty-region" : "unresolvable");
    return check;
  }
  // label/context anchors only need to point at *something*; the quote describes value anchors.
  if (role !== "value") return check;

  if (c.quote !== undefined && norm(resolved) !== norm(c.quote)) {
    check.problems.push("quote-mismatch");
    check.detail = `resolved ${JSON.stringify(trunc(resolved))} != quote ${JSON.stringify(trunc(c.quote))}`;
  }
  // A rejected citation is *expected* to disagree with the result value.
  if (c.status !== "rejected" && resultValue !== undefined) {
    const evidence = c.quote ?? resolved;
    if (!valueSupported(resultValue, evidence)) {
      check.problems.push("value-mismatch");
      check.detail = (check.detail ? check.detail + "; " : "") +
        `quote ${JSON.stringify(trunc(evidence))} does not support value ${JSON.stringify(resultValue)}`;
    }
  }
  return check;
}

function describe(a: Anchor): string {
  switch (a.kind) {
    case "page-region": return `${a.file} p${a.page} (${a.boxes.length} box${a.boxes.length === 1 ? "" : "es"})`;
    case "text-span": return `${a.file}${a.pointer ?? ""}[${a.start}:${a.end}]`;
    case "json-pointer": return `${a.file}${a.pointer}`;
    case "sheet-range": return `${a.file}!${a.sheet ?? ""}!${a.range}`;
  }
}

// ---------------------------------------------------------------------------
// Value support (field-aware normalization)
// ---------------------------------------------------------------------------

/** Does `quote` plausibly support result `value`? */
export function valueSupported(value: unknown, quote: string): boolean {
  if (typeof value === "boolean") return (quote.trim() !== "") === value; // presence field
  if (value === null || value === undefined) return false;
  const vd = datesIn(String(value));
  if (vd.size > 0) {
    const qd = datesIn(quote);
    if ([...vd].every((d) => qd.has(d))) return true;
  }
  const nv = norm(String(value)), nq = norm(quote);
  return nv !== "" && (nq.includes(nv) || nv.includes(nq));
}

export const norm = (s: string): string => s.replace(/[\s$,]+/g, "").toLowerCase();

const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
/** Extract dates as ISO yyyy-mm-dd strings from free text (m/d/y, y-m-d, "Mon d, yyyy"). */
export function datesIn(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g)) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    out.add(iso(y, +m[1], +m[2]));
  }
  for (const m of s.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) out.add(iso(+m[1], +m[2], +m[3]));
  for (const m of s.matchAll(/\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/g)) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) out.add(iso(+m[3], mi + 1, +m[2]));
  }
  return out;
}
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const trunc = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + "…" : s);

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

export function jsonPointerGet(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) throw new Error(`bad JSON pointer ${pointer}`);
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const tok = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(tok) || +tok >= cur.length) throw new Error(`pointer ${pointer}: index ${tok} out of range`);
      cur = cur[+tok];
    } else if (cur !== null && typeof cur === "object") {
      if (!(tok in (cur as object))) throw new Error(`pointer ${pointer}: no key ${JSON.stringify(tok)}`);
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      throw new Error(`pointer ${pointer}: cannot descend into ${typeof cur}`);
    }
  }
  return cur;
}

/** Text positioned on a page in normalized (0..1, top-left origin) coordinates. */
interface PlacedChar { ch: string; cx: number; cy: number; order: number }

class SourceContext {
  private pdfs = new Map<string, Promise<PDFDocumentProxy>>();
  private pageChars = new Map<string, Promise<PlacedChar[]>>();
  private texts = new Map<string, Promise<string>>();
  private books = new Map<string, Promise<XLSX.WorkBook>>();
  private filesDir: string;

  constructor(filesDir: string) {
    this.filesDir = filesDir;
  }

  async dispose() {
    for (const p of this.pdfs.values()) {
      // A cached promise may have rejected (missing/corrupt file); that was already reported.
      await p.then((doc) => doc.destroy(), () => undefined);
    }
  }

  resolve(a: Anchor): Promise<string> {
    switch (a.kind) {
      case "page-region": return this.resolvePageRegion(a);
      case "text-span": return this.resolveTextSpan(a);
      case "json-pointer": return this.resolveJsonPointer(a);
      case "sheet-range": return this.resolveSheetRange(a);
    }
  }

  private file(name: string) {
    if (name.includes("..") || name.includes("/")) throw new Error(`unsafe file name ${name}`);
    return path.join(this.filesDir, name);
  }

  private text(name: string): Promise<string> {
    let p = this.texts.get(name);
    if (!p) {
      p = fs.readFile(this.file(name), "utf8").then((t) => t.replace(/^\uFEFF/, ""));
      this.texts.set(name, p);
    }
    return p;
  }

  private async resolveTextSpan(a: Extract<Anchor, { kind: "text-span" }>): Promise<string> {
    let text = await this.text(a.file);
    if (a.pointer !== undefined) {
      const v = jsonPointerGet(JSON.parse(text), a.pointer);
      if (typeof v !== "string") throw new Error(`${a.file}${a.pointer} is not a string`);
      text = v;
    }
    if (a.end > text.length) throw new Error(`span end ${a.end} beyond text length ${text.length}`);
    return text.slice(a.start, a.end);
  }

  private async resolveJsonPointer(a: Extract<Anchor, { kind: "json-pointer" }>): Promise<string> {
    const v = jsonPointerGet(JSON.parse(await this.text(a.file)), a.pointer);
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  private async resolveSheetRange(a: Extract<Anchor, { kind: "sheet-range" }>): Promise<string> {
    let wbp = this.books.get(a.file);
    if (!wbp) {
      // CSV: decode as UTF-8 ourselves (SheetJS defaults to a legacy codepage for
      // byte input) and keep cells raw so dates/numbers are not reinterpreted.
      wbp = /\.csv$/i.test(a.file)
        ? this.text(a.file).then((t) => XLSX.read(t, { type: "string", raw: true, cellDates: false }))
        : fs.readFile(this.file(a.file)).then((buf) => XLSX.read(buf, { type: "buffer", cellDates: false }));
      this.books.set(a.file, wbp);
    }
    const wb = await wbp;
    const sheetName = a.sheet ?? wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    if (!ws) throw new Error(`no sheet ${JSON.stringify(sheetName)} in ${a.file} (have ${wb.SheetNames.join(", ")})`);
    const range = XLSX.utils.decode_range(a.range);
    const parts: string[] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell) parts.push(cell.w ?? String(cell.v ?? ""));
      }
    }
    return parts.join(" ");
  }

  private pdf(name: string): Promise<PDFDocumentProxy> {
    let p = this.pdfs.get(name);
    if (!p) {
      p = fs.readFile(this.file(name)).then(
        (buf) =>
          pdfjs.getDocument({
            data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, verbosity: 0,
          }).promise,
      );
      this.pdfs.set(name, p);
    }
    return p;
  }

  /** All characters on a page with normalized centre positions, in content order. */
  private chars(name: string, pageNo: number): Promise<PlacedChar[]> {
    const key = `${name}#${pageNo}`;
    let p = this.pageChars.get(key);
    if (!p) {
      p = (async () => {
        const doc = await this.pdf(name);
        if (pageNo < 1 || pageNo > doc.numPages) throw new Error(`${name} has ${doc.numPages} pages; page ${pageNo} requested`);
        const page = await doc.getPage(pageNo);
        const vp = page.getViewport({ scale: 1 }); // honours /Rotate; top-left origin
        const content = await page.getTextContent();
        const out: PlacedChar[] = [];
        let order = 0;
        for (const item of content.items) {
          if (!("str" in item) || item.str.length === 0) continue;
          const [a, b, , , e, f] = item.transform; // baseline origin (e,f), direction (a,b)
          const len = Math.hypot(a, b) || 1;
          const ux = a / len, uy = b / len; // unit vector along the baseline
          const h = item.height || len;
          const n = item.str.length;
          for (let k = 0; k < n; k++) {
            const t = ((k + 0.5) / n) * item.width; // proportional position along the baseline
            // centre of the glyph: along baseline by t, up by ~0.35·h (x-height midpoint)
            const px = e + ux * t - uy * 0.35 * h;
            const py = f + uy * t + ux * 0.35 * h;
            const [vx, vy] = vp.convertToViewportPoint(px, py);
            out.push({ ch: item.str[k], cx: vx / vp.width, cy: vy / vp.height, order: order++ });
          }
          if (item.hasEOL) out.push({ ch: "\n", cx: -1, cy: -1, order: order++ });
          else out.push({ ch: " ", cx: -1, cy: -1, order: order++ });
        }
        return out;
      })();
      this.pageChars.set(key, p);
    }
    return p;
  }

  private async resolvePageRegion(a: PageRegionAnchor): Promise<string> {
    const chars = await this.chars(a.file, a.page);
    const inside = (r: Rect, c: PlacedChar) =>
      c.cx >= r.left && c.cx <= r.left + r.width && c.cy >= r.top && c.cy <= r.top + r.height;
    const picked: PlacedChar[] = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c.cx < 0) continue; // separator
      if (a.boxes.some((r) => inside(r, c))) picked.push(c);
    }
    // Re-insert single spaces where consecutive picked chars are not adjacent in content order.
    let s = "";
    for (let i = 0; i < picked.length; i++) {
      if (i > 0 && picked[i].order !== picked[i - 1].order + 1) s += " ";
      s += picked[i].ch;
    }
    return s.replace(/\s+/g, " ").trim();
  }
}
