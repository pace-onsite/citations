/**
 * CLI: run the citation loop.
 *
 *   npm run cite -- 01-claim-evidence-review                 # print summary + traces for one case
 *   npm run cite -- 01-claim-evidence-review --pointer /FA_Name --trace
 *   npm run cite -- --all --out ../runs/baseline             # write <caseId>.citations.json per case
 *   npm run cite -- --eval --out ../runs/eval                # only the cases in eval/eval-set.json
 *   npm run cite -- 01-claim-evidence-review --write         # write test-cases/<id>/citations.json
 *
 * Flags: --no-llm  --model <name>  --cap <n>  --json
 */
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { citeCase } from "../server/cite/run.ts";
import type { RunMetrics } from "../server/cite/types.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const pointers = args.flatMap((a, i) => (a === "--pointer" ? [args[i + 1]] : []));
const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && args[i - 1] !== "--model" && args[i - 1] !== "--cap" && args[i - 1] !== "--pointer");

async function main() {
  let caseIds = ids;
  if (flag("--all")) caseIds = (await fs.readdir(path.join(repoRoot, "test-cases"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (flag("--eval")) {
    const ev = JSON.parse(await fs.readFile(path.join(repoRoot, "eval", "eval-set.json"), "utf8")) as { items: Array<{ caseId: string }> };
    caseIds = [...new Set(ev.items.map((i) => i.caseId))].sort();
  }
  if (!caseIds.length) { console.error("usage: cite <caseId>... | --all | --eval  [--out dir] [--write] [--pointer p]... [--trace] [--no-llm] [--model m] [--cap n] [--json]"); process.exit(2); }

  const out = opt("--out") ? path.resolve(process.cwd(), opt("--out")!) : undefined;
  if (out) await fs.mkdir(out, { recursive: true });
  const all: RunMetrics[] = [];

  for (const id of caseIds) {
    if (!existsSync(path.join(repoRoot, "test-cases", id))) { console.error(`no such case ${id}`); continue; }
    const r = await citeCase(repoRoot, id, { pointers: pointers.length ? pointers : undefined, llm: !flag("--no-llm"), model: opt("--model"), cap: opt("--cap") ? Number(opt("--cap")) : undefined });
    all.push(r.metrics);
    if (out) await fs.writeFile(path.join(out, `${id}.citations.json`), JSON.stringify(r.set, null, 2) + "\n");
    if (flag("--write")) await fs.writeFile(path.join(repoRoot, "test-cases", id, "citations.json"), JSON.stringify(r.set, null, 2) + "\n");
    if (flag("--json")) { console.log(JSON.stringify(r, null, 2)); continue; }
    printMetrics(r.metrics);
    if (flag("--trace") || pointers.length) {
      for (const t of r.traces) {
        console.log(`\n  ${t.pointer}  [${t.cls}] → ${t.decision} (${t.method}, conf ${t.confidence.toFixed(2)}, ${t.ms}ms, ${t.candidatesConsidered} candidates)`);
        console.log(`    ${t.reasoning}`);
        for (const s of t.shortlist) console.log(`    ${s.selected ? "★" : "·"} ${s.score.toFixed(2)} ${s.locator} ${JSON.stringify(s.quote.slice(0, 50))}${s.penalties.length ? `  −[${s.penalties.join("; ")}]` : ""}`);
      }
    }
  }
  if (out) {
    await fs.writeFile(path.join(out, "metrics.json"), JSON.stringify(all, null, 2) + "\n");
    console.log(`\nwrote ${all.length} case(s) to ${path.relative(process.cwd(), out)}`);
  }
}

function printMetrics(m: RunMetrics) {
  const v = m.validation;
  console.log(
    `\n== ${m.caseId}: ${m.processed} fields → ${m.cited} cited, ${m.contextOnly} discrepancy/context, ${m.empty} empty` +
      `\n   ${m.totalMs}ms total (index ${m.indexMs}ms, search ${m.searchMs}ms; per field mean ${m.perFieldMs.mean}ms p95 ${m.perFieldMs.p95}ms)` +
      `\n   ${m.candidates} candidates; LLM calls ${m.llmCalls} (${m.promptTokens}+${m.completionTokens} tok, $${m.estimatedCostUsd.toFixed(4)})` +
      (v ? `\n   validator: ${v.anchorsOk}/${v.anchors} anchors ok, ${v.invalidCitations} invalid citations ${JSON.stringify(Object.fromEntries(Object.entries(v.byProblem).filter(([, n]) => n > 0)))}` : "") +
      `\n   classes ${JSON.stringify(m.byClass)}\n   methods ${JSON.stringify(m.byMethod)}`,
  );
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exit(2); });
