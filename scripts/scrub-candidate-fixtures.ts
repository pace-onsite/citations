import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type PrivateFile = {
  entityId?: string;
  entityName?: string;
  entityType?: string;
  rawFile: string;
  ocrFile: string | null;
  renderedPdf: string | null;
  hasReductoChunks?: boolean;
};

type PrivateCase = {
  id: string;
  orgSlug?: string;
  taskName?: string;
  flowName?: string;
  nodeName?: string;
  createdAt?: string;
  durationMs?: number | null;
  dataBytes?: number;
  fileCounts?: Record<string, number>;
  files: PrivateFile[];
  directory: string;
  referenceMetrics?: {
    runDurationMs?: number | null;
    llmCallCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
};

type Manifest = {
  generatedAt?: string;
  totals?: Record<string, number>;
  cases: PrivateCase[];
};

type PublicFile = {
  documentName: string;
  documentType: string;
  file: string;
  ocrArtifact: string | null;
  renderedPdf: string | null;
  hasOcrArtifact: boolean;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, "..");

const parseRoot = (): string => {
  const args = process.argv.slice(2);
  const index = args.indexOf("--root");
  return path.resolve(index === -1 ? defaultRoot : (args[index + 1] ?? defaultRoot));
};

const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(filePath, "utf8")) as T;

const writeJson = async (filePath: string, value: unknown) => {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const scrubTitle = (value: string | undefined): string => {
  const cleaned = (value ?? "")
    .replace(/\[[^\]]*(?:eval|scheduled|test|dry-run|probe|fix|validation|baseline|smoke)[^\]]*\]/gi, "")
    .replace(/\b(?:eval|test|dry[- ]run|probe|baseline|smoke)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:_-]+|[\s:_-]+$/g, "");
  return cleaned || "Insurance Review";
};

const inferDomain = (testCase: PrivateCase) => {
  const haystack = `${testCase.flowName ?? ""} ${testCase.nodeName ?? ""} ${
    testCase.taskName ?? ""
  }`.toLowerCase();

  if (haystack.includes("coi") || haystack.includes("certificate")) {
    return {
      scenario: "Certificate of insurance request",
      reviewType: "Certificate evidence review",
      resultType: resultTypeForNode(testCase.nodeName, "Certificate request"),
      directorySlug: "certificate-evidence-review",
    };
  }

  if (haystack.includes("placement") || haystack.includes("binder")) {
    return {
      scenario: "Commercial property placement submission",
      reviewType: "Placement evidence review",
      resultType: resultTypeForNode(testCase.nodeName, "Placement summary"),
      directorySlug: "placement-evidence-review",
    };
  }

  if (haystack.includes("loss run") || haystack.includes("large losses")) {
    return {
      scenario: "Commercial loss-run packet",
      reviewType: "Loss-run evidence review",
      resultType: resultTypeForNode(testCase.nodeName, "Loss-run summary"),
      directorySlug: "loss-run-evidence-review",
    };
  }

  return {
    scenario: "Property claim document packet",
    reviewType: "Claim estimate evidence review",
    resultType: resultTypeForNode(testCase.nodeName, "Claim estimate summary"),
    directorySlug: "claim-evidence-review",
  };
};

const resultTypeForNode = (
  nodeName: string | undefined,
  fallback: string,
): string => {
  const readableName = scrubTitle(nodeName)
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compactName = readableName.replace(/[^a-z0-9]+/gi, "").toLowerCase();
  const knownResultTypes: Record<string, string> = {
    acord25export: "Certificate form summary",
    addplacement: "Placement summary",
    clientinfomodel: "Insured profile",
    decmodel: "Policy declaration summary",
    estimatemodel: "Estimate summary",
    glrmodel: "General loss report summary",
    guidelinesshared: "Certificate guideline summary",
    insurancedatamodel: "Binder insurance summary",
    lossrunsextraction: "Loss-run claim summary",
    mandatoryroofagelifedepreciation: "Roof depreciation check",
    mandatoryroofageslifedepreciation: "Roof depreciation check",
    policynumbers: "Policy number list",
    request: "Certificate request",
    standardlargelosses: "Large loss summary",
  };
  const knownType = knownResultTypes[compactName];
  if (knownType) {
    return knownType;
  }

  const normalized = readableName.replace(/model$/i, " summary").trim();
  if (!normalized || /^[0-9a-f-]{20,}$/i.test(normalized)) {
    return fallback;
  }
  return normalized;
};

const publicCaseId = (testCase: PrivateCase, index: number): string => {
  const domain = inferDomain(testCase);
  return `${String(index + 1).padStart(2, "0")}-${domain.directorySlug}`;
};

const renameFile = async (from: string, to: string) => {
  if (from === to) return;
  await fs.rm(to, { force: true });
  await fs.rename(from, to);
};

const documentExtension = (fileName: string): string => {
  const extension = path.extname(fileName);
  return extension || ".dat";
};

const publicDocumentType = (file: PrivateFile): string => {
  const rawType = (file.entityType ?? documentExtension(file.rawFile).slice(1))
    .toLowerCase()
    .trim();
  if (rawType.includes("email")) return "email-json";
  if (rawType.includes("spreadsheet") || rawType.includes("excel")) {
    return path.extname(file.rawFile).replace(".", "").toLowerCase() || "spreadsheet";
  }
  return rawType || "document";
};

const publicFilesForCase = async (
  caseDir: string,
  files: PrivateFile[],
): Promise<PublicFile[]> => {
  const filesDir = path.join(caseDir, "files");
  const sourceFiles: PublicFile[] = [];

  for (const [index, file] of files.entries()) {
    const sequence = String(index + 1).padStart(2, "0");
    const baseName = `document-${sequence}`;
    const rawFile = `${baseName}${documentExtension(file.rawFile)}`;
    const ocrArtifact = file.ocrFile ? `${baseName}-ocr.json` : null;
    const renderedPdf = file.renderedPdf ? `${baseName}-rendered.pdf` : null;

    await renameFile(path.join(filesDir, file.rawFile), path.join(filesDir, rawFile));

    if (file.ocrFile && ocrArtifact) {
      await renameFile(
        path.join(filesDir, file.ocrFile),
        path.join(filesDir, ocrArtifact),
      );
    }

    if (file.renderedPdf && renderedPdf) {
      await renameFile(
        path.join(filesDir, file.renderedPdf),
        path.join(filesDir, renderedPdf),
      );
    }

    sourceFiles.push({
      documentName: `Source document ${sequence}`,
      documentType: publicDocumentType(file),
      file: rawFile,
      ocrArtifact,
      renderedPdf,
      hasOcrArtifact: Boolean(ocrArtifact),
    });
  }

  return sourceFiles;
};

const publicFileCounts = (
  counts: Record<string, number> | undefined,
): Record<string, number> => {
  if (!counts) return {};
  const { reducto, ...rest } = counts;
  return {
    ...rest,
    ...(reducto === undefined ? {} : { ocr: reducto }),
  };
};

const publicMetadata = (
  testCase: PrivateCase,
  caseId: string,
  sourceFiles: PublicFile[],
) => {
  const domain = inferDomain(testCase);
  return {
    caseId,
    caseTitle: `${domain.reviewType} ${caseId.slice(0, 2)}`,
    industry: "Insurance",
    scenario: domain.scenario,
    reviewType: domain.reviewType,
    resultType: domain.resultType,
    receivedAt: testCase.createdAt ?? null,
    resultSizeBytes: testCase.dataBytes ?? null,
    sourceFileCounts: publicFileCounts(testCase.fileCounts),
    sourceFiles,
    benchmarkMetrics: {
      totalLatencyMs:
        testCase.referenceMetrics?.runDurationMs ?? testCase.durationMs ?? null,
      modelCallCount: testCase.referenceMetrics?.llmCallCount ?? 0,
      inputTokens: testCase.referenceMetrics?.inputTokens ?? 0,
      outputTokens: testCase.referenceMetrics?.outputTokens ?? 0,
      cachedInputTokens: testCase.referenceMetrics?.cachedInputTokens ?? 0,
    },
  };
};

const publicTotals = (
  totals: Record<string, number> | undefined,
): Record<string, number> => {
  return totals ?? {};
};

const moveSelectedCasesInternal = async (root: string) => {
  const rootSelectionPath = path.join(root, "selected-cases.json");
  const internalDir = path.join(root, ".internal");
  const internalSelectionPath = path.join(internalDir, "selected-cases.json");
  await fs.mkdir(internalDir, { recursive: true });

  try {
    await fs.rename(rootSelectionPath, internalSelectionPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
};

const main = async () => {
  const root = parseRoot();
  const manifestPath = path.join(root, "manifest.json");
  const manifest = await readJson<Manifest>(manifestPath);

  const publicCases = [];

  for (const [index, testCase] of manifest.cases.entries()) {
    if (!Array.isArray(testCase.files)) {
      throw new Error(
        "Manifest is already public or missing private file metadata. Re-run generate-fixtures.ts --export-only before scrubbing.",
      );
    }

    const caseId = publicCaseId(testCase, index);
    const oldDir = path.join(root, testCase.directory);
    const newDir = path.join(root, "test-cases", caseId);

    if (oldDir !== newDir) {
      await fs.rm(newDir, { recursive: true, force: true });
      await fs.rename(oldDir, newDir);
    }

    const sourceFiles = await publicFilesForCase(newDir, testCase.files);
    const metadata = publicMetadata(testCase, caseId, sourceFiles);
    const sourceIndex = {
      files: metadata.sourceFiles,
      note:
        "OCR artifacts are JSON chunk files generated from the matching source document. Rendered PDFs are included for spreadsheet sources when available.",
    };

    await writeJson(path.join(newDir, "metadata.json"), metadata);
    await writeJson(path.join(newDir, "source-index.json"), sourceIndex);

    publicCases.push({
      ...metadata,
      directory: path.relative(root, newDir),
    });
  }

  await writeJson(manifestPath, {
    generatedAt: manifest.generatedAt ?? new Date().toISOString(),
    totals: publicTotals(manifest.totals),
    cases: publicCases,
  });
  await moveSelectedCasesInternal(root);

  console.log(`Scrubbed ${publicCases.length} candidate-facing cases`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
