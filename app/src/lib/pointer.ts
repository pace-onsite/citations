import type { FieldDefinition, ResultField } from "../types";

/** RFC 6901: split a pointer into unescaped tokens. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export type ResolveResult = { found: true; value: unknown } | { found: false; failedAt: string };

/** Resolve a pointer against a document. Does not throw on misses. */
export function resolvePointer(doc: unknown, pointer: string): ResolveResult {
  let tokens: string[];
  try {
    tokens = parsePointer(pointer);
  } catch {
    return { found: false, failedAt: pointer };
  }
  let cur: unknown = doc;
  let walked = "";
  for (const tok of tokens) {
    walked += "/" + escapeToken(tok);
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(tok)) return { found: false, failedAt: walked };
      const idx = Number(tok);
      if (idx >= cur.length) return { found: false, failedAt: walked };
      cur = cur[idx];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return { found: false, failedAt: walked };
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      return { found: false, failedAt: walked };
    }
  }
  return { found: true, value: cur };
}

function typeOf(v: unknown): ResultField["valueType"] {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as ResultField["valueType"];
}

/**
 * Flatten result.json into an ordered list of fields (containers included so the
 * UI can show structure, leaves are the citable values). Definitions are matched
 * by replacing array indexes with `*`, which is how result-definition.json keys them.
 */
export function flattenResult(result: unknown, definitions: FieldDefinition[] = []): ResultField[] {
  const defs = new Map(definitions.map((d) => [d.path, d]));
  const out: ResultField[] = [];

  const walk = (value: unknown, pointer: string, depth: number) => {
    const t = typeOf(value);
    const wildcard = pointer.replace(/\/(0|[1-9][0-9]*)(?=\/|$)/g, "/*");
    out.push({
      pointer,
      value,
      valueType: t,
      depth,
      definition: defs.get(pointer) ?? defs.get(wildcard),
    });
    if (t === "array") {
      (value as unknown[]).forEach((item, i) => walk(item, `${pointer}/${i}`, depth + 1));
    } else if (t === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, `${pointer}/${escapeToken(k)}`, depth + 1);
      }
    }
  };

  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      walk(v, `/${escapeToken(k)}`, 0);
    }
  } else {
    walk(result, "", 0);
  }
  return out;
}

export const isLeaf = (f: ResultField) => f.valueType !== "array" && f.valueType !== "object";

export function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  return `{${Object.keys(v as object).length} keys}`;
}
