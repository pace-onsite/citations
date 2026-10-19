import * as fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { citeCase } from "./cite/run.ts";
import { llmConfigured } from "./cite/judge.ts";

/**
 * Dev-server middleware that exposes the fixture set to the UI.
 *
 *   GET  /api/schema                     citations.schema.json
 *   GET  /api/eval                       eval/eval-set.json
 *   GET  /api/cases                      case summaries
 *   GET  /api/cases/:id                  result, definition, source index, file listing
 *   GET  /api/cases/:id/citations        test-cases/<id>/citations.json (empty set if absent)
 *   PUT  /api/cases/:id/citations        writes test-cases/<id>/citations.json
 *   POST /api/cases/:id/cite             runs the citation loop → { set, traces, metrics, llm } (nothing written)
 *   GET  /api/cite/status                { configured, model } for the LLM judge
 *   GET  /cases/:id/files/<name>         raw source file (pdf, json, csv, xlsx, ...)
 *
 * Everything for a case lives in its folder: result.json, result-definition.json,
 * files/, and citations.json.
 */
export function casesPlugin(repoRoot: string): Plugin {
  const casesDir = path.join(repoRoot, "test-cases");
  const schemaFile = path.join(repoRoot, "schema", "citations.schema.json");
  const evalFile = path.join(repoRoot, "eval", "eval-set.json");
  const citationsFile = (id: string) => path.join(casesDir, id, "citations.json");

  const safeId = (id: string) => /^[A-Za-z0-9._-]+$/.test(id);
  const safeName = (name: string) => /^[A-Za-z0-9._ -]+$/.test(name) && !name.includes("..");

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };

  const readJson = async <T>(file: string): Promise<T> =>
    JSON.parse(await fs.readFile(file, "utf8")) as T;

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  const contentTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".eml": "message/rfc822",
    ".html": "text/html; charset=utf-8",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };

  async function listCases() {
    const entries = await fs.readdir(casesDir, { withFileTypes: true });
    const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    return Promise.all(
      ids.map(async (id) => {
        const meta: Record<string, unknown> = await readJson<Record<string, unknown>>(
          path.join(casesDir, id, "metadata.json"),
        ).catch(() => ({}) as Record<string, unknown>);
        return {
          id,
          caseTitle: meta.caseTitle ?? id,
          reviewType: meta.reviewType ?? null,
          resultType: meta.resultType ?? null,
          sourceFileCounts: meta.sourceFileCounts ?? null,
          hasCitations: existsSync(citationsFile(id)),
        };
      }),
    );
  }

  async function caseDetail(id: string) {
    const dir = path.join(casesDir, id);
    const [resultRaw, resultDefinition, sourceIndex, metadata] = await Promise.all([
      fs.readFile(path.join(dir, "result.json"), "utf8"),
      readJson(path.join(dir, "result-definition.json")).catch(() => null),
      readJson(path.join(dir, "source-index.json")).catch(() => null),
      readJson(path.join(dir, "metadata.json")).catch(() => null),
    ]);
    const result = JSON.parse(resultRaw) as unknown;
    const fileEntries = await fs.readdir(path.join(dir, "files"), { withFileTypes: true });
    const files = await Promise.all(
      fileEntries
        .filter((e) => e.isFile())
        .map(async (e) => {
          const stat = await fs.stat(path.join(dir, "files", e.name));
          return { name: e.name, size: stat.size, ext: path.extname(e.name).toLowerCase() };
        }),
    );
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { id, result, resultRaw, resultDefinition, sourceIndex, metadata, files };
  }

  async function loadCitations(id: string) {
    const file = citationsFile(id);
    const rel = path.relative(repoRoot, file);
    if (existsSync(file)) {
      return { origin: "case", path: rel, data: await readJson(file) };
    }
    return {
      origin: "none",
      path: rel,
      data: { schemaVersion: "citations/v1", caseId: id, citations: {} },
    };
  }

  return {
    name: "citation-cases-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const p = url.pathname;
        try {
          if (p === "/api/schema" && req.method === "GET") {
            return json(res, 200, await readJson(schemaFile));
          }
          if (p === "/api/cases" && req.method === "GET") {
            return json(res, 200, await listCases());
          }
          if (p === "/api/eval" && req.method === "GET") {
            if (!existsSync(evalFile)) return json(res, 404, { error: "eval/eval-set.json not found" });
            return json(res, 200, { path: path.relative(repoRoot, evalFile), data: await readJson(evalFile) });
          }

          const detail = p.match(/^\/api\/cases\/([^/]+)$/);
          if (detail && req.method === "GET") {
            const id = decodeURIComponent(detail[1]);
            if (!safeId(id)) return json(res, 400, { error: "bad case id" });
            if (!existsSync(path.join(casesDir, id))) return json(res, 404, { error: "no such case" });
            return json(res, 200, await caseDetail(id));
          }

          // Run the citation loop for a case (all leaves, or body.pointers).
          // Returns the proposed set plus a per-field trace of what the agent
          // considered and why it chose what it chose; nothing is written.
          const cite = p.match(/^\/api\/cases\/([^/]+)\/cite$/);
          if (cite && req.method === "POST") {
            const id = decodeURIComponent(cite[1]);
            if (!safeId(id)) return json(res, 400, { error: "bad case id" });
            if (!existsSync(path.join(casesDir, id))) return json(res, 404, { error: "no such case" });
            const body = await readBody(req);
            let opts: { pointers?: string[]; llm?: boolean } = {};
            if (body.trim()) {
              try { opts = JSON.parse(body) as typeof opts; } catch { return json(res, 400, { error: "body is not JSON" }); }
            }
            const pointers = Array.isArray(opts.pointers) ? opts.pointers.filter((x): x is string => typeof x === "string") : undefined;
            const useLlm = (opts.llm ?? true) && llmConfigured();
            const run = await citeCase(repoRoot, id, { pointers, llm: useLlm, validate: false });
            return json(res, 200, { ...run, llm: { requested: opts.llm ?? true, configured: llmConfigured(), model: process.env.CITE_MODEL ?? "gpt-4o-mini" } });
          }
          if (p === "/api/cite/status" && req.method === "GET") {
            return json(res, 200, { configured: llmConfigured(), model: process.env.CITE_MODEL ?? "gpt-4o-mini" });
          }

          const cit = p.match(/^\/api\/cases\/([^/]+)\/citations$/);
          if (cit) {
            const id = decodeURIComponent(cit[1]);
            if (!safeId(id)) return json(res, 400, { error: "bad case id" });
            if (req.method === "GET") return json(res, 200, await loadCitations(id));
            if (req.method === "PUT") {
              const body = await readBody(req);
              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                return json(res, 400, { error: "body is not JSON" });
              }
              if (!existsSync(path.join(casesDir, id))) return json(res, 404, { error: "no such case" });
              const file = citationsFile(id);
              await fs.writeFile(file, JSON.stringify(parsed, null, 2) + "\n", "utf8");
              return json(res, 200, { ok: true, path: path.relative(repoRoot, file) });
            }
          }

          const file = p.match(/^\/cases\/([^/]+)\/files\/(.+)$/);
          if (file && req.method === "GET") {
            const id = decodeURIComponent(file[1]);
            const name = decodeURIComponent(file[2]);
            if (!safeId(id) || !safeName(name)) return json(res, 400, { error: "bad path" });
            const abs = path.join(casesDir, id, "files", name);
            if (!existsSync(abs)) return json(res, 404, { error: "no such file" });
            const stat = await fs.stat(abs);
            res.statusCode = 200;
            res.setHeader("Content-Type", contentTypes[path.extname(name).toLowerCase()] ?? "application/octet-stream");
            res.setHeader("Content-Length", String(stat.size));
            res.setHeader("Cache-Control", "no-cache");
            createReadStream(abs).pipe(res);
            return;
          }
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        next();
      });
    },
  };
}
