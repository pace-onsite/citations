/**
 * Canonical evidence index for one case: every citable unit of every source
 * file, with the provenance needed to build a citations/v1 anchor later.
 *
 *   PDF + *-ocr.json  → OcrLine (words regrouped into lines; word indexes kept)
 *   .json             → JsonLeaf (pointer per leaf) + TextLine for long strings
 *   .txt/.eml/.html   → TextLine (UTF-16 offsets into the raw file)
 *   .xlsx/.xls/.csv   → SheetCell (A1 + header/row context)
 *
 * Artifacts (*-ocr.json, *-rendered.pdf) are never indexed as sources.
 */
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
import type { CaseIndex, JsonLeaf, OcrLine, OcrWord, SheetCell, TextLine } from "./types.ts";

interface RawOcrWord {
  text: string;
  bbox: { left: number; top: number; width: number; height: number; page: number; original_page?: number };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export async function buildIndex(repoRoot: string, caseId: string): Promise<CaseIndex> {
  const t0 = performance.now();
  const filesDir = path.join(repoRoot, "test-cases", caseId, "files");
  const names = (await fs.readdir(filesDir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();

  const idx: CaseIndex = {
    caseId,
    files: names,
    ocrLines: [],
    ocrByPage: new Map(),
    jsonLeaves: [],
    jsonByParent: new Map(),
    textLines: [],
    textByFile: new Map(),
    cells: [],
    cellsByRow: new Map(),
    rawText: new Map(),
    pageCount: new Map(),
    buildMs: 0,
    skipped: [],
  };

  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    const isArtifact = /-ocr\.json$/i.test(name) || /-rendered\.pdf$/i.test(name);
    if (isArtifact) continue;
    const abs = path.join(filesDir, name);
    try {
      if (ext === ".pdf") {
        const ocr = name.replace(/\.pdf$/i, "-ocr.json");
        if (!existsSync(path.join(filesDir, ocr))) { idx.skipped.push({ file: name, reason: "no OCR artifact" }); continue; }
        await indexOcr(idx, name, ocr, path.join(filesDir, ocr));
      } else if (ext === ".json") {
        const raw = (await fs.readFile(abs, "utf8")).replace(/^\uFEFF/, "");
        idx.rawText.set(name, raw);
        indexJson(idx, name, raw);
      } else if (ext === ".txt" || ext === ".eml" || ext === ".html" || ext === ".htm") {
        const raw = (await fs.readFile(abs, "utf8")).replace(/^\uFEFF/, "");
        idx.rawText.set(name, raw);
        indexText(idx, name, undefined, raw, 0);
      } else if (ext === ".csv") {
        const raw = (await fs.readFile(abs, "utf8")).replace(/^\uFEFF/, "");
        idx.rawText.set(name, raw);
        const wb = XLSX.read(raw, { type: "string", raw: true, cellDates: false });
        indexWorkbook(idx, name, wb, true);
      } else if (ext === ".xlsx" || ext === ".xls") {
        const buf = await fs.readFile(abs);
        const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
        indexWorkbook(idx, name, wb, false);
      } else {
        idx.skipped.push({ file: name, reason: `unsupported type ${ext || "(none)"}` });
      }
    } catch (err) {
      idx.skipped.push({ file: name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  idx.buildMs = Math.round(performance.now() - t0);
  return idx;
}

// ---------------------------------------------------------------------------
// OCR → lines
// ---------------------------------------------------------------------------

async function indexOcr(idx: CaseIndex, pdf: string, ocrFile: string, ocrPath: string) {
  const raw = JSON.parse(await fs.readFile(ocrPath, "utf8")) as { ocr?: { words?: RawOcrWord[] } };
  const words = raw.ocr?.words ?? [];
  if (words.length === 0) { idx.skipped.push({ file: pdf, reason: "OCR artifact has no words" }); return; }

  const byPage = new Map<number, OcrWord[]>();
  words.forEach((w, i) => {
    if (!w?.bbox || typeof w.text !== "string" || w.text.trim() === "") return;
    const ow: OcrWord = {
      text: w.text,
      page: Number.isInteger(w.bbox.original_page) && w.bbox.original_page! >= 1 ? w.bbox.original_page! : w.bbox.page,
      left: clamp01(w.bbox.left),
      top: clamp01(w.bbox.top),
      width: clamp01(w.bbox.width),
      height: clamp01(w.bbox.height),
      index: i,
    };
    (byPage.get(ow.page) ?? byPage.set(ow.page, []).get(ow.page)!).push(ow);
  });

  const pages = new Map<number, OcrLine[]>();
  let maxPage = 0;
  for (const [page, ws] of byPage) {
    maxPage = Math.max(maxPage, page);
    const lines = groupLines(ws);
    const out: OcrLine[] = lines.map((lw, lineNo) => {
      lw.sort((a, b) => a.left - b.left);
      const spans: Array<[number, number]> = [];
      const segments: OcrLine["segments"] = [];
      let text = "";
      for (let i = 0; i < lw.length; i++) {
        const w = lw[i];
        if (text) text += " ";
        const start = text.length;
        spans.push([start, start + w.text.length]);
        text += w.text;
        const prev = lw[i - 1];
        // Column break: gap wider than ~3 average characters (and at least 4% of the page).
        const charW = prev ? ((prev.width / Math.max(1, prev.text.length)) + (w.width / Math.max(1, w.text.length))) / 2 : 0;
        const gap = prev ? w.left - (prev.left + prev.width) : 0;
        const seg = segments[segments.length - 1];
        if (!seg || !prev || gap > Math.max(0.04, charW * 3)) segments.push({ start, end: start + w.text.length, left: w.left, right: w.left + w.width });
        else { seg.end = start + w.text.length; seg.right = Math.max(seg.right, w.left + w.width); }
      }
      return {
        kind: "ocr-line",
        id: `${ocrFile}#p${page}l${lineNo}`,
        file: pdf,
        ocrFile,
        page,
        words: lw,
        text,
        spans,
        segments,
        top: Math.min(...lw.map((w) => w.top)),
        bottom: Math.max(...lw.map((w) => w.top + w.height)),
        left: Math.min(...lw.map((w) => w.left)),
        right: Math.max(...lw.map((w) => w.left + w.width)),
        lineNo,
      };
    });
    pages.set(page, out);
    idx.ocrLines.push(...out);
  }
  idx.ocrByPage.set(ocrFile, pages);
  idx.pageCount.set(pdf, maxPage);
}

/** Cluster words into visual lines: same page, vertical centres within ~55% of word height. */
function groupLines(words: OcrWord[]): OcrWord[][] {
  const sorted = [...words].sort((a, b) => a.top + a.height / 2 - (b.top + b.height / 2) || a.left - b.left);
  const lines: Array<{ cy: number; h: number; words: OcrWord[] }> = [];
  for (const w of sorted) {
    const cy = w.top + w.height / 2;
    const last = lines[lines.length - 1];
    if (last && Math.abs(cy - last.cy) <= Math.max(last.h, w.height) * 0.55) {
      last.words.push(w);
      // running average keeps long lines stable
      last.cy = (last.cy * (last.words.length - 1) + cy) / last.words.length;
      last.h = Math.max(last.h, w.height);
    } else {
      lines.push({ cy, h: w.height, words: [w] });
    }
  }
  // A "line" can contain two columns; still fine for matching (we map ranges back to words).
  return lines.map((l) => l.words);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const esc = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");

function indexJson(idx: CaseIndex, file: string, raw: string) {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { idx.skipped.push({ file, reason: "invalid JSON" }); return; }
  const byParent = new Map<string, JsonLeaf[]>();
  idx.jsonByParent.set(file, byParent);

  const walk = (v: unknown, pointer: string, keys: string[], parent: string) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${pointer}/${i}`, [...keys, String(i)], pointer));
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, `${pointer}/${esc(k)}`, [...keys, k], pointer);
      return;
    }
    const text = v === null ? "null" : typeof v === "string" ? v : JSON.stringify(v);
    const leaf: JsonLeaf = { kind: "json-leaf", id: `${file}#${pointer}`, file, pointer, value: v, text, keys, parentPointer: parent };
    idx.jsonLeaves.push(leaf);
    (byParent.get(parent) ?? byParent.set(parent, []).get(parent)!).push(leaf);
    // Long strings (email bodies, html, descriptions) are also searched line by line.
    if (typeof v === "string" && (v.length > 60 || v.includes("\n"))) indexText(idx, file, pointer, v, 0);
  };
  walk(doc, "", [], "");
}

// ---------------------------------------------------------------------------
// Text-like
// ---------------------------------------------------------------------------

function indexText(idx: CaseIndex, file: string, pointer: string | undefined, text: string, base: number) {
  const list = idx.textByFile.get(file) ?? idx.textByFile.set(file, []).get(file)!;
  let start = 0;
  let lineNo = 0;
  // Split on \n but keep offsets exact (CR stays inside the line and is harmless to matching).
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    if (line.trim() !== "") {
      const tl: TextLine = { kind: "text-line", id: `${file}${pointer ?? ""}#L${lineNo}`, file, pointer, text: line, start: base + start, lineNo };
      idx.textLines.push(tl);
      list.push(tl);
    }
    lineNo++;
    if (end === text.length) break;
    start = end + 1;
  }
}

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

function indexWorkbook(idx: CaseIndex, file: string, wb: XLSX.WorkBook, isCsv: boolean) {
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const grid: Array<Array<{ text: string; a1: string } | undefined>> = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: Array<{ text: string; a1: string } | undefined> = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const a1 = XLSX.utils.encode_cell({ r, c });
        const cell = ws[a1];
        if (!cell || cell.v === undefined || cell.v === null) { row.push(undefined); continue; }
        const text = String(cell.w ?? cell.v).trim();
        row.push(text === "" ? undefined : { text, a1 });
      }
      grid.push(row);
    }
    // Header row: within the first 12 rows, the row with the most non-numeric cells.
    let headerRow = -1, best = 0;
    for (let r = 0; r < Math.min(12, grid.length); r++) {
      const n = grid[r].filter((c) => c && !/^[-$\d.,%\s()]+$/.test(c.text)).length;
      if (n > best && n >= 2) { best = n; headerRow = r; }
    }
    const headers = headerRow >= 0 ? grid[headerRow].map((c) => c?.text) : [];
    const headerA1s = headerRow >= 0 ? grid[headerRow].map((c) => c?.a1) : [];
    const key = `${file}!${isCsv ? "" : sheetName}`;
    const rows = new Map<number, SheetCell[]>();
    idx.cellsByRow.set(key, rows);
    for (let r = 0; r < grid.length; r++) {
      const rowCells = grid[r];
      const rowText = rowCells.filter(Boolean).map((c) => c!.text).join(" | ");
      const first = rowCells.find(Boolean);
      const rowLabel = first?.text;
      for (let c = 0; c < rowCells.length; c++) {
        const cell = rowCells[c];
        if (!cell) continue;
        const sc: SheetCell = {
          kind: "sheet-cell",
          id: `${file}!${sheetName}!${cell.a1}`,
          file,
          sheet: isCsv ? undefined : sheetName,
          row: range.s.r + r + 1,
          col: range.s.c + c + 1,
          a1: cell.a1,
          text: cell.text,
          header: r > headerRow ? headers[c] : undefined,
          headerA1: r > headerRow ? headerA1s[c] : undefined,
          rowLabel: rowLabel !== cell.text ? rowLabel : undefined,
          rowLabelA1: rowLabel !== cell.text ? first?.a1 : undefined,
          rowText,
        };
        idx.cells.push(sc);
        (rows.get(sc.row) ?? rows.set(sc.row, []).get(sc.row)!).push(sc);
      }
    }
  }
}
