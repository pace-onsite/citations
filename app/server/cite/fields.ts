/**
 * Triage: turn result.json leaves into FieldJobs. Decides *what kind of
 * evidence a field can have* before any searching happens.
 */
import type { FieldDefinition } from "../../src/types.ts";
import { isBlank, isZeroish, keywords, mentionsDefault, positionHints, quotedLabels, valueVariants } from "./normalize.ts";
import type { FieldClass, FieldJob } from "./types.ts";

const esc = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");

interface Leaf { pointer: string; value: unknown; parent: unknown; parentPointer: string; depth: number }

function flatten(result: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, pointer: string, parent: unknown, parentPointer: string, depth: number) => {
    if (Array.isArray(v)) {
      if (v.length === 0) out.push({ pointer, value: v, parent, parentPointer, depth });
      v.forEach((item, i) => walk(item, `${pointer}/${i}`, v, pointer, depth + 1));
    } else if (v !== null && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, `${pointer}/${esc(k)}`, v, pointer, depth + 1);
    } else {
      out.push({ pointer, value: v, parent, parentPointer, depth });
    }
  };
  walk(result, "", undefined, "", 0);
  return out;
}

const typeOf = (v: unknown): FieldJob["valueType"] => (v === null ? "null" : Array.isArray(v) ? "array" : (typeof v as FieldJob["valueType"]));

export function buildJobs(result: unknown, definitions: FieldDefinition[] = [], only?: string[]): FieldJob[] {
  const defs = new Map(definitions.map((d) => [d.path, d]));
  const want = only ? new Set(only) : null;
  const jobs: FieldJob[] = [];

  for (const leaf of flatten(result)) {
    if (want && !want.has(leaf.pointer)) continue;
    const wildcard = leaf.pointer.replace(/\/(0|[1-9][0-9]*)(?=\/|$)/g, "/*");
    const definition = defs.get(leaf.pointer) ?? defs.get(wildcard);
    const desc = definition?.description ?? "";
    const name = leaf.pointer.split("/").pop() ?? "";
    const vt = typeOf(leaf.value);

    // Row binding: is the parent an element of an array?
    const parentTokens = leaf.parentPointer.split("/");
    const inRow = /^\d+$/.test(parentTokens[parentTokens.length - 1] ?? "");
    const rowPointer = inRow ? leaf.parentPointer : undefined;
    const rowIdentifiers: string[] = [];
    const primaryIdentifiers: string[] = [];
    if (inRow && leaf.parent && typeof leaf.parent === "object") {
      for (const [k, v] of Object.entries(leaf.parent as Record<string, unknown>)) {
        if (k === name) continue;
        let s: string | null = null;
        if (typeof v === "string" && v.trim().length >= 4 && !isZeroish(v) && !/^\$?0(\.00)?$/.test(v)) s = v.trim();
        else if (typeof v === "number" && Math.abs(v) >= 100) s = String(v);
        if (s === null) continue;
        rowIdentifiers.push(s);
        // Keys like "Policy Number", "Claim #", "claimId" identify the row on their own;
        // a carrier name or a date is shared by many rows and must not bind by itself.
        if (/(policy|claim|account|file|cert|certificate|report)[ _-]*(number|no\.?|num|#|id)$|^(id|number|no)$|[ _]?(number|#)$/i.test(k.trim()) && /\d/.test(s)) primaryIdentifiers.push(s);
      }
    }

    let cls: FieldClass;
    if (vt === "array" || vt === "object") cls = isBlank(leaf.value) ? "blank" : "container";
    else if (isBlank(leaf.value)) cls = "blank";
    else if (vt === "boolean") cls = /following|after|field on|check for/i.test(desc) || /^Check for/i.test(desc) ? "boolean-presence" : "boolean-source";
    else if (typeof leaf.value === "string" && leaf.value.toUpperCase() === "N/A") cls = "rule-constant";
    else if (isZeroish(leaf.value)) cls = "zero";
    else if (typeof leaf.value === "string" && (leaf.value.length > 120 || /\n/.test(leaf.value))) cls = "prose";
    else cls = "scalar";

    if (cls === "zero" && mentionsDefault(desc, leaf.value)) cls = "zero"; // kept; search decides "default" vs "real"

    const vv = cls === "scalar" || cls === "zero" ? valueVariants(leaf.value) : { variants: [] as string[], kind: "string" as const };
    if (vv.kind === "composite") cls = "composite";

    // Labels: quoted in the definition when present; otherwise derived from the
    // field name ("Date_Inspected_Value" → "date inspected"). Single-word name
    // labels are only used when the definition also mentions that word, to
    // keep words like "contents" or "forms" from matching prose.
    const nameLabel = name.replace(/_?value$/i, "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").toLowerCase().trim();
    let explicitLabels = quotedLabels(desc).map((s) => s.toLowerCase());
    if (explicitLabels.length > 1) {
      // Several quoted labels: keep the ones that share a word with the field name ("Forms" → "forms:").
      const nameToks = nameLabel.split(" ").filter((t) => t.length >= 3);
      const related = explicitLabels.filter((l) => nameToks.some((t) => l.includes(t)));
      if (related.length) explicitLabels = related;
    }
    if (!explicitLabels.length) {
      if (nameLabel.includes(" ") ? nameLabel.length >= 5 : nameLabel.length >= 4 && desc.toLowerCase().includes(nameLabel)) explicitLabels.push(nameLabel);
    }
    // Common label spellings: "report number" → "report #", "report no."
    for (const l of [...explicitLabels]) {
      if (/\bnumber\b/.test(l)) explicitLabels.push(l.replace(/\bnumber\b/, "#"), l.replace(/\bnumber\b/, "no."), l.replace(/\bnumber\b/, "no"), l.replace(/\bnumber\b/, "num"));
      if (/\bdate of\b/.test(l)) explicitLabels.push(l.replace(/\bdate of\b/, ""));
    }
    explicitLabels = [...new Set(explicitLabels.map((l) => l.trim()).filter((l) => l.length >= 3))];

    jobs.push({
      pointer: leaf.pointer,
      value: leaf.value,
      valueType: vt,
      definition,
      cls,
      rowPointer,
      rowIdentifiers,
      primaryIdentifiers,
      name,
      explicitLabels,
      keywords: keywords(name, desc).filter((k) => !/^\d+$/.test(k)),
      hints: positionHints(desc),
      variants: vv.variants,
      parts: vv.kind === "composite" ? vv.parts : undefined,
    });
  }
  return jobs;
}
