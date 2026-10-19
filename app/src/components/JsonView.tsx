import { useEffect, useMemo, useRef } from "react";
import type { SchemaError } from "../lib/validate";
import type { CitationSet, CitationsResponse } from "../types";

interface Props {
  set: CitationSet;
  loaded: CitationsResponse | null;
  selectedPointer: string | null;
  schemaErrors: SchemaError[];
  onSelectPointer: (pointer: string) => void;
}

/**
 * Shows the citation file as it will be written, one block per JSON pointer so the
 * selected field's block can be highlighted and scrolled to. Schema errors are listed
 * at the top and attached to the block they belong to.
 */
export function JsonView({ set, loaded, selectedPointer, schemaErrors, onSelectPointer }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { citations, ...head } = set;
  const headText = useMemo(() => {
    const s = JSON.stringify(head, null, 2);
    return s.slice(0, -2); // drop closing "\n}" so we can continue the object
  }, [head]);
  const pointers = Object.keys(citations);

  useEffect(() => {
    if (!selectedPointer) return;
    ref.current?.querySelector<HTMLElement>(`[data-ptr="${CSS.escape(selectedPointer)}"]`)?.scrollIntoView({ block: "start" });
  }, [selectedPointer]);

  return (
    <div className="jsonview" ref={ref}>
      <div className="json-meta">
        <span>{loaded?.path ?? "citations.json"}</span>
        <span>{schemaErrors.length === 0 ? "✓ valid against citations/v1" : `${schemaErrors.length} schema error${schemaErrors.length === 1 ? "" : "s"}`}</span>
      </div>
      {schemaErrors.length > 0 && (
        <ul className="schema-errors">
          {schemaErrors.map((e, i) => (
            <li key={i} onClick={() => e.pointer && onSelectPointer(e.pointer)}>
              <code>{e.instancePath || "/"}</code> {e.message.replace(e.instancePath, "").trim()}
            </li>
          ))}
        </ul>
      )}
      <pre className="json head">{headText + (pointers.length ? ",\n  \"citations\": {" : ",\n  \"citations\": {}\n}")}</pre>
      {pointers.map((ptr, i) => {
        const body = JSON.stringify(citations[ptr], null, 2).replace(/\n/g, "\n    ");
        const errs = schemaErrors.filter((e) => e.pointer === ptr);
        return (
          <pre
            key={ptr}
            data-ptr={ptr}
            className={`json block ${ptr === selectedPointer ? "selected" : ""} ${errs.length ? "has-error" : ""}`}
            onClick={() => onSelectPointer(ptr)}
          >
            {`    ${JSON.stringify(ptr)}: ${body}${i < pointers.length - 1 ? "," : ""}`}
          </pre>
        );
      })}
      {pointers.length > 0 && <pre className="json tail">{"  }\n}"}</pre>}
    </div>
  );
}
