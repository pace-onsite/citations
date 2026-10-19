/**
 * CLI: validate citation files against the schema and against the source files.
 *
 *   npm run validate:citations                 # every test-cases/<id>/citations.json
 *   npm run validate:citations -- 01-claim-evidence-review path/to/other.json
 *   npm run validate:citations -- --json       # machine-readable report on stdout
 *
 * Arguments are case ids (resolved to test-cases/<id>/citations.json) or paths to
 * citation files. Exit code is 1 if any anchor has a problem or any file is schema-invalid.
 */
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCitationSet, type AnchorCheck, type ValidationReport } from "../server/validateCitations.ts";
import type { CitationSet } from "../src/types.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const casesDir = path.join(repoRoot, "test-cases");
const citationsFile = (id: string) => path.join(casesDir, id, "citations.json");

async function listTargets(args: string[]): Promise<string[]> {
  if (args.length === 0) {
    const ids = (await fs.readdir(casesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    return ids.map(citationsFile).filter((f) => existsSync(f));
  }
  return args.map((arg) => {
    if (existsSync(arg)) return path.resolve(arg);
    if (existsSync(citationsFile(arg))) return citationsFile(arg);
    throw new Error(`no citation file for ${JSON.stringify(arg)} (expected ${path.relative(repoRoot, citationsFile(arg))})`);
  });
}

function printReport(file: string, r: ValidationReport) {
  console.log(`\n== ${path.relative(repoRoot, file)}  (${r.caseId})`);
  if (!r.schemaValid) {
    console.log("  SCHEMA INVALID");
    for (const e of r.schemaErrors) console.log(`    ${e.instancePath || "/"} ${e.message ?? ""}`);
  }
  for (const c of r.checks) console.log(formatCheck(c));
  const s = r.summary;
  const kinds = Object.entries(s.byKind).map(([k, v]) => `${k} ${v.ok}/${v.total}`).join(", ");
  console.log(
    `  -- ${s.anchorsOk}/${s.anchors} anchors ok (${kinds}); ${s.invalidCitations} invalid of ${s.citations} citations; ` +
      `${s.fieldsWithCitations}/${s.fields} listed fields cited`,
  );
}

function formatCheck(c: AnchorCheck): string {
  const flag = c.problems.length === 0 ? "OK  " : "FAIL";
  const head = `  ${flag} ${c.kind.padEnd(12)} ${c.role.padEnd(7)} ${c.status.padEnd(8)} ${c.path.padEnd(44)} ${c.location}`;
  const lines = [head];
  if (c.problems.length) lines.push(`       problems: ${c.problems.join(", ")}${c.detail ? ` — ${c.detail}` : ""}`);
  else if (c.role === "value") lines.push(`       ${JSON.stringify(trunc(c.resolved ?? ""))}`);
  return lines.join("\n");
}
const trunc = (s: string, n = 90) => (s.length > n ? s.slice(0, n) + "…" : s);

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const targets = await listTargets(args.filter((a) => a !== "--json"));
  if (targets.length === 0) {
    console.error("no test-cases/<id>/citations.json files found");
    process.exit(2);
  }
  const schema = JSON.parse(await fs.readFile(path.join(repoRoot, "schema", "citations.schema.json"), "utf8")) as object;
  const reports: Array<{ file: string; report: ValidationReport }> = [];
  for (const file of targets) {
    const set = JSON.parse(await fs.readFile(file, "utf8")) as CitationSet;
    const report = await validateCitationSet(repoRoot, set, { schema });
    reports.push({ file: path.relative(repoRoot, file), report });
    if (!asJson) printReport(file, report);
  }
  const failed = reports.filter((r) => !r.report.schemaValid || r.report.summary.anchorsOk !== r.report.summary.anchors);
  if (asJson) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    const totals = reports.reduce(
      (t, { report: r }) => ({ anchors: t.anchors + r.summary.anchors, ok: t.ok + r.summary.anchorsOk }),
      { anchors: 0, ok: 0 },
    );
    console.log(`\n${reports.length} file(s), ${totals.ok}/${totals.anchors} anchors ok, ${failed.length} file(s) with problems`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(2);
});
