import { Link as CueLink } from "@cueplusplus/ui/layout";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * Request prose, painted from CUE++ tokens.
 *
 * The retired `.markdown-content` recipe carried a colour ramp, three pixel
 * type sizes and a hard-coded code-block ground, none of which followed the
 * theme or the density the reader chose. Every element the renderer emits is
 * given its own token-backed classes instead, so the same prose is
 * ultra-compact under one appearance and large under another without a second
 * stylesheet — and `break-words` on the container keeps an unbroken URL inside
 * the measure rather than widening the console's one scroller.
 */

const proseClasses =
  "flex min-w-0 flex-col gap-(--cue-space-2) break-words text-(length:--cue-text-ui) text-fg-muted";

const headingClasses = "font-mono text-(length:--cue-text-label) text-fg";

const codeClasses =
  "rounded-control border border-border bg-surface-2 px-(--cue-space-1) font-mono text-(length:--cue-text-micro) text-fg";

const preClasses =
  "overflow-x-auto border border-border bg-sunken p-(--cue-space-3) font-mono text-(length:--cue-text-micro) text-fg";

export function safeMarkdownUrl(value: string) {
  if (
    (value.startsWith("/") && !value.startsWith("//")) ||
    value.startsWith("#")
  ) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  const schemeSeparator = value.indexOf("://");
  const rawAuthority =
    schemeSeparator >= 0
      ? value.slice(schemeSeparator + 3).split(/[/?#]/u, 1)[0]
      : undefined;
  if (
    !(url.protocol === "https:" || url.protocol === "http:") ||
    !rawAuthority ||
    rawAuthority.includes("@") ||
    url.username ||
    url.password
  ) {
    return "";
  }
  return url.toString();
}

export function MarkdownContent({ children }: { children: string }) {
  return (
    <div className={proseClasses}>
      <ReactMarkdown
        components={{
          a: ({ children: linkChildren, href }) => {
            const safeHref = href ? safeMarkdownUrl(href) : "";
            if (!safeHref) return <span>{linkChildren}</span>;
            const external = /^(?:https?:)?\/\//u.test(safeHref);
            return (
              <CueLink
                className="break-all"
                href={safeHref}
                rel={external ? "noreferrer noopener" : undefined}
                target={external ? "_blank" : undefined}
                variant="underline"
              >
                {linkChildren}
              </CueLink>
            );
          },
          code: ({ children: codeChildren, className }) =>
            // A fenced block arrives as a `code` inside a `pre`, and carries a
            // language class; the inline chip must not wear the block's rim
            // twice, so only the unclassed form is inked here.
            className ? (
              <code className={className}>{codeChildren}</code>
            ) : (
              <code className={codeClasses}>{codeChildren}</code>
            ),
          h1: ({ children: headingChildren }) => (
            <h3 className={headingClasses}>{headingChildren}</h3>
          ),
          h2: ({ children: headingChildren }) => (
            <h3 className={headingClasses}>{headingChildren}</h3>
          ),
          h3: ({ children: headingChildren }) => (
            <h3 className={headingClasses}>{headingChildren}</h3>
          ),
          img: ({ alt }) => (
            <span className="font-mono text-fg-subtle">
              {alt ? `[Image: ${alt}]` : "[External image omitted]"}
            </span>
          ),
          ol: ({ children: listChildren }) => (
            <ol className="flex list-decimal flex-col gap-(--cue-space-1) ps-(--cue-space-5)">
              {listChildren}
            </ol>
          ),
          pre: ({ children: preChildren }) => (
            <pre className={preClasses}>{preChildren}</pre>
          ),
          ul: ({ children: listChildren }) => (
            <ul className="flex list-disc flex-col gap-(--cue-space-1) ps-(--cue-space-5)">
              {listChildren}
            </ul>
          ),
        }}
        rehypePlugins={[rehypeSanitize]}
        remarkPlugins={[remarkGfm]}
        urlTransform={safeMarkdownUrl}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
