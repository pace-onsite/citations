import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Model } from "../../../packages/shared/src/model";
import {
  type TemplatedText,
  templateToString,
} from "../../../packages/shared/src/text";

type PgPool = import("pg").Pool;

const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = requireFromCwd("pg") as typeof import("pg");

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";

type Args = {
  root: string;
  all: boolean;
  caseId: string | null;
};

type SelectedCase = {
  resultId: string;
};

type PublicCase = {
  caseId: string;
  resultType: string;
  directory: string;
};

type ResultDefinition = {
  schemaVersion: "result-definition/v1";
  caseId: string;
  resultType: string;
  purpose: string;
  resultFile: "result.json";
  fields: FieldDefinition[];
};

type FieldDefinition = {
  path: string;
  name: string;
  type: string;
  description: string;
  itemType?: string;
  allowedValues?: string[];
  fallbackValue?: string;
};

type ResultDefinitionRow = {
  result_data: unknown;
  model: Model;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, "..");

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const valueAfter = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? null : (args[index + 1] ?? null);
  };

  return {
    root: path.resolve(valueAfter("--root") ?? defaultRoot),
    all: args.includes("--all"),
    caseId: valueAfter("--case-id"),
  };
};

const stripOuterQuotes = (value: string | undefined): string =>
  (value ?? "").trim().replace(/^['"]|['"]$/g, "");

const createPool = (): PgPool => {
  const connectionString = stripOuterQuotes(
    process.env.CLAUDE_DB_READONLY || process.env.DATABASE_URL,
  );
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL or CLAUDE_DB_READONLY is required. Run through scripts/op-run-with-environments.sh.",
    );
  }

  return new Pool({
    connectionString,
    ssl: connectionString.includes("sslmode=require")
      ? { rejectUnauthorized: false }
      : undefined,
  });
};

const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(filePath, "utf8")) as T;

const writeJson = async (filePath: string, value: unknown) => {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const pointerSegment = (value: string): string =>
  value.replace(/~/g, "~0").replace(/\//g, "~1");

const pointerPath = (segments: string[]): string =>
  `/${segments.map(pointerSegment).join("/")}`;

const valueAt = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
};

const descriptionToText = (description: Model["description"]): string =>
  description
    ? templateToString(description as TemplatedText)
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : "";

const normalizeType = (model: Model): string => {
  if (model.type === "enums-container") return "enum-group";
  return model.type;
};

const arrayItemValue = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : undefined;

const collectFields = (
  model: Model,
  resultValue: unknown,
  pathSegments: string[] = [],
): FieldDefinition[] => {
  const fields: FieldDefinition[] = [];

  if (pathSegments.length > 0) {
    const definition: FieldDefinition = {
      path: pointerPath(pathSegments),
      name: model.name,
      type: normalizeType(model),
      description: descriptionToText(model.description),
    };

    if (model.type === "array") {
      definition.itemType = normalizeType(model.model);
    }
    if (model.type === "enum") {
      definition.allowedValues = model.types;
      if (model.fallbackValue !== undefined) {
        definition.fallbackValue = model.fallbackValue;
      }
    }

    fields.push(definition);
  }

  if (model.type === "object") {
    for (const child of model.fields) {
      fields.push(
        ...collectFields(child, valueAt(resultValue, child.name), [
          ...pathSegments,
          child.name,
        ]),
      );
    }
  }

  if (model.type === "array") {
    fields.push(
      ...collectFields(model.model, arrayItemValue(resultValue), [
        ...pathSegments,
        "*",
      ]),
    );
  }

  return fields;
};

const queryResultDefinitionRow = async (
  pool: PgPool,
  resultId: string,
): Promise<ResultDefinitionRow> => {
  const result = await pool.query<ResultDefinitionRow>(
    `
      SELECT
        r.data AS result_data,
        fn.data->'model' AS model
      FROM agentic.flow_run_results r
      JOIN agentic.flow_nodes fn
        ON fn.id = r.node_id
       AND fn.flow_version_id = r.flow_version_id
      WHERE r.id = $1::uuid
    `,
    [resultId],
  );

  const row = result.rows[0];
  if (!row?.model) {
    throw new Error(`No model definition found for result ${resultId}`);
  }
  return row;
};

const buildDefinition = async (options: {
  pool: PgPool;
  selectedCase: SelectedCase;
  publicCase: PublicCase;
}): Promise<ResultDefinition> => {
  const row = await queryResultDefinitionRow(
    options.pool,
    options.selectedCase.resultId,
  );

  return {
    schemaVersion: "result-definition/v1",
    caseId: options.publicCase.caseId,
    resultType: options.publicCase.resultType,
    purpose:
      "Explains the fields in result.json so citations can support the intended meaning of each value.",
    resultFile: "result.json",
    fields: collectFields(row.model, row.result_data),
  };
};

const main = async () => {
  const args = parseArgs();
  const selectedCases = (
    await readJson<{ cases: SelectedCase[] }>(
      path.join(args.root, ".internal", "selected-cases.json"),
    )
  ).cases;
  const publicCases = (
    await readJson<{ cases: PublicCase[] }>(path.join(args.root, "manifest.json"))
  ).cases;

  const pairedCases = publicCases.map((publicCase, index) => ({
    publicCase,
    selectedCase: selectedCases[index],
  }));
  const casesToExport = args.all
    ? pairedCases
    : pairedCases.filter(({ publicCase }, index) =>
        args.caseId ? publicCase.caseId === args.caseId : index === 0,
      );

  if (casesToExport.length === 0) {
    throw new Error(`No matching case found${args.caseId ? `: ${args.caseId}` : ""}`);
  }

  const pool = createPool();
  try {
    for (const { publicCase, selectedCase } of casesToExport) {
      if (!selectedCase) {
        throw new Error(`Missing internal selection for ${publicCase.caseId}`);
      }
      const definition = await buildDefinition({
        pool,
        selectedCase,
        publicCase,
      });
      const outputPath = path.join(
        args.root,
        publicCase.directory,
        "result-definition.json",
      );
      await writeJson(outputPath, definition);
      console.log(`Wrote ${path.relative(args.root, outputPath)}`);
    }
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
