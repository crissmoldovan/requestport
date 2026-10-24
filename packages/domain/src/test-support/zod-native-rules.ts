/*
  A reading of TypeScript source for zod rules written natively that zod
  4.6.7 answers differently from 4.4.3, the zod RequestPort 0.2.0 published
  its API on (`shared/zod-compat.ts` keeps 4.4.3's answer for each):
  - `.max(…)`, `.length(…)`, and `.min(n)` with `n` not a literal 0 or 1, on a
    chain rooted in a zod string schema (`z.string()`, `z.uuid()`,
    `z.coerce.string()`, `z.iso.date()`, `isoDatetime()`, `trimmedUrl()`, …):
    4.6.7 counts code points;
  - `z.maxLength(…)`, `z.minLength(…)` and `z.length(…)`, the same checks
    written as values, outside `utf16Max` and `utf16Min`;
  - `z.url()` and `.url()`: 4.6.7 removes a tab or a newline;
  - `z.iso.datetime(…)` outside `isoDatetime`: 4.6.7 requires seconds;
  - `z.email(…)` and `.email(…)` handed no `pattern`: 4.6.7's pattern is
    another string.

  It reads source rather than running it, so it sees modules no test can
  load (apps/web's server actions among them). It is a reading, not a
  compiler: comments, strings, template literals and regular expression
  literals are blanked first, and a receiver chain is followed back through
  calls and property reads to its root. A chain rooted in an identifier is
  followed to that identifier's `const` in the same file; a root it still
  cannot read is reported as `unknown root`, so that a reader decides
  rather than the scan passing it.
*/

const stringRoots = new Set([
  "string",
  "email",
  "url",
  "httpUrl",
  "uuid",
  "guid",
  "cuid",
  "cuid2",
  "ulid",
  "nanoid",
  "base64",
  "base64url",
  "hostname",
  "ipv4",
  "ipv6",
  "e164",
  "jwt",
  "emoji",
  "stringFormat",
  "templateLiteral",
]);
const isoStringRoots = new Set(["datetime", "date", "time", "duration"]);
const otherRoots = new Set([
  "number",
  "int",
  "int32",
  "uint32",
  "float32",
  "float64",
  "bigint",
  "array",
  "set",
  "map",
  "record",
  "tuple",
  "object",
  "strictObject",
  "looseObject",
  "file",
  "date",
]);
const stringMethods = new Set([
  "trim",
  "toLowerCase",
  "toUpperCase",
  "lowercase",
  "uppercase",
  "normalize",
  "regex",
  "startsWith",
  "endsWith",
  "includes",
  "slugify",
]);
const otherMethods = new Set([
  "int",
  "positive",
  "negative",
  "nonnegative",
  "nonpositive",
  "gt",
  "gte",
  "lt",
  "lte",
  "multipleOf",
  "step",
  "finite",
  "safe",
  "element",
]);
/** Calls that keep their receiver's kind. */
const neutralMethods = new Set([
  "min",
  "max",
  "length",
  "nonempty",
  "check",
  "refine",
  "superRefine",
  "overwrite",
  "describe",
  "meta",
  "brand",
  "with",
  "optional",
  "nullable",
  "nullish",
  "default",
  "catch",
  "readonly",
]);
/** Bare names whose `.max(…)`, `.min(…)` or `.length(…)` is no schema's. */
const nonSchemaRoots = new Set(["z", "Math"]);
/** This repository's own helpers that return a string schema. */
const ownStringHelpers = new Set(["isoDatetime", "trimmedUrl"]);

/**
 * `source` with every comment, string, template literal and regular
 * expression literal replaced by spaces of the same length (line breaks
 * kept), so that positions still match the source.
 */
export function blankLiterals(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let at = from; at < to; at += 1) if (out[at] !== "\n") out[at] = " ";
  };
  let at = 0;
  // The last significant character, to tell a division from a regex.
  let previous = "";
  const templateDepths: number[] = [];
  let braceDepth = 0;
  while (at < source.length) {
    const char = source[at] as string;
    const next = source[at + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", at);
      const stop = end < 0 ? source.length : end;
      blank(at, stop);
      at = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", at + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(at, stop);
      at = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = at + 1;
      while (end < source.length && source[end] !== char) {
        if (source[end] === "\\") end += 1;
        end += 1;
      }
      blank(at + 1, end);
      at = end + 1;
      previous = char;
      continue;
    }
    if (
      char === "`" ||
      (char === "}" &&
        templateDepths.length > 0 &&
        templateDepths.at(-1) === braceDepth)
    ) {
      if (char === "}") templateDepths.pop();
      let end = at + 1;
      while (end < source.length && source[end] !== "`") {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === "$" && source[end + 1] === "{") break;
        end += 1;
      }
      blank(at + 1, end);
      if (source[end] === "$") {
        templateDepths.push(braceDepth);
        at = end + 2;
        previous = "{";
      } else {
        at = end + 1;
        previous = "`";
      }
      continue;
    }
    if (
      char === "/" &&
      (previous === "" || /[(,=:[!&|?{};+\-*%<>~^]/u.test(previous))
    ) {
      let end = at + 1;
      let inClass = false;
      while (end < source.length && source[end] !== "\n") {
        const c = source[end];
        if (c === "\\") {
          end += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        end += 1;
      }
      if (source[end] === "/") {
        blank(at + 1, end);
        at = end + 1;
        previous = "/";
        continue;
      }
    }
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth -= 1;
    if (!/\s/u.test(char)) previous = char;
    at += 1;
  }
  return out.join("");
}

/** The position of the bracket that opens the one closing at `close`. */
function openingBracket(text: string, close: number): number {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  for (let at = close; at >= 0; at -= 1) {
    const char = text[at] as string;
    if (char in pairs) stack.push(pairs[char] as string);
    else if (char === "(" || char === "[" || char === "{") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return at;
    }
  }
  return -1;
}

/** The position of the bracket that closes the one opening at `open`. */
function closingBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let at = open; at < text.length; at += 1) {
    const char = text[at] as string;
    if (char in pairs) stack.push(pairs[char] as string);
    else if (char === ")" || char === "]" || char === "}") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return at;
    }
  }
  return -1;
}

type Link = { name: string; call: boolean };

/**
 * The chain a member call's receiver is, read back from `end` (the position
 * just before its `.`): root first.
 */
function receiverChain(text: string, end: number): Link[] {
  const links: Link[] = [];
  let at = end;
  for (;;) {
    while (at >= 0 && /\s/u.test(text[at] as string)) at -= 1;
    let call = false;
    if (text[at] === ")") {
      const open = openingBracket(text, at);
      if (open < 0) return [];
      at = open - 1;
      call = true;
      while (at >= 0 && /\s/u.test(text[at] as string)) at -= 1;
      // A type argument list: `fn<T>(…)`.
      if (text[at] === ">") {
        let depth = 0;
        for (; at >= 0; at -= 1) {
          if (text[at] === ">") depth += 1;
          else if (text[at] === "<") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        at -= 1;
      }
    } else if (text[at] === "!") {
      at -= 1;
      continue;
    }
    let start = at;
    while (start >= 0 && /[\w$]/u.test(text[start] as string)) start -= 1;
    const name = text.slice(start + 1, at + 1);
    if (!name) return [{ name: "", call }, ...links];
    links.unshift({ name, call });
    at = start;
    while (at >= 0 && /\s/u.test(text[at] as string)) at -= 1;
    if (text[at] === "." && text[at - 1] !== ".") {
      at -= 1;
      continue;
    }
    if (text[at] === "." && text[at - 1] === "?") {
      at -= 2;
      continue;
    }
    return links;
  }
}

type Kind = "string" | "other" | `unknown root ${string}`;

function kindOfChain(
  links: Link[],
  constants: Map<string, Link[]>,
  seen: Set<string> = new Set(),
): Kind {
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index] as Link;
    const before = links[index - 1];
    const beforeThat = links[index - 2];
    if (link.call && before?.name === "z" && index === 1) {
      if (stringRoots.has(link.name)) return "string";
      if (otherRoots.has(link.name)) return "other";
      return `unknown root z.${link.name}`;
    }
    if (
      link.call &&
      before &&
      !before.call &&
      beforeThat?.name === "z" &&
      index === 2
    ) {
      if (before?.name === "iso" && isoStringRoots.has(link.name))
        return "string";
      if (before?.name === "coerce")
        return link.name === "string" ? "string" : "other";
      return `unknown root z.${before?.name}.${link.name}`;
    }
    if (index === 0) {
      if (link.call && ownStringHelpers.has(link.name)) return "string";
      if (!link.call && constants.has(link.name) && !seen.has(link.name)) {
        seen.add(link.name);
        return kindOfChain(constants.get(link.name) ?? [], constants, seen);
      }
      return `unknown root ${link.name}${link.call ? "()" : ""}`;
    }
    if (!link.call) continue;
    if (stringMethods.has(link.name)) return "string";
    if (otherMethods.has(link.name)) return "other";
    if (neutralMethods.has(link.name)) continue;
    return `unknown root .${link.name}()`;
  }
  return "unknown root (none)";
}

/** Each `const name = <chain>` in the file, its chain read back. */
function constantChains(text: string): Map<string, Link[]> {
  const found = new Map<string, Link[]>();
  for (const match of text.matchAll(/\bconst\s+([\w$]+)(?:\s*:[^=]+)?\s*=/gu)) {
    let end = (match.index ?? 0) + match[0].length;
    // The expression runs to the `;` or the line break at bracket depth 0.
    let depth = 0;
    let stop = end;
    for (; stop < text.length; stop += 1) {
      const char = text[stop] as string;
      if ("([{".includes(char)) depth += 1;
      else if (")]}".includes(char)) {
        if (depth === 0) break;
        depth -= 1;
      } else if ((char === ";" || char === ",") && depth === 0) break;
    }
    while (stop > end && /\s/u.test(text[stop - 1] as string)) stop -= 1;
    end = stop - 1;
    const name = match[1] as string;
    found.set(name, receiverChain(text, end));
  }
  return found;
}

/** The body ranges of each `function <name>(…) {…}` named in `names`. */
function functionBodies(text: string, names: readonly string[]) {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/\bfunction\s+([\w$]+)\s*\(/gu)) {
    if (!names.includes(match[1] as string)) continue;
    const open = text.indexOf("(", match.index);
    const close = closingBracket(text, open);
    const brace = text.indexOf("{", close);
    const end = closingBracket(text, brace);
    if (brace >= 0 && end >= 0) ranges.push([brace, end]);
  }
  return ranges;
}

export interface NativeRule {
  line: number;
  rule: string;
}

/**
 * Every native zod rule in `source` that zod 4.6.7 answers differently from
 * 4.4.3, with its line, in source order.
 */
export function nativeZodRules(source: string): NativeRule[] {
  const text = blankLiterals(source);
  const constants = constantChains(text);
  const found: Array<{ at: number; rule: string }> = [];
  const inside = (at: number, ranges: Array<[number, number]>) =>
    ranges.some(([from, to]) => at > from && at < to);
  const lengthHelpers = functionBodies(text, ["utf16Max", "utf16Min"]);
  const datetimeHelpers = functionBodies(text, ["isoDatetime"]);
  const argumentsOf = (open: number) =>
    source.slice(open + 1, Math.max(open + 1, closingBracket(text, open)));

  for (const match of text.matchAll(/\.\s*(max|min|length)\s*\(/gu)) {
    const at = match.index ?? 0;
    const method = match[1] as string;
    if (text[at - 1] === ".") continue;
    const open = at + match[0].length - 1;
    const argument = argumentsOf(open).trim();
    if (method === "min" && /^[01](\s*,|$)/u.test(argument)) continue;
    const chain = receiverChain(text, at - 1);
    // `z.length(…)` is read below; `Math.max(…)` is no schema.
    const [root] = chain;
    if (
      chain.length === 1 &&
      !root?.call &&
      nonSchemaRoots.has(root?.name ?? "")
    )
      continue;
    const kind = kindOfChain(chain, constants);
    if (kind === "other") continue;
    found.push({
      at,
      rule:
        kind === "string"
          ? `.${method}(${argument}) on a string counts code points`
          : `.${method}(${argument}) on a chain with an ${kind}`,
    });
  }
  for (const match of text.matchAll(
    /\bz\s*\.\s*(maxLength|minLength|length)\s*\(/gu,
  )) {
    const at = match.index ?? 0;
    if (inside(at, lengthHelpers)) continue;
    found.push({ at, rule: `z.${match[1]}() counts code points` });
  }
  for (const match of text.matchAll(/(\bz\s*)?\.\s*url\s*\(/gu)) {
    found.push({
      at: match.index ?? 0,
      rule: "url() removes tabs and newlines",
    });
  }
  for (const match of text.matchAll(/\bz\s*\.\s*iso\s*\.\s*datetime\s*\(/gu)) {
    const at = match.index ?? 0;
    if (inside(at, datetimeHelpers)) continue;
    found.push({ at, rule: "z.iso.datetime() requires seconds" });
  }
  for (const match of text.matchAll(/(\bz\s*)?\.\s*email\s*\(/gu)) {
    const at = match.index ?? 0;
    const open = at + match[0].length - 1;
    if (/\bpattern\b/u.test(argumentsOf(open))) continue;
    found.push({ at, rule: "email() carries 4.6.7's pattern" });
  }
  return found
    .sort((left, right) => left.at - right.at)
    .map(({ at, rule }) => ({
      line: source.slice(0, at).split("\n").length,
      rule,
    }));
}
