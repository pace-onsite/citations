import { useState } from "react";

interface Props {
  caseId: string;
  raw: string;
}

export function RawResultView({ caseId, raw }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(raw);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="raw-result">
      <div className="json-meta raw-result-meta">
        <span>{`test-cases/${caseId}/result.json`}</span>
        <button type="button" className="raw-copy" onClick={copy}>
          {copied ? "Copied" : "Copy raw JSON"}
        </button>
      </div>
      <pre className="raw-json">{raw}</pre>
    </div>
  );
}
