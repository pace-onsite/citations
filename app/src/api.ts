import type { CaseDetail, CaseSummary, CitationSet, CitationsResponse, CiteResponse, EvalResponse } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  schema: () => getJson<Record<string, unknown>>("/api/schema"),
  cases: () => getJson<CaseSummary[]>("/api/cases"),
  evalSet: () => getJson<EvalResponse>("/api/eval"),
  caseDetail: (id: string) => getJson<CaseDetail>(`/api/cases/${encodeURIComponent(id)}`),
  citations: (id: string) => getJson<CitationsResponse>(`/api/cases/${encodeURIComponent(id)}/citations`),
  saveCitations: async (id: string, data: CitationSet) => {
    const res = await fetch(`/api/cases/${encodeURIComponent(id)}/citations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`save failed → ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ ok: true; path: string }>;
  },
  /** Run the citation loop server-side. Nothing is written; the caller merges the proposals. */
  cite: async (id: string, opts: { pointers?: string[]; llm?: boolean } = {}) => {
    const res = await fetch(`/api/cases/${encodeURIComponent(id)}/cite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`cite failed → ${res.status} ${await res.text()}`);
    return res.json() as Promise<CiteResponse>;
  },
  citeStatus: () => getJson<{ configured: boolean; model: string }>("/api/cite/status"),
  fileUrl: (caseId: string, name: string) =>
    `/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(name)}`,
};

/** Per-case cache of fetched source file contents so validators and viewers share one load. */
const textCache = new Map<string, Promise<string>>();
const bufferCache = new Map<string, Promise<ArrayBuffer>>();

export function fetchText(caseId: string, name: string): Promise<string> {
  const key = `${caseId}/${name}`;
  let p = textCache.get(key);
  if (!p) {
    p = fetch(api.fileUrl(caseId, name)).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${name} (${r.status})`);
      return r.text();
    });
    textCache.set(key, p);
  }
  return p;
}

export function fetchBuffer(caseId: string, name: string): Promise<ArrayBuffer> {
  const key = `${caseId}/${name}`;
  let p = bufferCache.get(key);
  if (!p) {
    p = fetch(api.fileUrl(caseId, name)).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${name} (${r.status})`);
      return r.arrayBuffer();
    });
    bufferCache.set(key, p);
  }
  return p;
}

const jsonCache = new Map<string, Promise<unknown>>();
export function fetchJson(caseId: string, name: string): Promise<unknown> {
  const key = `${caseId}/${name}`;
  let p = jsonCache.get(key);
  if (!p) {
    p = fetchText(caseId, name).then((t) => JSON.parse(t) as unknown);
    jsonCache.set(key, p);
  }
  return p;
}
