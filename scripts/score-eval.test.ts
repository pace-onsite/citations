/**
 * Unit tests for scripts/score-eval.ts. Everything here uses small synthetic in-memory
 * fixtures: no test-cases/ files, no LLM, no network.
 *
 *   npx -y tsx --test scripts/score-eval.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifySchemaError,
  compareWithBaseline,
  isPlausibleAnchor,
  matchJsonPointer,
  matchPageRegion,
  matchSheetRange,
  matchTextSpan,
  maximumBipartiteMatching,
  parseArgs,
  quoteConsistent,
  rectUnionStats,
  scoreItem,
  summarize,
  unionArea,
  type EvalItem,
  type Evidence,
  type ItemResult,
  type ScoreReport,
} from "./score-eval.ts";
import type { Anchor, JsonPointerAnchor, PageRegionAnchor, Rect, SheetRangeAnchor, TextSpanAnchor } from "../app/src/types.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const box = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });
const region = (boxes: Rect[], extra: Partial<PageRegionAnchor> = {}): PageRegionAnchor =>
  ({ kind: "page-region", file: "doc.pdf", page: 1, boxes, ...extra });
const span = (start: number, end: number, extra: Partial<TextSpanAnchor> = {}): TextSpanAnchor =>
  ({ kind: "text-span", file: "doc.txt", start, end, ...extra });
const ptr = (pointer: string, extra: Partial<JsonPointerAnchor> = {}): JsonPointerAnchor =>
  ({ kind: "json-pointer", file: "doc.json", pointer, ...extra });
const cell = (range: string, extra: Partial<SheetRangeAnchor> = {}): SheetRangeAnchor =>
  ({ kind: "sheet-range", file: "book.xlsx", sheet: "Sheet1", range, ...extra });

const evidence = (label: string, ...anchors: Anchor[]): Evidence => ({ label, anchors });

const item = (over: Partial<EvalItem> = {}): EvalItem => ({
  id: "t.item",
  caseId: "t-case",
  pointer: "/field",
  value: "x",
  categories: ["file:pdf"],
  expect: "cite",
  acceptable: [evidence("gt A", ptr("/a"))],
  secondary: [],
  forbidden: [],
  ...over,
});

let nextId = 0;
const citation = (anchors: Anchor[], over: Record<string, unknown> = {}) =>
  ({ id: `c${++nextId}`, status: "proposed", source: "auto", anchors, ...over });

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

describe("rectangle unions", () => {
  test("overlapping rectangles are not double counted", () => {
    const a = box(0, 0, 0.5, 0.5);
    const b = box(0.25, 0.25, 0.5, 0.5);
    assert.ok(Math.abs(unionArea([a, b]) - (0.25 + 0.25 - 0.0625)) < 1e-12);
    assert.ok(Math.abs(unionArea([a, a, a]) - 0.25) < 1e-12);
  });

  test("union IoU between two multi-box unions", () => {
    // Two GT boxes on one line (first + last name) vs one produced box spanning both plus the gap.
    const gt = [box(0.10, 0.10, 0.10, 0.02), box(0.22, 0.10, 0.10, 0.02)];
    const produced = [box(0.10, 0.10, 0.22, 0.02)];
    const s = rectUnionStats(produced, gt);
    assert.ok(Math.abs(s.areaB - 0.004) < 1e-12);
    assert.ok(Math.abs(s.areaA - 0.0044) < 1e-12);
    assert.ok(Math.abs(s.intersection - 0.004) < 1e-12);
    assert.ok(Math.abs(s.union - 0.0044) < 1e-12);
    const m = matchPageRegion(region(produced), region(gt));
    assert.ok(m, "spanning box should match (IoU 0.91)");
    assert.ok(Math.abs(m.score - 0.004 / 0.0044) < 1e-9);
  });

  test("a produced box that overlaps two GT boxes counts the overlap once", () => {
    const gt = [box(0, 0, 0.4, 0.1), box(0.2, 0, 0.4, 0.1)]; // GT boxes themselves overlap: union = 0.06
    const produced = [box(0, 0, 0.6, 0.1)];
    const s = rectUnionStats(produced, gt);
    assert.ok(Math.abs(s.areaB - 0.06) < 1e-12);
    assert.ok(Math.abs(s.intersection - 0.06) < 1e-12);
    assert.equal(matchPageRegion(region(produced), region(gt))?.score, 1);
  });
});

describe("page-region matching", () => {
  const gt = region([box(0.5, 0.5, 0.10, 0.02)]); // area 0.002

  test("IoU ≥ 0.5 matches, below does not", () => {
    assert.ok(matchPageRegion(region([box(0.5, 0.5, 0.10, 0.04)]), gt)); // IoU exactly 0.5
    assert.equal(matchPageRegion(region([box(0.55, 0.5, 0.10, 0.02)]), gt), null); // IoU 1/3
  });

  test("coverage ≥ 80 % with area ≤ 3× matches even when IoU < 0.5", () => {
    const wide = region([box(0.45, 0.495, 0.2, 0.03)]); // area 0.006 = 3×, fully covers GT, IoU 0.33
    const m = matchPageRegion(wide, gt);
    assert.ok(m);
    assert.match(m.detail, /coverage fallback/);
  });

  test("coverage fallback is blocked when area > 3× (whole-page box) or coverage < 80 %", () => {
    assert.equal(matchPageRegion(region([box(0, 0, 1, 1)]), gt), null);
    assert.equal(matchPageRegion(region([box(0.45, 0.495, 0.2001, 0.03)]), gt), null); // just over 3×
    // covers 70 % of GT, area 2.1× → IoU 0.29, coverage 0.7 → no match
    assert.equal(matchPageRegion(region([box(0.5, 0.5, 0.07, 0.06)]), gt), null);
  });

  test("different page or file never matches", () => {
    assert.equal(matchPageRegion(region(gt.boxes, { page: 2 }), gt), null);
    assert.equal(matchPageRegion(region(gt.boxes, { file: "other.pdf" }), gt), null);
  });
});

// ---------------------------------------------------------------------------
// text-span / json-pointer / sheet-range
// ---------------------------------------------------------------------------

describe("text-span matching", () => {
  const gt = span(100, 110); // length 10

  test("exactly 50 % overlap matches; one less does not", () => {
    assert.ok(matchTextSpan(span(105, 115), gt));
    assert.equal(matchTextSpan(span(106, 116), gt), null);
    assert.ok(matchTextSpan(span(95, 105), gt));
    assert.equal(matchTextSpan(span(94, 104), gt), null);
  });

  test("produced length exactly 2× matches; 2× + 1 does not", () => {
    assert.ok(matchTextSpan(span(95, 115), gt));
    assert.equal(matchTextSpan(span(95, 116), gt), null);
  });

  test("pointer must be identical, with both-absent counting as equal", () => {
    assert.ok(matchTextSpan(span(100, 110), gt));
    assert.equal(matchTextSpan(span(100, 110, { pointer: "/bodyPlain" }), gt), null);
    const gtPtr = span(100, 110, { file: "mail.json", pointer: "/bodyPlain" });
    assert.ok(matchTextSpan(span(100, 110, { file: "mail.json", pointer: "/bodyPlain" }), gtPtr));
    assert.equal(matchTextSpan(span(100, 110, { file: "mail.json", pointer: "/bodyHtml" }), gtPtr), null);
    assert.equal(matchTextSpan(span(100, 110, { file: "other.json", pointer: "/bodyPlain" }), gtPtr), null);
  });
});

describe("json-pointer matching", () => {
  const gt = ptr("/data/insured/name");
  const ctx = { jsonStringLength: (file: string, pointer: string) => (file === "doc.json" && pointer === "/data/insured/name" ? 13 : undefined) };

  test("identical pointer on the same file matches; anything else does not", () => {
    assert.equal(matchJsonPointer(ptr("/data/insured/name"), gt)?.score, 1);
    assert.equal(matchJsonPointer(ptr("/data/insured/name/"), gt), null);
    assert.equal(matchJsonPointer(ptr("/data/insured/name", { file: "other.json" }), gt), null);
    assert.equal(matchJsonPointer(ptr("/data/insured"), gt), null);
  });

  test("a text-span on the same pointer matches only when it covers the whole string", () => {
    const whole = span(0, 13, { file: "doc.json", pointer: "/data/insured/name" });
    assert.ok(matchJsonPointer(whole, gt, ctx));
    assert.equal(matchJsonPointer(span(0, 12, { file: "doc.json", pointer: "/data/insured/name" }), gt, ctx), null);
    assert.equal(matchJsonPointer(span(1, 13, { file: "doc.json", pointer: "/data/insured/name" }), gt, ctx), null);
    assert.equal(matchJsonPointer(whole, gt, {}), null, "without a length lookup the span cannot be confirmed");
    assert.equal(matchJsonPointer(span(0, 13, { file: "doc.json", pointer: "/other" }), gt, ctx), null);
  });
});

describe("sheet-range matching", () => {
  const gt = cell("R6");

  test("GT cell inside a produced range of ≤ 4 cells matches", () => {
    assert.equal(matchSheetRange(cell("R6"), gt)?.score, 1);
    assert.equal(matchSheetRange(cell("Q6:R7"), gt)?.score, 0.25);
    assert.ok(matchSheetRange(cell("R5:R8"), gt)); // 4 cells, vertical
    assert.ok(matchSheetRange(cell("R8:R5"), gt), "reversed corners are normalised");
  });

  test("five or more cells never match, even when they contain the GT cell", () => {
    assert.equal(matchSheetRange(cell("N6:R6"), gt), null);
    assert.equal(matchSheetRange(cell("R1:R5"), gt), null, "does not contain R6 either");
  });

  test("sheet and file must agree; csv anchors have no sheet", () => {
    assert.equal(matchSheetRange(cell("R6", { sheet: "Other" }), gt), null);
    assert.equal(matchSheetRange(cell("R6", { file: "other.xlsx" }), gt), null);
    const csvGt = cell("C2", { file: "export.csv", sheet: undefined });
    assert.ok(matchSheetRange(cell("C2", { file: "export.csv", sheet: undefined }), csvGt));
    assert.equal(matchSheetRange(cell("C2", { file: "export.csv", sheet: "Sheet1" }), csvGt), null);
  });
});

// ---------------------------------------------------------------------------
// item scoring
// ---------------------------------------------------------------------------

describe("citation list handling", () => {
  test("missing pointer / missing file is an empty list", () => {
    const empty = scoreItem(item({ expect: "empty", acceptable: [] }), undefined);
    assert.equal(empty.pass, true);
    assert.equal(empty.citations.total, 0);
    const cite = scoreItem(item(), undefined);
    assert.equal(cite.pass, false);
    assert.deepEqual(cite.failureReasons, ["missing-acceptable"]);
  });

  test("a non-array citation value is scored as empty and flagged as schema-invalid", () => {
    const r = scoreItem(item({ expect: "empty", acceptable: [] }), { not: "an array" });
    assert.equal(r.pass, false);
    assert.deepEqual(r.failureReasons, ["schema-invalid"]);
  });

  test("rejected citations are ignored for pass/fail and counted", () => {
    const forbidden = [evidence("wrong column", cell("N6"))];
    const it = item({ acceptable: [evidence("right cell", cell("R6"))], forbidden });
    const r = scoreItem(it, [citation([cell("N6")], { status: "rejected" }), citation([cell("R6")])]);
    assert.equal(r.pass, true);
    assert.equal(r.citations.rejected, 1);
    assert.equal(r.citations.scored, 1);
    assert.equal(r.forbiddenMatches.length, 0);
  });

  test("malformed anchors are schema problems, not crashes", () => {
    const r = scoreItem(item(), [citation([{ kind: "page-region", file: "doc.pdf", page: 1 } as unknown as Anchor, ptr("/a")])]);
    assert.equal(r.pass, false);
    assert.deepEqual(r.failureReasons, ["schema-invalid"]);
    assert.equal(r.anchors[0]!.classification, "invalid");
    assert.equal(r.matchedAcceptable.length, 1, "the well-formed anchor is still matched");
  });
});

describe("pass rule: cite", () => {
  test("passes when an acceptable entry is matched by a value anchor", () => {
    const r = scoreItem(item(), [citation([ptr("/a")])]);
    assert.equal(r.pass, true);
    assert.equal(r.distinctAcceptableMatches, 1);
  });

  test("a label-role anchor on acceptable evidence is not a match for cite", () => {
    const r = scoreItem(item(), [citation([ptr("/a", { role: "label" })])]);
    assert.deepEqual(r.failureReasons, ["missing-acceptable"]);
  });

  test("an unmatched value anchor fails even when acceptable evidence is matched", () => {
    const r = scoreItem(item(), [citation([ptr("/a"), ptr("/somewhere-else")])]);
    assert.deepEqual(r.failureReasons, ["unmatched-value-anchor"]);
    assert.equal(r.unmatchedValueAnchors.length, 1);
    assert.equal(r.unmatchedValueAnchors[0]!.location, "doc.json/somewhere-else");
  });

  test("label/context anchors are never false positives", () => {
    const r = scoreItem(item(), [citation([ptr("/a"), ptr("/anything", { role: "context" }), ptr("/label", { role: "label" })])]);
    assert.equal(r.pass, true);
    assert.equal(r.citations.labelContextAnchors, 2);
  });

  test("secondary-only matches are neither a pass nor a false positive", () => {
    const r = scoreItem(item({ secondary: [evidence("csv restatement", cell("C2", { file: "x.csv", sheet: undefined }))] }), [
      citation([cell("C2", { file: "x.csv", sheet: undefined })]),
    ]);
    assert.deepEqual(r.failureReasons, ["missing-acceptable"]);
    assert.equal(r.matchedSecondary.length, 1);
    assert.equal(r.unmatchedValueAnchors.length, 0);
  });

  test("minAcceptableMatches counts distinct entries, one per citation", () => {
    const it = item({ minAcceptableMatches: 2, acceptable: [evidence("A", ptr("/a")), evidence("B", ptr("/b"))] });
    // one citation whose two anchors hit the same entry twice → still 1
    let r = scoreItem(it, [citation([ptr("/a"), ptr("/a")])]);
    assert.deepEqual(r.failureReasons, ["insufficient-multi-citation-recall"]);
    assert.equal(r.distinctAcceptableMatches, 1);
    // two citations on the same entry → still 1
    r = scoreItem(it, [citation([ptr("/a")]), citation([ptr("/a")])]);
    assert.equal(r.distinctAcceptableMatches, 1);
    assert.equal(r.pass, false);
    // one citation spanning both entries counts once; a second citation is needed
    r = scoreItem(it, [citation([ptr("/a"), ptr("/b")])]);
    assert.equal(r.distinctAcceptableMatches, 1);
    r = scoreItem(it, [citation([ptr("/a"), ptr("/b")]), citation([ptr("/b")])]);
    assert.equal(r.distinctAcceptableMatches, 2);
    assert.equal(r.pass, true);
  });

  test("an evidence entry with label + value anchors requires the citation to cover the label too", () => {
    const it = item({ acceptable: [evidence("row", cell("R5", { role: "label" }), cell("R6"))] });
    const valueOnly = scoreItem(it, [citation([cell("R6")])]);
    assert.deepEqual(valueOnly.failureReasons, ["missing-acceptable", "unmatched-value-anchor"]);
    assert.equal(scoreItem(it, [citation([cell("R6"), cell("R5", { role: "label" })])]).pass, true);
    assert.equal(scoreItem(it, [citation([cell("R6"), cell("R5", { role: "context" })])]).pass, true);
    // Citing the label cell with role value covers the context, but that anchor is itself an unmatched value.
    assert.ok(scoreItem(it, [citation([cell("R6"), cell("R5")])]).failureReasons.includes("unmatched-value-anchor"));
    const labelOnly = scoreItem(it, [citation([cell("R5", { role: "label" })])]);
    assert.deepEqual(labelOnly.failureReasons, ["missing-acceptable"]);
  });

  test("required context must be matched by a role=context anchor in addition to the value", () => {
    const it = item({ requiredContext: [evidence("section heading", ptr("/heading", { role: "context" }))] });
    assert.deepEqual(scoreItem(it, [citation([ptr("/a")])]).failureReasons, ["missing-required-context"]);
    assert.equal(scoreItem(it, [citation([ptr("/a"), ptr("/heading", { role: "context" })])]).pass, true);
    assert.deepEqual(
      scoreItem(it, [citation([ptr("/a"), ptr("/heading", { role: "label" })])]).failureReasons,
      ["missing-required-context"],
      "a label-role anchor does not satisfy an explicit context requirement",
    );
  });
});

describe("pass rule: context-only", () => {
  const it = item({ expect: "context-only", acceptable: [evidence("null premium", ptr("/lines/56/premium", { role: "context" }))], forbidden: [evidence("other premium", ptr("/lines/3/premium"))] });

  test("empty list passes", () => assert.equal(scoreItem(it, []).pass, true));
  test("a value anchor matching a context-only entry passes (any role)", () => assert.equal(scoreItem(it, [citation([ptr("/lines/56/premium")])]).pass, true));
  test("a context anchor matching passes", () => assert.equal(scoreItem(it, [citation([ptr("/lines/56/premium", { role: "context" })])]).pass, true));
  test("an unmatched value anchor fails", () => assert.deepEqual(scoreItem(it, [citation([ptr("/lines/9/premium")])]).failureReasons, ["unmatched-value-anchor"]));
  test("an unmatched context anchor is tolerated", () => assert.equal(scoreItem(it, [citation([ptr("/lines/9/premium", { role: "context" })])]).pass, true));
  test("a forbidden match fails", () => assert.deepEqual(scoreItem(it, [citation([ptr("/lines/3/premium")])]).failureReasons, ["forbidden-match"]));
});

describe("pass rule: empty", () => {
  const it = item({ expect: "empty", acceptable: [evidence("parent flag", ptr("/umbrella/requested", { role: "context" }))], forbidden: [evidence("tempting neighbour", ptr("/yearBuilt"))] });

  test("no citations passes", () => assert.equal(scoreItem(it, []).pass, true));
  test("label/context anchors matching acceptable are tolerated", () => {
    assert.equal(scoreItem(it, [citation([ptr("/umbrella/requested", { role: "context" })])]).pass, true);
  });
  test("any value-role anchor fails, even one on acceptable context evidence", () => {
    const r = scoreItem(it, [citation([ptr("/umbrella/requested")])]);
    assert.deepEqual(r.failureReasons, ["unexpected-value-for-empty"]);
  });
  test("role omitted means value", () => {
    assert.deepEqual(scoreItem(it, [citation([ptr("/whatever")])]).failureReasons, ["unexpected-value-for-empty"]);
  });
  test("a forbidden value anchor reports both codes", () => {
    assert.deepEqual(scoreItem(it, [citation([ptr("/yearBuilt")])]).failureReasons, ["forbidden-match", "unexpected-value-for-empty"]);
  });
});

describe("forbidden evidence", () => {
  test("a forbidden match overrides an acceptable match on the same anchor", () => {
    // A 2-cell range that contains the right cell (R6) and a forbidden neighbour (S6).
    const it = item({ acceptable: [evidence("Pd Medical", cell("R6"))], forbidden: [evidence("wrong column", cell("S6"))] });
    const r = scoreItem(it, [citation([cell("R6:S6")])]);
    assert.equal(r.pass, false);
    assert.ok(r.failureReasons.includes("forbidden-match"));
    assert.equal(r.anchors[0]!.classification, "forbidden");
    assert.equal(r.matchedAcceptable.length, 1, "the acceptable match is still recorded for the report");
    assert.equal(r.forbiddenMatches[0]!.matchedBy[0]!.citationId, r.anchors[0]!.citationId);
  });

  test("forbidden matches by label/context anchors are not false positives", () => {
    const it = item({ forbidden: [evidence("wrong column", cell("S6"))] });
    const r = scoreItem(it, [citation([ptr("/a"), cell("S6", { role: "context" })])]);
    assert.equal(r.pass, true);
    assert.equal(r.forbiddenMatches.length, 0);
  });
});

describe("validation plumbing", () => {
  test("schema errors passed in fail the item with schema-invalid", () => {
    const r = scoreItem(item({ expect: "empty", acceptable: [] }), [], { schemaErrors: ["/schemaVersion must be equal to constant"] });
    assert.deepEqual(r.failureReasons, ["schema-invalid"]);
  });

  test("schema errors are localised to the citations pointer they belong to", () => {
    assert.deepEqual(classifySchemaError({ instancePath: "/citations/~1Loss Runs~15~1Premium/0/anchors/1/file", keyword: "pattern", message: "must match pattern" }).affects, { pointer: "/Loss Runs/5/Premium" });
    assert.equal(classifySchemaError({ instancePath: "/schemaVersion", keyword: "const", message: "must be equal to constant" }).affects, "all");
    assert.equal(classifySchemaError({ instancePath: "", keyword: "required", message: "must have required property 'caseId'" }).affects, "all");
    assert.equal(classifySchemaError({ instancePath: "/citations", keyword: "propertyNames", message: "property name must be valid", params: { propertyName: "bad" } }).affects, null);
  });

  test("isPlausibleAnchor rejects shapes the resolver cannot handle", () => {
    assert.equal(isPlausibleAnchor(ptr("/a")), true);
    assert.equal(isPlausibleAnchor({ kind: "json-pointer", file: "doc.pdf", pointer: "/a" }), false);
    assert.equal(isPlausibleAnchor({ kind: "text-span", file: "doc.txt", start: 5, end: 5 }), false);
    assert.equal(isPlausibleAnchor({ kind: "sheet-range", file: "book.xlsx", range: "6R" }), false);
    assert.equal(isPlausibleAnchor({ kind: "page-region", file: "doc.pdf", page: 1, boxes: [] }), false);
    assert.equal(isPlausibleAnchor({ kind: "page-region", file: "doc.pdf", page: 1, boxes: [box(0, 0, 0.1, 0.1)], role: "primary" }), false);
    assert.equal(isPlausibleAnchor({ kind: "ocr-chunk", file: "doc.pdf" }), false);
  });

  test("quoteConsistent tolerates text-layer clipping, word order and number formatting", () => {
    assert.equal(quoteConsistent("12/20/2025", "12/20/2025"), true);
    assert.equal(quoteConsistent("s 12/20/202", "12/20/2025"), false, "pdf.js clipping alone is not enough — OCR text is consulted");
    assert.equal(quoteConsistent("myn Bana", "Amyn Bana"), true);
    assert.equal(quoteConsistent("Owner Occupied", "Occupied Owner"), true);
    assert.equal(quoteConsistent("$847,000.00 ", "847000"), true);
    assert.equal(quoteConsistent("$0.00 ", "0"), true);
    assert.equal(quoteConsistent("Barn", "Detached Garage"), false);
    assert.equal(quoteConsistent("", "0"), false);
  });
});

describe("maximum bipartite matching", () => {
  test("finds an augmenting path a greedy assignment would miss", () => {
    // L0 → {R0, R1}, L1 → {R0}. Greedy (L0 takes R0) would leave L1 unmatched.
    const edges = [[true, true], [true, false]];
    assert.equal(maximumBipartiteMatching(2, 2, (l, r) => edges[l]![r]!), 2);
    assert.equal(maximumBipartiteMatching(3, 1, () => true), 1);
    assert.equal(maximumBipartiteMatching(0, 3, () => true), 0);
  });
});

// ---------------------------------------------------------------------------
// aggregation + baseline
// ---------------------------------------------------------------------------

const fakeReport = (results: ItemResult[]): ScoreReport => ({
  schemaVersion: "citation-eval-report/v1",
  scoredAt: "2026-01-01T00:00:00.000Z",
  run: { directory: "/run", files: [] },
  evalSet: { path: "eval-set.json", schemaVersion: "citation-eval/v1", totalItems: results.length },
  filters: { category: [], case: [] },
  summary: summarize(results, []),
  items: results,
});

describe("summary metrics", () => {
  test("slices, precision, abstention and multi-citation recall", () => {
    const results = [
      scoreItem(item({ id: "cite-ok", categories: ["file:pdf", "multi-citation"], minAcceptableMatches: 2, acceptable: [evidence("A", ptr("/a")), evidence("B", ptr("/b"))] }), [citation([ptr("/a")]), citation([ptr("/b")])]),
      scoreItem(item({ id: "cite-half", categories: ["file:json", "multi-citation", "many-occurrences"], acceptable: [evidence("A", ptr("/a")), evidence("B", ptr("/b"))] }), [citation([ptr("/a")]), citation([ptr("/a")]), citation([ptr("/a")])]),
      scoreItem(item({ id: "empty-ok", expect: "empty", categories: ["file:json", "zero:default"], acceptable: [] }), []),
      scoreItem(item({ id: "empty-bad", expect: "empty", categories: ["file:json", "zero:default"], acceptable: [], forbidden: [evidence("F", ptr("/f"))] }), [citation([ptr("/f")])]),
    ];
    const s = summarize(results, []);
    assert.equal(s.items, 4);
    assert.equal(s.passed, 3);
    assert.equal(s.byExpect.cite!.passed, 2);
    assert.equal(s.byExpect.empty!.passed, 1);
    assert.equal(s.byCategory["zero:default"]!.passRate, 0.5);
    assert.deepEqual(Object.keys(s.byFileType), ["file:json", "file:pdf"]);
    assert.equal(s.anchors.value, 6);
    assert.equal(s.anchors.acceptable, 5);
    assert.equal(s.anchors.forbidden, 1);
    assert.equal(s.anchors.precision, 5 / 6);
    assert.equal(s.forbidden.itemsWithHit, 1);
    assert.equal(s.emptyFields.abstentionRate, 0.5);
    assert.equal(s.multiCitation.acceptableEntries, 4);
    assert.equal(s.multiCitation.matchedEntries, 3);
    assert.equal(s.multiCitation.recall, 0.75);
    assert.equal(s.manyOccurrences.items, 1);
    assert.equal(s.manyOccurrences.citations, 3);
    assert.equal(s.manyOccurrences.perItem[0]!.distinctAcceptableMatches, 1);
    assert.deepEqual(s.failureReasons, { "forbidden-match": 1, "unexpected-value-for-empty": 1 });
  });
});

describe("baseline comparison", () => {
  const gt = item({ id: "a", acceptable: [evidence("A", ptr("/a"))], forbidden: [evidence("F", ptr("/f"))] });
  const other = item({ id: "b", expect: "empty", acceptable: [], categories: ["file:json"] });
  const pass = (it: EvalItem, cits: unknown[]) => scoreItem(it, cits);

  test("a newly failing item is a regression", () => {
    const base = fakeReport([pass(gt, [citation([ptr("/a")])]), pass(other, [])]);
    const cur = fakeReport([pass(gt, []), pass(other, [])]);
    const c = compareWithBaseline(base, cur, "base.json");
    assert.equal(c.regression, true);
    assert.deepEqual(c.newlyFailing, [{ id: "a", failureReasons: ["missing-acceptable"] }]);
    assert.equal(c.overall.delta, -0.5);
    assert.equal(c.byExpect.cite!.delta, -1);
    assert.equal(c.byCategory["file:pdf"]!.delta, -1);
  });

  test("a newly introduced forbidden match is a regression even if the item already failed", () => {
    const base = fakeReport([pass(gt, []), pass(other, [])]);
    const cur = fakeReport([pass(gt, [citation([ptr("/f")])]), pass(other, [])]);
    const c = compareWithBaseline(base, cur, "base.json");
    assert.equal(c.newlyFailing.length, 0);
    assert.deepEqual(c.newForbiddenMatches, [{ id: "a", label: "F" }]);
    assert.equal(c.regression, true);
  });

  test("improvements are not regressions", () => {
    const base = fakeReport([pass(gt, [citation([ptr("/f")])]), pass(other, [])]);
    const cur = fakeReport([pass(gt, [citation([ptr("/a")])]), pass(other, [])]);
    const c = compareWithBaseline(base, cur, "base.json");
    assert.equal(c.regression, false);
    assert.deepEqual(c.newlyPassing, ["a"]);
    assert.equal(c.overall.delta, 0.5);
  });

  test("only common items are compared", () => {
    const base = fakeReport([pass(gt, [citation([ptr("/a")])])]);
    const cur = fakeReport([pass(gt, [citation([ptr("/a")])]), pass(other, [citation([ptr("/x")])])]);
    const c = compareWithBaseline(base, cur, "base.json");
    assert.equal(c.comparedItems, 1);
    assert.deepEqual(c.onlyInCurrent, ["b"]);
    assert.equal(c.regression, false);
    assert.equal(c.overall.delta, 0);
  });
});

describe("CLI argument parsing", () => {
  test("parses all flags", () => {
    const o = parseArgs(["--run", "out", "--category", "zero:default", "--category", "list-item", "--case", "19-x", "--baseline", "b.json", "--json", "--output", "r.json"]);
    assert.deepEqual(o, { run: "out", category: ["zero:default", "list-item"], case: ["19-x"], baseline: "b.json", json: true, output: "r.json", help: false });
  });
  test("rejects missing --run, unknown flags and dangling values", () => {
    assert.throws(() => parseArgs([]), /--run/);
    assert.throws(() => parseArgs(["--run", "out", "--bogus"]), /unknown argument/);
    assert.throws(() => parseArgs(["--run"]), /requires a value/);
    assert.throws(() => parseArgs(["--run", "out", "--category", "--json"]), /requires a value/);
  });
});
