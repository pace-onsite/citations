/**
 * Ground-truth checks for one eval item: does the item still describe the fixtures?
 * Reuses the citation validator by wrapping each evidence entry as a pseudo-citation.
 */
import type { CaseDetail, Citation, EvalItem, EvalSet } from "../types";
import type { Group } from "./evalMatch";
import { resolvePointer } from "./pointer";
import { validateCitation, worstOf, type CitationReport, type Finding, type Level } from "./validate";

export interface EvidenceReport {
  group: Group;
  entryIndex: number;
  report: CitationReport;
}

export interface ItemReport {
  itemId: string;
  /** Item-level findings: value drift, undeclared categories, missing case. */
  findings: Finding[];
  evidence: EvidenceReport[];
  worst: Level;
}

const valueSupportCodes = new Set([
  "quote-equals-value",
  "quote-contains-value",
  "quote-numeric-match",
  "quote-indirect",
  "no-quote",
  "boolean-field",
  "container",
  "empty-value",
]);

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function pseudoCitation(item: EvalItem, group: Group, entryIndex: number): Citation {
  const ev = (item[group] ?? [])[entryIndex];
  if (!ev) throw new Error(`missing ${group}[${entryIndex}] on ${item.id}`);
  return { id: `${item.id}#${group}[${entryIndex}]`, status: "proposed", source: "auto", quote: ev.quote, anchors: ev.anchors };
}

export async function validateEvalItem(item: EvalItem, set: EvalSet, detail: CaseDetail): Promise<ItemReport> {
  const findings: Finding[] = [];

  const r = resolvePointer(detail.result, item.pointer);
  if (!r.found) {
    findings.push({ level: "error", code: "pointer-missing", message: `${item.pointer} does not exist in result.json (failed at ${r.failedAt})` });
  } else if (!deepEqual(r.value, item.value)) {
    findings.push({
      level: "error",
      code: "value-drift",
      message: `item.value is ${JSON.stringify(item.value)} but result.json has ${JSON.stringify(r.value)}`,
    });
  } else {
    findings.push({ level: "ok", code: "value-matches", message: `value matches result.json` });
  }

  const undeclared = item.categories.filter((c) => !(c in set.categories));
  if (undeclared.length) findings.push({ level: "warn", code: "undeclared-category", message: `categories not in taxonomy: ${undeclared.join(", ")}` });

  if (item.expect === "cite" && item.acceptable.length === 0) {
    findings.push({ level: "error", code: "cite-without-evidence", message: `expect is "cite" but there is no acceptable evidence` });
  }
  if ((item.requiredContext ?? []).some((e) => e.anchors.some((a) => a.role !== "context"))) {
    findings.push({ level: "error", code: "invalid-required-context", message: `every requiredContext anchor must use role "context"` });
  }
  if ((item.expect === "empty" || item.expect === "context-only") && item.forbidden.length === 0 && item.acceptable.length === 0) {
    findings.push({ level: "info", code: "no-evidence", message: `no evidence listed — passes only on absence of value-role anchors` });
  }

  const jobs: Promise<EvidenceReport>[] = [];
  for (const group of ["acceptable", "requiredContext", "secondary", "forbidden"] as Group[]) {
    (item[group] ?? []).forEach((_, i) => {
      jobs.push(
        validateCitation(item.caseId, item.pointer, pseudoCitation(item, group, i), detail).then((report) => {
          // The quote↔result-value heuristic only means something for evidence that is supposed to support the value.
          const keepValueSupport = group === "acceptable" && item.expect === "cite";
          const filtered = keepValueSupport ? report.findings : report.findings.filter((f) => !valueSupportCodes.has(f.code));
          return { group, entryIndex: i, report: { ...report, findings: filtered, worst: worstOf(filtered.map((f) => f.level)) } };
        }),
      );
    });
  }
  const evidence = await Promise.all(jobs);
  const worst = worstOf([...findings.map((f) => f.level), ...evidence.map((e) => e.report.worst)]);
  return { itemId: item.id, findings, evidence, worst };
}
