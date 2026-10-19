# Citations

## The Problem

Insurance reviewers often receive a structured summary plus a messy packet of supporting documents: PDFs, emails, spreadsheets, JSON exports, and OCR output. Your task is to build a small workbench that helps a reviewer answer one question:

> For each important value in `result.json`, where did it come from?

The workbench should load one test case, show the structured result, let the reviewer inspect source documents, and produce field-level citations that point back to the supporting evidence.

This is intentionally open-ended. A strong solution does not need to be perfect across every file type, but it should make clear tradeoffs, handle a few representative cases well, and expose cost, latency, and quality metrics for the citation run.

## What To Build

- Load a test case folder containing `result.json` and `files/`.
- Use `result-definition.json` to understand what each result field means.
- Display the result in a UI where a reviewer can select fields.
- Display source files in a useful way.
- Generate or let the reviewer create citations for result fields.
- Save citation output keyed by JSON Pointer paths, such as `/insured/name` or `/claims/0/dateOfLoss`.
- Track runtime metrics: Accuracy, Cost and Latency are all really important here
  - Accuracy is tough to measure here without a ground truth, so we can focus on just ballpark accuracy vibes and focus more on cost and latency metrics.

You may use an LLM, deterministic parsing, or really any approach.

## Dataset

The fixture set contains 40 insurance review cases:

- Claim estimate reviews.
- Commercial loss-run reviews.
- Property placement reviews.
- Certificate of insurance reviews.

Across the dataset there are:

- 374 raw source files.
- 231 PDFs.
- 39 Excel files and 59 spreadsheet files total.
- 78 structured JSON/TXT/email-style files.
- 271 OCR artifact files named with the `*-ocr.json` suffix.

Each case lives under `test-cases/<case-id>/`:

```text
result.json                  # The structured result that needs citations.
result-definition.json       # Field names, types, and instructions for interpreting result values.
files/                       # Source documents and optional OCR artifacts.
metadata.json                # Case metadata and benchmark metrics.
source-index.json            # Inventory of source files for the case.
```

Use `result-definition.json` when a raw value is ambiguous. For example, a boolean like `"Tenants": true` may mean "the TENANT(S) field on the loss report has a non-empty value," not that the reviewer should independently infer tenant occupancy.

## File Examples

PDF with OCR:

```text
files/document-03.pdf
files/document-03-ocr.json
```

For a PDF, the OCR file contains chunked text and layout information. A citation might point to the PDF page and bounding box, or to the OCR chunk that supports the value.

Structured file without OCR:

```text
files/document-05.json
```

For JSON, TXT, CSV, or email-style files, there may be no OCR artifact. A citation can use a JSON path, line/character offsets, or another clear text location.

Spreadsheet with a rendered PDF:

```text
files/document-09.xlsx
files/document-09-ocr.json
files/document-09-rendered.pdf
```

For spreadsheets, you can cite cells or ranges directly, cite extracted text, or use the rendered PDF for page-based visual citations. Explain the tradeoff you choose.

## Citation Output

Use any reasonable schema, but it should be easy to validate. One possible shape:

```json
{
  "/insured/name": [
    {
      "file": "document-03.pdf",
      "type": "pdf-bbox",
      "page": 2,
      "bbox": {
        "top": 0.24,
        "left": 0.12,
        "width": 0.31,
        "height": 0.02
      }
    }
  ],
  "/claims/0/claimNumber": [
    {
      "file": "document-05.json",
      "type": "json-path",
      "path": "$.claims[0].claimNumber"
    }
  ]
}
```

The exact schema is less important than consistency, inspectability, and whether a reviewer can use it to verify the result.

## Suggested Few-Hour Scope

Start with one or two cases and make the core loop work end to end:

- Pick a field in `result.json`.
- Find likely supporting evidence in the source files.
- Show the evidence in the UI.
- Save a citation for that field.
- Report basic metrics.

Then expand coverage across file types. A good implementation that handles PDFs with OCR, raw JSON/TXT-style files, and one spreadsheet strategy is more valuable than a broad but shallow implementation.

## How We Evaluate

We care about:

- Correctness: citations actually support the cited values.
- UX: a reviewer can inspect, adjust, and trust the citations.
- File coverage: the approach handles OCR-backed PDFs, non-OCR structured files, and spreadsheets.
- Engineering judgment: clear data model, simple abstractions, and reasonable error handling.
- Metrics: latency, estimated cost, citation coverage, invalid citation count, and any quality signal you add.
- Tradeoffs: clear explanation of what works, what is partial, and what you would improve next.
