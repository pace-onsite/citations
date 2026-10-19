export interface DocumentSearchProps {
  searchQuery: string;
  activeSearchIndex: number;
  onSearchCount: (count: number) => void;
}

export function findOccurrences(text: string, query: string): { start: number; end: number }[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const haystack = text.toLocaleLowerCase();
  const matches: { start: number; end: number }[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) break;
    matches.push({ start, end: start + needle.length });
    from = start + Math.max(1, needle.length);
  }
  return matches;
}
