import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router-dom";
import type { EntitySummary } from "../api.js";
import { resolveWikiLinks } from "../lib/wikilinks.js";

/**
 * Renders knowledge-base markdown (wiki pages, digests). [[Entity Name]] wiki
 * links resolve to internal routes; internal hrefs navigate via the router.
 * When `onInternalLink` is supplied, internal links call it instead of routing —
 * so a host (e.g. the chat's wiki side panel) can open them in place.
 */
export function Markdown({
  text,
  entities,
  onInternalLink,
}: {
  text: string;
  entities: EntitySummary[];
  onInternalLink?: (href: string) => void;
}) {
  const resolved = useMemo(() => resolveWikiLinks(text, entities), [text, entities]);

  return (
    <div className="prose-meos">
      <ReactMarkdown
        components={{
          a: ({ href, children }) =>
            href?.startsWith("/") ? (
              onInternalLink ? (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onInternalLink(href);
                  }}
                >
                  {children}
                </a>
              ) : (
                <Link to={href}>{children}</Link>
              )
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
