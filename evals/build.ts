import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const appRequire = createRequire(path.join(root, "app", "package.json"));
const XLSX = appRequire("xlsx");
const Ajv2020 = appRequire("ajv/dist/2020").default;
const addFormats = appRequire("ajv-formats").default;

type Role = "value" | "label" | "context";
type Rect = { left: number; top: number; width: number; height: number };
type Range2 = [number, number];

type OcrLocator = {
  ocr: string;
  page: number;
  find: string;
  select?: string;
  occurrence?: number;
  within?: { top?: Range2; left?: Range2 };
  role?: Role;
};
type TextLocator = {
  text: string;
  pointer?: string;
  find: string;
  select?: string;
  occurrence?: number;
  fromOffset?: number;
  role?: Role;
};
type JsonLocator = { json: string; pointer: string; role?: Role };
type JsonValueLocator = { jsonValue: string; equals: string | number; pointerPrefix?: string; role?: Role };
type JsonTextLocator = { jsonText: string; find: string; select?: string; pointerPrefix?: string; role?: Role };
type SheetLocator = { sheet: string; range: string; sheetName?: string; expectEach?: string; expect?: string[]; role?: Role };
type RegionLocator = { region: string; page: number; box: Rect; label: string; role?: Role };
type Locator = OcrLocator | TextLocator | JsonLocator | JsonValueLocator | JsonTextLocator | SheetLocator | RegionLocator;

type GoldSpec = { id?: string; note?: string; match?: "overlap" | "within"; anchors: Locator[] };
type TrapSpec = { why: string; anchor: Locator };
type ItemSpec = {
  id: string;
  caseId: string;
  pointer?: string;
  probe?: { field: string; value: string; description: string };
  edgeCases: string[];
  expected: "cite" | "empty" | "label-only" | "empty-or-cite";
  fullRecallCitations?: number;
  goldConfidence: "high" | "medium";
  rationale: string;
  gold?: GoldSpec[];
  traps?: TrapSpec[];
  conflicts?: TrapSpec[];
};
type Spec = { description: string; edgeCaseTags: Record<string, string>; scoring: unknown; items: ItemSpec[] };

type Anchor = Record<string, unknown> & { kind: string; file: string };

const caseDir = (caseId: string) => path.join(root, "test-cases", caseId);
const filePath = (caseId: string, file: string) => path.join(caseDir(caseId), "files", file);
const round = (n: number) => Math.round(n * 1e5) / 1e5;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const cache = new Map<string, unknown>();
const readJson = (p: string): any => {
  if (!cache.has(p)) cache.set(p, JSON.parse(fs.readFileSync(p, "utf8")));
  return cache.get(p);
};

const unescapeToken = (t: string) => t.replace(/~1/g, "/").replace(/~0/g, "~");
const escapeToken = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");
const resolvePointer = (doc: any, pointer: string): { found: boolean; value: any } => {
  if (pointer === "") return { found: true, value: doc };
  let cur = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = unescapeToken(raw);
    if (cur === null || typeof cur !== "object" || !(key in cur)) return { found: false, value: undefined };
    cur = cur[key];
  }
  return { found: true, value: cur };
};
function* leaves(v: any, p = ""): Generator<[string, any]> {
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) yield* leaves(x, `${p}/${escapeToken(k)}`);
  } else yield [p, v];
}

const pdfFor = (caseId: string, ocrFile: string) => {
  const stem = ocrFile.replace(/-ocr\.json$/, "");
  for (const candidate of [`${stem}.pdf`, `${stem}-rendered.pdf`]) {
    if (fs.existsSync(filePath(caseId, candidate))) return candidate;
  }
  throw new Error(`No PDF counterpart for ${ocrFile}`);
};

const unionRect = (rects: Rect[]): Rect => {
  const l = Math.min(...rects.map((r) => r.left));
  const t = Math.min(...rects.map((r) => r.top));
  const r = Math.max(...rects.map((x) => x.left + x.width));
  const b = Math.max(...rects.map((x) => x.top + x.height));
  return { left: round(clamp01(l)), top: round(clamp01(t)), width: round(clamp01(r) - clamp01(l)), height: round(clamp01(b) - clamp01(t)) };
};

type Resolved = { anchor: Anchor; quote: string };

function resolveOcr(caseId: string, loc: OcrLocator): Resolved {
  const ocr = readJson(filePath(caseId, loc.ocr)).ocr;
  const words: any[] = ocr.words;
  const lines = (ocr.lines as any[])
    .map((l, i) => ({ ...l, i }))
    .filter((l) => l.bbox.page === loc.page && norm(l.text).includes(norm(loc.find)))
    .filter((l) => {
      const w = loc.within;
      if (!w) return true;
      if (w.top && (l.bbox.top < w.top[0] || l.bbox.top > w.top[1])) return false;
      if (w.left && (l.bbox.left < w.left[0] || l.bbox.left > w.left[1])) return false;
      return true;
    })
    .sort((a, b) => a.bbox.top - b.bbox.top || a.bbox.left - b.bbox.left);
  const line = lines[loc.occurrence ?? 0];
  if (!line) throw new Error(`OCR line not found: ${loc.ocr} p${loc.page} "${loc.find}"`);

  const lb = line.bbox;
  const inLine = words
    .map((w, i) => ({ ...w, i }))
    .filter((w) => {
      const b = w.bbox;
      const cy = b.top + b.height / 2;
      return b.page === loc.page && cy >= lb.top - 0.002 && cy <= lb.top + lb.height + 0.002 && b.left >= lb.left - 0.002 && b.left + b.width <= lb.left + lb.width + 0.002;
    })
    .sort((a, b) => a.bbox.left - b.bbox.left);

  const target = (loc.select ?? loc.find).split(/\s+/).map(norm);
  const tokens = inLine.map((w) => norm(w.text));
  let start = -1;
  for (let s = 0; s + target.length <= tokens.length && start < 0; s++) {
    if (target.every((t, k) => tokens[s + k] === t)) start = s;
  }
  if (start < 0) {
    throw new Error(`Words "${loc.select ?? loc.find}" not found in line "${line.text}" (${loc.ocr} p${loc.page}); tokens=${JSON.stringify(tokens)}`);
  }
  const picked = inLine.slice(start, start + target.length);
  return {
    anchor: {
      kind: "page-region",
      file: pdfFor(caseId, loc.ocr),
      page: loc.page,
      boxes: [unionRect(picked.map((w) => w.bbox))],
      ...(loc.role && loc.role !== "value" ? { role: loc.role } : {}),
      provenance: { ocrFile: loc.ocr, wordIndexes: picked.map((w) => w.i) },
    },
    quote: picked.map((w) => w.text).join(" "),
  };
}

function resolveText(caseId: string, loc: TextLocator): Resolved {
  const p = filePath(caseId, loc.text);
  let body: string;
  if (loc.pointer !== undefined) {
    const r = resolvePointer(readJson(p), loc.pointer);
    if (!r.found || typeof r.value !== "string") throw new Error(`${loc.text}${loc.pointer} is not a string`);
    body = r.value;
  } else {
    body = fs.readFileSync(p, "utf8");
  }
  let at = loc.fromOffset ?? 0;
  let ctx = -1;
  for (let n = 0; n <= (loc.occurrence ?? 0); n++) {
    ctx = body.indexOf(loc.find, at);
    if (ctx < 0) throw new Error(`Text "${loc.find}" (occurrence ${n}) not found in ${loc.text}${loc.pointer ?? ""}`);
    at = ctx + 1;
  }
  const sel = loc.select ?? loc.find;
  const rel = loc.find.indexOf(sel);
  if (rel < 0) throw new Error(`select "${sel}" not inside find "${loc.find}"`);
  const start = ctx + rel;
  return {
    anchor: {
      kind: "text-span",
      file: loc.text,
      ...(loc.pointer !== undefined ? { pointer: loc.pointer } : {}),
      start,
      end: start + sel.length,
      ...(loc.role && loc.role !== "value" ? { role: loc.role } : {}),
    },
    quote: sel,
  };
}

function resolveJson(caseId: string, loc: JsonLocator): Resolved {
  const r = resolvePointer(readJson(filePath(caseId, loc.json)), loc.pointer);
  if (!r.found) throw new Error(`Pointer ${loc.pointer} not found in ${loc.json}`);
  return {
    anchor: { kind: "json-pointer", file: loc.json, pointer: loc.pointer, ...(loc.role && loc.role !== "value" ? { role: loc.role } : {}) },
    quote: typeof r.value === "string" ? r.value : JSON.stringify(r.value),
  };
}

function expandJsonValue(caseId: string, loc: JsonValueLocator): Resolved[] {
  const out: Resolved[] = [];
  for (const [p, v] of leaves(readJson(filePath(caseId, loc.jsonValue)))) {
    if (loc.pointerPrefix && !p.startsWith(loc.pointerPrefix)) continue;
    if (v === loc.equals) out.push(resolveJson(caseId, { json: loc.jsonValue, pointer: p, role: loc.role }));
  }
  if (!out.length) throw new Error(`No leaf equal to ${JSON.stringify(loc.equals)} in ${loc.jsonValue}`);
  return out;
}

function expandJsonText(caseId: string, loc: JsonTextLocator): Resolved[] {
  const out: Resolved[] = [];
  for (const [p, v] of leaves(readJson(filePath(caseId, loc.jsonText)))) {
    if (loc.pointerPrefix && !p.startsWith(loc.pointerPrefix)) continue;
    if (typeof v === "string" && v.includes(loc.find)) {
      out.push(resolveText(caseId, { text: loc.jsonText, pointer: p, find: loc.find, select: loc.select, role: loc.role }));
    }
  }
  if (!out.length) throw new Error(`No string containing "${loc.find}" in ${loc.jsonText}`);
  return out;
}

function resolveSheet(caseId: string, loc: SheetLocator): Resolved {
  const wb = XLSX.readFile(filePath(caseId, loc.sheet));
  const sheetName = loc.sheetName ?? wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet ${sheetName} missing in ${loc.sheet}`);
  const rg = XLSX.utils.decode_range(loc.range);
  const values: string[] = [];
  for (let R = rg.s.r; R <= rg.e.r; R++) {
    for (let C = rg.s.c; C <= rg.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      values.push(cell ? String(cell.v) : "");
    }
  }
  if (loc.expectEach !== undefined && values.some((v) => v !== loc.expectEach)) {
    throw new Error(`${loc.sheet}!${loc.range} expected every cell = ${loc.expectEach}, got ${JSON.stringify(values)}`);
  }
  if (loc.expect && JSON.stringify(values) !== JSON.stringify(loc.expect)) {
    throw new Error(`${loc.sheet}!${loc.range} expected ${JSON.stringify(loc.expect)}, got ${JSON.stringify(values)}`);
  }
  const isCsv = /\.csv$/i.test(loc.sheet);
  return {
    anchor: {
      kind: "sheet-range",
      file: loc.sheet,
      ...(isCsv ? {} : { sheet: sheetName }),
      range: loc.range,
      ...(loc.role && loc.role !== "value" ? { role: loc.role } : {}),
    },
    quote: values.join(" "),
  };
}

function resolveOne(caseId: string, loc: Locator): Resolved[] {
  if ("ocr" in loc) return [resolveOcr(caseId, loc)];
  if ("text" in loc) return [resolveText(caseId, loc)];
  if ("json" in loc) return [resolveJson(caseId, loc)];
  if ("jsonValue" in loc) return expandJsonValue(caseId, loc);
  if ("jsonText" in loc) return expandJsonText(caseId, loc);
  if ("sheet" in loc) return [resolveSheet(caseId, loc)];
  if ("region" in loc) {
    if (!fs.existsSync(filePath(caseId, loc.region))) throw new Error(`Missing ${loc.region}`);
    const anchor = { kind: "page-region", file: loc.region, page: loc.page, boxes: [loc.box], ...(loc.role && loc.role !== "value" ? { role: loc.role } : {}) };
    return [{ anchor, quote: loc.label }];
  }
  throw new Error(`Unknown locator ${JSON.stringify(loc)}`);
}

const fileTypeOf = (file: string): string => path.extname(file).slice(1).toLowerCase();

function fieldDefinition(caseId: string, pointer: string) {
  const def = readJson(path.join(caseDir(caseId), "result-definition.json"));
  const generic = pointer.replace(/\/\d+(?=\/|$)/g, "/*");
  return (def.fields as any[]).find((f) => f.path === generic || f.path === pointer);
}

function build() {
  const spec: Spec = readJson(path.join(here, "spec.json"));
  const schema = readJson(path.join(root, "schema", "citations.schema.json"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validateCitation = ajv.getSchema(`${schema.$id}#/$defs/Citation`)!;
  const validateAnchor = ajv.getSchema(`${schema.$id}#/$defs/Anchor`)!;

  const errors: string[] = [];
  const ids = new Set<string>();
  const items = spec.items.map((item) => {
    try {
      if (ids.has(item.id)) throw new Error("duplicate id");
      ids.add(item.id);
      for (const tag of item.edgeCases) if (!(tag in spec.edgeCaseTags)) throw new Error(`unknown edge case tag ${tag}`);

      let value: unknown;
      let definition: any;
      if (item.pointer !== undefined) {
        const r = resolvePointer(readJson(path.join(caseDir(item.caseId), "result.json")), item.pointer);
        if (!r.found) throw new Error(`pointer ${item.pointer} not in result.json`);
        value = r.value;
        definition = fieldDefinition(item.caseId, item.pointer);
      } else if (item.probe) {
        value = item.probe.value;
      } else throw new Error("item needs pointer or probe");

      const isBlank = value === "" || value === null;
      if ((item.expected === "empty" || item.expected === "label-only") && item.edgeCases.some((t) => t.startsWith("blank")) && !isBlank) {
        throw new Error(`blank-tagged item has non-blank value ${JSON.stringify(value)}`);
      }
      if (item.expected === "cite" && !item.gold?.length) throw new Error("expected=cite requires gold");
      if (item.expected === "empty" && item.gold?.length) throw new Error("expected=empty must not have gold");

      const fileTypes = new Set<string>();
      const gold = (item.gold ?? []).flatMap((g, gi) => {
        const resolvedPerAnchor = g.anchors.map((loc) => resolveOne(item.caseId, loc));
        const expanding = resolvedPerAnchor.filter((r) => r.length > 1);
        if (expanding.length && g.anchors.length > 1) throw new Error("multi-match locators must be the only anchor in a gold citation");
        const variants = expanding.length ? resolvedPerAnchor[0].map((r) => [r]) : [resolvedPerAnchor.map((r) => r[0])];
        return variants.map((resolved, vi) => {
          const valueAnchors = resolved.filter((r) => (r.anchor.role ?? "value") === "value");
          const citation = {
            id: `${item.id}-g${gi + 1}${variants.length > 1 ? `.${vi + 1}` : ""}`,
            status: "accepted",
            source: "manual",
            method: "gold",
            quote: valueAnchors.map((r) => r.quote).join(" "),
            ...(g.note ? { note: g.note } : {}),
            anchors: resolved.map((r) => r.anchor),
          };
          if (!validateCitation(citation)) throw new Error(`gold citation invalid: ${ajv.errorsText(validateCitation.errors)}`);
          resolved.forEach((r) => fileTypes.add(fileTypeOf(r.anchor.file)));
          return { match: g.match ?? "overlap", citation };
        });
      });

      const resolveTraps = (list: TrapSpec[] | undefined) =>
        (list ?? []).flatMap((t) =>
          resolveOne(item.caseId, t.anchor).map((r) => {
            if (!validateAnchor(r.anchor)) throw new Error(`trap anchor invalid: ${ajv.errorsText(validateAnchor.errors)}`);
            fileTypes.add(fileTypeOf(r.anchor.file));
            return { why: t.why, quote: r.quote, anchor: r.anchor };
          }),
        );
      const traps = resolveTraps(item.traps);
      const conflicts = resolveTraps(item.conflicts);

      return {
        id: item.id,
        caseId: item.caseId,
        ...(item.pointer !== undefined ? { pointer: item.pointer } : { probe: item.probe }),
        value,
        fieldType: definition?.type ?? null,
        fieldDescription: definition?.description || null,
        edgeCases: item.edgeCases,
        fileTypes: [...fileTypes].sort(),
        expected: item.expected,
        ...(item.fullRecallCitations ? { fullRecallCitations: item.fullRecallCitations } : {}),
        goldConfidence: item.goldConfidence,
        rationale: item.rationale,
        gold,
        traps,
        ...(conflicts.length ? { conflicts } : {}),
      };
    } catch (e) {
      errors.push(`${item.id}: ${(e as Error).message}`);
      return null;
    }
  });

  if (errors.length) {
    console.error(`Build failed with ${errors.length} error(s):\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  const built = items.filter((x): x is NonNullable<typeof x> => x !== null);

  const count = (key: (i: (typeof built)[number]) => string[]) =>
    built.reduce<Record<string, number>>((acc, i) => {
      for (const k of key(i)) acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const matrix: Record<string, Record<string, number>> = {};
  for (const i of built) for (const t of i.edgeCases) for (const f of i.fileTypes) {
    matrix[t] ??= {};
    matrix[t][f] = (matrix[t][f] ?? 0) + 1;
  }

  const out = {
    schemaVersion: "citation-eval/v1",
    description: spec.description,
    citationSchema: "schema/citations.schema.json",
    edgeCaseTags: spec.edgeCaseTags,
    scoring: spec.scoring,
    coverage: {
      items: built.length,
      cases: [...new Set(built.map((i) => i.caseId))].sort(),
      byExpected: count((i) => [i.expected]),
      byEdgeCase: count((i) => i.edgeCases),
      byFileType: count((i) => i.fileTypes),
      edgeCaseByFileType: matrix,
      goldCitations: built.reduce((n, i) => n + i.gold.length, 0),
      traps: built.reduce((n, i) => n + i.traps.length, 0),
    },
    items: built,
  };
  fs.writeFileSync(path.join(here, "eval-set.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote evals/eval-set.json: ${built.length} items, ${out.coverage.goldCitations} gold citations, ${out.coverage.traps} traps`);
  console.log("byExpected", out.coverage.byExpected);
  console.log("byFileType", out.coverage.byFileType);
  console.log("byEdgeCase", out.coverage.byEdgeCase);
}

build();
