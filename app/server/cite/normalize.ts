/**
 * Text normalization and value-variant generation.
 *
 * Variants are *narrow and explainable*: a number may match its currency form,
 * a date its other common formats, a string its case/whitespace-insensitive
 * form. Nothing here does fuzzy matching across different values.
 */

/** Lowercase, collapse whitespace, strip $ and thousands separators. Used for comparisons. */
export const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Aggressive form for name-ish comparisons: letters/digits only. */
export const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const MON = MONTHS.map((m) => m.slice(0, 3));

export interface Ymd { y: number; m: number; d: number }

/** Parse one date in common US / ISO / long forms. Returns null when the text is not a single date. */
export function parseDate(s: string): Ymd | null {
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) return { m: +m[1], d: +m[2], y: m[3].length === 2 ? 2000 + +m[3] : +m[3] };
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = t.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/);
  if (m) {
    const mi = MON.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return { y: +m[3], m: mi + 1, d: +m[2] };
  }
  m = t.match(/^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/);
  if (m) {
    const mi = MON.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return { y: +m[3], m: mi + 1, d: +m[1] };
  }
  return null;
}

/** All dates found inside free text, as yyyy-mm-dd keys. */
export function datesIn(s: string): Set<string> {
  const out = new Set<string>();
  const add = (d: Ymd | null) => d && d.m >= 1 && d.m <= 12 && d.d >= 1 && d.d <= 31 && out.add(dateKey(d));
  for (const m of s.matchAll(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g)) add(parseDate(m[0]));
  for (const m of s.matchAll(/\b\d{4}-\d{1,2}-\d{1,2}\b/g)) add(parseDate(m[0]));
  for (const m of s.matchAll(/\b[A-Za-z]{3,9}\.? \d{1,2},? \d{4}\b/g)) add(parseDate(m[0]));
  for (const m of s.matchAll(/\b\d{1,2} [A-Za-z]{3,9}\.? \d{4}\b/g)) add(parseDate(m[0]));
  return out;
}

export const dateKey = (d: Ymd) => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;

/** Source-format variants of a date (lowercased; matched against lowercased text). */
export function dateVariants(d: Ymd): string[] {
  const mm = String(d.m).padStart(2, "0"), dd = String(d.d).padStart(2, "0");
  const yy = String(d.y).slice(2);
  const v = new Set<string>([
    `${d.m}/${d.d}/${d.y}`, `${mm}/${dd}/${d.y}`, `${d.m}/${d.d}/${yy}`, `${mm}/${dd}/${yy}`,
    `${d.m}-${d.d}-${d.y}`, `${mm}-${dd}-${d.y}`, `${mm}-${dd}-${yy}`,
    `${d.y}-${mm}-${dd}`,
    `${MON[d.m - 1]} ${d.d}, ${d.y}`, `${MON[d.m - 1]} ${dd}, ${d.y}`, `${MON[d.m - 1]}. ${d.d}, ${d.y}`,
    `${MONTHS[d.m - 1]} ${d.d}, ${d.y}`, `${MONTHS[d.m - 1]} ${dd}, ${d.y}`,
    `${d.d} ${MON[d.m - 1]} ${d.y}`, `${d.d} ${MONTHS[d.m - 1]} ${d.y}`,
  ]);
  return [...v];
}

/** Parse a number from "$1,234.50", "1,234", "48%", "(500)" etc. */
export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/^\((.*)\)$/, "-$1");
  const m = t.match(/^-?\$?\s*-?\d[\d,]*(?:\.\d+)?\s*%?$/);
  if (!m) return null;
  const n = Number(t.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Source-format variants for a number. */
export function numberVariants(n: number, opts: { percent?: boolean } = {}): string[] {
  const abs = Math.abs(n);
  const isInt = Number.isInteger(abs);
  const grouped = abs.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const grouped2 = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const plain = String(abs);
  const plain2 = abs.toFixed(2);
  const sign = n < 0 ? "-" : "";
  const v = new Set<string>();
  for (const core of [plain, plain2, grouped, grouped2]) {
    v.add(sign + core);
    v.add(sign + "$" + core);
    v.add("$" + sign + core);
    v.add(sign + "$ " + core);
    if (opts.percent) { v.add(sign + core + "%"); v.add(sign + core + " %"); }
  }
  if (isInt && abs < 10) v.add(sign + plain); // keep tiny ints as-is only
  return [...v];
}

export const STOP = new Set(
  "the a an of to from in on at for and or is are be as by with this that get return format if not it its value field page report document check string immediately following please pick up always number no do need interpret present blank empty true false mm dd yyyy enter there one list all each name".split(" "),
);

/** Tokenize a field name / description into lowercase keywords (no stop words, len ≥ 3). */
/**
 * Drop negated clauses ("Do not get the name of the insured party from the top.",
 * "not the policy number") so words from what to *avoid* never score as context.
 */
export function stripNegations(t: string): string {
  return t
    .replace(/\b(do not|don't|never|must not|should not|not)\b[^.;\n]*[.;]?/gi, " ")
    .replace(/\b(ignore|exclude|excluding|rather than|instead of|as opposed to)\b[^.;\n]*[.;]?/gi, " ");
}

export function keywords(...texts: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    const spaced = stripNegations(t).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_/.-]+/g, " ");
    for (const w of spaced.toLowerCase().match(/[a-z][a-z0-9']{2,}/g) ?? []) {
      const base = w.replace(/'s$/, "");
      if (!STOP.has(base) && base.length >= 3) out.add(base);
    }
  }
  return [...out];
}

/**
 * Quoted labels inside a definition: `the "TENANT(S):" field` → ["tenant(s):"].
 * Definitions often quote several things (section names, example values, other
 * fields not to confuse with). Prefer strings that are clearly *this* field's
 * label: ending in ':' / '#', or immediately followed by the word "field".
 * Fall back to the first quoted string.
 */
export function quotedLabels(description?: string): string[] {
  if (!description) return [];
  const all: Array<{ s: string; strong: boolean }> = [];
  for (const m of description.matchAll(/["“]([^"”]{2,60})["”]/g)) {
    const s = m[1].trim();
    if (/^[md]{1,2}[/-][md]{1,2}[/-]y{2,4}$/i.test(s)) continue; // format hint
    const after = description.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12);
    all.push({ s, strong: /[:#]$/.test(s) || /^\s*(field|label|column|row)\b/i.test(after) });
  }
  const strong = all.filter((a) => a.strong).map((a) => a.s);
  if (strong.length) return strong;
  return all.length ? [all[0].s] : [];
}

/** Positional hints parsed from a definition. */
export function positionHints(description?: string): { page?: number; region?: "top" | "bottom" | "top-right" | "top-left" | "bottom-right" | "bottom-left" } {
  if (!description) return {};
  const d = description.toLowerCase();
  const out: ReturnType<typeof positionHints> = {};
  if (/\bfirst page\b|\bpage 1\b|\bpage one\b/.test(d)) out.page = 1;
  const tr = /\btop[- ]right\b/.test(d), tl = /\btop[- ]left\b/.test(d);
  const br = /\bbottom[- ]right\b/.test(d), bl = /\bbottom[- ]left\b/.test(d);
  if (tr) out.region = "top-right";
  else if (tl) out.region = "top-left";
  else if (br) out.region = "bottom-right";
  else if (bl) out.region = "bottom-left";
  else if (/\bbottom\b/.test(d)) out.region = "bottom";
  else if (/\btop\b/.test(d)) out.region = "top";
  return out;
}

/** Does the definition say the value is a default when nothing is in the source? */
export function mentionsDefault(description: string | undefined, value: unknown): boolean {
  if (!description) return false;
  const d = description.toLowerCase();
  const v = String(value).toLowerCase();
  if (/if (?:empty|not available|unavailable|missing|none|blank|not (?:found|present|listed))[^.]{0,40}(?:display|return|enter|use|put|show)\s*\$?0\b/.test(d) && /^\$?0(?:\.0+)?$/.test(v)) return true;
  if (/(?:display|return|enter|use|put|show)\s*\$?0\b[^.]{0,40}if (?:empty|not available|unavailable|missing|none|blank)/.test(d) && /^\$?0(?:\.0+)?$/.test(v)) return true;
  if (v === "n/a" && /\bn\/a\b/.test(d)) return true;
  return false;
}

export const isZeroish = (v: unknown): boolean =>
  v === 0 || (typeof v === "string" && /^\s*\$?\s*0+(?:\.0+)?\s*%?\s*$/.test(v));

export const isBlank = (v: unknown): boolean => v === "" || v === null || (Array.isArray(v) && v.length === 0);

/**
 * Build the lowercase search variants for a scalar value. Composite values
 * (two dates joined by "to"/"-") return `parts`, each with its own variants.
 */
export function valueVariants(value: unknown): { variants: string[]; parts?: string[][]; kind: "date" | "number" | "string" | "composite" } {
  if (typeof value === "number") return { variants: numberVariants(value), kind: "number" };
  const s = String(value).trim();
  const low = s.toLowerCase();
  // composite date range
  const ds = [...datesIn(s)];
  if (ds.length >= 2 && /\b(to|-|–|through|thru)\b|[-–]/.test(s)) {
    const parts = ds.map((k) => {
      const [y, m, d] = k.split("-").map(Number);
      return dateVariants({ y, m, d });
    });
    return { variants: [low], parts, kind: "composite" };
  }
  const d = parseDate(s);
  if (d) return { variants: dateVariants(d), kind: "date" };
  const n = parseNumber(s);
  if (n !== null && /\d/.test(s)) return { variants: numberVariants(n, { percent: s.includes("%") }), kind: "number" };
  // string
  const v = new Set<string>([low, norm(s)]);
  // "Last, First" → "First Last" and vice versa (names)
  const nm = s.match(/^([A-Za-z'.-]+),\s*([A-Za-z'. -]+)$/);
  if (nm) v.add(`${nm[2]} ${nm[1]}`.toLowerCase());
  return { variants: [...v], kind: "string" };
}
