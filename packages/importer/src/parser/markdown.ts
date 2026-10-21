import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import type { ParsedLegacyRecord } from "./types.js";

/**
 * The version an import run records for the analysis that produced its
 * entries (a correction run records its run's, suffixed `:correction`). v2
 * inferred project hints from a record's text; v3, since J.2b (ruling 175,
 * owner question 4), infers none, and the analyzer gives every record
 * `missing_project`.
 */
export const LEGACY_PARSER_VERSION = "requestport-legacy-markdown-v3";
function unique(values: string[]) {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

function normalizeLegacyKey(value: string) {
  return value.toUpperCase().replace(/[ _]/gu, "-");
}

const EXPLICIT_RECORD_HEADING =
  /^(?:#{1,2})\s+(?:(?:FR|BR|REQ|BUG|HANDOFF)[-_ ]?\d{1,8}\b|(?:feature|bug)\s+request\b)/iu;

function splitExplicitRecords(markdown: string) {
  const candidates = [...markdown.matchAll(/^#{1,2}\s+.+$/gmu)]
    .filter((match) => EXPLICIT_RECORD_HEADING.test(match[0]))
    .map((match) => match.index ?? 0);
  if (candidates.length < 2) return [markdown];
  return candidates.map((start, index) => {
    const end = candidates[index + 1] ?? markdown.length;
    const preamble = index === 0 ? markdown.slice(0, start) : "";
    return `${preamble}${markdown.slice(start, end)}`.trim();
  });
}

function parseSingleRecord(
  markdown: string,
  recordIndex: number,
): ParsedLegacyRecord {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const headings: Array<{ depth: number; value: string }> = [];
  const listItems: string[] = [];
  visit(tree, "heading", (node) =>
    headings.push({ depth: node.depth, value: mdastToString(node).trim() }),
  );
  visit(tree, "listItem", (node) => listItems.push(mdastToString(node).trim()));
  const title =
    headings[0]?.value ||
    markdown
      .split(/\r?\n/u)
      .find((line) => line.trim())
      ?.replace(/^#+\s*/u, "")
      .trim();
  const keys = unique(
    [...markdown.matchAll(/\b(?:FR|BR|REQ|BUG|HANDOFF)[-_ ]?\d{1,8}\b/giu)].map(
      (match) => normalizeLegacyKey(match[0]),
    ),
  );
  const headingKey = title?.match(
    /\b(?:FR|BR|REQ|BUG|HANDOFF)[-_ ]?\d{1,8}\b/iu,
  )?.[0];
  const primaryKey = headingKey ? normalizeLegacyKey(headingKey) : keys[0];
  const relatedLegacyKeys = keys.filter((key) => key !== primaryKey);
  const pathHints = unique(
    [
      ...markdown.matchAll(
        /(?:^|[\s`(])((?:src|apps|packages|docs|feature-requests|handoffs)\/[A-Za-z0-9._/+-]+)/gmu,
      ),
    ].map((match) => match[1] as string),
  );
  const acceptanceCriteria = headings.some((heading) =>
    /acceptance|criteria|done when/iu.test(heading.value),
  )
    ? listItems.filter((item) => item.length <= 1_000).slice(0, 100)
    : [];
  const status = markdown
    .match(/(?:^|\n)\s*(?:status|state)\s*[:|-]\s*([^\n]+)/iu)?.[1]
    ?.trim();
  const lowered = `${title ?? ""}\n${markdown.slice(0, 2_000)}`.toLowerCase();
  const kind: ParsedLegacyRecord["kind"] = /handoff|hand-off/iu.test(lowered)
    ? "handoff"
    : /response|reply|evaluation/iu.test(lowered)
      ? "response"
      : /research|investigation/iu.test(lowered)
        ? "research"
        : keys.length || /feature request|bug report|request/iu.test(lowered)
          ? "request"
          : "unknown";
  const warnings: string[] = [];
  if (keys.length > 1 && kind === "handoff") warnings.push("ambiguous_bundle");
  if (!title) warnings.push("missing_title");
  if (!keys.length) warnings.push("missing_legacy_key");
  return {
    recordIndex,
    kind,
    ...(primaryKey
      ? { legacyKey: { namespace: "legacy", normalizedKey: primaryKey } }
      : {}),
    ...(title ? { title: title.slice(0, 240) } : {}),
    bodyMarkdown: markdown,
    ...(status ? { statusClaim: status.slice(0, 120) } : {}),
    acceptanceCriteria,
    referencedPaths: pathHints,
    relatedLegacyKeys,
    confidence: {
      kind: kind === "unknown" ? 0.2 : 0.8,
      title: title ? 0.9 : 0,
      legacyKey: primaryKey ? 0.85 : 0,
    },
    warnings,
  };
}

export function parseLegacyArtifact(markdown: string): ParsedLegacyRecord[] {
  return splitExplicitRecords(markdown).map(parseSingleRecord);
}
