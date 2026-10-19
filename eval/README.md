# Citation eval set

An edge-case evaluation set for the citation workbench. It answers: *given a result field, did the run cite the right evidence — and, just as important, did it refuse to cite when there is nothing to cite?*

| File | Purpose |
|---|---|
| `eval-set.json` | 56 items across 8 cases. Each item = one JSON Pointer in a case `result.json`, its edge-case tags, the expected behaviour, and ground-truth evidence in `citations/v1` anchor shapes. |
| `eval-set.schema.json` | JSON Schema for `eval-set.json`. Anchors reference `../schema/citations.schema.json#/$defs/Anchor`. |
| `../scripts/validate-eval-set.ts` | Re-derives every ground-truth anchor from the fixtures (OCR word indexes → boxes, UTF-16 offsets → text, pointers → values, A1 refs → cells) and fails on any drift. Run `npx -y tsx scripts/validate-eval-set.ts`. |
| `../scripts/score-eval.ts` | Scores a run directory of `<caseId>.citations.json` files with the matching and pass rules below, validates anchors against the sources (via `app/server/validateCitations.ts`), and emits the metrics listed under *Metrics to report*. Run `npx -y tsx scripts/score-eval.ts --run <dir> [--category <tag>] [--case <id>] [--baseline <report.json>] [--json] [--output <report.json>]`. Unit tests: `npx -y tsx --test scripts/score-eval.test.ts`. |

The ground truth was generated from the fixtures, not typed by hand: page-region boxes come from `provenance.wordIndexes` through the same clamp-and-merge-per-line logic the UI uses, text spans are UTF-16 offsets into the raw file (line endings preserved), and spreadsheet cells were read from the workbook XML. A page-region `page` is the PDF page (`bbox.original_page`). `bbox.page` resets inside long OCR jobs and is not the page the highlight belongs on. The validator checks all of that independently, so a fixture change that invalidates an item shows up immediately.

## Why these edge cases

The set is built around the failure modes that a naive "find the value string" approach gets wrong:

**A result value can have several citations.** `01.date_of_loss` is on the loss report PDF *and* in long form ("Dec 20, 2025") in an email JSON; `34.Metadata.Requestor.name` is in a `.txt` and inside HTML markup; `29.claim_list.0.claim_number` is in an email subject and on 20+ photo-sheet pages. Items with `minAcceptableMatches: 2` require the run to find more than one.

**An exact string match is not a citation.** Several fields repeat the same characters in the wrong section, on the wrong page, or in a downstream copy. Those hits are `forbidden` (or `secondary` when they restate the right fact from the wrong artifact). Examples: `27.Policy_Effective_Date` is only the first declarations page, even though "Policy Period From: 7/1/2025" is repeated later; `02...Roof_Name` is the Detached Garage roofing section, not every "Detached Garage" in the recap or coverage allocation; `19...EffectiveDate` is that policy's loss-run `documentEffectiveDate`, not another policy's expiration that happens to be 08/11/2022; `39...eachOccurrence` is coverage code EAOCC, not the PIADV or auto CSL limits that are also 5000000. `many-occurrences` is reserved for values where every listed hit actually satisfies the field definition (`29.policy_number` is labeled "Policy #:" on every photo sheet).

**One citation can need several boxes.** A first + last name is two OCR words (`29.insured_full_name`); a policy term is two dates with "To:" between them (`01.policy_term`); "MYCON 70846" is assembled from two strings in a quotation (`34...jobNameAndNumber`). Ground truth is one anchor with merged box(es) per line — not a union rectangle over unrelated text. Partial-name fields (`29.insured_first_name`) want a box over only that word; the full-name box is tolerated as `secondary`.

**Zeros are not all the same.** Case 19 is a loss-run packet where a 48-row result has `$0` / `0` in most money and count columns, and the source spreadsheet row is full of `0` cells. The set separates four situations that look identical in `result.json`:

| Category | Example | Expected |
|---|---|---|
| `zero:real` — the 0 is printed in the source | `19...PaidMedical` (cell R6 = 0), `01.coverage_list/5` ("Replacement Cost $0.00") | **cite** the specific cell/word; neighbouring zeros in other columns are `forbidden` |
| `zero:default` — "if empty display 0", no source | `19...RecordOnlyClaims`, `19...Recovery`, `19.LossRuns/46/Premium` | **empty**; every other `0` in the row is listed as `forbidden` |
| `zero:null-source` — the source field is explicitly `null` | `19.LossRuns/38/Premium` | **context-only**: cite the `null` as context, never a real dollar amount |
| `zero:derived` — computed by counting | `19...OpenClaims` (O/C column = "C") | **context-only**: the column the count came from |

**Blank is a valid answer — for several reasons.**

| Category | Example | Expected |
|---|---|---|
| `blank:absent` — field doesn't exist in any document | `02...IWS_Q`, `19...Rate`, `29.fnol_date`, `24.Year_of_Installation_Roof` | **empty**; tempting neighbours (loss date, Year Built) are `forbidden` |
| `blank:present-empty` — the field exists but has no value | `29.loss_address_line2`, `39.insured.address.line2` | **empty**; a context anchor on the one-line address is tolerated |
| `blank:by-design` — parent flag is false | `39...umbrellaExcessLiability.policyNumber` | **empty**; the parent `requested: false` is acceptable context |

**Lists.** 21 items point into arrays, including: a row whose value is identical to a sibling row's (`02.Dep%_Entered_Roofs/1` — "48%" appears under both Detached Garage and Barn Shingle Roof; the Barn occurrences are `forbidden`), empty arrays (`02.Drywall_Rooms`, `39.coverages.otherPolicies`), and pointers with spaces / `%` in keys (`/Loss Runs/0/Premium`, `/Contact List/0/First Name`).

**Every file type in the dataset.**

| Type | Items | Anchor kind | Notes |
|---|---|---|---|
| PDF + OCR | 27 | `page-region` | boxes re-derived from `wordIndexes` |
| JSON (structured) | 13 | `json-pointer` | includes a 1.3 MB raw API payload (case 39) |
| JSON (email) | 4 | `text-span` + `pointer` | `bodyPlain` in case 29 has an emoji, so UTF-16 offsets ≠ code-point offsets after it (`offsets:utf16-surrogates`) |
| XLSX | 8 | `sheet-range` + `sheet` | incl. evidence on the *second* worksheet (`19...ValuationDate`). OCR block bboxes for spreadsheets are 1-based **cell** units (`left:1, top:5` = `A5`), not page fractions |
| CSV | 3 | `sheet-range` (no `sheet`) | every CSV in the dataset is a downstream model-check export, so CSV hits are `secondary`; case 27's CSV has two columns both headed "Deductible" |
| TXT | 6 | `text-span` | whitespace-aligned quotation / signature |
| EML | 2 | `text-span` | offsets into the raw RFC 822 file with CRLF preserved |
| HTML | 2 | `text-span` | offsets into raw markup, not stripped text |

Also exercised: an OCR artifact that exists for a *non*-PDF (`29.examiner`, `document-02.json` has a `-ocr.json`; page-region anchors on it are schema-invalid), and a 17 MB extension-less file in case 24 that the loader must not choke on.

## Item shape

```jsonc
{
  "id": "19.LossRuns.5.PaidMedical",
  "caseId": "19-loss-run-evidence-review",
  "pointer": "/Loss Runs/5/Paid Medical",
  "value": "$0",                       // copied from result.json; validator checks for drift
  "fieldType": "string",
  "fieldDefinition": "…",               // from result-definition.json; explains defaults / N/A rules
  "categories": ["zero:real", "file:xlsx", "list-item", "distractor:same-value-other-column"],
  "expect": "cite",                     // cite | context-only | empty
  "minAcceptableMatches": 1,            // only for cite; >1 on multi-citation items
  "acceptable": [ { "label": "…", "quote": "0", "anchors": [ /* citations/v1 anchors */ ] } ],
  "requiredContext": [ /* optional evidence that must be matched with role: "context" */ ],
  "secondary":  [ /* not wrong, not sufficient alone (derived CSV, over-wide box) */ ],
  "forbidden":  [ /* known distractors; matching one is a false positive */ ],
  "notes": "…"
}
```

An **evidence entry** is one logical piece of evidence, possibly several anchors (a `label` anchor plus a `value` anchor; or two spans that together form the value). A produced citation matches an evidence entry when one of its anchors matches a value-role ground-truth anchor (or any anchor, if the entry has no value-role anchor). If that entry also has `label` or `context` anchors, the same citation must cover at least one of them — the words around the value that identify the field. A single box that overlaps both the value and the label counts. Items may also declare `requiredContext`; only produced anchors explicitly marked `role: "context"` satisfy those entries.

## Matching a produced anchor to a ground-truth anchor

| Kind | Match when |
|---|---|
| `page-region` | same `file` and `page`, and IoU of the box unions ≥ 0.5, **or** the produced union covers ≥ 80 % of the ground-truth union and is ≤ 3× its area (lets a slightly wide box count, blocks a whole-page box) |
| `text-span` | same `file` and same `pointer` (both absent counts as same); overlap ≥ 50 % of the ground-truth span and produced span ≤ 2× its length |
| `json-pointer` | same `file`, identical pointer. A `text-span` with the same `pointer` covering the whole string also matches |
| `sheet-range` | same `file` and `sheet`; the ground-truth cell is inside the produced range and the produced range is ≤ 4 cells |

A produced anchor with role `label` or `context` is never a false positive on its own; only `value`-role anchors (role omitted = value) are judged.

## Pass rules per `expect`

| `expect` | Pass when | Fails when |
|---|---|---|
| `cite` | ≥ `minAcceptableMatches` distinct `acceptable` entries are matched by value-role anchors, plus ≥ `minRequiredContextMatches` (default 1) when `requiredContext` is present | missing required context; any `forbidden` match; or a value-role anchor matches nothing (unmatched = presumed wrong) |
| `context-only` | the list is empty, **or** every produced anchor matches an `acceptable`/`secondary` entry (any role) | any unmatched value-role anchor; any `forbidden` match |
| `empty` | no produced citation has a value-role anchor (label/context anchors matching `acceptable` are tolerated) | any value-role anchor; any `forbidden` match |

Citations with `status: "rejected"` are ignored for pass/fail and counted separately as reviewer corrections.

## Metrics to report

- **Pass rate**, overall and sliced by `expect`, by each `categories` tag, and by `file:*` tag. The interesting slices are `zero:*`, `blank:*`, `distractor:*`, and the per-file-type rows.
- **Precision**: value-role anchors that matched `acceptable`+`secondary` ÷ all value-role anchors. `forbidden` hits reported separately — they are the most informative failures.
- **Recall over `acceptable`** on `multi-citation` items.
- **Dedupe**: on `many-occurrences` items, how many citations were emitted for the one value (`29.policy_number` has 31 occurrences).
- **Cost / latency per item**, which the README asks for anyway. `many-occurrences` and `file:large-json` items are the ones that blow up token counts if a run stuffs whole files into a prompt.

## Caveats

- `secondary` evidence is deliberately neutral. The CSV files look like sources but are model-check exports that *restate the result*; a run that cites only the CSV has not actually grounded the value, but it has not cited something false either.
- `01.garage_roof_age` is an inference (the garage is attached, so the dwelling roof age applies). It is marked `cite` because the definition's alternative ("N/A if there is no garage") does not apply; reasonable people could call it `context-only`.
- Ground truth for `.xls` (legacy binary Excel) cells is not covered — case 19 was chosen over case 15 because it is `.xlsx`, which the dependency-free validator can read.
- `expect` is about citation behaviour, not result correctness.

## Item index

| id | pointer | value | expect | categories |
|---|---|---|---|---|
| `01.date_of_loss` | `/date_of_loss` | `"12/20/2025"` | cite (≥2) | multi-citation, normalization:date — _pdf, email-json_ |
| `01.policy_term` | `/policy_term` | `"3/18/2025 to 3/18/2026"` | cite | multi-box, normalization:composite — _pdf_ |
| `01.coverage_list.0.coverage_insurance` | `/coverage_list/0/coverage_insurance` | `100000` | cite | list-item, normalization:currency, distractor:same-label-other-table — _pdf_ |
| `01.coverage_list.5.coverage_insurance` | `/coverage_list/5/coverage_insurance` | `0` | cite | zero:real, list-item, distractor:same-label-other-table — _pdf_ |
| `01.coverage_list.7.coverage_insurance` | `/coverage_list/7/coverage_insurance` | `0` | cite | zero:real, list-item, distractor:same-label-other-table — _pdf_ |
| `01.garage_roof_age` | `/garage_roof_age` | `"10"` | cite | inferred, normalization:type — _pdf_ |
| `01.dwelling_roof_age` | `/dwelling_roof_age` | `10` | cite | distractor:derived-artifact, normalization:type — _pdf, csv_ |
| `01.Tenants` | `/Tenants` | `true` | cite | boolean:label-presence — _pdf_ |
| `01.FA_Name` | `/FA_Name` | `"Amyn Bana"` | cite | name, multi-box, multi-citation, distractor:same-name-wrong-context — _pdf_ |
| `02.Roof_Information.0.IWS_Q` | `/Roof_Information/0/IWS_Q` | `""` | empty | blank:absent, list-item — _pdf_ |
| `02.Drywall_Rooms` | `/Drywall_Rooms` | `[]` | empty | list-empty, distractor:near-miss-line-item — _pdf_ |
| `02.Dep%_Entered_Roofs.1.Dep%_Entered` | `/Dep%_Entered_Roofs/1/Dep%_Entered` | `"48%"` | cite | list-item, list-row-disambiguation, pointer:special-chars — _pdf_ |
| `02.Dep%_Entered_Roofs.1.Roof_Name` | `/Dep%_Entered_Roofs/1/Roof_Name` | `"Detached Garage"` | cite | list-item, pointer:special-chars, distractor:exact-match-wrong-context — _pdf_ |
| `19.LossRuns.0.Premium` | `/Loss Runs/0/Premium` | `"$44,001"` | cite | normalization:currency, pointer:special-chars, list-item, distractor:derived-artifact — _json_ |
| `19.LossRuns.38.Premium` | `/Loss Runs/38/Premium` | `"$0"` | context-only | zero:null-source, list-item — _json_ |
| `19.LossRuns.46.Premium` | `/Loss Runs/46/Premium` | `"$0"` | empty | zero:default, list-item — _json_ |
| `19.LossRuns.5.TotalIncurred` | `/Loss Runs/5/Total Incurred` | `"$847,000"` | cite | normalization:currency, list-item — _xlsx_ |
| `19.LossRuns.5.PaidMedical` | `/Loss Runs/5/Paid Medical` | `"$0"` | cite | zero:real, list-item, distractor:same-value-other-column — _xlsx_ |
| `19.LossRuns.5.RecordOnlyClaims` | `/Loss Runs/5/Record-Only Claims` | `0` | empty | zero:default, list-item, spreadsheet:zeros-everywhere — _xlsx_ |
| `19.LossRuns.5.Recovery` | `/Loss Runs/5/Recovery` | `"$0"` | empty | zero:default, list-item, spreadsheet:zeros-everywhere — _xlsx_ |
| `19.LossRuns.5.OpenClaims` | `/Loss Runs/5/Open Claims` | `0` | context-only | zero:derived, list-item — _xlsx_ |
| `19.LossRuns.5.Rate` | `/Loss Runs/5/Rate` | `""` | empty | blank:absent, list-item — _xlsx_ |
| `19.LossRuns.5.EffectiveDate` | `/Loss Runs/5/Effective Date` | `"08/11/2022"` | cite | normalization:date, list-item, distractor:exact-match-wrong-context, distractor:same-value-other-field — _json, xlsx_ |
| `19.LossRuns.5.ValuationDate` | `/Loss Runs/5/Valuation Date` | `"05/11/2025"` | cite | list-item, multi-citation — _xlsx, xlsx-second-sheet_ |
| `29.insured_full_name` | `/insured_full_name` | `"Sharon Lewis"` | cite | name, multi-box, multi-citation — _pdf_ |
| `29.insured_first_name` | `/insured_first_name` | `"Sharon"` | cite | name, name:partial — _pdf_ |
| `29.insured_last_name` | `/insured_last_name` | `"Lewis"` | cite | name, name:partial — _pdf_ |
| `29.examiner` | `/examiner` | `"Jesse Hope"` | cite | name, normalization:name-order, ocr-artifact-for-non-pdf — _email-json_ |
| `29.client_adjuster` | `/client_adjuster` | `"Thomas Guzman"` | cite | name, offsets:utf16-surrogates, many-occurrences — _email-json_ |
| `29.claim_list.0.claim_number` | `/claim_list/0/claim_number` | `"00201868651"` | cite (≥2) | list-item, many-occurrences, multi-citation, cross-file-type, offsets:utf16-surrogates — _pdf, email-json_ |
| `29.ContactList.0.FirstName` | `/Contact List/0/First Name` | `"Sharon"` | cite | list-item, pointer:special-chars, name, name:partial — _pdf_ |
| `29.claimant_last_name` | `/claimant_last_name` | `""` | empty | blank:absent, name — _pdf_ |
| `29.fnol_date` | `/fnol_date` | `""` | empty | blank:absent, distractor:adjacent-date — _pdf_ |
| `29.loss_address_line2` | `/loss_address_line2` | `""` | empty | blank:present-empty — _pdf_ |
| `29.public_adjuster_address_line1` | `/public_adjuster_address_line1` | `"N/A"` | context-only | constant:rule — _pdf_ |
| `29.policy_number` | `/policy_number` | `"PSM016057011"` | cite | many-occurrences — _pdf_ |
| `34.CertificateParties.namedInsured` | `/CertificateParties/namedInsured` | `"dormakaba USA Inc. - Houston"` | cite | — _txt_ |
| `34.Metadata.Requestor.name` | `/Metadata/Requestor/name` | `"Tiara Williams"` | cite (≥2) | multi-citation, name, cross-file-type — _txt, html_ |
| `34.Metadata.Requestor.phone` | `/Metadata/Requestor/phone` | `"317.526.6346"` | cite | multi-citation — _txt, html_ |
| `34.DescriptionOfOperations.projectNameAndNumber` | `/DescriptionOfOperations/projectNameAndNumber` | `"WALMART 2257"` | cite | — _txt_ |
| `34.DescriptionOfOperations.jobNameAndNumber` | `/DescriptionOfOperations/jobNameAndNumber` | `"MYCON 70846"` | cite | multi-box, multi-citation, normalization:composite — _txt, eml_ |
| `34.CertificateParties.holderEmailOrFax` | `/CertificateParties/holderEmailOrFax` | `""` | empty | blank:absent — _txt, eml_ |
| `34.CoverageFacts.Umbrella.specialInterests` | `/CoverageFacts/Umbrella/specialInterests` | `[]` | empty | list-empty |
| `39.insured.fullName` | `/insured/fullName` | `"Sixense, Inc."` | cite | distractor:derived-artifact — _json_ |
| `39.insurers.0.naicCode` | `/insurers/0/naicCode` | `"16535"` | cite | list-item, normalization:type, distractor:derived-artifact — _json, large-json_ |
| `39.insurers.0.fullName` | `/insurers/0/fullName` | `"Zurich American Insurance Company"` | cite | list-item, distractor:derived-artifact — _json, large-json_ |
| `39.coverages.generalLiability.policyNumber` | `/coverages/generalLiability/policyNumber` | `"GLO0184640-10"` | cite | distractor:exact-match-wrong-context, distractor:derived-artifact — _json_ |
| `39.coverages.generalLiability.limits.eachOccurrence` | `/coverages/generalLiability/limits/eachOccurrence` | `"$5,000,000"` | cite | normalization:currency, distractor:exact-match-wrong-context, distractor:same-value-other-field — _json, large-json_ |
| `39.insured.address.line2` | `/insured/address/line2` | `""` | empty | blank:present-empty — _json_ |
| `39.coverages.umbrellaExcessLiability.included` | `/coverages/umbrellaExcessLiability/included` | `false` | cite | boolean:from-boolean — _json_ |
| `39.coverages.umbrellaExcessLiability.policyNumber` | `/coverages/umbrellaExcessLiability/policyNumber` | `""` | empty | blank:by-design — _json_ |
| `39.coverages.otherPolicies` | `/coverages/otherPolicies` | `[]` | empty | list-empty — _json_ |
| `27.Deductible` | `/Deductible` | `2500` | cite | context:required, many-occurrences, distractor:derived-artifact, distractor:duplicate-header, normalization:currency — _pdf, csv_ |
| `27.Policy_Effective_Date` | `/Policy_Effective_Date` | `"07/01/2025"` | cite | normalization:date, distractor:exact-match-wrong-context, distractor:same-value-other-field, distractor:derived-artifact — _pdf, csv_ |
| `24.Year_of_Installation_Roof` | `/Year_of_Installation_Roof` | `""` | empty | blank:absent, distractor:adjacent-field — _pdf_ |
| `24.Year_Built` | `/Year_Built` | `"2022"` | cite | normalization:type, distractor:exact-match-wrong-context — _pdf_ |
