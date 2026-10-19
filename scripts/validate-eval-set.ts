/**
 * Validates eval/eval-set.json against the fixtures it points at.
 *
 * For every item: the pointer resolves in result.json and equals `value`.
 * For every ground-truth anchor (acceptable / secondary / forbidden):
 *   page-region  -> file is a PDF in the case, boxes are in [0,1], and the boxes
 *                   re-derived from `provenance.wordIndexes` (same merge logic as
 *                   schema/citations.ts) equal the stored boxes; the OCR words under
 *                   value-role anchors are consistent with `quote`.
 *   text-span    -> file (or the JSON string field at `pointer`) sliced with UTF-16
 *                   offsets equals / is contained in `quote`.
 *   json-pointer -> pointer resolves in the JSON file; value matches `quote`.
 *   sheet-range  -> csv: the cell exists and matches `quote`;
 *                   xlsx: the sheet exists and the cell matches `quote` (the workbook
 *                   is unzipped with node:zlib, no dependencies).
 *
 * Usage: npx -y tsx scripts/validate-eval-set.ts [--root <repo>]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";
// ---------------------------------------------------------------------------
// citations/v1 anchor shapes (mirrors schema/citations.schema.json)
// ---------------------------------------------------------------------------
type Rect = { left: number; top: number; width: number; height: number };
type AnchorRole = "value" | "label" | "context";
type PageRegionAnchor = {
  kind: "page-region"; file: string; page: number; boxes: Rect[]; role?: AnchorRole;
  provenance?: { ocrFile?: string; chunkIndex?: number; blockIndex?: number; wordIndexes?: number[] };
};
type TextSpanAnchor = { kind: "text-span"; file: string; pointer?: string; start: number; end: number; role?: AnchorRole };
type JsonPointerAnchor = { kind: "json-pointer"; file: string; pointer: string; role?: AnchorRole };
type SheetRangeAnchor = { kind: "sheet-range"; file: string; sheet?: string; range: string; role?: AnchorRole };
type Anchor = PageRegionAnchor | TextSpanAnchor | JsonPointerAnchor | SheetRangeAnchor;
type OcrBbox = { left: number; top: number; width: number; height: number; page: number; original_page?: number };
type OcrWord = { text: string; bbox: OcrBbox };
// bbox.page resets inside long OCR jobs. original_page is the PDF page the box is drawn on.
const pdfPage = (b: OcrBbox) => (Number.isInteger(b.original_page) && b.original_page! >= 1 ? b.original_page! : b.page);

// Box derivation used to build the ground truth: clamp each OCR word bbox into
// the page, then merge words that sit on the same visual line into one rect.
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const fromOcrBbox = (b: OcrBbox): Rect => {
  const left = clamp01(b.left);
  const top = clamp01(b.top);
  return {
    left, top,
    width: Math.max(Number.EPSILON, clamp01(b.left + b.width) - left),
    height: Math.max(Number.EPSILON, clamp01(b.top + b.height) - top),
  };
};
const verticalOverlap = (a: Rect, b: Rect) => {
  const ov = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return ov <= 0 ? 0 : ov / Math.min(a.height, b.height);
};
const mergeLineRects = (rects: Rect[], minOverlap = 0.5): Rect[] => {
  const out: Rect[] = [];
  for (const r of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = out[out.length - 1];
    if (last && verticalOverlap(last, r) >= minOverlap) {
      const left = Math.min(last.left, r.left), top = Math.min(last.top, r.top);
      const right = Math.max(last.left + last.width, r.left + r.width);
      const bottom = Math.max(last.top + last.height, r.top + r.height);
      out[out.length - 1] = { left, top, width: right - left, height: bottom - top };
    } else out.push({ ...r });
  }
  return out;
};
const anchorFromWords = (file: string, words: OcrWord[], wordIndexes: number[]): PageRegionAnchor => {
  if (!words.length) throw new Error("anchorFromWords: no words");
  const page = pdfPage(words[0]!.bbox);
  if (words.some((w) => pdfPage(w.bbox) !== page)) throw new Error("words span multiple pages; emit one anchor per page");
  return { kind: "page-region", file, page, boxes: mergeLineRects(words.map((w) => fromOcrBbox(w.bbox))), provenance: { wordIndexes } };
};

type Evidence = { label: string; quote?: string; anchors: Anchor[] };
type Item = {
  id: string;
  caseId: string;
  pointer: string;
  value: unknown;
  categories: string[];
  expect: "cite" | "context-only" | "empty";
  minAcceptableMatches?: number;
  minRequiredContextMatches?: number;
  acceptable: Evidence[];
  requiredContext?: Evidence[];
  secondary: Evidence[];
  forbidden: Evidence[];
};
type EvalSet = {
  schemaVersion: string;
  expectations: Record<string, string>;
  categories: Record<string, string>;
  items: Item[];
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = path.resolve(rootIdx === -1 ? path.join(scriptDir, "..") : args[rootIdx + 1]!);

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const resolvePointer = (obj: unknown, pointer: string): { ok: boolean; value?: unknown } => {
  if (pointer === "") return { ok: true, value: obj };
  let cur: any = obj;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { ok: false };
      cur = cur[i];
    } else if (cur && typeof cur === "object" && key in cur) {
      cur = cur[key];
    } else {
      return { ok: false };
    }
  }
  return { ok: true, value: cur };
};

const jsonCache = new Map<string, Promise<unknown>>();
const readJson = (p: string) => {
  if (!jsonCache.has(p)) jsonCache.set(p, fs.readFile(p, "utf8").then((s) => JSON.parse(s)));
  return jsonCache.get(p)!;
};
const textCache = new Map<string, Promise<string>>();
const readText = (p: string) => {
  if (!textCache.has(p)) textCache.set(p, fs.readFile(p, "utf8"));
  return textCache.get(p)!;
};
const exists = async (p: string) => fs.stat(p).then((s) => s.isFile()).catch(() => false);

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

// ---- CSV ------------------------------------------------------------------
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
};
const colToIndex = (col: string) => [...col].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
const splitA1 = (a1: string) => {
  const m = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(a1);
  if (!m) throw new Error(`bad A1 ref ${a1}`);
  return { col: colToIndex(m[1]!), row: Number(m[2]) - 1 };
};

// ---- XLSX (minimal zip + xml reader, no deps) ------------------------------
type Workbook = Map<string, Map<string, string>>; // sheet -> (A1 -> value)
const workbookCache = new Map<string, Promise<Workbook>>();

const unzip = (buf: Buffer): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  // locate End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + csize);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
};

const xmlText = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const readWorkbook = (p: string): Promise<Workbook> => {
  if (!workbookCache.has(p)) {
    workbookCache.set(
      p,
      fs.readFile(p).then((buf) => {
        const files = unzip(buf);
        const get = (n: string) => files.get(n)?.toString("utf8") ?? "";
        const shared: string[] = [];
        for (const si of get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
          shared.push([...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]!)).join(""));
        }
        const rels = new Map<string, string>();
        for (const r of get("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
          const id = /Id="([^"]+)"/.exec(r[1]!)?.[1];
          const target = /Target="([^"]+)"/.exec(r[1]!)?.[1];
          if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
        }
        const wb: Workbook = new Map();
        for (const s of get("xl/workbook.xml").matchAll(/<sheet\b([^>]*)\/?>/g)) {
          const name = xmlText(/name="([^"]+)"/.exec(s[1]!)?.[1] ?? "");
          const rid = /r:id="([^"]+)"/.exec(s[1]!)?.[1] ?? "";
          const cells = new Map<string, string>();
          const xml = get(rels.get(rid) ?? "");
          for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const ref = /\br="([A-Z]+[0-9]+)"/.exec(c[1]!)?.[1];
            if (!ref) continue;
            const type = /\bt="([^"]+)"/.exec(c[1]!)?.[1];
            const inner = c[2] ?? "";
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
            if (v !== undefined) cells.set(ref, type === "s" ? shared[Number(v)] ?? "" : xmlText(v));
            else if (type === "inlineStr") {
              cells.set(ref, [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]!)).join(""));
            }
          }
          wb.set(name, cells);
        }
        return wb;
      }),
    );
  }
  return workbookCache.get(p)!;
};

// ---------------------------------------------------------------------------
// anchor checks
// ---------------------------------------------------------------------------
const isValueRole = (a: Anchor) => !("role" in a) || a.role === undefined || a.role === "value";

const checkPageRegion = async (ctx: string, filesDir: string, a: PageRegionAnchor): Promise<string | null> => {
  if (!/\.pdf$/i.test(a.file)) fail(`${ctx}: page-region file must be a PDF, got ${a.file}`);
  if (!(await exists(path.join(filesDir, a.file)))) fail(`${ctx}: missing file ${a.file}`);
  if (!Number.isInteger(a.page) || a.page < 1) fail(`${ctx}: bad page ${a.page}`);
  if (!a.boxes.length) fail(`${ctx}: no boxes`);
  for (const b of a.boxes) {
    for (const k of ["left", "top", "width", "height"] as const) {
      if (typeof b[k] !== "number" || b[k] < 0 || b[k] > 1) fail(`${ctx}: box.${k}=${b[k]} out of [0,1]`);
    }
    if (b.width <= 0 || b.height <= 0) fail(`${ctx}: box has non-positive size`);
    if (b.left + b.width > 1.0001 || b.top + b.height > 1.0001) fail(`${ctx}: box exceeds page`);
  }
  const prov = a.provenance;
  if (!prov?.ocrFile || !prov.wordIndexes?.length) {
    fail(`${ctx}: ground-truth page-region anchors must carry provenance.ocrFile + wordIndexes`);
    return null;
  }
  const ocrPath = path.join(filesDir, prov.ocrFile);
  if (!(await exists(ocrPath))) { fail(`${ctx}: missing OCR file ${prov.ocrFile}`); return null; }
  const ocr = (await readJson(ocrPath)) as { ocr?: { words?: OcrWord[] } };
  const words = ocr.ocr?.words ?? [];
  const picked: OcrWord[] = [];
  for (const i of prov.wordIndexes) {
    const w = words[i];
    if (!w) { fail(`${ctx}: word index ${i} out of range (${words.length} words)`); return null; }
    picked.push(w);
  }
  let rederived: PageRegionAnchor;
  try {
    rederived = anchorFromWords(a.file, picked, prov.wordIndexes);
  } catch (e) {
    fail(`${ctx}: ${(e as Error).message}`);
    return null;
  }
  if (rederived.page !== a.page) fail(`${ctx}: page ${a.page} != OCR page ${rederived.page}`);
  if (rederived.boxes.length !== a.boxes.length) {
    fail(`${ctx}: ${a.boxes.length} boxes stored, ${rederived.boxes.length} re-derived from word indexes`);
  } else {
    rederived.boxes.forEach((rb, i) => {
      const sb = a.boxes[i]!;
      if (!near(rb.left, sb.left) || !near(rb.top, sb.top) || !near(rb.width, sb.width) || !near(rb.height, sb.height)) {
        fail(`${ctx}: box ${i} differs from re-derived box (${JSON.stringify(sb)} vs ${JSON.stringify(rb)})`);
      }
    });
  }
  return picked.map((w) => w.text).join(" ");
};

const utf16Slice = (s: string, start: number, end: number) => s.slice(start, end); // JS strings are UTF-16

const checkEvidence = async (ctx: string, caseDir: string, ev: Evidence) => {
  const filesDir = path.join(caseDir, "files");
  if (!ev.label) fail(`${ctx}: evidence without label`);
  if (!ev.anchors?.length) { fail(`${ctx}: evidence without anchors`); return; }
  const valueTexts: { text: string; kind: Anchor["kind"] }[] = [];
  for (const [ai, a] of ev.anchors.entries()) {
    const actx = `${ctx} anchor[${ai}] (${a.kind})`;
    switch (a.kind) {
      case "page-region": {
        const text = await checkPageRegion(actx, filesDir, a);
        if (text !== null && isValueRole(a)) valueTexts.push({ text, kind: a.kind });
        break;
      }
      case "text-span": {
        const p = path.join(filesDir, a.file);
        if (!(await exists(p))) { fail(`${actx}: missing file ${a.file}`); break; }
        if (!Number.isInteger(a.start) || !Number.isInteger(a.end) || a.start < 0 || a.end <= a.start) {
          fail(`${actx}: bad offsets ${a.start}..${a.end}`); break;
        }
        let hay: string;
        if (a.pointer !== undefined) {
          if (!/\.json$/i.test(a.file)) fail(`${actx}: text-span.pointer only applies to JSON files`);
          const r = resolvePointer(await readJson(p), a.pointer);
          if (!r.ok || typeof r.value !== "string") { fail(`${actx}: pointer ${a.pointer} does not resolve to a string`); break; }
          hay = r.value;
        } else {
          hay = await readText(p);
        }
        if (a.end > hay.length) { fail(`${actx}: end ${a.end} beyond text length ${hay.length}`); break; }
        const text = utf16Slice(hay, a.start, a.end);
        if (isValueRole(a)) valueTexts.push({ text, kind: a.kind });
        break;
      }
      case "json-pointer": {
        const p = path.join(filesDir, a.file);
        if (!/\.json$/i.test(a.file)) fail(`${actx}: json-pointer file must be .json`);
        if (!(await exists(p))) { fail(`${actx}: missing file ${a.file}`); break; }
        const r = resolvePointer(await readJson(p), a.pointer);
        if (!r.ok) { fail(`${actx}: pointer ${a.pointer} does not resolve`); break; }
        if (isValueRole(a) || ev.quote !== undefined) {
          const v = r.value;
          const text = typeof v === "string" ? v : JSON.stringify(v);
          if (isValueRole(a)) valueTexts.push({ text, kind: a.kind });
          else if (ev.quote !== undefined && text !== ev.quote) fail(`${actx}: value ${text} != quote ${ev.quote}`);
        }
        break;
      }
      case "sheet-range": {
        const p = path.join(filesDir, a.file);
        if (!(await exists(p))) { fail(`${actx}: missing file ${a.file}`); break; }
        if (!/^[A-Z]{1,3}[1-9][0-9]*(:[A-Z]{1,3}[1-9][0-9]*)?$/.test(a.range)) fail(`${actx}: bad range ${a.range}`);
        const isCsv = /\.csv$/i.test(a.file);
        if (isCsv && a.sheet) fail(`${actx}: csv anchors must not have a sheet`);
        if (!isCsv && !a.sheet) fail(`${actx}: xlsx/xls anchors must have a sheet`);
        if (a.range.includes(":")) break; // ranges: existence only
        let cell: string | undefined;
        if (isCsv) {
          const rows = parseCsv(await readText(p));
          const { col, row } = splitA1(a.range);
          cell = rows[row]?.[col];
        } else if (/\.xlsx$/i.test(a.file)) {
          const wb = await readWorkbook(p);
          const sheet = wb.get(a.sheet!);
          if (!sheet) { fail(`${actx}: sheet ${a.sheet} not in ${a.file} (have ${[...wb.keys()].join(", ")})`); break; }
          cell = sheet.get(a.range);
        } else {
          break; // legacy .xls: not parsed here
        }
        if (cell === undefined) { fail(`${actx}: cell ${a.range} is empty / missing`); break; }
        if (isValueRole(a)) valueTexts.push({ text: cell, kind: a.kind });
        break;
      }
      default:
        fail(`${ctx}: unknown anchor kind ${(a as { kind: string }).kind}`);
    }
  }
  // quote consistency: every value-role anchor's text must be consistent with quote.
  //  - exact match, or
  //  - every whitespace token of the anchor text is a token of the quote (composite
  //    evidence: two spans / two boxes that together form the quote), or
  //  - sheet cells only: the cell contains the quote (cell granularity is coarser).
  if (ev.quote !== undefined && valueTexts.length) {
    const q = ev.quote;
    const qTokens = new Set(q.split(/\s+/).filter(Boolean));
    for (const { text: t, kind } of valueTexts) {
      const tTokens = t.split(/\s+/).filter(Boolean);
      const ok = t === q ||
        (tTokens.length > 0 && tTokens.every((w) => qTokens.has(w))) ||
        (kind === "sheet-range" && t.includes(q));
      if (!ok) fail(`${ctx}: text under value anchor ${JSON.stringify(t.slice(0, 80))} is inconsistent with quote ${JSON.stringify(q)}`);
    }
  }
};

// ---------------------------------------------------------------------------
const main = async () => {
  const evalPath = path.join(root, "eval", "eval-set.json");
  const set = (await readJson(evalPath)) as EvalSet;
  if (set.schemaVersion !== "citation-eval/v1") fail(`schemaVersion must be citation-eval/v1`);

  const ids = new Set<string>();
  const usedCategories = new Map<string, number>();
  const expectCounts = new Map<string, number>();
  let anchorCount = 0;
  let evidenceCount = 0;

  for (const item of set.items) {
    const ctx = `item ${item.id}`;
    if (ids.has(item.id)) fail(`${ctx}: duplicate id`);
    ids.add(item.id);
    if (!(item.expect in set.expectations)) fail(`${ctx}: unknown expect ${item.expect}`);
    expectCounts.set(item.expect, (expectCounts.get(item.expect) ?? 0) + 1);
    for (const c of item.categories) {
      if (!(c in set.categories)) fail(`${ctx}: undeclared category ${c}`);
      usedCategories.set(c, (usedCategories.get(c) ?? 0) + 1);
    }

    const caseDir = path.join(root, "test-cases", item.caseId);
    const result = await readJson(path.join(caseDir, "result.json")).catch(() => undefined);
    if (result === undefined) { fail(`${ctx}: cannot read result.json for ${item.caseId}`); continue; }
    const r = resolvePointer(result, item.pointer);
    if (!r.ok) fail(`${ctx}: pointer ${item.pointer} does not resolve in result.json`);
    else if (JSON.stringify(r.value) !== JSON.stringify(item.value)) {
      fail(`${ctx}: value drift — eval has ${JSON.stringify(item.value)}, result.json has ${JSON.stringify(r.value)}`);
    }

    if (item.expect === "cite" && item.acceptable.length === 0) fail(`${ctx}: expect=cite needs acceptable evidence`);
    if (item.expect === "cite" && (item.minAcceptableMatches ?? 1) > item.acceptable.length) {
      fail(`${ctx}: minAcceptableMatches exceeds acceptable count`);
    }
    if (item.minAcceptableMatches !== undefined && item.expect !== "cite") fail(`${ctx}: minAcceptableMatches only applies to expect=cite`);
    const requiredContext = item.requiredContext ?? [];
    if (item.minRequiredContextMatches !== undefined && item.expect !== "cite") {
      fail(`${ctx}: minRequiredContextMatches only applies to expect=cite`);
    }
    if (item.minRequiredContextMatches !== undefined && requiredContext.length === 0) {
      fail(`${ctx}: minRequiredContextMatches requires requiredContext evidence`);
    }
    if ((item.minRequiredContextMatches ?? (requiredContext.length ? 1 : 0)) > requiredContext.length) {
      fail(`${ctx}: minRequiredContextMatches exceeds requiredContext count`);
    }
    if (requiredContext.some((e) => e.anchors.some((a) => a.role !== "context"))) {
      fail(`${ctx}: every requiredContext anchor must have role=context`);
    }
    if (item.expect === "empty" && item.acceptable.some((e) => e.anchors.some(isValueRole))) {
      fail(`${ctx}: expect=empty but an acceptable anchor has role value`);
    }

    for (const bucket of ["acceptable", "requiredContext", "secondary", "forbidden"] as const) {
      for (const [ei, ev] of (item[bucket] ?? []).entries()) {
        evidenceCount++;
        anchorCount += ev.anchors.length;
        await checkEvidence(`${ctx} ${bucket}[${ei}] "${ev.label.slice(0, 50)}"`, caseDir, ev);
      }
    }
  }

  for (const c of Object.keys(set.categories)) {
    if (!usedCategories.has(c)) fail(`category ${c} is declared but unused`);
  }

  const cases = new Set(set.items.map((i) => i.caseId));
  console.log(`eval set: ${set.items.length} items across ${cases.size} cases, ${evidenceCount} evidence entries, ${anchorCount} anchors`);
  console.log(`expect: ${[...expectCounts].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`categories used: ${usedCategories.size}`);
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("OK — every ground-truth anchor re-derives from the fixtures.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
