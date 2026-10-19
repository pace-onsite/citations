import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { fetchText } from "../../api";
import { indexToCol, inRange, parseCsv, parseRange, type CellRange } from "../../lib/a1";
import { getWorkbook } from "../../lib/validate";
import type { Anchor, SheetRangeAnchor } from "../../types";

interface Props {
  caseId: string;
  file: string;
  anchors: { anchor: Anchor; index: number }[];
  activeIndex: number;
}

const MAX_ROWS = 2000;

/** Grid view for csv/xlsx with sheet-range highlights. For xlsx, each worksheet is a tab. */
export function SheetViewer({ caseId, file, anchors, activeIndex }: Props) {
  const isCsv = /\.csv$/i.test(file);
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setErr(null);
    const load = isCsv
      ? fetchText(caseId, file).then((t) => [{ name: "csv", rows: parseCsv(t).rows }])
      : getWorkbook(caseId, file).then((wb) =>
          wb.SheetNames.map((name) => ({
            name,
            rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, raw: false, defval: "" }) as string[][],
          })),
        );
    load.then((s) => !cancelled && setSheets(s)).catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [caseId, file, isCsv]);

  const ranges = useMemo(
    () =>
      anchors
        .filter((a): a is { anchor: SheetRangeAnchor; index: number } => a.anchor.kind === "sheet-range")
        .map((a) => ({ ...a, range: parseRange(a.anchor.range) }))
        .filter((a): a is typeof a & { range: CellRange } => a.range !== null),
    [anchors],
  );

  // Follow the active anchor's sheet; otherwise first sheet.
  useEffect(() => {
    if (!sheets) return;
    const active = ranges.find((r) => r.index === activeIndex) ?? ranges[0];
    const wanted = isCsv ? sheets[0].name : active?.anchor.sheet;
    setSheetName((cur) => (wanted && sheets.some((s) => s.name === wanted) ? wanted : cur && sheets.some((s) => s.name === cur) ? cur : sheets[0]?.name ?? null));
  }, [sheets, ranges, activeIndex, isCsv]);

  useEffect(() => {
    tableRef.current?.querySelector<HTMLElement>("td.hl.active")?.scrollIntoView({ block: "center", inline: "center" });
  }, [sheets, sheetName, activeIndex]);

  if (err) return <div className="viewer-empty error">{err}</div>;
  if (!sheets) return <div className="viewer-empty">Loading {file}…</div>;
  const sheet = sheets.find((s) => s.name === sheetName) ?? sheets[0];
  if (!sheet) return <div className="viewer-empty">Workbook has no sheets.</div>;

  const sheetRanges = ranges.filter((r) => isCsv || r.anchor.sheet === sheet.name);
  const cols = Math.max(1, ...sheet.rows.map((r) => r.length));
  const rows = showAll ? sheet.rows : sheet.rows.slice(0, MAX_ROWS);

  return (
    <div className="sheet">
      {!isCsv && (
        <div className="sheet-tabs">
          {sheets.map((s) => {
            const hits = ranges.filter((r) => r.anchor.sheet === s.name).length;
            return (
              <button key={s.name} className={`${s.name === sheet.name ? "on" : ""} ${hits ? "has-anchors" : ""}`} onClick={() => setSheetName(s.name)}>
                {s.name}
                {hits > 0 && <span className="pill">{hits}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="sheet-scroll" ref={tableRef}>
        <table>
          <thead>
            <tr>
              <th className="rn" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c}>{indexToCol(c + 1)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th className="rn">{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const hit = sheetRanges.find((sr) => inRange(sr.range, c + 1, r + 1));
                  const active = hit?.index === activeIndex;
                  const v = row[c] ?? "";
                  return (
                    <td
                      key={c}
                      className={hit ? `hl role-${hit.anchor.role ?? "value"} ${active ? "active" : ""}` : ""}
                      title={hit ? `anchor ${hit.index} · ${hit.anchor.range}` : `${indexToCol(c + 1)}${r + 1}`}
                    >
                      {v.length > 300 ? v.slice(0, 300) + "…" : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rows.length > MAX_ROWS && !showAll && (
          <div className="viewer-note">
            showing {MAX_ROWS} of {sheet.rows.length} rows ·{" "}
            <button className="link" onClick={() => setShowAll(true)}>
              show all
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
