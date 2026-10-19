/**
 * Scoring rules from eval/README.md: how a produced citation anchor matches a
 * ground-truth anchor, and when an item passes for each `expect` value.
 */
import type { Anchor, Citation, EvalItem, Evidence, Rect } from "../types";
import { parseRange } from "./a1";

export type Group = "acceptable" | "requiredContext" | "secondary" | "forbidden";
type CoreGroup = Exclude<Group, "requiredContext">;

const isValueRole = (a: Anchor) => (a.role ?? "value") === "value";

// ---- geometry ----------------------------------------------------------------

function union(boxes: Rect[]): Rect {
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}
const area = (r: Rect) => r.width * r.height;
function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w <= 0 || h <= 0 ? 0 : w * h;
}

// ---- per-kind match -------------------------------------------------------------

export function anchorsMatch(produced: Anchor, truth: Anchor): boolean {
  if (produced.file !== truth.file) return false;
  switch (truth.kind) {
    case "page-region": {
      if (produced.kind !== "page-region" || produced.page !== truth.page) return false;
      const p = union(produced.boxes);
      const t = union(truth.boxes);
      const inter = intersection(p, t);
      const iou = inter / (area(p) + area(t) - inter);
      if (iou >= 0.5) return true;
      return inter / area(t) >= 0.8 && area(p) <= 3 * area(t);
    }
    case "text-span": {
      if (produced.kind !== "text-span") return false;
      if ((produced.pointer ?? null) !== (truth.pointer ?? null)) return false;
      const overlap = Math.min(produced.end, truth.end) - Math.max(produced.start, truth.start);
      const tLen = truth.end - truth.start;
      const pLen = produced.end - produced.start;
      return overlap >= 0.5 * tLen && pLen <= 2 * tLen;
    }
    case "json-pointer": {
      if (produced.kind === "json-pointer") return produced.pointer === truth.pointer;
      // A text-span over the whole string counts; without the string length we accept a span starting at 0.
      if (produced.kind === "text-span") return produced.pointer === truth.pointer && produced.start === 0;
      return false;
    }
    case "sheet-range": {
      if (produced.kind !== "sheet-range") return false;
      if ((produced.sheet ?? null) !== (truth.sheet ?? null)) return false;
      const pr = parseRange(produced.range);
      const tr = parseRange(truth.range);
      if (!pr || !tr) return false;
      const cells = (pr.end.col - pr.start.col + 1) * (pr.end.row - pr.start.row + 1);
      if (cells > 4) return false;
      return tr.start.col >= pr.start.col && tr.end.col <= pr.end.col && tr.start.row >= pr.start.row && tr.end.row <= pr.end.row;
    }
  }
}

/** A produced anchor matches an evidence entry via its value-role anchors (or any anchor if it has none). */
export function matchesEvidence(produced: Anchor, ev: Evidence): boolean {
  const valueAnchors = ev.anchors.filter(isValueRole);
  const candidates = valueAnchors.length ? valueAnchors : ev.anchors;
  return candidates.some((t) => anchorsMatch(produced, t));
}

const localContextAnchors = (ev: Evidence) => ev.anchors.filter((a) => a.role === "label" || a.role === "context");

/** Value evidence with a label/context anchor counts only when this citation also covers that context. */
export function citationCoversLocalContext(anchors: readonly Anchor[], ev: Evidence): boolean {
  const context = localContextAnchors(ev);
  if (!context.length) return true;
  return anchors.some((produced) => context.some((truth) => anchorsMatch(produced, truth)));
}

// ---- item scoring --------------------------------------------------------------

export interface AnchorVerdict {
  citationId: string;
  citationStatus: Citation["status"];
  anchorIndex: number;
  anchor: Anchor;
  valueRole: boolean;
  /** First evidence entry matched, searching acceptable → secondary → forbidden. */
  match?: { group: Group; entryIndex: number; label: string };
}

export interface ItemScore {
  /** null when the item is not scorable (no citations.json for the case). */
  pass: boolean | null;
  reasons: string[];
  verdicts: AnchorVerdict[];
  acceptableMatched: Set<number>;
  requiredContextMatched: Set<number>;
  forbiddenHits: number;
  unmatchedValueAnchors: number;
  rejectedIgnored: number;
  considered: number;
}

export function scoreItem(item: EvalItem, produced: Citation[] | undefined): ItemScore {
  const verdicts: AnchorVerdict[] = [];
  const acceptableMatched = new Set<number>();
  const requiredContextMatched = new Set<number>();
  const requiredContext = item.requiredContext ?? [];
  let forbiddenHits = 0;
  let unmatchedValueAnchors = 0;
  let unmatchedAnyRole = 0;
  let rejectedIgnored = 0;

  const list = produced ?? [];
  for (const c of list) {
    if (c.status === "rejected") {
      rejectedIgnored++;
      continue;
    }
    c.anchors.forEach((a, i) => {
      const v: AnchorVerdict = { citationId: c.id, citationStatus: c.status, anchorIndex: i, anchor: a, valueRole: isValueRole(a) };
      for (const group of ["acceptable", "secondary", "forbidden"] as CoreGroup[]) {
        const idx = item[group].findIndex((ev) => {
          if (!matchesEvidence(a, ev)) return false;
          if (group === "acceptable" && !citationCoversLocalContext(c.anchors, ev)) return false;
          return true;
        });
        if (idx >= 0) {
          v.match = { group, entryIndex: idx, label: item[group][idx].label };
          break;
        }
      }
      if ((a.role ?? "value") === "context") {
        const idx = requiredContext.findIndex((ev) => matchesEvidence(a, ev));
        if (idx >= 0) {
          requiredContextMatched.add(idx);
          if (!v.match) v.match = { group: "requiredContext", entryIndex: idx, label: requiredContext[idx].label };
        }
      }
      if (v.match?.group === "acceptable") {
        if (v.valueRole) acceptableMatched.add(v.match.entryIndex);
      }
      if (v.match?.group === "forbidden" && v.valueRole) forbiddenHits++;
      if (!v.match) {
        unmatchedAnyRole++;
        if (v.valueRole) unmatchedValueAnchors++;
      }
      verdicts.push(v);
    });
  }

  const considered = list.length - rejectedIgnored;
  const reasons: string[] = [];
  if (produced === undefined) {
    return { pass: null, reasons: ["no citations.json entry for this pointer (not scored)"], verdicts, acceptableMatched, requiredContextMatched, forbiddenHits, unmatchedValueAnchors, rejectedIgnored, considered };
  }

  const valueAnchors = verdicts.filter((v) => v.valueRole).length;
  let pass = true;
  switch (item.expect) {
    case "cite": {
      const need = item.minAcceptableMatches ?? 1;
      if (acceptableMatched.size >= need) reasons.push(`${acceptableMatched.size} acceptable entr${acceptableMatched.size === 1 ? "y" : "ies"} matched (need ${need})`);
      else {
        pass = false;
        reasons.push(`only ${acceptableMatched.size} acceptable entr${acceptableMatched.size === 1 ? "y" : "ies"} matched by value-role anchors; need ${need}`);
      }
      const contextNeed = requiredContext.length ? (item.minRequiredContextMatches ?? 1) : 0;
      if (requiredContextMatched.size >= contextNeed) {
        if (contextNeed) reasons.push(`${requiredContextMatched.size} required context entr${requiredContextMatched.size === 1 ? "y" : "ies"} matched (need ${contextNeed})`);
      } else {
        pass = false;
        reasons.push(`only ${requiredContextMatched.size} required context entr${requiredContextMatched.size === 1 ? "y" : "ies"} matched by role=context anchors; need ${contextNeed}`);
      }
      if (forbiddenHits) {
        pass = false;
        reasons.push(`${forbiddenHits} forbidden match${forbiddenHits === 1 ? "" : "es"} (false positive)`);
      }
      if (unmatchedValueAnchors) {
        pass = false;
        reasons.push(`${unmatchedValueAnchors} value-role anchor${unmatchedValueAnchors === 1 ? "" : "s"} matched nothing (presumed wrong)`);
      }
      break;
    }
    case "context-only": {
      if (considered === 0) reasons.push("no citations produced — acceptable for a derived/defaulted value");
      else if (unmatchedAnyRole === 0 && forbiddenHits === 0) reasons.push("every produced anchor matches acceptable/secondary evidence");
      if (unmatchedValueAnchors) {
        pass = false;
        reasons.push(`${unmatchedValueAnchors} unmatched value-role anchor${unmatchedValueAnchors === 1 ? "" : "s"}`);
      }
      if (forbiddenHits) {
        pass = false;
        reasons.push(`${forbiddenHits} forbidden match${forbiddenHits === 1 ? "" : "es"}`);
      }
      break;
    }
    case "empty": {
      if (valueAnchors === 0) reasons.push(considered === 0 ? "no citations produced" : "only label/context anchors produced (tolerated)");
      else {
        pass = false;
        reasons.push(`${valueAnchors} value-role anchor${valueAnchors === 1 ? "" : "s"} produced; expected none`);
      }
      if (forbiddenHits) {
        pass = false;
        reasons.push(`${forbiddenHits} forbidden match${forbiddenHits === 1 ? "" : "es"}`);
      }
      break;
    }
  }
  if (rejectedIgnored) reasons.push(`${rejectedIgnored} rejected citation${rejectedIgnored === 1 ? "" : "s"} ignored (reviewer corrections)`);

  return { pass, reasons, verdicts, acceptableMatched, requiredContextMatched, forbiddenHits, unmatchedValueAnchors, rejectedIgnored, considered };
}
