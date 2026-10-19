/** A1-style spreadsheet references. Rows/cols are 1-based like Excel. */

export interface CellRef {
  col: number;
  row: number;
}
export interface CellRange {
  start: CellRef;
  end: CellRef;
}

export function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function indexToCol(index: number): string {
  let s = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function parseCell(ref: string): CellRef | null {
  const m = ref.match(/^([A-Z]{1,3})([1-9][0-9]*)$/);
  if (!m) return null;
  return { col: colToIndex(m[1]), row: Number(m[2]) };
}

export function parseRange(range: string): CellRange | null {
  const [a, b] = range.split(":");
  const start = parseCell(a);
  if (!start) return null;
  const end = b ? parseCell(b) : start;
  if (!end) return null;
  return {
    start: { col: Math.min(start.col, end.col), row: Math.min(start.row, end.row) },
    end: { col: Math.max(start.col, end.col), row: Math.max(start.row, end.row) },
  };
}

export function inRange(r: CellRange, col: number, row: number): boolean {
  return col >= r.start.col && col <= r.end.col && row >= r.start.row && row <= r.end.row;
}

/**
 * Minimal RFC 4180 CSV parser (handles quoted fields, escaped quotes, CR/LF).
 * Returns rows of cells plus the character offset where each cell's raw text begins,
 * which lets us cross-reference sheet-range and text-span anchors on the same CSV.
 */
export function parseCsv(text: string): { rows: string[][]; offsets: number[][] } {
  const rows: string[][] = [];
  const offsets: number[][] = [];
  let row: string[] = [];
  let rowOff: number[] = [];
  let cell = "";
  let cellStart = 0;
  let i = 0;
  let inQuotes = false;
  let cellBegun = false;

  const pushCell = () => {
    row.push(cell);
    rowOff.push(cellStart);
    cell = "";
    cellBegun = false;
  };
  const pushRow = () => {
    rows.push(row);
    offsets.push(rowOff);
    row = [];
    rowOff = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (!cellBegun) {
      cellStart = i;
      cellBegun = true;
    }
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushCell();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      pushCell();
      pushRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cellBegun || row.length) {
    pushCell();
    pushRow();
  }
  return { rows, offsets };
}
