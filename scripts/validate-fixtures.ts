import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Manifest = {
  totals?: {
    cases?: number;
    files?: number;
    pdfFiles?: number;
    excelFiles?: number;
    structuredFiles?: number;
    ocrFiles?: number;
  };
  cases?: Array<{
    id?: string;
    caseId?: string;
    directory: string;
    files?: Array<{
      rawFile?: string;
      ocrFile?: string | null;
      file?: string;
      ocrArtifact?: string | null;
      renderedPdf?: string | null;
    }>;
    sourceFiles?: Array<{
      file?: string;
      ocrArtifact?: string | null;
      renderedPdf?: string | null;
    }>;
  }>;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, "..");

const parseArgs = (): { root: string; expectedCases: number } => {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const expectedCasesIndex = args.indexOf("--expected-cases");
  const expectedCasesRaw =
    expectedCasesIndex === -1 ? "20" : args[expectedCasesIndex + 1];
  const expectedCases = Number.parseInt(expectedCasesRaw ?? "", 10);
  if (!Number.isInteger(expectedCases) || expectedCases <= 0) {
    throw new Error("--expected-cases must be a positive integer");
  }

  return {
    root: path.resolve(
      rootIndex === -1 ? defaultRoot : (args[rootIndex + 1] ?? defaultRoot),
    ),
    expectedCases,
  };
};

const assertFile = async (filePath: string) => {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }
  if (stat.size === 0) {
    throw new Error(`${filePath} is empty`);
  }
};

const readJson = async <T>(filePath: string): Promise<T> => {
  await assertFile(filePath);
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
};

const main = async () => {
  const { root, expectedCases } = parseArgs();
  const manifest = await readJson<Manifest>(path.join(root, "manifest.json"));
  const cases = manifest.cases ?? [];
  if (cases.length !== expectedCases) {
    throw new Error(`Expected ${expectedCases} cases, found ${cases.length}`);
  }
  if ((manifest.totals?.excelFiles ?? 0) < 1) {
    throw new Error("Expected at least one Excel file");
  }
  if ((manifest.totals?.pdfFiles ?? 0) < 1) {
    throw new Error("Expected at least one PDF file");
  }
  if ((manifest.totals?.structuredFiles ?? 0) < 1) {
    throw new Error("Expected at least one structured JSON/TXT-style file");
  }
  if ((manifest.totals?.ocrFiles ?? 0) < 1) {
    throw new Error("Expected at least one OCR artifact");
  }

  for (const testCase of cases) {
    const caseDir = path.join(root, testCase.directory);
    await readJson(path.join(caseDir, "result.json"));
    await readJson(path.join(caseDir, "result-definition.json"));
    await readJson(path.join(caseDir, "metadata.json"));
    await readJson(path.join(caseDir, "source-index.json"));

    const files = testCase.files ?? testCase.sourceFiles ?? [];
    const caseId = testCase.id ?? testCase.caseId ?? testCase.directory;
    if (files.length === 0) {
      throw new Error(`${caseId} has no files`);
    }

    for (const file of files) {
      const rawFile = file.rawFile ?? file.file;
      if (!rawFile) {
        throw new Error(`${caseId} has a file entry without a file path`);
      }
      await assertFile(path.join(caseDir, "files", rawFile));
      const ocrFile = file.ocrFile ?? file.ocrArtifact;
      if (ocrFile) {
        await readJson(path.join(caseDir, "files", ocrFile));
      }
      if (file.renderedPdf) {
        await assertFile(path.join(caseDir, "files", file.renderedPdf));
      }
    }
  }

  console.log(
    `Validated ${cases.length} cases with ${manifest.totals?.files ?? "unknown"} raw files`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
