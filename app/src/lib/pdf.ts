import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { api } from "../api";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const docCache = new Map<string, Promise<PDFDocumentProxy>>();

/** Shared PDF document loader so the viewer and the validator parse each file once. */
export function getPdf(caseId: string, file: string): Promise<PDFDocumentProxy> {
  const key = `${caseId}/${file}`;
  let p = docCache.get(key);
  if (!p) {
    p = pdfjs.getDocument({ url: api.fileUrl(caseId, file) }).promise;
    p.catch(() => docCache.delete(key));
    docCache.set(key, p);
  }
  return p;
}

export { pdfjs };
