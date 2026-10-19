import * as fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/**
 * Dev-server middleware that exposes the fixture set to the UI.
 *
 *   GET  /api/schema                     citations.schema.json
 *   GET  /api/cases                      case summaries
 *   GET  /api/cases/:id                  result, definition, source index, file listing
 *   GET  /api/cases/:id/citations        output/<id>.citations.json → schema/examples → empty
 *   PUT  /api/cases/:id/citations        writes output/<id>.citations.json
 *   GET  /cases/:id/files/<name>         raw source file (pdf, json, csv, xlsx, ...)
 */
export function casesPlugin(repoRoot: string): Plugin {
  const casesDir = path.join(repoRoot, "test-cases");
  const outputDir = path.join(repoRoot, "output");
  const examplesDir = path.join(repoRoot, "schema", "examples");
  const schemaFile = path.join(repoRoot, "schema", "citations.schema.json");

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
          hasOutput: existsSync(path.join(outputDir, `${id}.citations.json`)),
          hasExample: existsSync(path.join(examplesDir, `${id}.citations.json`)),
        };
      }),
    );
  }

  async function caseDetail(id: string) {
    const dir = path.join(casesDir, id);
    const [result, resultDefinition, sourceIndex, metadata] = await Promise.all([
      readJson(path.join(dir, "result.json")),
      readJson(path.join(dir, "result-definition.json")).catch(() => null),
      readJson(path.join(dir, "source-index.json")).catch(() => null),
      readJson(path.join(dir, "metadata.json")).catch(() => null),
    ]);
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
    return { id, result, resultDefinition, sourceIndex, metadata, files };
  }

  async function loadCitations(id: string) {
    const outFile = path.join(outputDir, `${id}.citations.json`);
    const exFile = path.join(examplesDir, `${id}.citations.json`);
    if (existsSync(outFile)) {
      return { origin: "output", path: path.relative(repoRoot, outFile), data: await readJson(outFile) };
    }
    if (existsSync(exFile)) {
      return { origin: "example", path: path.relative(repoRoot, exFile), data: await readJson(exFile) };
    }
    return {
      origin: "none",
      path: path.relative(repoRoot, outFile),
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

          const detail = p.match(/^\/api\/cases\/([^/]+)$/);
          if (detail && req.method === "GET") {
            const id = decodeURIComponent(detail[1]);
            if (!safeId(id)) return json(res, 400, { error: "bad case id" });
            if (!existsSync(path.join(casesDir, id))) return json(res, 404, { error: "no such case" });
            return json(res, 200, await caseDetail(id));
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
              await fs.mkdir(outputDir, { recursive: true });
              const outFile = path.join(outputDir, `${id}.citations.json`);
              await fs.writeFile(outFile, JSON.stringify(parsed, null, 2) + "\n", "utf8");
              return json(res, 200, { ok: true, path: path.relative(repoRoot, outFile) });
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
