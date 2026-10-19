import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type PgPool = import("pg").Pool;

const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
const { GetObjectCommand, S3Client } = requireFromCwd(
  "@aws-sdk/client-s3",
) as typeof import("@aws-sdk/client-s3");
const { Pool } = requireFromCwd("pg") as typeof import("pg");

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";

type S3 = InstanceType<typeof S3Client>;

type Args = {
  output: string;
  orgSlugs: string[];
  limit: number;
  perOrg: number;
  recentRunsPerOrg: number;
  maxFiles: number;
  clean: boolean;
  selectOnly: boolean;
  exportOnly: boolean;
  appendCount: number | null;
  selectedCasesPath?: string;
  includeRenderedPdf: boolean;
};

type OrgRow = {
  id: string;
  slug: string;
  name: string;
};

type RunRow = {
  org_id: string;
  org_slug: string;
  task_id: string;
  task_name: string;
  run_id: string;
  flow_id: string;
  flow_name: string;
  created_at: Date;
  terminal_at: Date | null;
  duration_ms: number | string | null;
};

type EntityRow = {
  id: string;
  run_id: string;
  org_id: string;
  name: string;
  type: string;
  storage_path: string;
  pdf_storage_path: string | null;
  content_storage_path: string | null;
  reducto_chunks_path: string | null;
  reducto_job_id: string | null;
  created_at: Date;
};

type ResultSummaryRow = {
  result_id: string;
  run_id: string;
  node_id: string;
  node_name: string;
  data_bytes: number;
  data_kind: string | null;
};

type ResultLinkRow = {
  result_id: string;
  entity_id: string;
};

type SelectedCase = {
  id: string;
  orgSlug: string;
  orgId: string;
  taskId: string;
  taskName: string;
  runId: string;
  flowId: string;
  flowName: string;
  resultId: string;
  nodeId: string;
  nodeName: string;
  createdAt: string;
  terminalAt: string | null;
  durationMs: number | null;
  score: number;
  dataBytes: number;
  fileCounts: FileCounts;
  entityIds: string[];
};

type ExportedCase = SelectedCase & {
  directory: string;
  files: ExportedFile[];
  referenceMetrics: {
    runDurationMs: number | null;
    llmCallCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
};

type ExportedFile = {
  entityId: string;
  entityName: string;
  entityType: string;
  rawFile: string;
  ocrFile: string | null;
  renderedPdf: string | null;
  hasReductoChunks: boolean;
};

type FileCounts = {
  total: number;
  pdf: number;
  spreadsheet: number;
  excel: number;
  structured: number;
  reducto: number;
};

type FullResultRow = {
  id: string;
  data: unknown;
  reasoning: unknown;
  confidence: unknown;
};

type UsageRow = {
  run_id: string;
  llm_call_count: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cached_input_tokens: string | null;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultOutput = path.resolve(scriptDir, "..");

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const getValue = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };

  const has = (name: string) => args.includes(name);
  const numberValue = (name: string, fallback: number) => {
    const raw = getValue(name);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
  };

  return {
    output: path.resolve(getValue("--output") ?? defaultOutput),
    orgSlugs: (getValue("--org-slugs") ?? "ryze,wtw")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
    limit: numberValue("--limit", 20),
    perOrg: numberValue("--per-org", 10),
    recentRunsPerOrg: numberValue("--recent-runs-per-org", 1200),
    maxFiles: numberValue("--max-files", 12),
    clean: !has("--no-clean"),
    selectOnly: has("--select-only"),
    exportOnly: has("--export-only"),
    appendCount: getValue("--append-count")
      ? numberValue("--append-count", 0)
      : null,
    selectedCasesPath: getValue("--selected-cases"),
    includeRenderedPdf: !has("--no-rendered-pdf"),
  };
};

const stripOuterQuotes = (value: string | undefined): string =>
  (value ?? "").trim().replace(/^['"]|['"]$/g, "");

const getDatabaseUrl = (): string => {
  const url = stripOuterQuotes(
    process.env.CLAUDE_DB_READONLY || process.env.DATABASE_URL,
  );
  if (!url) {
    throw new Error(
      "DATABASE_URL or CLAUDE_DB_READONLY is required. Run through scripts/op-run-with-environments.sh.",
    );
  }
  return url;
};

const createPool = (): PgPool =>
  {
    const connectionString = getDatabaseUrl();
    return new Pool({
      connectionString,
      ssl: connectionString.includes("sslmode=require")
        ? { rejectUnauthorized: false }
        : undefined,
    });
  };

const createS3 = () =>
  new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
  });

const parseS3Location = (
  storagePath: string,
): { bucket: string; key: string } => {
  if (storagePath.startsWith("s3://")) {
    const withoutScheme = storagePath.slice("s3://".length);
    const slashIndex = withoutScheme.indexOf("/");
    if (slashIndex === -1) {
      throw new Error(`Invalid S3 URI: ${storagePath}`);
    }
    return {
      bucket: withoutScheme.slice(0, slashIndex),
      key: withoutScheme.slice(slashIndex + 1),
    };
  }

  const bucket = process.env.S3_DOCUMENT_BUCKET || "foundation-ryze";
  return { bucket, key: storagePath };
};

const downloadS3File = async (
  s3: S3,
  storagePath: string,
  outputPath: string,
) => {
  const { bucket, key } = parseS3Location(storagePath);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`S3 object has no body: ${storagePath}`);
  }

  const body = response.Body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (!body.transformToByteArray) {
    throw new Error(`S3 object body is not readable: ${storagePath}`);
  }

  const bytes = await body.transformToByteArray();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(bytes));
};

const queryOrganizations = async (
  pool: PgPool,
  slugs: string[],
): Promise<OrgRow[]> => {
  const result = await pool.query<OrgRow>(
    `
      SELECT id, slug, name
      FROM public.organizations
      WHERE slug = ANY($1::text[])
      ORDER BY slug
    `,
    [slugs],
  );

  const found = new Set(result.rows.map((row) => row.slug));
  const missing = slugs.filter((slug) => !found.has(slug));
  if (missing.length > 0) {
    throw new Error(`Could not find org slug(s): ${missing.join(", ")}`);
  }

  return result.rows;
};

const queryRecentRunsForOrg = async (
  pool: PgPool,
  org: OrgRow,
  limit: number,
): Promise<RunRow[]> => {
  const result = await pool.query<RunRow>(
    `
      WITH recent AS (
        SELECT
          fr.org_id,
          $2::text AS org_slug,
          ft.id AS task_id,
          ft.name AS task_name,
          fr.id AS run_id,
          fr.flow_id,
          f.name AS flow_name,
          fr.created_at,
          COALESCE(fr.finished_at, fr.failed_at, fr.cancelled_at, fr.ready_for_review_at) AS terminal_at,
          CASE
            WHEN COALESCE(fr.finished_at, fr.failed_at, fr.cancelled_at, fr.ready_for_review_at) IS NULL
              THEN NULL
            ELSE FLOOR(EXTRACT(EPOCH FROM (COALESCE(fr.finished_at, fr.failed_at, fr.cancelled_at, fr.ready_for_review_at) - fr.created_at)) * 1000)::bigint
          END AS duration_ms
        FROM agentic.flow_runs fr
        JOIN agentic.flow_tasks ft ON ft.id = fr.task_id
        JOIN agentic.flows f ON f.id = fr.flow_id
        WHERE fr.org_id = $1::uuid
          AND fr.status = 'completed'
          AND COALESCE(ft.is_eval, false) = false
        ORDER BY fr.created_at DESC
        LIMIT ($3::int * 4)
      ),
      latest_per_task AS (
        SELECT DISTINCT ON (task_id) *
        FROM recent
        ORDER BY task_id, created_at DESC
      )
      SELECT *
      FROM latest_per_task
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [org.id, org.slug, limit],
  );
  return result.rows;
};

const queryEntities = async (
  pool: PgPool,
  runIds: string[],
): Promise<EntityRow[]> => {
  if (runIds.length === 0) return [];
  const result = await pool.query<EntityRow>(
    `
      SELECT
        id,
        run_id,
        org_id,
        name,
        type::text AS type,
        storage_path,
        pdf_storage_path,
        content_storage_path,
        reducto_chunks_path,
        reducto_job_id,
        created_at
      FROM agentic.flow_run_entities
      WHERE run_id = ANY($1::uuid[])
    `,
    [runIds],
  );
  return result.rows;
};

const queryResultSummaries = async (
  pool: PgPool,
  runIds: string[],
): Promise<ResultSummaryRow[]> => {
  if (runIds.length === 0) return [];
  const result = await pool.query<ResultSummaryRow>(
    `
      SELECT
        r.id AS result_id,
        r.run_id,
        r.node_id,
        COALESCE(fn.data->>'name', r.node_id::text) AS node_name,
        LENGTH(r.data::text)::int AS data_bytes,
        jsonb_typeof(r.data) AS data_kind
      FROM agentic.flow_run_results r
      LEFT JOIN agentic.flow_nodes fn
        ON fn.id = r.node_id
       AND fn.flow_version_id = r.flow_version_id
      WHERE r.run_id = ANY($1::uuid[])
    `,
    [runIds],
  );
  return result.rows;
};

const queryResultLinks = async (
  pool: PgPool,
  resultIds: string[],
): Promise<ResultLinkRow[]> => {
  if (resultIds.length === 0) return [];
  const result = await pool.query<ResultLinkRow>(
    `
      SELECT result_id, entity_id
      FROM agentic.flow_run_result_entities
      WHERE result_id = ANY($1::uuid[])
    `,
    [resultIds],
  );
  return result.rows;
};

const isPdf = (type: string): boolean => type.toLowerCase() === "pdf";

const isExcel = (type: string): boolean =>
  ["xlsx", "xls", "xlsm"].includes(type.toLowerCase());

const isSpreadsheet = (type: string): boolean =>
  isExcel(type) || type.toLowerCase() === "csv";

const isStructured = (type: string): boolean => {
  const lower = type.toLowerCase();
  return (
    lower.includes("json") ||
    ["txt", "xml", "email-eml", "msg"].includes(lower)
  );
};

const countFiles = (entities: EntityRow[]): FileCounts => ({
  total: entities.length,
  pdf: entities.filter((entity) => isPdf(entity.type)).length,
  spreadsheet: entities.filter((entity) => isSpreadsheet(entity.type)).length,
  excel: entities.filter((entity) => isExcel(entity.type)).length,
  structured: entities.filter((entity) => isStructured(entity.type)).length,
  reducto: entities.filter((entity) => entity.reducto_chunks_path).length,
});

const selectFileEntities = (options: {
  runEntities: EntityRow[];
  linkedEntities: EntityRow[];
  maxFiles: number;
}): EntityRow[] => {
  const linked =
    options.linkedEntities.length > 0
      ? options.linkedEntities
      : options.runEntities;
  const linkedCounts = countFiles(linked);
  const runCounts = countFiles(options.runEntities);

  const smallRun = options.runEntities.length <= options.maxFiles;
  const runAddsUsefulSource =
    (linkedCounts.structured === 0 && runCounts.structured > 0) ||
    (linkedCounts.spreadsheet === 0 && runCounts.spreadsheet > 0) ||
    (linkedCounts.excel === 0 && runCounts.excel > 0);

  return smallRun && runAddsUsefulSource ? options.runEntities : linked;
};

const scoreCandidate = (counts: FileCounts, result: ResultSummaryRow): number =>
  counts.pdf * 30 +
  counts.reducto * 20 +
  counts.structured * 24 +
  counts.excel * 40 +
  (counts.spreadsheet - counts.excel) * 18 +
  Math.min(result.data_bytes / 100, 35) -
  counts.total * 1.5;

const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "case";
};

const buildCaseId = (options: {
  orgSlug: string;
  taskName: string;
  nodeName: string;
  index: number;
}): string => {
  const padded = String(options.index + 1).padStart(2, "0");
  return `${padded}-${options.orgSlug}-${slugify(options.taskName)}-${slugify(
    options.nodeName,
  )}`.slice(0, 120);
};

const toIso = (value: Date | string | null): string | null => {
  if (!value) return null;
  return new Date(value).toISOString();
};

const chooseCases = async (pool: PgPool, args: Args): Promise<SelectedCase[]> => {
  const orgs = await queryOrganizations(pool, args.orgSlugs);
  const allCandidates: SelectedCase[] = [];

  for (const org of orgs) {
    const runs = await queryRecentRunsForOrg(pool, org, args.recentRunsPerOrg);
    const runIds = runs.map((run) => run.run_id);
    const entities = await queryEntities(pool, runIds);
    const results = await queryResultSummaries(pool, runIds);
    const links = await queryResultLinks(
      pool,
      results.map((result) => result.result_id),
    );

    const runsById = new Map(runs.map((run) => [run.run_id, run]));
    const entitiesByRun = groupBy(entities, (entity) => entity.run_id);
    const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
    const linksByResult = groupBy(links, (link) => link.result_id);

    const bestByRun = new Map<string, SelectedCase>();
    for (const result of results) {
      const run = runsById.get(result.run_id);
      if (!run) continue;
      if (result.data_kind !== "object" && result.data_kind !== "array") {
        continue;
      }
      if (result.data_bytes < 100) continue;

      const runEntities = entitiesByRun.get(result.run_id) ?? [];
      if (runEntities.length === 0) continue;

      const linkedEntities = (linksByResult.get(result.result_id) ?? [])
        .map((link) => entitiesById.get(link.entity_id))
        .filter((entity): entity is EntityRow => Boolean(entity));
      const fileEntities = selectFileEntities({
        runEntities,
        linkedEntities,
        maxFiles: args.maxFiles,
      });
      if (fileEntities.length === 0 || fileEntities.length > args.maxFiles) {
        continue;
      }

      const counts = countFiles(fileEntities);
      if (counts.pdf === 0 && counts.structured === 0 && counts.spreadsheet === 0) {
        continue;
      }

      const score = scoreCandidate(counts, result);
      const existing = bestByRun.get(result.run_id);
      if (existing && existing.score >= score) {
        continue;
      }

      bestByRun.set(result.run_id, {
        id: "pending",
        orgSlug: run.org_slug,
        orgId: run.org_id,
        taskId: run.task_id,
        taskName: run.task_name,
        runId: run.run_id,
        flowId: run.flow_id,
        flowName: run.flow_name,
        resultId: result.result_id,
        nodeId: result.node_id,
        nodeName: result.node_name,
        createdAt: toIso(run.created_at) ?? "",
        terminalAt: toIso(run.terminal_at),
        durationMs: run.duration_ms === null ? null : Number(run.duration_ms),
        score,
        dataBytes: result.data_bytes,
        fileCounts: counts,
        entityIds: fileEntities.map((entity) => entity.id),
      });
    }

    allCandidates.push(...bestByRun.values());
  }

  const byOrg = groupBy(allCandidates, (candidate) => candidate.orgSlug);
  const selected: SelectedCase[] = [];
  const selectedKeys = new Set<string>();

  for (const orgSlug of args.orgSlugs) {
    const orgCandidates = (byOrg.get(orgSlug) ?? []).sort(compareCandidates);
    for (const candidate of takeDiverse(orgCandidates, args.perOrg)) {
      selected.push(candidate);
      selectedKeys.add(candidate.resultId);
    }
  }

  if (selected.length < args.limit) {
    for (const candidate of allCandidates.sort(compareCandidates)) {
      if (selected.length >= args.limit) break;
      if (selectedKeys.has(candidate.resultId)) continue;
      selected.push(candidate);
      selectedKeys.add(candidate.resultId);
    }
  }

  return selected.slice(0, args.limit).map((candidate, index) => ({
    ...candidate,
    id: buildCaseId({
      orgSlug: candidate.orgSlug,
      taskName: candidate.taskName,
      nodeName: candidate.nodeName,
      index,
    }),
  }));
};

const normalizeDiversityKey = (taskName: string): string => {
  const withoutPrefixes = taskName
    .replace(/^\[[^\]]+\]\s*/g, "")
    .replace(/^\[Eval\]\s*/i, "");
  const subject = withoutPrefixes.split(/\s+-\s+/)[0] ?? withoutPrefixes;
  return slugify(subject);
};

const takeDiverse = (
  candidates: SelectedCase[],
  limit: number,
): SelectedCase[] => {
  const selected: SelectedCase[] = [];
  const selectedIds = new Set<string>();
  const subjectCounts = new Map<string, number>();
  const nodeCounts = new Map<string, number>();

  const tryAdd = (candidate: SelectedCase, enforceCaps: boolean) => {
    if (selected.length >= limit || selectedIds.has(candidate.resultId)) {
      return;
    }

    const subjectKey = normalizeDiversityKey(candidate.taskName);
    const nodeKey = slugify(candidate.nodeName);
    if (enforceCaps) {
      if ((subjectCounts.get(subjectKey) ?? 0) >= 2) return;
      if ((nodeCounts.get(nodeKey) ?? 0) >= 4) return;
    }

    selected.push(candidate);
    selectedIds.add(candidate.resultId);
    subjectCounts.set(subjectKey, (subjectCounts.get(subjectKey) ?? 0) + 1);
    nodeCounts.set(nodeKey, (nodeCounts.get(nodeKey) ?? 0) + 1);
  };

  for (const candidate of candidates) {
    tryAdd(candidate, true);
  }
  for (const candidate of candidates) {
    tryAdd(candidate, false);
  }

  return selected;
};

const compareCandidates = (left: SelectedCase, right: SelectedCase): number => {
  const leftHasExcel = left.fileCounts.excel > 0 ? 1 : 0;
  const rightHasExcel = right.fileCounts.excel > 0 ? 1 : 0;
  if (rightHasExcel !== leftHasExcel) return rightHasExcel - leftHasExcel;

  const leftHasStructured = left.fileCounts.structured > 0 ? 1 : 0;
  const rightHasStructured = right.fileCounts.structured > 0 ? 1 : 0;
  if (rightHasStructured !== leftHasStructured) {
    return rightHasStructured - leftHasStructured;
  }

  if (right.score !== left.score) return right.score - left.score;
  return right.createdAt.localeCompare(left.createdAt);
};

const groupBy = <T, K>(items: T[], key: (item: T) => K): Map<K, T[]> => {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const existing = map.get(groupKey);
    if (existing) {
      existing.push(item);
    } else {
      map.set(groupKey, [item]);
    }
  }
  return map;
};

const queryFullResults = async (
  pool: PgPool,
  resultIds: string[],
): Promise<Map<string, FullResultRow>> => {
  if (resultIds.length === 0) return new Map();
  const result = await pool.query<FullResultRow>(
    `
      SELECT id, data, reasoning, confidence
      FROM agentic.flow_run_results
      WHERE id = ANY($1::uuid[])
    `,
    [resultIds],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
};

const queryEntitiesById = async (
  pool: PgPool,
  entityIds: string[],
): Promise<Map<string, EntityRow>> => {
  if (entityIds.length === 0) return new Map();
  const result = await pool.query<EntityRow>(
    `
      SELECT
        id,
        run_id,
        org_id,
        name,
        type::text AS type,
        storage_path,
        pdf_storage_path,
        content_storage_path,
        reducto_chunks_path,
        reducto_job_id,
        created_at
      FROM agentic.flow_run_entities
      WHERE id = ANY($1::uuid[])
    `,
    [entityIds],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
};

const queryUsage = async (
  pool: PgPool,
  runIds: string[],
): Promise<Map<string, UsageRow>> => {
  if (runIds.length === 0) return new Map();
  const result = await pool.query<UsageRow>(
    `
      SELECT
        run_id,
        COUNT(*)::text AS llm_call_count,
        SUM(CASE WHEN data->'usage'->>'inputTokens' ~ '^[0-9]+$' THEN (data->'usage'->>'inputTokens')::int ELSE 0 END)::text AS input_tokens,
        SUM(CASE WHEN data->'usage'->>'outputTokens' ~ '^[0-9]+$' THEN (data->'usage'->>'outputTokens')::int ELSE 0 END)::text AS output_tokens,
        SUM(CASE WHEN data->'usage'->>'cachedInputTokens' ~ '^[0-9]+$' THEN (data->'usage'->>'cachedInputTokens')::int ELSE 0 END)::text AS cached_input_tokens
      FROM agentic.sandbox_run_log_entries
      WHERE run_id = ANY($1::uuid[])
        AND entry_type = 'llm_call'
      GROUP BY run_id
    `,
    [runIds],
  );
  return new Map(result.rows.map((row) => [row.run_id, row]));
};

const extensionByType = new Map<string, string>([
  ["api-call", ".json"],
  ["csv", ".csv"],
  ["doc", ".doc"],
  ["docx", ".docx"],
  ["email-eml", ".eml"],
  ["email-gmail-json", ".json"],
  ["email-graph-json", ".json"],
  ["email-mailgun-json", ".json"],
  ["email-postmark-json", ".json"],
  ["jpeg", ".jpg"],
  ["jpg", ".jpg"],
  ["json", ".json"],
  ["msg", ".msg"],
  ["pdf", ".pdf"],
  ["png", ".png"],
  ["pptx", ".pptx"],
  ["txt", ".txt"],
  ["xls", ".xls"],
  ["xlsm", ".xlsm"],
  ["xlsx", ".xlsx"],
  ["xml", ".xml"],
]);

const sanitizeFileSegment = (value: string): string => {
  const sanitized = value
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return sanitized || "file";
};

const rawFileNameForEntity = (entity: EntityRow): string => {
  const baseName = path.basename(entity.name.replace(/\\/g, "/"));
  const parsed = path.parse(baseName);
  const fallbackExt = extensionByType.get(entity.type.toLowerCase()) ?? ".bin";
  const ext = parsed.ext || fallbackExt;
  const nameWithoutExt = parsed.ext ? parsed.name : baseName;
  return `${sanitizeFileSegment(nameWithoutExt)}${ext.toLowerCase()}`;
};

const uniqueName = (fileName: string, usedNames: Set<string>): string => {
  if (!usedNames.has(fileName)) {
    usedNames.add(fileName);
    return fileName;
  }

  const parsed = path.parse(fileName);
  for (let index = 2; ; index += 1) {
    const candidate = `${parsed.name}_${index}${parsed.ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
};

const uniqueRawName = (
  fileName: string,
  usedNames: Set<string>,
  usedStems: Set<string>,
): string => {
  const parsed = path.parse(fileName);
  let candidate = fileName;
  let index = 2;

  while (
    usedNames.has(candidate) ||
    usedStems.has(path.parse(candidate).name)
  ) {
    candidate = `${parsed.name}_${index}${parsed.ext}`;
    index += 1;
  }

  usedNames.add(candidate);
  usedStems.add(path.parse(candidate).name);
  return candidate;
};

const uniqueSuffixedName = (options: {
  stem: string;
  suffix: string;
  ext: string;
  usedNames: Set<string>;
}): string => {
  let candidate = `${options.stem}${options.suffix}${options.ext}`;
  let index = 2;

  while (options.usedNames.has(candidate)) {
    candidate = `${options.stem}_${index}${options.suffix}${options.ext}`;
    index += 1;
  }

  options.usedNames.add(candidate);
  return candidate;
};

const toNumber = (value: string | null | undefined): number =>
  value ? Number.parseInt(value, 10) || 0 : 0;

const exportCases = async (
  pool: PgPool,
  args: Args,
  selectedCases: SelectedCase[],
): Promise<ExportedCase[]> => {
  const s3 = createS3();
  const testCasesDir = path.join(args.output, "test-cases");
  if (args.clean) {
    await fs.rm(testCasesDir, { recursive: true, force: true });
  }
  await fs.mkdir(testCasesDir, { recursive: true });

  const resultIds = selectedCases.map((testCase) => testCase.resultId);
  const runIds = selectedCases.map((testCase) => testCase.runId);
  const entityIds = Array.from(
    new Set(selectedCases.flatMap((testCase) => testCase.entityIds)),
  );
  const fullResults = await queryFullResults(pool, resultIds);
  const entitiesById = await queryEntitiesById(pool, entityIds);
  const usageByRun = await queryUsage(pool, runIds);

  const exportedCases: ExportedCase[] = [];

  for (const testCase of selectedCases) {
    const caseDir = path.join(testCasesDir, testCase.id);
    const filesDir = path.join(caseDir, "files");
    await fs.mkdir(filesDir, { recursive: true });

    const result = fullResults.get(testCase.resultId);
    if (!result) {
      throw new Error(`Missing result row for ${testCase.resultId}`);
    }

    await fs.writeFile(
      path.join(caseDir, "result.json"),
      `${JSON.stringify(result.data, null, 2)}\n`,
    );

    const usedFileNames = new Set<string>();
    const usedRawStems = new Set<string>();
    const exportedFiles: ExportedFile[] = [];

    for (const entityId of testCase.entityIds) {
      const entity = entitiesById.get(entityId);
      if (!entity) {
        throw new Error(`Missing entity row for ${entityId}`);
      }

      const rawFileName = uniqueRawName(
        rawFileNameForEntity(entity),
        usedFileNames,
        usedRawStems,
      );
      const rawPath = path.join(filesDir, rawFileName);
      await downloadS3File(s3, entity.storage_path, rawPath);

      const parsed = path.parse(rawFileName);
      let ocrFile: string | null = null;
      if (entity.reducto_chunks_path) {
        ocrFile = uniqueSuffixedName({
          stem: parsed.name,
          suffix: "-ocr",
          ext: ".json",
          usedNames: usedFileNames,
        });
        await downloadS3File(
          s3,
          entity.reducto_chunks_path,
          path.join(filesDir, ocrFile),
        );
      }

      let renderedPdf: string | null = null;
      if (
        args.includeRenderedPdf &&
        entity.pdf_storage_path &&
        !isPdf(entity.type) &&
        isSpreadsheet(entity.type)
      ) {
        renderedPdf = uniqueSuffixedName({
          stem: parsed.name,
          suffix: "-rendered",
          ext: ".pdf",
          usedNames: usedFileNames,
        });
        await downloadS3File(
          s3,
          entity.pdf_storage_path,
          path.join(filesDir, renderedPdf),
        );
      }

      exportedFiles.push({
        entityId: entity.id,
        entityName: entity.name,
        entityType: entity.type,
        rawFile: rawFileName,
        ocrFile,
        renderedPdf,
        hasReductoChunks: Boolean(entity.reducto_chunks_path),
      });
    }

    const usage = usageByRun.get(testCase.runId);
    const metadata: ExportedCase = {
      ...testCase,
      directory: path.relative(args.output, caseDir),
      files: exportedFiles,
      referenceMetrics: {
        runDurationMs: testCase.durationMs,
        llmCallCount: toNumber(usage?.llm_call_count),
        inputTokens: toNumber(usage?.input_tokens),
        outputTokens: toNumber(usage?.output_tokens),
        cachedInputTokens: toNumber(usage?.cached_input_tokens),
      },
    };

    await fs.writeFile(
      path.join(caseDir, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(caseDir, "source-index.json"),
      `${JSON.stringify(
        {
          files: exportedFiles,
          note:
            "OCR artifacts are Reducto chunk files from reducto_chunks_path. Rendered PDFs are included only for spreadsheet entities when production had a converted PDF.",
        },
        null,
        2,
      )}\n`,
    );

    exportedCases.push(metadata);
    console.log(`Exported ${testCase.id}: ${exportedFiles.length} files`);
  }

  return exportedCases;
};

const writeSelectedCases = async (output: string, cases: SelectedCase[]) => {
  const internalDir = path.join(output, ".internal");
  await fs.mkdir(internalDir, { recursive: true });
  await fs.writeFile(
    path.join(internalDir, "selected-cases.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2)}\n`,
  );
};

const readSelectedCases = async (args: Args): Promise<SelectedCase[]> => {
  const selectedPath =
    args.selectedCasesPath ??
    path.join(args.output, ".internal", "selected-cases.json");
  const raw = await fs.readFile(selectedPath, "utf8");
  const parsed = JSON.parse(raw) as { cases?: SelectedCase[] };
  if (!Array.isArray(parsed.cases)) {
    throw new Error(`${selectedPath} does not contain a cases array`);
  }
  return parsed.cases;
};

const appendSelectedCases = async (
  pool: PgPool,
  args: Args,
): Promise<SelectedCase[]> => {
  const appendCount = args.appendCount ?? 0;
  if (appendCount <= 0) {
    throw new Error("--append-count must be a positive integer");
  }

  const existing = await readSelectedCases(args);
  const poolSize = existing.length + appendCount + 50;
  const candidatePool = await chooseCases(pool, {
    ...args,
    limit: poolSize,
    perOrg: Math.max(args.perOrg, Math.ceil(poolSize / args.orgSlugs.length)),
  });

  const existingResultIds = new Set(existing.map((testCase) => testCase.resultId));
  const existingTaskIds = new Set(existing.map((testCase) => testCase.taskId));
  const existingRunIds = new Set(existing.map((testCase) => testCase.runId));
  const selectedResultIds = new Set(existingResultIds);

  const candidates = candidatePool.filter(
    (candidate) =>
      !existingResultIds.has(candidate.resultId) &&
      !existingTaskIds.has(candidate.taskId) &&
      !existingRunIds.has(candidate.runId),
  );

  const additions: SelectedCase[] = [];
  const addCandidate = (candidate: SelectedCase) => {
    if (
      additions.length >= appendCount ||
      selectedResultIds.has(candidate.resultId)
    ) {
      return;
    }

    const index = existing.length + additions.length;
    additions.push({
      ...candidate,
      id: buildCaseId({
        orgSlug: candidate.orgSlug,
        taskName: candidate.taskName,
        nodeName: candidate.nodeName,
        index,
      }),
    });
    selectedResultIds.add(candidate.resultId);
  };

  const basePerOrg = Math.floor(appendCount / args.orgSlugs.length);
  const remainder = appendCount % args.orgSlugs.length;
  args.orgSlugs.forEach((orgSlug, orgIndex) => {
    const target = basePerOrg + (orgIndex < remainder ? 1 : 0);
    let addedForOrg = 0;
    for (const candidate of candidates) {
      if (addedForOrg >= target) break;
      if (candidate.orgSlug !== orgSlug) continue;
      if (selectedResultIds.has(candidate.resultId)) continue;
      addCandidate(candidate);
      addedForOrg += 1;
    }
  });

  for (const candidate of candidates) {
    addCandidate(candidate);
  }

  if (additions.length < appendCount) {
    throw new Error(
      `Only found ${additions.length} additional cases; requested ${appendCount}`,
    );
  }

  return [...existing, ...additions];
};

const writeManifest = async (output: string, cases: ExportedCase[]) => {
  const totals = cases.reduce(
    (acc, testCase) => ({
      cases: acc.cases + 1,
      files: acc.files + testCase.files.length,
      pdfFiles:
        acc.pdfFiles +
        testCase.files.filter((file) => file.entityType.toLowerCase() === "pdf")
          .length,
      excelFiles:
        acc.excelFiles +
        testCase.files.filter((file) => isExcel(file.entityType)).length,
      spreadsheetFiles:
        acc.spreadsheetFiles +
        testCase.files.filter((file) => isSpreadsheet(file.entityType)).length,
      structuredFiles:
        acc.structuredFiles +
        testCase.files.filter((file) => isStructured(file.entityType)).length,
      ocrFiles: acc.ocrFiles + testCase.files.filter((file) => file.ocrFile).length,
    }),
    {
      cases: 0,
      files: 0,
      pdfFiles: 0,
      excelFiles: 0,
      spreadsheetFiles: 0,
      structuredFiles: 0,
      ocrFiles: 0,
    },
  );

  await fs.writeFile(
    path.join(output, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals,
        cases,
      },
      null,
      2,
    )}\n`,
  );
};

const main = async () => {
  const args = parseArgs();
  if (args.selectOnly && args.exportOnly) {
    throw new Error("Use only one of --select-only or --export-only");
  }

  const pool = createPool();
  try {
    let selectedCases: SelectedCase[];
    if (args.exportOnly) {
      selectedCases = await readSelectedCases(args);
    } else if (args.appendCount !== null) {
      selectedCases = await appendSelectedCases(pool, args);
      await writeSelectedCases(args.output, selectedCases);
      console.log(
        `Selected ${selectedCases.length} cases (${args.appendCount} appended)`,
      );
    } else {
      selectedCases = await chooseCases(pool, args);
      await writeSelectedCases(args.output, selectedCases);
      console.log(`Selected ${selectedCases.length} cases`);
    }

    if (!args.selectOnly) {
      const exportedCases = await exportCases(pool, args, selectedCases);
      await writeManifest(args.output, exportedCases);
      console.log(`Wrote manifest for ${exportedCases.length} exported cases`);
    }
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
