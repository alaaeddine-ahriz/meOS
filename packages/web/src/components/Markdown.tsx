import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router-dom";
import type { EntitySummary } from "../api.js";

/**
 * Renders knowledge-base markdown. [[Entity Name]] wiki links are resolved to
 * internal routes using the entity index; unresolved links render as plain text.
 */
export function Markdown({ text, entities }: { text: string; entities: EntitySummary[] }) {
  const resolved = useMemo(() => {
    const slugByName = new Map(entities.map((e) => [e.name.toLowerCase(), e.slug]));
    return text.replace(/\[\[([^\]]+)\]\]/g, (_match, name: string) => {
      const slug = slugByName.get(name.trim().toLowerCase());
      return slug ? `[${name}](/wiki/${slug})` : name;
    });
  }, [text, entities]);

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
