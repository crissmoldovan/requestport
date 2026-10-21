/**
 * Reading a TypeScript source as text, for the guards that have to.
 *
 * Several contracts in this repository are decided before anything runs: which
 * module holds a directive, which import crosses which boundary, which class a
 * suite selects. None of them can be observed from a rendered tree — a Server
 * Component that composes a client-only module renders perfectly in jsdom, and
 * a spec selecting a retired class waits out its timeout rather than saying so
 * — so they are read off the sources instead.
 *
 * Reading text has exactly one systematic trap: prose. Every one of these
 * guards has to write down the very shape it forbids in order to look for it,
 * and this repository comments heavily, so a guard that reads comments reports
 * itself and every module that explains the rule. Stripping them is therefore
 * the first step of every such rule, and it lives here so both halves of every
 * guard agree about where the prose ends.
 */

/**
 * A source with its comments replaced by whitespace, and its strings left
 * exactly as written.
 *
 * Strings stay because a guard that quietly stops seeing part of a module is
 * far worse than one that occasionally over-reports: a false positive fails
 * loudly and is fixed in a line, while a false negative is indistinguishable
 * from a clean tree. A rule that needs to tell a directive from a quoted
 * example of one gets that from *where* the quote sits — statement position —
 * rather than from deleting the string it sits in.
 *
 * A comment opens only outside a string, which is the whole reason this is a
 * scanner rather than two replacements: `"https://example.invalid"` carries a
 * line-comment delimiter, and a stripper that matched it anywhere would delete
 * the rest of that line.
 */
export function withoutComments(source: string): string {
  let output = "";
  let quote = "";
  let index = 0;

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (quote) {
      if (character === "\\") {
        output += character + next;
        index += 2;
        continue;
      }
      if (character === quote) quote = "";
      output += character;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      // A space, so the tokens either side of a comment stay two tokens.
      output += " ";
      index = end < 0 ? source.length : end + 2;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

/**
 * A `"use server"` directive, wherever JavaScript lets one be written.
 *
 * The App Router compiles two shapes into action endpoints: a module whose head
 * is the directive, and an ordinary module that puts the directive at the head
 * of a *function body*. The second is the one a top-of-file pattern cannot see,
 * and it is by far the cheaper of the two to write — a lone `async function`
 * inside an otherwise unremarkable module is a Server Action, and nothing about
 * the file around it says so. A rule that reads only line 1 therefore answers
 * "no action endpoint here" about precisely the file most likely to hold one.
 *
 * A directive is a *statement*, so it is read only where a statement may begin:
 * at the head of the module, or straight after `{`, `}` or `;`. That is the
 * whole difference between a directive and the two ways this repository writes
 * the same characters without meaning them — a `toContain` argument and a
 * quoted pattern — where the quote is preceded by something no statement can
 * follow.
 *
 * It lives here because two dispatch boundaries now read it: the tenant switch
 * and the tenant creation, which are the same cookie write and owe the same
 * rule.
 */
const serverDirective = /(?:^|[{};])\s*(["'])use server\1\s*;/u;

export function declaresServerDirective(source: string): boolean {
  return serverDirective.test(withoutComments(source));
}

/**
 * A source with every string literal emptied, and its quotes, its `${…}`
 * substitutions and its own length left exactly as written.
 *
 * `withoutComments` keeps strings on purpose, because a rule that has to tell a
 * directive from a quoted example of one decides that from statement position
 * rather than by deleting the quote. A rule about *calls* needs the opposite:
 * `"context()"` is a sentence, not a call, and a rule that read it as one would
 * clear an action that authorizes nowhere — a false negative, which is the one
 * kind of wrong that reads exactly like a clean tree.
 *
 * Lengths are preserved so an index read off the blanked text is an index in
 * the source, and a template's substitutions are kept because they are code: a
 * submission read written inside `${…}` is a read, and blanking it would
 * introduce the blindness this exists to remove.
 */
export function withoutStringContents(source: string): string {
  const output: string[] = [];
  const stack: string[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index] ?? "";
    const inside = stack.at(-1);

    if (inside === "'" || inside === '"' || inside === "`") {
      if (character === "\\") {
        output.push("  ");
        index += 2;
        continue;
      }
      if (character === inside) {
        stack.pop();
        output.push(character);
        index += 1;
        continue;
      }
      if (inside === "`" && character === "$" && source[index + 1] === "{") {
        stack.push("${");
        output.push("${");
        index += 2;
        continue;
      }
      // A newline stays a newline: every rule above reads line structure.
      output.push(character === "\n" ? "\n" : " ");
      index += 1;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      stack.push(character);
    } else if (character === "{") {
      stack.push("{");
    } else if (character === "}" && (inside === "{" || inside === "${")) {
      stack.pop();
    }
    output.push(character);
    index += 1;
  }

  return output.join("");
}
