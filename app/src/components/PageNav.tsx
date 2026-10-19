export type Page = "review" | "eval";

export function currentPage(): Page {
  return new URLSearchParams(location.search).get("page") === "eval" ? "eval" : "review";
}

export function pageHref(page: Page, params: Record<string, string | null | undefined> = {}): string {
  const q = new URLSearchParams();
  if (page === "eval") q.set("page", "eval");
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : location.pathname;
}

export function PageNav({ page }: { page: Page }) {
  return (
    <nav className="pagenav" aria-label="pages">
      <a className={page === "review" ? "on" : ""} href={pageHref("review")}>
        Review
      </a>
      <a className={page === "eval" ? "on" : ""} href={pageHref("eval")}>
        Eval set
      </a>
    </nav>
  );
}
