import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router-dom";
import type { EntitySummary } from "../api.js";
import { resolveWikiLinks } from "../lib/wikilinks.js";

/**
 * Renders knowledge-base markdown (wiki pages, digests). [[Entity Name]] wiki
 * links resolve to internal routes; internal hrefs navigate via the router.
 */
export function Markdown({ text, entities }: { text: string; entities: EntitySummary[] }) {
  const resolved = useMemo(() => resolveWikiLinks(text, entities), [text, entities]);

  return (
    <div className="prose-meos">
      <ReactMarkdown
        components={{
          a: ({ href, children }) =>
            href?.startsWith("/") ? (
              <Link to={href}>{children}</Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {resolved}
      </ReactMarkdown>
    </div>
  );
}
