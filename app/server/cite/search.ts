/**
 * Candidate generation. For a FieldJob, find every place in the index where
 * the value (or, for blanks/booleans, the *label*) occurs, then score each
 * occurrence by its context:
 *
 *   - is the field's label on the same line / in the key path / in the header?
 *   - does the surrounding row/block contain the sibling identifiers of this list row?
 *   - does the position satisfy definition hints ("first page", "bottom right")?
 *   - is the source authoritative (CSV model exports are secondary)?
 *
 * Scores are deterministic and every contribution is recorded as a reason, so
 * the UI can show *why* a location was chosen or rejected.
 */
import { datesIn, norm, parseDate, parseNumber, squash } from "./normalize.ts";
import type { CaseIndex, Candidate, FieldJob, JsonLeaf, OcrLine, SheetCell, TextLine } from "./types.ts";

const isWordChar = (ch: string | undefined) => ch !== undefined && /[a-z0-9]/i.test(ch);

/** Keywords too generic to make a competing label "related" on their own. */
const GENERIC = new Set(["date", "number", "name", "value", "total", "totals", "amount", "code", "type", "format", "letter", "address", "get", "loss"]);

/** All non-overlapping occurrences of any variant in `text`, respecting token boundaries. */
export function findVariants(text: string, variants: string[]): Array<[number, number]> {
  const low = text.toLowerCase();
  const hits: Array<[number, number]> = [];
  for (const v of variants) {
    if (!v) continue;
    let from = 0;
    while (from <= low.length - v.length) {
      const i = low.indexOf(v, from);
      if (i < 0) break;
      const before = low[i - 1], after = low[i + v.length];
      const okStart = !isWordChar(before) || isWordChar(v[0]) === false;
      const okEnd = !isWordChar(after) || isWordChar(v[v.length - 1]) === false;
      // decimals: "100" must not match inside "100.50" / "1,100"
      const decimalTail = after === "." && /\d/.test(low[i + v.length + 1] ?? "") && /\d$/.test(v);
      const commaTail = after === "," && /\d{3}/.test(low.slice(i + v.length + 1, i + v.length + 4)) && /\d$/.test(v);
      const commaHead = before === "," && /\d/.test(low[i - 2] ?? "") && /^\d/.test(v);
      if (okStart && okEnd && !decimalTail && !commaTail && !commaHead) hits.push([i, i + v.length]);
      from = i + Math.max(1, v.length);
    }
  }
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: Array<[number, number]> = [];
  for (const h of hits) if (!out.some((o) => h[0] < o[1] && o[0] < h[1])) out.push(h);
  return out;
}

/** Find a label (case-insensitive) in text; returns the range or null. Prefers label followed by ':'/'#'. */
export function findLabel(text: string, labels: string[]): [number, number] | null {
  const low = text.toLowerCase();
  let best: [number, number] | null = null;
  for (const l of labels) {
    if (l.length < 3) continue;
    const i = low.indexOf(l);
    if (i < 0) continue;
    const before = low[i - 1];
    if (isWordChar(before)) continue;
    let end = i + l.length;
    const after = low[end];
    if (isWordChar(after) && isWordChar(l[l.length - 1])) continue;
    if (after === ":" || after === "#") end++;
    if (!best || end - i > best[1] - best[0]) best = [i, end];
  }
  return best;
}

interface Ctx { idx: CaseIndex; job: FieldJob; seq: { n: number } }

export function searchCandidates(idx: CaseIndex, job: FieldJob): Candidate[] {
  const ctx: Ctx = { idx, job, seq: { n: 0 } };
  const out: Candidate[] = [];
  switch (job.cls) {
    case "scalar":
    case "zero":
      out.push(...searchOcr(ctx), ...searchText(ctx), ...searchJson(ctx), ...searchCells(ctx));
      break;
    case "composite":
      out.push(...searchComposite(ctx));
      break;
    case "boolean-presence":
    case "blank":
      out.push(...searchLabels(ctx));
      break;
    case "boolean-source":
      out.push(...searchJsonBoolean(ctx));
      break;
    default:
      break;
  }
  bindToDocument(ctx, out);
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Document-level row binding
// ---------------------------------------------------------------------------

/** Squashed full text per file, built once per index (loss runs name the policy once, in a header sheet). */
const fileTextCache = new WeakMap<CaseIndex, Map<string, string>>();
function fileTexts(idx: CaseIndex): Map<string, string> {
  let m = fileTextCache.get(idx);
  if (m) return m;
  m = new Map();
  const add = (file: string, text: string) => m!.set(file, (m!.get(file) ?? "") + squash(text) + " ");
  for (const l of idx.ocrLines) add(l.file, l.text);
  for (const l of idx.textLines) add(l.file, l.text);
  for (const l of idx.jsonLeaves) add(l.file, l.text);
  for (const c of idx.cells) add(c.file, c.text);
  fileTextCache.set(idx, m);
  return m;
}

/** Distinctive pieces of a row key: "CUP-6J948865-22-26" → ["cup6j94886522-26", "6j948865"]. */
function keyCores(key: string): string[] {
  const out = [squash(key)];
  for (const t of key.split(/[^A-Za-z0-9]+/)) if (t.length >= 5 && /\d/.test(t) && /[A-Za-z]/.test(t) || t.length >= 7 && /^\d+$/.test(t)) out.push(squash(t));
  return [...new Set(out)];
}

/**
 * When a list row has a proper key (policy / claim number) but the key is not
 * on the candidate's own row (loss-run rows are claims; the policy is named once
 * per document), bind at the document level instead: files that mention the key
 * get a bonus, files that do not — while others do — get a penalty.
 */
function bindToDocument(ctx: Ctx, cands: Candidate[]) {
  const { job, idx } = ctx;
  if (!job.primaryIdentifiers.length || !cands.length) return;
  const cores = job.primaryIdentifiers.flatMap(keyCores);
  const texts = fileTexts(idx);
  const hit = new Map<string, string | null>();
  for (const c of cands) {
    if (!hit.has(c.file)) {
      const t = texts.get(c.file) ?? "";
      hit.set(c.file, cores.find((k) => t.includes(k)) ?? null);
    }
  }
  const anyHit = [...hit.values()].some(Boolean);
  for (const c of cands) {
    if (c.rowBound || c.rowConflict) continue;
    const k = hit.get(c.file);
    const rowPenalty = c.penalties.findIndex((p) => p.startsWith("row key "));
    if (k) {
      if (rowPenalty >= 0) { c.penalties.splice(rowPenalty, 1); c.score += 0.3; }
      const ns = c.penalties.indexOf("no sibling identifier of this list row nearby");
      if (ns >= 0) { c.penalties.splice(ns, 1); c.score += 0.15; }
      const sl = c.penalties.indexOf("short literal; needs label or row support");
      if (sl >= 0 && (c.labelCell || c.labelRange)) { c.penalties.splice(sl, 1); c.score += 0.15; }
      c.rowBound = true;
      c.score += 0.15;
      c.reasons.push(`document ${c.file} is for this row's key ("${k}")`);
    } else if (anyHit && rowPenalty < 0) {
      c.score -= 0.2;
      c.penalties.push(`document ${c.file} never mentions the row key ${job.primaryIdentifiers.map((s) => `"${s}"`).join(" / ")}`);
    }
    c.score = Math.max(0, Math.min(1, Math.round(c.score * 1000) / 1000));
  }
}

// ---------------------------------------------------------------------------
// OCR lines
// ---------------------------------------------------------------------------

/** Integer values may be printed with cents ("$807.39" for 807). */
function centsHits(text: string, job: FieldJob): Array<[number, number]> {
  const n = typeof job.value === "number" ? job.value : parseNumber(String(job.value));
  if (n === null || !Number.isInteger(n) || n === 0) return [];
  const grouped = Math.abs(n).toLocaleString("en-US");
  const re = new RegExp(`(?<![\\d.])\\$?\\s?(?:${grouped.replace(/[.,]/g, "\\$&")}|${Math.abs(n)})\\.\\d{2}(?!\\d)`, "g");
  return [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
}

/** Segment of `line` that contains char offset `pos`. */
const segmentAt = (line: OcrLine, pos: number) => line.segments.findIndex((s) => pos >= s.start && pos <= s.end);

/** Segment on `other` that sits in the same column as `seg` (left edges within 3% of page width). */
function sameColumnSegment(seg: OcrLine["segments"][number], other: OcrLine | undefined) {
  if (!other) return undefined;
  return other.segments.find((s) => Math.abs(s.left - seg.left) <= 0.03 || (s.left >= seg.left - 0.01 && s.left <= seg.right));
}

/**
 * Text of the "row block" around a segment: the segment itself, the rest of
 * its line, and the same-column segments on the lines directly above/below
 * (wrapped table cells). Used for row binding and the judge's context window.
 */
interface RowPart { unit: OcrLine | TextLine; range: [number, number] }

function rowBlock(lines: OcrLine[], li: number, segIndex: number): { text: string; sameColumn: string; parts: RowPart[] } {
  const line = lines[li];
  const seg = line.segments[segIndex] ?? line.segments[0];
  const above = sameColumnSegment(seg, lines[li - 1]);
  const below = sameColumnSegment(seg, lines[li + 1]);
  const aboveText = above ? lines[li - 1].text.slice(above.start, above.end) : "";
  const belowText = below ? lines[li + 1].text.slice(below.start, below.end) : "";
  const sameColumn = [aboveText, line.text.slice(seg.start, seg.end), belowText].filter(Boolean).join(" ");
  const parts: RowPart[] = [{ unit: line, range: [0, line.text.length] }];
  if (above) parts.push({ unit: lines[li - 1], range: [above.start, above.end] });
  if (below) parts.push({ unit: lines[li + 1], range: [below.start, below.end] });
  return { text: [aboveText, line.text, belowText].filter(Boolean).join("\n"), sameColumn, parts };
}

function searchOcr(ctx: Ctx): Candidate[] {
  const { idx, job } = ctx;
  const out: Candidate[] = [];
  const longest = job.variants.reduce((a, b) => (b.length > a.length ? b : a), "");
  for (const [, pages] of idx.ocrByPage) {
    for (const [, lines] of pages) {
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        let hits = findVariants(line.text, job.variants);
        let cents = false;
        if (!hits.length) { hits = centsHits(line.text, job); cents = hits.length > 0; }
        if (hits.length) {
          for (const h of hits.slice(0, 6)) {
            const c = ocrCandidate(ctx, line, [h], lines, li);
            if (cents) { c.matchType = "normalized"; c.reasons[0] = `source prints "${c.quote}" (cents) for integer ${String(job.value)}`; }
            out.push(c);
          }
          continue;
        }
        // Wrapped value: this segment + the same-column segment on the next line.
        if (longest.length >= 8 && li + 1 < lines.length) {
          const next = lines[li + 1];
          for (let si = 0; si < line.segments.length; si++) {
            const seg = line.segments[si];
            const nseg = sameColumnSegment(seg, next);
            if (!nseg) continue;
            const a = line.text.slice(seg.start, seg.end), b = next.text.slice(nseg.start, nseg.end);
            const joined = `${a} ${b}`;
            const jh = findVariants(joined, [longest]).filter((h) => h[0] < a.length && h[1] > a.length + 1);
            if (!jh.length) continue;
            const h = jh[0];
            const r1: [number, number] = [seg.start + h[0], seg.end];
            const r2: [number, number] = [nseg.start, nseg.start + (h[1] - a.length - 1)];
            const c = ocrCandidate(ctx, line, [r1], lines, li);
            c.continuation = { unit: next, range: r2 };
            c.quote = `${wordsText(line, r1)} ${wordsText(next, r2)}`;
            c.matchType = "normalized";
            c.reasons[0] = `matches across two lines of one column ("${c.quote}")`;
            out.push(c);
            break;
          }
        }
      }
    }
  }
  return out;
}

/** Text of the whole OCR words that a char range touches — exactly what a box over them covers. */
export function wordsText(line: OcrLine, range: [number, number]): string {
  const parts: string[] = [];
  line.spans.forEach(([ws, we], i) => { if (ws < range[1] && range[0] < we) parts.push(line.words[i].text); });
  return parts.join(" ") || line.text.slice(range[0], range[1]);
}

function ocrCandidate(ctx: Ctx, line: OcrLine, ranges: Array<[number, number]>, lines: OcrLine[], li: number): Candidate {
  const { job } = ctx;
  // Boxes cover whole words, so the quote must too ("(807.39)" not "807.39").
  const quote = ranges.map((r) => wordsText(line, r)).join(" ");
  const block = rowBlock(lines, li, segmentAt(line, ranges[0][0]));
  const window = block.text;
  const c = baseCandidate(ctx, line, ranges, quote, window, `${line.file} p${line.page} l${line.lineNo + 1}`);

  // label on the same line, before the value
  const lab = findLabel(line.text.slice(0, ranges[0][0]), job.explicitLabels);
  if (lab) { c.labelRange = { unit: line, range: lab }; c.score += 0.3; c.reasons.push(`label "${line.text.slice(lab[0], lab[1])}" on the same line`); }
  else {
    const prev = lines[li - 1];
    const labPrev = prev ? findLabel(prev.text, job.explicitLabels) : null;
    // A label on the line above is a column header: carry it as context rather than as the field label.
    if (labPrev) { c.labelRange = { unit: prev, range: labPrev, role: "context" }; c.score += 0.15; c.reasons.push(`label "${prev.text.slice(labPrev[0], labPrev[1])}" on the line above`); }
    else {
      // generic label: some other "Something:" right before the value on this line → competing label
      const before = line.text.slice(0, ranges[0][0]);
      const other = before.match(/([A-Za-z][A-Za-z /()&'.-]{2,40}):\s*$/);
      if (other) {
        const ol = other[1].toLowerCase();
        const overlap = job.keywords.filter((k) => !GENERIC.has(k) && ol.includes(k)).length;
        if (overlap === 0) { c.score -= 0.25; c.penalties.push(`preceded by a different label "${other[1].trim()}:"`); }
        else {
          const start = before.length - other[0].length + (other[0].length - other[0].trimStart().length);
          c.labelRange = { unit: line, range: [start, start + other[0].trimEnd().length] };
          c.score += 0.2;
          c.reasons.push(`preceded by related label "${other[1].trim()}:"`);
        }
      }
    }
  }
  // Two-letter state code sitting in an address ("Fayetteville, GA 30214").
  if (/^[A-Z]{2}$/.test(String(job.value)) && /^\s+\d{5}(-\d{4})?\b/.test(line.text.slice(ranges[0][1])) && job.keywords.some((k) => /state|address|location/.test(k))) {
    c.score += 0.3;
    c.reasons.push("state code followed by a ZIP code (address line)");
  }
  // Rows with several amounts: cannot tell which column is this field without a header.
  const amounts = (line.text.match(/\$\s?\d[\d,]*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/g) ?? []).length;
  if (amounts >= 3 && (typeof job.value === "number" || parseNumber(String(job.value)) !== null) && !c.labelRange) {
    c.score -= Math.min(0.2, 0.07 * (amounts - 1));
    c.penalties.push(`row holds ${amounts} amounts; column is ambiguous`);
  }
  scoreKeywords(c, window, job);
  // Row binding: sibling values must sit on this line or in the same column
  // directly above/below (wrapped cell), not merely somewhere on the page.
  scoreRow(c, `${line.text}\n${block.sameColumn}`, job, block.parts);
  scoreHints(c, job, line.page, (line.top + line.bottom) / 2, (line.left + line.right) / 2);
  finalize(c);
  return c;
}

// ---------------------------------------------------------------------------
// Text lines (txt/eml/html + long JSON strings)
// ---------------------------------------------------------------------------

function searchText(ctx: Ctx): Candidate[] {
  const { idx, job } = ctx;
  const out: Candidate[] = [];
  for (const [, lines] of idx.textByFile) {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let hits = findVariants(line.text, job.variants);
      let cents = false;
      if (!hits.length) { hits = centsHits(line.text, job); cents = hits.length > 0; }
      const isHtml = /<[a-z!/][^>]*>/i.test(line.text.slice(0, 2000));
      // Long single-line HTML bodies can hold hundreds of hits for short literals; keep a few.
      for (const h of hits.slice(0, isHtml ? 2 : 6)) {
        const quote = line.text.slice(h[0], h[1]);
        // Context window: ±200 chars on this line plus the neighbouring short lines.
        const local = line.text.slice(Math.max(0, h[0] - 200), Math.min(line.text.length, h[1] + 200));
        const neighbours = [lines[li - 1], lines[li + 1]].filter((l): l is TextLine => Boolean(l) && l!.text.length <= 400).map((l) => l.text);
        const window = [lines[li - 1] && neighbours[0], local, lines[li + 1] && neighbours[neighbours.length - 1]].filter((s): s is string => typeof s === "string").join("\n");
        const c = baseCandidate(ctx, line, [h], quote, window, `${line.file}${line.pointer ?? ""} L${line.lineNo + 1}`);
        if (cents) { c.matchType = "normalized"; c.reasons[0] = `source prints "${quote}" (cents) for integer ${String(job.value)}`; }
        const before = line.text.slice(Math.max(0, h[0] - 120), h[0]);
        const lab = findLabel(before, job.explicitLabels);
        if (lab) { c.labelRange = { unit: line, range: [lab[0] + Math.max(0, h[0] - 120), lab[1] + Math.max(0, h[0] - 120)] }; c.score += 0.3; c.reasons.push(`label "${before.slice(lab[0], lab[1])}" on the same line`); }
        else {
          const other = before.match(/([A-Za-z][A-Za-z /()&'.-]{2,40})\s*[:#-]\s*$/);
          if (other && !job.keywords.some((k) => !GENERIC.has(k) && other[1].toLowerCase().includes(k))) { c.score -= 0.2; c.penalties.push(`preceded by a different label "${other[1].trim()}"`); }
        }
        if (isHtml) { c.penalties.push("inside HTML markup"); c.score -= 0.05; }
        if (line.pointer) c.reasons.push(`inside JSON string ${line.pointer}`);
        if (/\.(pdf|xlsx?|csv|docx?|eml|msg|png|jpe?g)\s*$/i.test(line.text) && line.text.length <= 200) { c.score -= 0.25; c.penalties.push("inside a file name, not a field value"); }
        scoreKeywords(c, window, job);
        scoreRow(c, window, job);
        finalize(c);
        out.push(c);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON leaves
// ---------------------------------------------------------------------------

function leafMatches(leaf: JsonLeaf, job: FieldJob): Candidate["matchType"] | null {
  const v = job.value;
  const t = leaf.text;
  if (typeof v === "number") {
    const n = parseNumber(t);
    return n !== null && n === v ? (t === String(v) ? "exact" : "normalized") : null;
  }
  const s = String(v);
  if (norm(t) === norm(s)) return "exact";
  // dates: "2024-02-01T00:00:00" vs "02/01/2024"
  const d = parseDate(s);
  if (d) {
    const ld = parseDate(t);
    if (ld && ld.y === d.y && ld.m === d.m && ld.d === d.d) return "normalized";
    return null;
  }
  const n = parseNumber(s);
  if (n !== null && /\d/.test(s)) {
    const ln = parseNumber(t);
    return ln !== null && ln === n ? "normalized" : null;
  }
  if (squash(t) === squash(s) && squash(s).length >= 4) return "normalized";
  return null;
}

function searchJson(ctx: Ctx): Candidate[] {
  const { idx, job } = ctx;
  const out: Candidate[] = [];
  const s = String(job.value);
  for (const leaf of idx.jsonLeaves) {
    const mt = leafMatches(leaf, job);
    let ranges: Array<[number, number]> = [];
    let quote = leaf.text;
    let matchType = mt;
    if (!mt) {
      // sub-span inside a short string leaf (long ones are covered by text lines)
      if (typeof leaf.value !== "string" || leaf.text.length > 60 || leaf.text.includes("\n")) continue;
      const hits = findVariants(leaf.text, job.variants);
      if (!hits.length) continue;
      ranges = [hits[0]];
      quote = leaf.text.slice(hits[0][0], hits[0][1]);
      matchType = "partial";
    }
    const siblings = idx.jsonByParent.get(leaf.file)?.get(leaf.parentPointer) ?? [];
    const window = siblings.map((l) => `${l.keys[l.keys.length - 1]}: ${l.text.length > 80 ? l.text.slice(0, 80) + "…" : l.text}`).join("\n");
    const c = baseCandidate(ctx, leaf, ranges, quote, window, `${leaf.file}${leaf.pointer}`, matchType!);
    // key path vs label/keywords
    const keyText = leaf.keys.filter((k) => !/^\d+$/.test(k)).join(" ");
    const lastKey = leaf.keys[leaf.keys.length - 1] ?? "";
    const lastSq = squash(lastKey);
    const labelHit = job.explicitLabels.find((l) => squash(l).length >= 4 && (lastSq === squash(l) || lastSq.includes(squash(l)) || squash(l).includes(lastSq) && lastSq.length >= 4));
    if (labelHit) { c.score += 0.3; c.reasons.push(`key "${lastKey}" matches field label "${labelHit}"`); }
    else {
      const kw = job.keywords.filter((k) => squash(keyText).includes(squash(k)));
      if (kw.length) { c.score += Math.min(0.2, 0.08 * kw.length); c.reasons.push(`key path mentions ${kw.map((k) => `"${k}"`).join(", ")}`); }
      else if (/\b(id|name|filename|file|subject|key|lookup|code)\b/i.test(lastKey) && job.keywords.length && !job.keywords.some((k) => /name|number|id|code|subject/.test(k))) {
        c.score -= 0.1; c.penalties.push(`key "${lastKey}" is unrelated to the field`);
      }
    }
    if (typeof leaf.value === "number" && typeof job.value === "string" && /\$/.test(s)) c.reasons.push("numeric source for a currency string");
    scoreRow(c, window, job);
    recordKeyConflict(c, siblings, job);
    finalize(c);
    out.push(c);
  }
  return out;
}

const KEY_FIELD = /(policy|claim|account|cert|certificate|report|file)[ _-]*(number|no\.?|num|#|id)$|^(id|number|no)$|[ _]?(number|#)$/i;
/**
 * A JSON record that carries its own policy/claim number which differs from
 * this row's key is a different row — no document-level rescue for it.
 */
function recordKeyConflict(c: Candidate, siblings: JsonLeaf[], job: FieldJob) {
  if (!job.primaryIdentifiers.length || c.rowBound) return;
  const cores = job.primaryIdentifiers.flatMap(keyCores);
  for (const s of siblings) {
    const k = s.keys[s.keys.length - 1] ?? "";
    if (!KEY_FIELD.test(k) || !/\d/.test(s.text)) continue;
    const v = squash(s.text);
    if (cores.some((core) => v.includes(core) || core.includes(v))) return; // same key, differently formatted
    c.rowConflict = `${k} = ${s.text}`;
    c.score -= 0.3;
    c.penalties.push(`record is for ${k} "${s.text}", not this row's key`);
    return;
  }
}

function searchJsonBoolean(ctx: Ctx): Candidate[] {
  const { idx, job } = ctx;
  const out: Candidate[] = [];
  for (const leaf of idx.jsonLeaves) {
    if (typeof leaf.value !== "boolean" || leaf.value !== job.value) continue;
    const lastKey = leaf.keys[leaf.keys.length - 1] ?? "";
    const kw = job.keywords.filter((k) => squash(leaf.keys.join(" ")).includes(squash(k)));
    if (!kw.length) continue;
    const siblings = idx.jsonByParent.get(leaf.file)?.get(leaf.parentPointer) ?? [];
    const window = siblings.map((l) => `${l.keys[l.keys.length - 1]}: ${l.text.slice(0, 80)}`).join("\n");
    const c = baseCandidate(ctx, leaf, [], leaf.text, window, `${leaf.file}${leaf.pointer}`, "exact");
    c.score += Math.min(0.35, 0.12 * kw.length);
    c.reasons.push(`boolean key "${lastKey}" mentions ${kw.map((k) => `"${k}"`).join(", ")}`);
    scoreRow(c, window, job);
    finalize(c);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spreadsheet cells
// ---------------------------------------------------------------------------

function cellMatches(cell: SheetCell, job: FieldJob): Candidate["matchType"] | null {
  const v = job.value;
  const t = cell.text;
  if (typeof v === "number") { const n = parseNumber(t); return n !== null && n === v ? "exact" : null; }
  const s = String(v);
  if (norm(t) === norm(s)) return "exact";
  const d = parseDate(s);
  if (d) { const cd = parseDate(t); if (cd && cd.y === d.y && cd.m === d.m && cd.d === d.d) return "normalized"; const ds = datesIn(t); return ds.size === 1 && ds.has(`${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`) ? "normalized" : null; }
  const n = parseNumber(s);
  if (n !== null && /\d/.test(s)) { const cn = parseNumber(t); return cn !== null && cn === n ? "normalized" : null; }
  if (t.length <= 200 && findVariants(t, job.variants).length) return "partial";
  return null;
}

function searchCells(ctx: Ctx): Candidate[] {
  const { idx, job } = ctx;
  const out: Candidate[] = [];
  for (const cell of idx.cells) {
    const mt = cellMatches(cell, job);
    if (!mt) continue;
    const ranges: Array<[number, number]> = mt === "partial" ? [findVariants(cell.text, job.variants)[0]] : [];
    const quote = mt === "partial" ? cell.text.slice(ranges[0][0], ranges[0][1]) : cell.text;
    const window = `${cell.header ? `header: ${cell.header}\n` : ""}${cell.rowLabel ? `row: ${cell.rowLabel}\n` : ""}${cell.rowText}`;
    const c = baseCandidate(ctx, cell, ranges, quote, window, `${cell.file}!${cell.sheet ?? ""}!${cell.a1}`, mt);
    scoreCellLabels(c, cell, job);
    if (/\.csv$/i.test(cell.file)) { c.score -= 0.3; c.penalties.push("CSV files in this dataset are model-check exports (secondary source)"); }
    scoreRow(c, cell.rowText, job);
    finalize(c);
    out.push(c);
  }
  return out;
}

/** Column-header abbreviations seen in loss runs / dec pages. */
const ABBR: Record<string, string> = {
  pd: "paid", inc: "incurred", incd: "incurred", os: "outstanding", "o/s": "outstanding", res: "reserved", rsv: "reserved", reserve: "reserved", reserves: "reserved",
  tot: "total", med: "medical", exp: "expense", expenses: "expense", ind: "indemnity", indem: "indemnity", no: "number", num: "number", "#": "number",
  eff: "effective", exp_date: "expiration", amt: "amount", desc: "description", dt: "date", pol: "policy", clm: "claim", cov: "coverage", ded: "deductible",
  prem: "premium", recov: "recovery", subro: "subrogation", loc: "location", yr: "year",
};
/** Tokens that change *which measure* a column is (paid vs incurred vs outstanding…). */
const QUALIFIERS = new Set(["paid", "incurred", "outstanding", "reserved", "total", "open", "closed", "net", "gross", "expense", "medical", "indemnity", "loss", "recovery"]);
/** Sørensen–Dice similarity over character bigrams (0..1). */
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}
const canon = (s: string) => tokenize(s.replace(/[()]/g, " ")).map((t) => ABBR[t] ?? t.replace(/s$/, "")).filter((t) => t.length >= 2 && !["of", "the", "and", "or", "in", "to", "as", "at", "on"].includes(t));

/** Score a sheet cell by its column header and row label; record which cell names it. */
function scoreCellLabels(c: Candidate, cell: SheetCell, job: FieldJob) {
  const hdr = (cell.header ?? "").toLowerCase();
  const labelCell = (a1: string | undefined, role: "label" | "context" = "label") => { if (a1) c.labelCell = { file: cell.file, sheet: cell.sheet, a1, role }; };
  const lab = job.explicitLabels.find((l) => squash(l).length >= 3 && (squash(hdr) === squash(l) || squash(hdr).includes(squash(l))));
  if (lab) { c.score += 0.3; c.reasons.push(`column header "${cell.header}" matches "${lab}"`); labelCell(cell.headerA1); return; }
  const rowLab = job.explicitLabels.find((l) => squash(l).length >= 3 && cell.rowLabel && squash(cell.rowLabel).includes(squash(l)));
  if (rowLab) { c.score += 0.3; c.reasons.push(`row label "${cell.rowLabel}" matches "${rowLab}"`); labelCell(cell.rowLabelA1); return; }

  const fieldToks = canon(job.name.replace(/[_-]+/g, " "));
  if (cell.header && fieldToks.length) {
    const hToks = new Set(canon(hdr));
    const covered = fieldToks.filter((t) => hToks.has(t));
    const conflict = [...hToks].filter((t) => QUALIFIERS.has(t) && !fieldToks.includes(t));
    if (covered.length === fieldToks.length && !conflict.length) { c.score += 0.3; c.reasons.push(`column header "${cell.header}" names the field`); labelCell(cell.headerA1); return; }
    if (covered.length && conflict.length) {
      c.score -= 0.15;
      c.penalties.push(`column header "${cell.header}" is a different measure (${conflict.join("/")}, not ${fieldToks.filter((t) => !hToks.has(t)).join("/") || "this field"})`);
      return;
    }
    if (covered.length) { c.score += Math.min(0.2, 0.1 * covered.length); c.reasons.push(`column header "${cell.header}" mentions ${covered.map((k) => `"${k}"`).join(", ")}`); labelCell(cell.headerA1); return; }
  }
  // A column header that shares nothing with the field name is a different column,
  // whatever the description happens to mention ("claim" in "Claim Recovery" ≠ "OS Claim").
  if (cell.header && fieldToks.length) { c.score -= 0.1; c.penalties.push(`column header "${cell.header}" does not mention the field`); return; }
  // Key/value sheets: "Losses as of:" | 05/11/2025 — fuzzy against the definition's labels (OCR/wording drift).
  if (cell.rowLabel && /:\s*$/.test(cell.rowLabel)) {
    const rl = squash(cell.rowLabel.replace(/:\s*$/, ""));
    const fuzzy = job.explicitLabels.map((l) => ({ l, d: dice(rl, squash(l)) })).sort((a, b) => b.d - a.d)[0];
    if (fuzzy && fuzzy.d >= 0.5) { c.score += 0.25; c.reasons.push(`row label "${cell.rowLabel}" resembles "${fuzzy.l}"`); labelCell(cell.rowLabelA1); return; }
  }
  const kw = job.keywords.filter((k) => !GENERIC.has(k) && (squash(hdr).includes(squash(k)) || squash(cell.rowLabel ?? "").includes(squash(k))));
  if (kw.length) {
    const fromRow = kw.some((k) => squash(cell.rowLabel ?? "").includes(squash(k)));
    c.score += Math.min(0.2, 0.08 * kw.length) + (fromRow && /:\s*$/.test(cell.rowLabel ?? "") ? 0.1 : 0);
    c.reasons.push(`header/row label mentions ${kw.map((k) => `"${k}"`).join(", ")}`);
    labelCell(fromRow ? cell.rowLabelA1 : cell.headerA1);
  } else if (cell.header) { c.score -= 0.1; c.penalties.push(`column header "${cell.header}" does not mention the field`); }
}

// ---------------------------------------------------------------------------
// Composite values (two dates on one line)
// ---------------------------------------------------------------------------

function searchComposite(ctx: Ctx): Candidate[] {
  const { idx, job } = ctx;
  const parts = job.parts ?? [];
  const out: Candidate[] = [];
  const tryLines = (lines: Array<OcrLine | TextLine>, locator: (l: OcrLine | TextLine) => string) => {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const ranges: Array<[number, number]> = [];
      for (const pv of parts) {
        const hs = findVariants(line.text, pv).filter((h) => !ranges.some((r) => r[0] === h[0]));
        if (!hs.length) { ranges.length = 0; break; }
        ranges.push(hs[0]);
      }
      if (!ranges.length) continue;
      ranges.sort((a, b) => a[0] - b[0]);
      const quote = ranges.map((r) => (line.kind === "ocr-line" ? wordsText(line, r) : line.text.slice(r[0], r[1]))).join(" ");
      const window = lines.slice(Math.max(0, li - 2), li + 2).map((l) => l.text).join("\n");
      const c = baseCandidate(ctx, line, ranges, quote, window, locator(line), "normalized");
      c.reasons.push(`all ${parts.length} parts found on one line`);
      const lab = findLabel(line.text.slice(0, ranges[0][0]), job.explicitLabels);
      if (lab) { c.labelRange = { unit: line, range: lab }; c.score += 0.3; c.reasons.push(`label "${line.text.slice(lab[0], lab[1])}" on the same line`); }
      scoreKeywords(c, window, job);
      scoreRow(c, window, job);
      if (line.kind === "ocr-line") scoreHints(c, job, line.page, (line.top + line.bottom) / 2, (line.left + line.right) / 2);
      finalize(c);
      out.push(c);
    }
  };
  for (const [, pages] of idx.ocrByPage) for (const [, lines] of pages) tryLines(lines, (l) => `${l.file} p${(l as OcrLine).page} l${(l as OcrLine).lineNo + 1}`);
  for (const [, lines] of idx.textByFile) tryLines(lines, (l) => `${l.file}${(l as TextLine).pointer ?? ""} L${(l as TextLine).lineNo + 1}`);
  // Sheets / JSON: one cell holding both dates, or matching a single "term" string.
  for (const cell of idx.cells) {
    const ds = datesIn(cell.text);
    if (parts.every((pv) => pv.some((v) => cell.text.toLowerCase().includes(v)))) {
      const c = baseCandidate(ctx, cell, [], cell.text, cell.rowText, `${cell.file}!${cell.sheet ?? ""}!${cell.a1}`, "normalized");
      c.reasons.push("cell holds both dates");
      if (/\.csv$/i.test(cell.file)) { c.score -= 0.3; c.penalties.push("CSV is a secondary source"); }
      scoreRow(c, cell.rowText, job);
      finalize(c);
      out.push(c);
    }
    void ds;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Label-driven search (boolean presence, blanks)
// ---------------------------------------------------------------------------

function searchLabels(ctx: Ctx): Candidate[] {
  const { idx, job } = ctx;
  const out: Candidate[] = [];
  // Strong labels only: ending in ':'/'#' (quoted in the definition), multi-word, or ≥6 chars.
  const labels = job.explicitLabels.filter((l) => /[:#]$/.test(l) || l.length >= 6 || l.includes(" "));
  if (!labels.length) return out;

  const scan = (lines: Array<OcrLine | TextLine>, locator: (l: OcrLine | TextLine) => string) => {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lab = findLabel(line.text, labels);
      if (!lab) continue;
      // The value is what follows the label *within the same column segment*. When the
      // label ends its segment ("Mortgagee:   ROCKET MORTGAGE"), the value is the next
      // segment if it starts close by (form gap), not a far-right column.
      let segEnd = line.text.length;
      if (line.kind === "ocr-line") {
        const si = line.segments.findIndex((s) => lab[0] >= s.start && lab[0] <= s.end);
        const seg = line.segments[si];
        if (seg) {
          segEnd = seg.end;
          const nextSeg = line.segments[si + 1];
          if (line.text.slice(lab[1], seg.end).trim() === "" && nextSeg && nextSeg.left - seg.right < 0.15) segEnd = nextSeg.end;
        }
      }
      let rest = line.text.slice(lab[1], segEnd);
      // Stop at the next "Label:" on the same line (form rows with several fields).
      const nextLabel = rest.match(/\s{2,}[A-Z][A-Za-z /()&'.-]{2,40}:|\s[A-Z][A-Za-z /()&'.-]{2,40}:\s/);
      if (nextLabel && nextLabel.index !== undefined && nextLabel.index > 0) rest = rest.slice(0, nextLabel.index);
      const restTrim = rest.trim();
      const valueStart = lab[1] + (rest.length - rest.trimStart().length);
      const valueRange: [number, number] | null = restTrim ? [valueStart, valueStart + restTrim.length] : null;
      const window = lines.slice(Math.max(0, li - 1), li + 3).map((l) => l.text).join("\n");
      const valueQuote = valueRange ? (line.kind === "ocr-line" ? wordsText(line, valueRange) : restTrim) : "";
      const c = baseCandidate(ctx, line, valueRange ? [valueRange] : [], valueQuote, window, locator(line), valueRange ? "normalized" : "label-only");
      c.labelRange = { unit: line, range: lab };
      c.score += 0.35;
      c.reasons.push(`label "${line.text.slice(lab[0], lab[1])}" found`);
      if (valueRange) c.reasons.push(`followed by "${restTrim.length > 60 ? restTrim.slice(0, 60) + "…" : restTrim}"`);
      else c.reasons.push("nothing follows the label on this line");
      if (!valueRange && li + 1 < lines.length) {
        // Value on the next line, in the same column as the label (form layouts).
        const next = lines[li + 1];
        let range: [number, number] | null = [0, next.text.length];
        if (line.kind === "ocr-line" && next.kind === "ocr-line") {
          const seg = line.segments.find((s) => lab[0] >= s.start && lab[0] <= s.end);
          const nseg = seg ? sameColumnSegment(seg, next) : undefined;
          range = nseg ? [nseg.start, nseg.end] : null;
        }
        const candidateText = range ? next.text.slice(range[0], range[1]).trim() : "";
        if (range && candidateText && !/^[A-Z][A-Za-z /()&'.-]{2,40}:/.test(candidateText)) {
          c.continuation = { unit: next, range };
          c.quote = next.kind === "ocr-line" ? wordsText(next, range) : candidateText;
          c.matchType = "normalized";
          c.reasons.push(`value appears on the next line: "${candidateText.slice(0, 60)}"`);
        }
      }
      scoreKeywords(c, window, job);
      scoreRow(c, window, job);
      if (line.kind === "ocr-line") scoreHints(c, job, line.page, (line.top + line.bottom) / 2, (line.left + line.right) / 2);
      finalize(c);
      out.push(c);
    }
  };
  for (const [, pages] of idx.ocrByPage) for (const [, lines] of pages) scan(lines, (l) => `${l.file} p${(l as OcrLine).page} l${(l as OcrLine).lineNo + 1}`);
  for (const [, lines] of idx.textByFile) scan(lines, (l) => `${l.file}${(l as TextLine).pointer ?? ""} L${(l as TextLine).lineNo + 1}`);

  // JSON: a key equal to the label inside the bound row (or anywhere, if no row).
  for (const leaf of idx.jsonLeaves) {
    const lastSq = squash(leaf.keys[leaf.keys.length - 1] ?? "");
    const lab = labels.find((l) => squash(l) === lastSq);
    if (!lab) continue;
    const siblings = idx.jsonByParent.get(leaf.file)?.get(leaf.parentPointer) ?? [];
    const window = siblings.map((l) => `${l.keys[l.keys.length - 1]}: ${l.text.slice(0, 80)}`).join("\n");
    const hasValue = leaf.value !== null && leaf.value !== "" && leaf.text !== "[]";
    const c = baseCandidate(ctx, leaf, [], hasValue ? leaf.text : "", window, `${leaf.file}${leaf.pointer}`, hasValue ? "normalized" : "label-only");
    c.score += 0.35;
    c.reasons.push(`key "${leaf.keys[leaf.keys.length - 1]}" equals field label${hasValue ? `; value is ${JSON.stringify(leaf.text.slice(0, 60))}` : "; value is empty/null"}`);
    scoreRow(c, window, job);
    finalize(c);
    out.push(c);
  }
  // Sheets: header equal to the label in the bound row.
  for (const cell of idx.cells) {
    const hdr = squash(cell.header ?? "");
    if (!hdr) continue;
    const lab = labels.find((l) => squash(l) === hdr);
    if (!lab) continue;
    const c = baseCandidate(ctx, cell, [], cell.text, cell.rowText, `${cell.file}!${cell.sheet ?? ""}!${cell.a1}`, "normalized");
    c.score += 0.3;
    c.reasons.push(`column header "${cell.header}" equals field label; cell is ${JSON.stringify(cell.text.slice(0, 40))}`);
    if (/\.csv$/i.test(cell.file)) { c.score -= 0.3; c.penalties.push("CSV is a secondary source"); }
    scoreRow(c, cell.rowText, job);
    finalize(c);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function baseCandidate(ctx: Ctx, unit: Candidate["unit"], ranges: Array<[number, number]>, quote: string, window: string, locator: string, matchType?: Candidate["matchType"]): Candidate {
  const { job } = ctx;
  const mt = matchType ?? classifyMatch(quote, job);
  const base = mt === "exact" ? 0.55 : mt === "normalized" ? 0.5 : mt === "partial" ? 0.4 : 0.3;
  const c: Candidate = {
    id: `c${++ctx.seq.n}`,
    unit,
    ranges,
    quote,
    matchType: mt,
    window,
    score: base,
    reasons: [mt === "exact" ? "exact match" : mt === "normalized" ? `matches after normalization ("${quote.length > 40 ? quote.slice(0, 40) + "…" : quote}")` : mt === "partial" ? "value is part of a longer text" : "label match"],
    penalties: [],
    rowBound: false,
    file: unit.file,
    locator,
  };
  // Short / common literals are weak evidence on their own (penalty applied in finalize once label/row support is known).
  const s = String(job.value);
  if ((job.cls === "zero" || /^\d{1,2}$/.test(s) || /^[A-Za-z]{1,2}$/.test(s)) && mt !== "label-only") shortLiteral.add(c.id);
  return c;
}
const shortLiteral = new Set<string>();

function classifyMatch(quote: string, job: FieldJob): Candidate["matchType"] {
  const s = String(job.value);
  if (quote.toLowerCase() === s.toLowerCase()) return "exact";
  return "normalized";
}

function scoreKeywords(c: Candidate, window: string, job: FieldJob) {
  const w = window.toLowerCase();
  const hits = job.keywords.filter((k) => w.includes(k));
  if (hits.length) {
    c.score += Math.min(0.15, 0.05 * hits.length);
    c.reasons.push(`nearby text mentions ${hits.slice(0, 4).map((k) => `"${k}"`).join(", ")}`);
  }
}

/**
 * Row binding for list items. A candidate belongs to the right row when one of
 * the sibling values of that row (e.g. the coverage_name next to a
 * coverage_insurance) is in the same container: whole-value containment first,
 * then token overlap (names wrap and get re-ordered by OCR).
 */
const tokenize = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9'.-]*/g) ?? []).map((w) => w.replace(/[.-]+$/, ""));

/** Char range in `part` covering the words whose tokens are in `tokens` (first..last match). */
function tokenSpan(part: RowPart, tokens: Set<string>): [number, number] | null {
  const text = part.unit.text.slice(part.range[0], part.range[1]);
  let lo = -1, hi = -1;
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9'.-]*/g)) {
    const t = m[0].toLowerCase().replace(/[.-]+$/, "");
    if (!tokens.has(t)) continue;
    if (lo < 0) lo = m.index!;
    hi = m.index! + m[0].length;
  }
  return lo < 0 ? null : [part.range[0] + lo, part.range[0] + hi];
}

function scoreRow(c: Candidate, container: string, job: FieldJob, parts: RowPart[] = []) {
  if (!job.rowIdentifiers.length) return;
  const cs = squash(container);
  // A proper row key (policy / claim number) decides on its own when the row has one.
  if (job.primaryIdentifiers.length) {
    const hit = job.primaryIdentifiers.find((id) => cs.includes(squash(id)));
    if (hit) {
      c.rowBound = true;
      c.score += 0.35;
      c.reasons.push(`same row/record holds the row key "${hit}"`);
      const toks = new Set(tokenize(hit));
      for (const p of parts) { const span = tokenSpan(p, toks); if (span) { c.contextRange = { unit: p.unit, range: span }; break; } }
      return;
    }
    // Only penalize when the container looks like a record that *should* carry the key
    // (another identifier-like token is present); plain prose lines just get no bonus.
    const otherKey = /\b[A-Z]{2,}[-\s]?\d{4,}|\b\d{6,}\b|[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+/.test(container);
    if (otherKey) {
      c.score -= 0.3;
      c.penalties.push(`row key ${job.primaryIdentifiers.map((s) => `"${s}"`).join(" / ")} is not in this row/record`);
      return;
    }
  }
  const exact = job.rowIdentifiers.find((id) => squash(id).length >= 4 && cs.includes(squash(id)));
  if (exact) {
    c.rowBound = true;
    c.score += 0.3;
    c.reasons.push(`same row/block contains sibling value "${exact}"`);
    // Record where the sibling sits so the citation can carry it as context.
    const toks = new Set(tokenize(exact));
    for (const p of parts) {
      const span = tokenSpan(p, toks);
      if (span && squash(p.unit.text.slice(span[0], span[1])).includes(squash(exact))) { c.contextRange = { unit: p.unit, range: span }; break; }
    }
    return;
  }
  const words = new Set(tokenize(container));
  let best: { id: string; ratio: number; matched: string[] } | null = null;
  for (const id of job.rowIdentifiers) {
    // Dates and plain numbers are not names; their digit groups match everywhere.
    if (parseDate(id) || /^[\d\s$,./%-]+$/.test(id)) continue;
    const toks = tokenize(id).filter((t) => t.length >= 1);
    if (toks.length < 2) continue;
    const matched = toks.filter((t) => words.has(t));
    const ratio = matched.length / toks.length;
    // need most of the tokens, including at least one real word (not a single letter / number)
    if (ratio >= 0.6 && matched.some((t) => /^[a-z]{3,}/.test(t)) && (!best || ratio > best.ratio)) best = { id, ratio, matched };
  }
  if (best) {
    c.rowBound = true;
    c.score += 0.2 + 0.1 * best.ratio;
    c.reasons.push(`row block contains ${best.matched.length}/${tokenize(best.id).length} words of sibling value "${best.id}"`);
    const toks = new Set(best.matched);
    let span: { part: RowPart; span: [number, number] } | null = null;
    for (const p of parts) { const s = tokenSpan(p, toks); if (s) { span = { part: p, span: s }; break; } }
    if (span) c.contextRange = { unit: span.part.unit, range: span.span };
  } else {
    c.score -= 0.15;
    c.penalties.push("no sibling identifier of this list row nearby");
  }
}

function scoreHints(c: Candidate, job: FieldJob, page: number, cy: number, cx: number) {
  const h = job.hints;
  if (h.page !== undefined) {
    if (page === h.page) { c.score += 0.1; c.reasons.push(`on page ${page} as the definition says`); }
    else { c.score -= 0.3; c.penalties.push(`definition says page ${h.page}; this is page ${page}`); }
  }
  if (h.region) {
    const top = cy < 0.45, bottom = cy > 0.55, right = cx > 0.5, left = cx <= 0.5;
    const ok =
      (h.region === "top" && top) || (h.region === "bottom" && bottom) ||
      (h.region === "top-right" && top && right) || (h.region === "top-left" && top && left) ||
      (h.region === "bottom-right" && bottom && right) || (h.region === "bottom-left" && bottom && left);
    if (ok) { c.score += 0.1; c.reasons.push(`position matches "${h.region}" hint`); }
    else { c.score -= 0.15; c.penalties.push(`position does not match "${h.region}" hint`); }
  }
}

function finalize(c: Candidate) {
  if (shortLiteral.delete(c.id) && !c.labelRange && !c.rowBound) {
    c.score -= 0.15;
    c.penalties.push("short literal; needs label or row support");
  }
  c.score = Math.max(0, Math.min(1, Math.round(c.score * 1000) / 1000));
}
