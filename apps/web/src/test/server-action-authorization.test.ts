import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { describe, expect, test } from "vitest";

import {
  declaresServerDirective,
  withoutComments,
  withoutStringContents,
} from "./source-text.js";

/**
 * The order a rate-limited Server Action is obliged to do two things in, read
 * out of the sources themselves.
 *
 * A Server Action is a public HTTP endpoint. Nothing about the form that draws
 * it is a precondition for calling it, so an action that parses the submission
 * before it resolves the session answers an anonymous caller a question: *is
 * this body well formed?* On the modules this sweep covers that answer is
 * often addressed to a named control, which makes it a per-field oracle — and
 * because the limiter is resolved by the very call the action skipped, there is
 * no bound on how often it may be asked. Thirty actions across five modules
 * were written that way, one of them a webhook creation reachable only by an
 * organization owner or admin.
 *
 * Reordering thirty call sites by hand fixes today. This is what stops the
 * thirty-first: the rule is read off the source, so an action written in the
 * wrong order fails here rather than shipping.
 *
 * The rule is deliberately narrow, because a narrow rule can be decided from
 * text without a type checker. For each exported action, two positions in its
 * body are located — where it first resolves an authorizing helper, and where
 * it first mentions the parameter its submission arrives in. The first must
 * come before the second. An action that never mentions its submission has
 * nothing to order and is not judged.
 *
 * "Authorizing helper" is itself derived rather than listed: it is any function
 * in the module that reaches `getApplicationContext`, directly or through
 * another such function. A module that renames its helper, or wraps it in one
 * more, therefore stays covered without editing this file.
 *
 * "Exported action" is read the same way. Next compiles an exported async value
 * of a `"use server"` module into an endpoint however it was declared, so this
 * reader decides every form it accepts — a `function` declaration, a `const`
 * bound to an arrow or to a function expression, an arrow with an expression
 * body, a declaration sent out by an export list or as the default — and, more
 * importantly, says so when it meets one it cannot decide. A rule that silently
 * skipped the form nobody has written yet would report no offenders and read
 * exactly like a swept module, which is worse than no rule at all; so an export
 * this reader cannot resolve to a function fails the sweep by name.
 *
 * The sweep itself is the same shape. A `"use server"` module under `src/app/`
 * either owns a limiter in its own text or forwards the submission, untouched,
 * to an implementation that does — and the second kind used to be selected out
 * by the very test that looked for the limiter, which left three modules
 * checked by nothing while the register above read as complete. So the
 * delegation is followed to the declaration that actually reads the form, the
 * rule is applied there, and a dispatcher this reader cannot classify fails by
 * name rather than dropping out of the survey.
 */

const webRoot = resolve(import.meta.dirname, "../..");

/**
 * The rate-limited action modules that still read the submission first.
 *
 * It is empty, and that is a checked claim rather than a hopeful one: the
 * register is asserted in both directions, so a module named here that no
 * longer violates fails this suite — a fix cannot leave a stale exemption
 * behind — and a module that violates without being named here fails it too.
 * Empty therefore means every rate-limited action module in the tree resolves
 * its session before it reads a submission, not that nobody looked.
 *
 * It stays here rather than being deleted because the next module to be written
 * in the wrong order needs somewhere to be recorded while it is being fixed,
 * with the reason, instead of being quietly exempted.
 */
const deferredModules: readonly string[] = [];

/**
 * Every `"use server"` module that owns no limiter because it forwards.
 *
 * They are named for the same reason `orderedModules` is: the delegation
 * follower deciding that a dispatcher is no longer a dispatcher would take
 * three modules back out of the sweep without failing anything.
 */
const delegatingModules: readonly string[] = [
  "src/app/(app)/actions.ts",
  "src/app/(app)/settings/appearance/actions.ts",
  "src/app/(app)/settings/projects/actions.ts",
];

/** Every module the sweep has to keep finding, with its actions. */
const orderedModules: readonly string[] = [
  "src/app/(app)/agents/actions.ts",
  "src/app/(app)/overview-actions.ts",
  "src/app/(app)/imports/actions.ts",
  "src/app/(app)/requests/actions.ts",
  "src/app/(app)/settings/members/actions.ts",
  "src/app/(app)/settings/operations/actions.ts",
  "src/app/(app)/settings/operators/actions.ts",
  "src/app/(app)/settings/projects/[projectId]/actions.ts",
  "src/app/(app)/settings/routing/actions.ts",
  "src/app/(app)/slack/actions.ts",
  "src/app/(app)/webhooks/actions.ts",
  "src/app/oauth/agent-consent/actions.ts",
];

export type ActionOrdering = {
  /** Web-app-relative POSIX path. */
  readonly file: string;
  readonly action: string;
  /** Characters into the body at which an authorizing helper is called. */
  readonly authorizedAt: number;
  /** Characters into the body at which the submission is first mentioned. */
  readonly readsSubmissionAt: number;
};

/* ------------------------------------------------------------------ *
 * Reading a module's functions.
 * ------------------------------------------------------------------ */

/**
 * The index of the `}` that closes the block opened at `from`.
 *
 * Quotes are honoured because a message may carry a brace of its own, and a
 * template literal's `${…}` is skipped whole for the same reason.
 */
function blockEnd(source: string, from: number): number {
  let depth = 0;
  let quote = "";

  for (let index = from; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/** The index of the `)` that closes the list opened at `from`. */
function parenEnd(source: string, from: number): number {
  let depth = 0;
  let quote = "";

  for (let index = from; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/**
 * Where a function's body starts, given the `)` that closed its parameters.
 *
 * The return annotation is skipped rather than searched past, because two of
 * these modules annotate a union of object types — `Promise<{ ok: true; … } |
 * { ok: false; … }>` — whose braces *and* whose semicolons all arrive before
 * the body does. Only a brace written outside every angle bracket opens a body,
 * and only a semicolon written outside every angle bracket ends a declaration
 * that has none.
 */
function bodyStart(source: string, afterParameters: number): number {
  let angles = 0;

  for (let index = afterParameters + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (character === "<") angles += 1;
    else if (character === ">") angles = Math.max(0, angles - 1);
    else if (angles === 0 && character === "{") return index;
    else if (angles === 0 && character === ";") return -1;
  }

  return -1;
}

type FunctionDeclaration = {
  readonly name: string;
  readonly exported: boolean;
  /** The name of the last parameter, or "" when the function takes none. */
  readonly submission: string;
  readonly body: string;
};

/** `_previous: WebhookActionState` — the binding, without its annotation. */
function parameterName(written: string): string {
  return (/^[A-Za-z_$][\w$]*/u.exec(written.trim()) ?? [""])[0];
}

/** The last parameter's name, which is where a submission always arrives. */
function submissionParameter(list: string): string {
  let depth = 0;
  let start = 0;
  const parameters: string[] = [];

  for (let index = 0; index < list.length; index += 1) {
    const character = list[index] ?? "";
    if ("<([{".includes(character)) depth += 1;
    else if (">)]}".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      parameters.push(list.slice(start, index));
      start = index + 1;
    }
  }
  parameters.push(list.slice(start));

  const last = parameters.filter((parameter) => parameter.trim()).at(-1);

  return last ? parameterName(last) : "";
}

/** The first index at or after `from` that is not whitespace. */
function afterSpace(source: string, from: number): number {
  let index = from;
  while (index < source.length && /\s/u.test(source[index] ?? "")) index += 1;

  return index;
}

/** Whether `word` is written at `index` as a whole token rather than a prefix. */
function tokenAt(source: string, index: number, word: string): boolean {
  return (
    source.startsWith(word, index) &&
    !/[\w$]/u.test(source[index + word.length] ?? "")
  );
}

/** The identifier written at `index`, or "" when what is written is not one. */
function identifierAt(source: string, index: number): string {
  return (/^[A-Za-z_$][\w$]*/u.exec(source.slice(index)) ?? [""])[0];
}

/**
 * The index of the `=` that opens a binding's initializer, or -1 when it has
 * none.
 *
 * Only an `=` written outside every bracket counts, so a type annotation of any
 * shape — `Record<string, () => void>`, an object type, a tuple — is stepped
 * over rather than parsed, and `==`, `=>`, `<=`, `>=` and `!=` are not mistaken
 * for one.
 */
function initializerStart(source: string, from: number): number {
  let depth = 0;
  let quote = "";

  for (let index = from; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (depth === 0 && character === ";") return -1;
    else if (
      depth === 0 &&
      character === "=" &&
      !"=>".includes(source[index + 1] ?? "") &&
      !"=!<>".includes(source[index - 1] ?? "")
    ) {
      return index;
    }
  }

  return -1;
}

/**
 * The index just past the `=>` that follows a parameter list closed at `from`,
 * or -1 when no arrow follows one.
 *
 * The return annotation between the two is skipped the same way a binding's is,
 * so `): Promise<(next: State) => State> =>` finds the outer arrow and not the
 * one written inside the type.
 */
function arrowAfter(source: string, from: number): number {
  let depth = 0;
  let quote = "";

  for (let index = from + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (depth === 0 && character === ";") return -1;
    else if (depth === 0 && character === "=" && source[index + 1] === ">") {
      return index + 2;
    }
  }

  return -1;
}

/** The index of the `;` that ends an expression written from `from`. */
function statementEnd(source: string, from: number): number {
  let depth = 0;
  let quote = "";

  for (let index = from; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      depth -= 1;
      // A bracket that closes something we never opened ends the expression as
      // firmly as a semicolon does, and bounds a region to its own block.
      if (depth < 0) return index;
    } else if (depth === 0 && character === ";") return index;
  }

  return source.length;
}

type FunctionShape = {
  /** The name of the last parameter, or "" when the function takes none. */
  readonly submission: string;
  readonly body: string;
};

/**
 * The function written at `from`, in whichever form it is written, or `null`
 * when what is written there is not one.
 *
 * The App Router compiles an exported `async` value into an action endpoint
 * however it was declared, so every form it accepts is read here: a `function`
 * expression named or not, an arrow with a parameter list, an arrow whose only
 * parameter carries no parentheses, and an arrow whose body is an expression
 * rather than a block. `null` is not "nothing to judge" — it is the reader
 * saying it does not know this shape, which the sweep turns into a failure
 * rather than a silent pass.
 */
function functionAt(source: string, from: number): FunctionShape | null {
  let at = afterSpace(source, from);
  if (tokenAt(source, at, "async")) at = afterSpace(source, at + 5);

  if (tokenAt(source, at, "function")) {
    at = afterSpace(source, at + 8);
    if (source[at] === "*") at = afterSpace(source, at + 1);
    at = afterSpace(source, at + identifierAt(source, at).length);
    if (source[at] !== "(") return null;
    const closing = parenEnd(source, at);
    if (closing < 0) return null;
    const opened = bodyStart(source, closing);
    if (opened < 0) return null;
    const ended = blockEnd(source, opened);
    if (ended < 0) return null;

    return {
      body: source.slice(opened + 1, ended),
      submission: submissionParameter(source.slice(at + 1, closing)),
    };
  }

  let submission = "";
  let arrow = -1;
  if (source[at] === "(") {
    const closing = parenEnd(source, at);
    if (closing < 0) return null;
    submission = submissionParameter(source.slice(at + 1, closing));
    arrow = arrowAfter(source, closing);
  } else {
    const only = identifierAt(source, at);
    if (!only) return null;
    const followed = afterSpace(source, at + only.length);
    if (!source.startsWith("=>", followed)) return null;
    submission = only;
    arrow = followed + 2;
  }
  if (arrow < 0) return null;

  const opened = afterSpace(source, arrow);
  if (source[opened] !== "{") {
    return {
      body: source.slice(opened, statementEnd(source, opened)),
      submission,
    };
  }
  const ended = blockEnd(source, opened);

  return ended < 0
    ? null
    : { body: source.slice(opened + 1, ended), submission };
}

const functionHead =
  /(?:^|\n)(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gu;

/** `const`, `let` or `var` written at the module's top level. */
const bindingHead =
  /(?:^|\n)(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu;

/** `export default …`, whose value may be a function or a name declared above. */
const defaultHead = /(?:^|\n)export\s+default\s+/gu;

/** `export { save, rename as renameAction };`, never `export type { … }`. */
const exportList = /(?:^|\n)export\s*\{([^}]*)\}/gu;

type DefaultExport = {
  /** Where the exported value is written. */
  readonly at: number;
  readonly kind: "name" | "declaration" | "value";
  readonly name: string;
};

/** What `export default` sends out: a name declared above, or a value. */
function defaultExport(source: string, from: number): DefaultExport {
  const at = afterSpace(source, from);
  const named = identifierAt(source, at);
  if (named && source[afterSpace(source, at + named.length)] === ";") {
    return { at, kind: "name", name: named };
  }

  const head = tokenAt(source, at, "async") ? afterSpace(source, at + 5) : at;
  if (tokenAt(source, head, "function")) {
    const declared = identifierAt(source, afterSpace(source, head + 8));
    if (declared) return { at, kind: "declaration", name: declared };
  }

  return { at, kind: "value", name: "default" };
}

/**
 * The local names a module sends out through an export list or as its default.
 *
 * A declaration is an endpoint because of where its *name* goes, not because of
 * the keyword written in front of it, so an `export { saveAction }` two hundred
 * lines below makes a plain `async function` exactly as reachable as `export
 * async function` would have.
 */
function exportedElsewhere(source: string): ReadonlySet<string> {
  const names = new Set<string>();

  for (const match of source.matchAll(exportList)) {
    for (const entry of (match[1] ?? "").split(",")) {
      const written = entry.trim();
      if (!written || tokenAt(written, 0, "type")) continue;
      names.add(parameterName(written));
    }
  }
  for (const match of source.matchAll(defaultHead)) {
    const sent = defaultExport(source, match.index + match[0].length);
    if (sent.kind === "name") names.add(sent.name);
  }

  return names;
}

export function functionDeclarations(
  written: string,
): readonly FunctionDeclaration[] {
  const source = withoutStringContents(withoutComments(written));
  const listed = exportedElsewhere(source);
  const declarations: FunctionDeclaration[] = [];

  for (const match of source.matchAll(functionHead)) {
    const shape = functionAt(
      source,
      match.index + match[0].lastIndexOf("function"),
    );
    if (shape) {
      declarations.push({
        ...shape,
        exported: Boolean(match[1]),
        name: match[2] ?? "",
      });
    }
  }

  for (const match of source.matchAll(bindingHead)) {
    const assigned = initializerStart(source, match.index + match[0].length);
    if (assigned < 0) continue;
    const shape = functionAt(source, assigned + 1);
    if (shape) {
      declarations.push({
        ...shape,
        exported: Boolean(match[1]),
        name: match[2] ?? "",
      });
    }
  }

  for (const match of source.matchAll(defaultHead)) {
    const sent = defaultExport(source, match.index + match[0].length);
    if (sent.kind !== "value") continue;
    const shape = functionAt(source, sent.at);
    if (shape) declarations.push({ ...shape, exported: true, name: "default" });
  }

  return declarations.map((declaration) => ({
    ...declaration,
    exported: declaration.exported || listed.has(declaration.name),
  }));
}

/** Every value name a module sends out, whichever keyword sends it. */
function valueExports(source: string): readonly string[] {
  const names = new Set<string>(exportedElsewhere(source));

  for (const match of source.matchAll(functionHead)) {
    if (match[1]) names.add(match[2] ?? "");
  }
  for (const match of source.matchAll(bindingHead)) {
    if (match[1]) names.add(match[2] ?? "");
  }
  for (const match of source.matchAll(defaultHead)) {
    const sent = defaultExport(source, match.index + match[0].length);
    if (sent.kind === "value") names.add("default");
  }

  return [...names];
}

/**
 * Every export of a module this reader could not resolve to a function.
 *
 * This is the half that stops the rule from *reading* as coverage it does not
 * have. A form the reader does not know yields no ordering, and an absent
 * ordering is indistinguishable from a compliant one — so the export is
 * reported instead, and the sweep fails naming it.
 */
export function unresolvedExports(
  file: string,
  written: string,
): readonly { file: string; export: string }[] {
  const source = withoutStringContents(withoutComments(written));
  const resolved = new Set(
    functionDeclarations(written).map((declaration) => declaration.name),
  );

  return valueExports(source)
    .filter((name) => !resolved.has(name))
    .sort()
    .map((name) => ({ export: name, file }));
}

/**
 * Every export name the reader resolved to a function it went on to judge.
 *
 * `unresolvedExports` above is the text half of the completeness claim, and it
 * is computed from the same two line-anchored patterns the ordering reader is:
 * a `function` head and a `const`/`let`/`var` head, each written at the start of
 * a line. So a form neither pattern matches produces no ordering *and* no
 * complaint — `export const a = …, b = …` publishes `b` invisibly, and a
 * destructured export, a generator, a class and a declaration written after
 * something else on its line are invisible whole. Seven such forms were
 * confirmed by probe, each of them silent in both directions.
 *
 * A completeness half that shares the blind spots of the thing it is checking
 * is not a completeness half. So the names are not derived from the text at
 * all: the sweep imports the module and asks it what it exports, exactly as the
 * administration-views survey reads its views off the module rather than off a
 * written list — and requires every function it publishes to appear here. This
 * function is the "judged" side of that comparison; anything a module publishes
 * and this set does not contain is named, whatever it was written as.
 *
 * A published name is not always the declared one, so both are read: an export
 * list may rename, and a declaration sent out as the default is published as
 * `default` however it was named where it was written.
 */
export function judgedExports(written: string): ReadonlySet<string> {
  const source = withoutStringContents(withoutComments(written));
  const resolved = new Set(
    functionDeclarations(written)
      .filter((declaration) => declaration.exported)
      .map((declaration) => declaration.name),
  );
  const names = new Set<string>(resolved);

  for (const match of source.matchAll(exportList)) {
    for (const entry of (match[1] ?? "").split(",")) {
      const sent = entry.trim();
      if (!sent || tokenAt(sent, 0, "type")) continue;
      const parts = sent.split(/\s+as\s+/u);
      const local = parameterName(parts[0] ?? "");
      if (resolved.has(local))
        names.add(parameterName(parts[1] ?? parts[0] ?? ""));
    }
  }
  for (const match of source.matchAll(defaultHead)) {
    const sent = defaultExport(source, match.index + match[0].length);
    if (resolved.has(sent.kind === "value" ? "default" : sent.name)) {
      names.add("default");
    }
  }

  return names;
}

/* ------------------------------------------------------------------ *
 * The rule.
 * ------------------------------------------------------------------ */

/** `name(` written as a call rather than as a property or a longer word. */
function calls(body: string, name: string): number {
  return body.search(new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "u"));
}

/* ------------------------------------------------------------------ *
 * Whether the action makes the call, or merely contains it.
 * ------------------------------------------------------------------ */

/** The word written immediately before `index`, and where it starts. */
function wordBefore(
  source: string,
  index: number,
): { readonly word: string; readonly at: number } {
  let end = index;
  while (end > 0 && /\s/u.test(source[end - 1] ?? "")) end -= 1;
  let start = end;
  while (start > 0 && /[\w$]/u.test(source[start - 1] ?? "")) start -= 1;

  return { at: start, word: source.slice(start, end) };
}

/** The index of the `(` that opens the list closed at `from`. */
function parenStart(source: string, from: number): number {
  let depth = 0;

  for (let index = from; index >= 0; index -= 1) {
    const character = source[index] ?? "";
    if (character === ")") depth += 1;
    else if (character === "(") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/** The keywords whose block a body may skip, or run only later. */
const deferringWords = [
  "catch",
  "do",
  "else",
  "finally",
  "for",
  "if",
  "switch",
  "while",
];

/**
 * Whether the `{` at `index` opens a block the body may skip or defer.
 *
 * A `try` block does not: its head runs the moment the statement is reached,
 * which is exactly why every reordered module puts the authorizing call there.
 * An object literal does not either — it is evaluated where it is written. What
 * does are the blocks of the branching keywords, and the body of any function
 * written inside the action, whose contents run when *it* is called and not
 * before.
 */
function opensDeferredBlock(source: string, index: number): boolean {
  const previous = wordBefore(source, index);
  if (deferringWords.includes(previous.word)) return true;

  let at = index - 1;
  while (at >= 0 && /\s/u.test(source[at] ?? "")) at -= 1;
  if (source[at] === ">" && source[at - 1] === "=") return true;
  if (source[at] !== ")") return false;

  const opening = parenStart(source, at);
  if (opening < 0) return true;
  const head = wordBefore(source, opening);

  return (
    deferringWords.includes(head.word) ||
    head.word === "function" ||
    wordBefore(source, head.at).word === "function"
  );
}

/** The branching statements a body may skip, written without a block. */
function bracelessRegions(
  body: string,
): readonly { readonly from: number; readonly to: number }[] {
  const regions: { from: number; to: number }[] = [];

  for (const match of body.matchAll(
    /(?<![\w$.])(?:if|for|while|switch)\s*\(/gu,
  )) {
    const closing = parenEnd(body, match.index + match[0].length - 1);
    if (closing < 0) continue;
    const from = afterSpace(body, closing + 1);
    if (body[from] === "{") continue;
    regions.push({ from, to: statementEnd(body, from) });
  }
  for (const match of body.matchAll(/(?<![\w$.])(?:else|do)(?![\w$])/gu)) {
    const from = afterSpace(body, match.index + match[0].length);
    if (body[from] === "{" || tokenAt(body, from, "if")) continue;
    regions.push({ from, to: statementEnd(body, from) });
  }
  // An arrow whose body is an expression opens no block either, and it is the
  // cheapest way of all to write a call the action never makes.
  for (const match of body.matchAll(/=>/gu)) {
    const from = afterSpace(body, match.index + 2);
    if (body[from] === "{") continue;
    regions.push({ from, to: statementEnd(body, from) });
  }

  return regions;
}

/**
 * Every index of a body that is reached before whatever is written after it.
 *
 * This is the difference between "the helper's name appears earlier in the
 * file" and "the action calls the helper first", which is the claim the rule
 * is actually making. A character inside a closure, or inside a branch, is at
 * an earlier *offset* and at no earlier point in the run at all.
 */
function unconditionalPositions(body: string): Uint8Array {
  const mask = new Uint8Array(body.length).fill(1);
  const opened: number[] = [];
  let deferred = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? "";
    if (character === "{") {
      const skips = opensDeferredBlock(body, index) ? 1 : 0;
      opened.push(skips);
      deferred += skips;
    } else if (character === "}") {
      deferred -= opened.pop() ?? 0;
    }
    if (deferred > 0) mask[index] = 0;
  }
  for (const region of bracelessRegions(body)) {
    for (
      let index = Math.max(0, region.from);
      index <= region.to && index < body.length;
      index += 1
    ) {
      mask[index] = 0;
    }
  }

  return mask;
}

/**
 * `name(` written as a call, optionally as a member of something else.
 *
 * The dispatchers' implementations take their session read as an injected
 * dependency, so the call that authorizes them is written `dependencies.gate()`
 * — or `dependencies.gate?.()`, which is the same call with a default. A rule
 * that only knew the free-function form would find no authorizing call in any
 * of them and report every one as an offender.
 */
function callPattern(name: string, member: boolean, flags: string): RegExp {
  return new RegExp(
    member
      ? `(?<![\\w$])${name}\\s*(?:\\?\\.)?\\s*\\(`
      : `(?<![\\w$.])${name}\\s*\\(`,
    flags,
  );
}

/** `name(` written anywhere in `body`, a member's call included. */
function invokes(body: string, name: string): number {
  return body.search(callPattern(name, true, "u"));
}

/** Where a body calls `name` at a point it is certain to reach. */
function dominatingCall(body: string, name: string, member = false): number {
  const reached = unconditionalPositions(body);

  for (const match of body.matchAll(callPattern(name, member, "gu"))) {
    if (reached[match.index] === 1) return match.index;
  }

  return -1;
}

/**
 * What the rules in this file are known not to decide, and why each was left
 * open.
 *
 * The same instrument `reviewedAuditLimits` is for the native audit, kept
 * separate only because that register's channels name the audit's own two. The
 * reason for both is one reason: an assumed limit and a forgotten defect are
 * the same artefact until one of them is written down. `authorizedAt` used to
 * be a character offset, which a sentence in a message and a call in a closure
 * both satisfied; it is now a position the action is certain to reach. That is
 * a stronger claim, and still not "authorization ran" — so the distance is
 * recorded here rather than left implied by the name.
 *
 * Every entry carries both halves: the `reason` is why closing it was not worth
 * what closing it would cost, and the `consequence` is what a reader of a clean
 * sweep is therefore not entitled to conclude.
 */
export type ReviewedOrderingLimit = {
  readonly subject: string;
  readonly reason: string;
  readonly consequence: string;
};

export const reviewedOrderingLimits: readonly ReviewedOrderingLimit[] = [
  {
    consequence:
      "An exported action whose submission the reader cannot name yields no ordering from `actionOrderings` (which filters on `exported && submission`) while still counting as judged by `judgedExports` (which filters on `exported` alone), so it is checked by neither half. Verified latent by probe: every one of the sixty-three published endpoints in this tree declares its submission as a plain `formData` parameter, and none is written destructured or as a rest element. A future action written `export async function act(_prev, { entries })` would ship unchecked.",
    reason:
      "The two filters differ on purpose. An export with no submission at all is judged vacuously — there is nothing to read before authorizing, so no ordering exists to state. Separating that from an export whose parameter list the reader failed to decode needs `functionDeclarations` to report the failure rather than simply yielding no name, which is a change to what the reader returns rather than to what a rule asks of it. Recorded rather than built, because the gap is latent and the register is where a bounded scanner's residue belongs.",
    subject: "a submission the reader cannot name is judged by neither half",
  },
  {
    consequence:
      "`await (resumed ? context() : null)` written above the parse counts as authorizing, so a module that resolves the session on only one arm of a conditional expression would pass. Verified by probe: the branch cases in this file are the block and braceless statement forms, and both are caught; the expression forms are not. No module in this tree writes one — every one of the fifty-nine actions resolves its helper as a statement.",
    reason:
      "Reachability is decided from blocks and from the branching statements written without one, which is what a text scanner can settle without becoming a parser. A ternary, a `&&`, a `||` or a `??` opens no block, so its arms are not distinguishable from straight-line code without evaluating the expression's shape — and a guard that parses expressions to decide what it forbids has stopped being readable off the source.",
    subject:
      "an authorizing call written as an expression rather than a statement",
  },
  {
    consequence:
      "An action that starts the helper, reads the submission, and only then awaits satisfies the rule while the parse in fact runs before any session exists. Every module here awaits on the statement that calls, so nothing rests on this today.",
    reason:
      "Statements at the top level of a body, and of a `try` inside it, run in the order they are written, and that order is the only one this rule reads. Modelling a promise created early and awaited late means tracking a value through the body, which is a type checker's job and not a scanner's.",
    subject: "textual order stands in for execution order",
  },
  {
    consequence:
      "A helper that resolves the application context and then ignores what it found still counts as a guard here. What the session is checked *for* — an organization, a role, a limiter — is each module's own contract and is pinned by that module's tests, not by this one.",
    reason:
      "The helper set is derived rather than listed precisely so a renamed or one-more-wrapper helper stays covered without editing this file. Deciding that a helper authorizes rather than merely resolves means reading its body for a check whose shape differs in every module.",
    subject: "reaching `getApplicationContext` stands in for authorizing",
  },
  {
    consequence:
      "A mention inside a closure the action never invokes still counts as reading the submission, so this rule over-reports rather than under-reports. That is the deliberate direction: a false positive fails loudly and is fixed in a line, while a false negative is indistinguishable from a compliant module.",
    reason:
      "The submission is a parameter, and every use of it is a use — including one written inside a callback that the very next line passes to something that runs it. Deciding which closures run means the evaluation this rule refuses to do, and erring the other way would reintroduce exactly the blindness it exists to remove.",
    subject: "the submission is any mention of the parameter it arrives in",
  },
  {
    consequence:
      "A module that publishes a name this reader resolved, but whose runtime value is not the declaration it resolved — a binding reassigned after it was declared, or wrapped on its way out — counts as judged. Nothing in this tree writes one; the pairing is by name and says so.",
    reason:
      "The export names are read off the imported module precisely so they cannot share the text reader's blind spots, and the orderings are read off the text because a compiled function no longer says what order it was written in. Matching one to the other by anything stronger than the name it is published under means source maps, which is a compiler's evidence and not a scanner's.",
    subject: "an export is judged if a declaration of its name was judged",
  },
  {
    consequence:
      "Two reachable declarations of the same name that both read a submission make the dispatcher unclassified rather than silently mis-judged, which is the safe direction — but a delegation written in any other shape, and a chain that goes on delegating from the implementation, are reported as unclassified rather than followed. A clean sweep says the first hop was followed, not that every hop was.",
    reason:
      "Resolving a forwarded name to its binding the way the compiler would means following imports through re-exports, aliases and destructuring — a type checker's job. What a scanner can settle is narrower and is what is settled here: the submission mentioned once, as a call's argument, and exactly one declaration of that name in the modules the dispatcher can reach that reads a submission of its own.",
    subject: "a delegated implementation is resolved by name, one hop",
  },
  {
    consequence:
      "A dependency that resolves the context and then ignores it counts as a gate, exactly as `getApplicationContext` does in the direct rule; and an unrelated object in the same closure that happens to bind the same key name would count too. What each gate is checked *for* stays that module's own contract.",
    reason:
      "An implementation reached through a dispatcher never calls the session read itself — it calls what it was injected with, so the gate has to be read off the composition root rather than the implementation. Deciding that a bound value authorizes rather than merely resolves means reading its body for a check whose shape differs in every module, which is the same line the direct rule already declines to cross.",
    subject:
      "an injected gate is any key bound to the session read or the limiter",
  },
  {
    consequence:
      "A boundary that catches around an injected call is not held to the rethrow by the sentinel rule. `lib/appearance.ts` is the one such boundary in this tree, and it is not left to the rule: it calls `unstable_rethrow` anyway, and `appearance.test.ts` proves both sentinels escape it by running them rather than by reading it.",
    reason:
      "The sentinel rule reads a `try` for a call that can reach the application context, which is what a scanner can see. A boundary that takes its session read as a parameter says nothing in its own text about whether the thing it calls redirects — deciding that means following the injection to its production wiring, which is a type checker's reach and not a scanner's.",
    subject: "a sentinel that arrives through an injected dependency",
  },
];

/**
 * Every function in the module that reaches `getApplicationContext`, directly
 * or through another such function.
 *
 * Derived rather than named so that a module which renames its helper — or
 * wraps it in one more, as two of these do to hand a rejection back as a state
 * instead of throwing it — stays covered without editing this file.
 *
 * Only module-internal functions are followed. An exported one is an endpoint,
 * not a helper, and reaching the session inside it says nothing about the order
 * any *other* endpoint does its two things in — `getApplicationContext` itself
 * is always a guard, so an action that calls it directly needs no entry here.
 */
export function authorizingHelpers(
  declarations: readonly FunctionDeclaration[],
): ReadonlySet<string> {
  const helpers = declarations.filter((declaration) => !declaration.exported);
  const names = new Set<string>();

  for (let pass = 0; pass <= helpers.length; pass += 1) {
    const before = names.size;

    for (const declaration of helpers) {
      if (names.has(declaration.name)) continue;
      const reaches =
        calls(declaration.body, "getApplicationContext") >= 0 ||
        [...names].some((name) => calls(declaration.body, name) >= 0);
      if (reaches) names.add(declaration.name);
    }
    if (names.size === before) break;
  }

  return names;
}

/** Where each exported action of one module authorizes, and where it reads. */
export function actionOrderings(
  file: string,
  written: string,
): readonly ActionOrdering[] {
  const declarations = functionDeclarations(written);
  const helpers = authorizingHelpers(declarations);
  const guards = ["getApplicationContext", ...helpers];

  return declarations
    .filter((declaration) => declaration.exported && declaration.submission)
    .map((declaration) => ({
      action: declaration.name,
      authorizedAt:
        guards
          .map((guard) => dominatingCall(declaration.body, guard))
          .filter((at) => at >= 0)
          .sort((left, right) => left - right)[0] ?? -1,
      file,
      readsSubmissionAt: declaration.body.search(
        new RegExp(`(?<![\\w$.])${declaration.submission}(?![\\w$])`, "u"),
      ),
    }));
}

/** An action that reads its submission before, or without, authorizing. */
export function readsBeforeAuthorizing(ordering: ActionOrdering): boolean {
  if (ordering.readsSubmissionAt < 0) return false;

  return (
    ordering.authorizedAt < 0 ||
    ordering.authorizedAt > ordering.readsSubmissionAt
  );
}

/* ------------------------------------------------------------------ *
 * The framework's own control flow.
 * ------------------------------------------------------------------ */

/**
 * `redirect()` and `notFound()` are not returns — they are throws.
 *
 * `getApplicationContext` signs an expired or absent session out by calling
 * `redirect("/sign-in")`, and Next implements that by throwing a digest-carrying
 * error which the framework catches above the action. A `catch` that maps every
 * throw to a state therefore catches the navigation as well, and the reader who
 * should have been sent to sign in gets a permanent banner instead.
 *
 * `unstable_rethrow` is Next's own answer: it re-throws anything the framework
 * owns and returns for everything else. `lib/appearance-actions.ts` already
 * calls it. The rule below is what stops the next catch from being written
 * without it — and it is scoped the way the danger is: a catch whose `try` can
 * reach the application context, in any module that reaches it, rather than
 * every catch in the tree. A boundary that converts a driver failure into a
 * `Response` is not this defect and is not asked to change.
 */
const rethrowHelper = "unstable_rethrow";

export type SentinelSwallow = {
  /** Web-app-relative POSIX path. */
  readonly file: string;
  /** The declaration the `catch` is written in. */
  readonly declaration: string;
};

/** Every `try`/`catch` written in `body`, as the two blocks' text. */
function tryCatchPairs(
  body: string,
): readonly { readonly guarded: string; readonly handler: string }[] {
  const pairs: { guarded: string; handler: string }[] = [];

  for (const match of body.matchAll(/(?<![\w$.])try\s*\{/gu)) {
    const opened = match.index + match[0].length - 1;
    const ended = blockEnd(body, opened);
    if (ended < 0) continue;
    let at = afterSpace(body, ended + 1);
    if (!tokenAt(body, at, "catch")) continue;
    at = afterSpace(body, at + 5);
    if (body[at] === "(") {
      const closing = parenEnd(body, at);
      if (closing < 0) continue;
      at = afterSpace(body, closing + 1);
    }
    if (body[at] !== "{") continue;
    const handled = blockEnd(body, at);
    if (handled < 0) continue;
    pairs.push({
      guarded: body.slice(opened + 1, ended),
      handler: body.slice(at + 1, handled),
    });
  }

  return pairs;
}

/**
 * Every catch in a module that can swallow one of the framework's sentinels.
 *
 * "Can" is read the same way the ordering rule reads authorization: a `try`
 * that reaches `getApplicationContext`, directly or through one of the module's
 * own helpers, can be thrown a redirect. The handler has to hand it back before
 * it does anything else, so the check is on the handler's *first* statement —
 * a rethrow written after a branch has already returned a state is not a
 * rethrow.
 */
export function sentinelSwallows(
  file: string,
  written: string,
): readonly SentinelSwallow[] {
  const declarations = functionDeclarations(written);
  const guards = ["getApplicationContext", ...authorizingHelpers(declarations)];

  return declarations.flatMap((declaration) =>
    tryCatchPairs(declaration.body)
      .filter(
        ({ guarded, handler }) =>
          guards.some((guard) => calls(guarded, guard) >= 0) &&
          !handler.trimStart().startsWith(`${rethrowHelper}(`),
      )
      .map(() => ({ declaration: declaration.name, file })),
  );
}

/** Every module that reaches the application context, test files aside. */
function contextReachingModules(): { file: string; source: string }[] {
  return webModules().filter(
    ({ source }) =>
      calls(withoutComments(source), "getApplicationContext") >= 0,
  );
}

/* ------------------------------------------------------------------ *
 * Following a dispatcher to the module that reads the submission.
 * ------------------------------------------------------------------ */

/**
 * Three `"use server"` modules own no limiter and parse nothing. They hand the
 * `FormData` straight to an implementation in `src/lib/`, which the sweep's
 * path test then excludes — so the rule found no `enforceRateLimit` in them,
 * skipped them, and reported a clean tree about modules it had never read.
 *
 * The exports of a dispatcher are still endpoints, and the ordering its
 * implementation is written in is still the thing that decides whether an
 * anonymous caller gets a per-field oracle. So the delegation is followed: the
 * forwarded name is resolved, inside the modules the dispatcher can actually
 * reach, to the one declaration that reads a submission, and the same rule is
 * applied there.
 *
 * Resolution is required to be unambiguous. A dispatcher whose action does not
 * forward, or whose forwarded name resolves to no declaration or to more than
 * one, is reported by name — because a module this reader cannot classify is
 * exactly the module it must not quietly leave out.
 */

/** Every relative specifier a module imports, `import()` included. */
function relativeImports(source: string): readonly string[] {
  const text = withoutComments(source);
  const specifiers: string[] = [];

  for (const match of text.matchAll(/from\s*["'](\.[^"']*)["']/gu)) {
    specifiers.push(match[1] ?? "");
  }
  for (const match of text.matchAll(
    /import\s*\(\s*["'](\.[^"']*)["']\s*\)/gu,
  )) {
    specifiers.push(match[1] ?? "");
  }

  return specifiers;
}

/**
 * The web-app-relative file a specifier names, or null when it names none.
 *
 * Specifiers are written with the `.js` extension the emitted module will have,
 * so the source they name is found by putting the source extension back.
 */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = resolve(webRoot, dirname(from), specifier).replace(/\.js$/u, "");

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (existsSync(candidate)) {
      return relative(webRoot, candidate).split(sep).join("/");
    }
  }

  return null;
}

/** Every module a dispatcher can reach through relative imports. */
function importClosure(file: string): readonly string[] {
  const seen = new Set<string>([file]);
  const queue = [file];

  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    const source = readFileSync(resolve(webRoot, current), "utf8");

    for (const specifier of relativeImports(source)) {
      const target = resolveSpecifier(current, specifier);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  seen.delete(file);

  return [...seen].sort();
}

/** A module's source with its comments and its string contents removed. */
const readModules = new Map<string, string>();

function moduleText(file: string): string {
  const cached = readModules.get(file);
  if (cached !== undefined) return cached;

  const text = withoutStringContents(
    withoutComments(readFileSync(resolve(webRoot, file), "utf8")),
  );
  readModules.set(file, text);

  return text;
}

type ModuleFunction = FunctionShape & {
  readonly name: string;
  /** Where the body opens, and where it closes. */
  readonly from: number;
  readonly to: number;
};

/**
 * The words that are followed by a parenthesised head and a block without ever
 * being a function's name.
 */
const notFunctionNames = new Set([
  "catch",
  "do",
  "for",
  "function",
  "if",
  "return",
  "switch",
  "while",
]);

/**
 * Every function written anywhere in a module, however deeply nested.
 *
 * `functionDeclarations` deliberately reads only the module's top level,
 * because exportedness is what makes a declaration an endpoint. The
 * implementations reached through a dispatcher are not written that way at all
 * — they are methods of an object a factory returns, and the helper that
 * authorizes them is a `function` nested inside that factory. Neither is
 * visible to a line-anchored reader, so this one is not anchored: a name, a
 * parameter list, and a block that follows either it or a return annotation.
 */
function moduleFunctions(text: string): readonly ModuleFunction[] {
  const found: ModuleFunction[] = [];

  for (const match of text.matchAll(
    /(?:^|[^\w$.])(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*\(/gu,
  )) {
    const name = match[1] ?? "";
    if (notFunctionNames.has(name)) continue;
    const opening = match.index + match[0].length - 1;
    const closing = parenEnd(text, opening);
    if (closing < 0) continue;
    // Only whitespace, or a return annotation, may stand between the parameter
    // list and the body — otherwise `expect(x).toEqual({ … })` reads as one.
    const next = afterSpace(text, closing + 1);
    if (text[next] !== "{" && text[next] !== ":") continue;
    const opened = text[next] === "{" ? next : bodyStart(text, closing);
    if (opened < 0) continue;
    const ended = blockEnd(text, opened);
    if (ended < 0) continue;

    found.push({
      body: text.slice(opened + 1, ended),
      from: opened,
      name,
      submission: submissionParameter(text.slice(opening + 1, closing)),
      to: ended,
    });
  }

  return found;
}

/** The end of a value written from `from` as one entry of an object literal. */
function entryEnd(text: string, from: number): number {
  let depth = 0;

  for (let index = from; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      depth -= 1;
      if (depth < 0) return index;
    } else if (depth === 0 && (character === "," || character === ";")) {
      return index;
    }
  }

  return text.length;
}

/** Every `key: value` and `key() { … }` a module writes, as key and value. */
function namedValues(
  text: string,
): readonly { readonly key: string; readonly value: string }[] {
  const entries: { key: string; value: string }[] = [];

  for (const match of text.matchAll(
    /[{,]\s*(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*:/gu,
  )) {
    const from = match.index + match[0].length;
    entries.push({
      key: match[1] ?? "",
      value: text.slice(from, entryEnd(text, from)),
    });
  }
  for (const declaration of moduleFunctions(text)) {
    entries.push({ key: declaration.name, value: declaration.body });
  }

  return entries;
}

/**
 * The dependency names a composition root binds to a session read or a limiter.
 *
 * An implementation reached through a dispatcher never calls
 * `getApplicationContext` itself: it calls whatever it was injected with. Which
 * of those injections authorize is not guessed and not listed — it is read off
 * the module that writes the injection, which is in the dispatcher's own import
 * closure and calls the two things directly.
 */
function gateKeys(closure: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>();

  for (const file of closure) {
    for (const { key, value } of namedValues(moduleText(file))) {
      if (
        calls(value, "getApplicationContext") >= 0 ||
        calls(value, "enforceRateLimit") >= 0
      ) {
        keys.add(key);
      }
    }
  }

  return keys;
}

/** Where a body mentions the parameter its submission arrives in. */
function submissionMention(body: string, submission: string): number {
  return body.search(new RegExp(`(?<![\\w$.])${submission}(?![\\w$])`, "u"));
}

/**
 * The name an action forwards its whole submission to, or null.
 *
 * A dispatcher does exactly one thing with the `FormData` it is handed: it
 * passes it, untouched, to something else. So the shape read here is the shape
 * that makes a module a dispatcher — the submission mentioned once, as the
 * argument of a call — and anything else is left unresolved rather than guessed
 * at.
 */
function forwardedMember(action: {
  readonly body: string;
  readonly submission: string;
}): string | null {
  const mentions = [
    ...action.body.matchAll(
      new RegExp(`(?<![\\w$.])${action.submission}(?![\\w$])`, "gu"),
    ),
  ];
  if (mentions.length !== 1) return null;

  const written = action.body
    .slice(0, mentions[0]?.index ?? 0)
    .replace(/\s*$/u, "");
  const callee = /([A-Za-z_$][\w$.]*)\s*\($/u.exec(written);

  return callee ? ((callee[1] ?? "").split(".").at(-1) ?? null) : null;
}

export type DelegatedOrdering = ActionOrdering & {
  /** The `"use server"` module whose exported action forwarded the submission. */
  readonly dispatcher: string;
  readonly forwardedBy: string;
};

export type UnclassifiedAction = {
  /** Web-app-relative POSIX path of the `"use server"` module. */
  readonly file: string;
  readonly action: string;
  readonly reason: string;
};

/** What a dispatcher's actions resolve to, and what they fail to resolve to. */
function delegatedActions(
  file: string,
  source: string,
): {
  readonly orderings: readonly DelegatedOrdering[];
  readonly unclassified: readonly UnclassifiedAction[];
} {
  const closure = importClosure(file);
  const gates = gateKeys(closure);
  const reachable = closure.flatMap((module) =>
    moduleFunctions(moduleText(module)).map((declaration) => ({
      ...declaration,
      file: module,
    })),
  );
  const orderings: DelegatedOrdering[] = [];
  const unclassified: UnclassifiedAction[] = [];

  for (const action of functionDeclarations(source)) {
    if (!action.exported || !action.submission) continue;

    const member = forwardedMember(action);
    if (!member) {
      unclassified.push({
        action: action.name,
        file,
        reason: "reads its submission rather than forwarding it whole",
      });
      continue;
    }

    const candidates = reachable.filter(
      (declaration) =>
        declaration.name === member &&
        declaration.submission &&
        submissionMention(declaration.body, declaration.submission) >= 0,
    );
    const target = candidates[0];
    if (candidates.length !== 1 || !target) {
      unclassified.push({
        action: action.name,
        file,
        reason: `${candidates.length} reachable declarations of ${member} read a submission`,
      });
      continue;
    }

    // A helper is derived at the target the way it is everywhere else, from the
    // gate outwards — but only among declarations written beside the target.
    // One that contains it, or is contained by it, is the factory around it or
    // a closure inside it, and neither has authorized anybody by being there.
    const helpers = new Set<string>([...gates, "getApplicationContext"]);
    const beside = reachable.filter(
      (declaration) =>
        declaration.file === target.file &&
        (declaration.to < target.from || declaration.from > target.to),
    );
    for (let pass = 0; pass <= beside.length; pass += 1) {
      const before = helpers.size;

      for (const declaration of beside) {
        if (helpers.has(declaration.name)) continue;
        if ([...helpers].some((name) => invokes(declaration.body, name) >= 0)) {
          helpers.add(declaration.name);
        }
      }
      if (helpers.size === before) break;
    }

    orderings.push({
      action: member,
      authorizedAt:
        [...helpers]
          .map((guard) => dominatingCall(target.body, guard, true))
          .filter((at) => at >= 0)
          .sort((left, right) => left - right)[0] ?? -1,
      dispatcher: file,
      file: target.file,
      forwardedBy: action.name,
      readsSubmissionAt: submissionMention(target.body, target.submission),
    });
  }

  return { orderings, unclassified };
}

/* ------------------------------------------------------------------ *
 * The sweep.
 * ------------------------------------------------------------------ */

/**
 * Every App Router module that declares Server Actions and rate limits them.
 *
 * Both halves are read from the source: the `"use server"` directive says the
 * exports are HTTP endpoints, and a call to `enforceRateLimit` says the module
 * owns a limiter an unauthenticated caller must not be able to step around. A
 * module added tomorrow is swept the moment it has both.
 */
function webModules(): { file: string; source: string }[] {
  return readdirSync(resolve(webRoot, "src"), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .map((path) => relative(webRoot, path).split(sep).join("/"))
    .filter((file) => !/\.test\.tsx?$/u.test(file))
    .sort()
    .map((file) => ({
      file,
      source: readFileSync(resolve(webRoot, file), "utf8"),
    }));
}

/**
 * The specifier this suite imports a swept module by.
 *
 * Every swept module lives under `src/app/`, and this file under `src/test/`,
 * so one step out of the suite's own directory reaches all of them.
 */
function moduleSpecifier(file: string): string {
  return `../${file.slice("src/".length)}`;
}

/** Every App Router module whose exports are Server Action endpoints. */
function serverActionModules(): { file: string; source: string }[] {
  return webModules().filter(
    ({ file, source }) =>
      file.startsWith("src/app/") && declaresServerDirective(source),
  );
}

function rateLimitedActionModules(): { file: string; source: string }[] {
  return serverActionModules().filter(
    ({ source }) => calls(withoutComments(source), "enforceRateLimit") >= 0,
  );
}

/**
 * Every action module that owns no limiter because it forwards the submission.
 *
 * This is the complement, deliberately: a `"use server"` module under
 * `src/app/` either rate limits in its own text or it hands the submission to
 * something that does, and the second half used to be nothing at all.
 */
function delegatingActionModules(): { file: string; source: string }[] {
  const rateLimited = new Set(
    rateLimitedActionModules().map(({ file }) => file),
  );

  return serverActionModules().filter(({ file }) => !rateLimited.has(file));
}

function delegatedOrderings(): readonly DelegatedOrdering[] {
  return delegatingActionModules().flatMap(
    ({ file, source }) => delegatedActions(file, source).orderings,
  );
}

function unclassifiedActions(): readonly UnclassifiedAction[] {
  return delegatingActionModules().flatMap(
    ({ file, source }) => delegatedActions(file, source).unclassified,
  );
}

function surveyOrderings(): readonly ActionOrdering[] {
  return rateLimitedActionModules().flatMap(({ file, source }) =>
    actionOrderings(file, source),
  );
}

function offenders(): readonly ActionOrdering[] {
  return surveyOrderings().filter(readsBeforeAuthorizing);
}

describe("the rule, against sources written to break it", () => {
  const wrongOrder = [
    '"use server";',
    "async function context() {",
    "  const application = await getApplicationContext();",
    '  await enforceRateLimit({ endpointClass: "mutation" });',
    "  return application;",
    "}",
    "export async function saveAction(_previous: State, formData: FormData) {",
    "  const input = schema.parse(Object.fromEntries(formData));",
    "  const current = await context();",
    "  return write(current, input);",
    "}",
  ].join("\n");

  test("reports an action that parses before it authorizes", () => {
    expect(
      actionOrderings("x.ts", wrongOrder).filter(readsBeforeAuthorizing),
    ).toEqual([
      {
        action: "saveAction",
        authorizedAt: expect.any(Number),
        file: "x.ts",
        readsSubmissionAt: expect.any(Number),
      },
    ]);
  });

  test("clears the same action once the two statements are swapped", () => {
    const rightOrder = wrongOrder
      .replace(
        "  const input = schema.parse(Object.fromEntries(formData));\n",
        "",
      )
      .replace(
        "  const current = await context();",
        [
          "  const current = await context();",
          "  const input = schema.parse(Object.fromEntries(formData));",
        ].join("\n"),
      );

    expect(
      actionOrderings("x.ts", rightOrder).filter(readsBeforeAuthorizing),
    ).toEqual([]);
  });

  test("follows a helper that only reaches the session through another", () => {
    // Two of these modules wrap the throwing helper in one that returns the
    // failure as a state, so the call an action makes is one step further out
    // than the one that touches the session.
    const wrapped = [
      "async function context() {",
      "  return getApplicationContext();",
      "}",
      "async function authorized() {",
      "  return { ok: true, current: await context() };",
      "}",
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  const gate = await authorized();",
      "  return schema.parse(Object.fromEntries(formData));",
      "}",
    ].join("\n");

    expect(authorizingHelpers(functionDeclarations(wrapped))).toEqual(
      new Set(["context", "authorized"]),
    );
    expect(
      actionOrderings("x.ts", wrapped).filter(readsBeforeAuthorizing),
    ).toEqual([]);
  });

  test("never reads a return annotation's braces as the function body", () => {
    // `Promise<{ ok: true … } | { ok: false … }>` opens two braces before the
    // body does, and a reader that took the first would judge the type.
    const annotated = [
      "export async function saveAction(",
      "  _previous: State,",
      "  formData: FormData,",
      "): Promise<{ ok: true; value: string } | { ok: false }> {",
      "  const current = await getApplicationContext();",
      "  return schema.parse(Object.fromEntries(formData));",
      "}",
    ].join("\n");
    const [declaration] = functionDeclarations(annotated);

    expect(declaration?.submission).toBe("formData");
    expect(declaration?.body.trimStart().startsWith("const current")).toBe(
      true,
    );
  });

  test("never reads a comment or a message as a call", () => {
    const prose = [
      "/** Never call getApplicationContext() after reading formData. */",
      "export async function saveAction(_previous: State, formData: FormData) {",
      '  const input = schema.parse(Object.fromEntries(formData), "context()");',
      "  return input;",
      "}",
    ].join("\n");

    expect(
      actionOrderings("x.ts", prose).filter(readsBeforeAuthorizing),
    ).toEqual([
      {
        action: "saveAction",
        authorizedAt: -1,
        file: "x.ts",
        readsSubmissionAt: expect.any(Number),
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * What "authorized before" is allowed to mean.
 * ------------------------------------------------------------------ */

describe("an authorizing call the action actually makes", () => {
  /** The helper every case below shares. */
  const helper = [
    "async function context() {",
    "  return getApplicationContext();",
    "}",
  ].join("\n");

  const offender = [
    {
      action: "saveAction",
      authorizedAt: expect.any(Number),
      file: "x.ts",
      readsSubmissionAt: expect.any(Number),
    },
  ];

  test("never reads the helper's name inside a message as a call", () => {
    // `withoutComments` keeps strings on purpose, so before this the earliest
    // "call" the rule could find was a sentence about one.
    const quoted = [
      helper,
      "export async function saveAction(_previous: State, formData: FormData) {",
      '  const banner = "context() runs first";',
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input, banner);",
      "}",
    ].join("\n");

    expect(
      actionOrderings("x.ts", quoted).filter(readsBeforeAuthorizing),
    ).toEqual(offender);
  });

  test("never reads the submission's name inside a message as a read", () => {
    // The same blindness in the other direction, which reports a module that
    // is in fact correct — loud, but still wrong.
    const quoted = [
      helper,
      "export async function saveAction(_previous: State, formData: FormData) {",
      '  const banner = "formData is read after the session";',
      "  const current = await context();",
      "  return write(current, Object.fromEntries(formData), banner);",
      "}",
    ].join("\n");

    expect(
      actionOrderings("x.ts", quoted).filter(readsBeforeAuthorizing),
    ).toEqual([]);
  });

  test("never counts a call the action only closes over", () => {
    // A call inside a function nobody invoked has not authorized anybody. Its
    // position in the file is earlier; its position in the run is nowhere.
    const deferred = [
      helper,
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  const later = () => context();",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await later(), input);",
      "}",
    ].join("\n");

    expect(
      actionOrderings("x.ts", deferred).filter(readsBeforeAuthorizing),
    ).toEqual(offender);
  });

  test("never counts a call reached only through a branch", () => {
    const branched = [
      helper,
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  if (previouslyChecked) {",
      "    await context();",
      "  }",
      "  return schema.parse(Object.fromEntries(formData));",
      "}",
    ].join("\n");

    expect(
      actionOrderings("x.ts", branched).filter(readsBeforeAuthorizing),
    ).toEqual(offender);
  });

  test("never counts a call reached through a branch written without braces", () => {
    const branched = [
      helper,
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  if (previouslyChecked) await context();",
      "  return schema.parse(Object.fromEntries(formData));",
      "}",
    ].join("\n");

    expect(
      actionOrderings("x.ts", branched).filter(readsBeforeAuthorizing),
    ).toEqual(offender);
  });

  test("still counts the call every reordered module actually makes", () => {
    // The shape all ten modules are written in: the helper is resolved as the
    // first statement of a `try` whose block runs unconditionally.
    const written = [
      helper,
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  try {",
      "    const { organization } = await context();",
      "    return write(organization, Object.fromEntries(formData));",
      "  } catch (error) {",
      "    return errorState(error);",
      "  }",
      "}",
    ].join("\n");

    expect(
      actionOrderings("x.ts", written).filter(readsBeforeAuthorizing),
    ).toEqual([]);
  });

  test("records what the rule is known not to decide, with its consequence", () => {
    // The same instrument `reviewedAuditLimits` is for the native audit, and
    // for the same reason: an assumed limit and a forgotten defect are the same
    // artefact until one of them is written down. The claim this rule makes is
    // narrower than "authorization ran", and the distance between the two is
    // recorded here rather than left implied.
    expect(reviewedOrderingLimits.map((limit) => limit.subject)).toEqual([
      "a submission the reader cannot name is judged by neither half",
      "an authorizing call written as an expression rather than a statement",
      "textual order stands in for execution order",
      "reaching `getApplicationContext` stands in for authorizing",
      "the submission is any mention of the parameter it arrives in",
      "an export is judged if a declaration of its name was judged",
      "a delegated implementation is resolved by name, one hop",
      "an injected gate is any key bound to the session read or the limiter",
      "a sentinel that arrives through an injected dependency",
    ]);
    expect(
      reviewedOrderingLimits.filter(
        (limit) => limit.reason.length === 0 || limit.consequence.length === 0,
      ),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Every declaration form Next compiles into a Server Action.
 * ------------------------------------------------------------------ */

/**
 * A `"use server"` module's authorizing helper, written once.
 *
 * Each form below is spliced onto it, so the only thing that varies between
 * the cases is *how the action is declared* — which is the whole question.
 */
const helperPrelude = [
  '"use server";',
  "async function context() {",
  "  const application = await getApplicationContext();",
  '  await enforceRateLimit({ endpointClass: "mutation" });',
  "  return application;",
  "}",
].join("\n");

/**
 * The forms, each written once in the wrong order and once in the right one.
 *
 * A reader that knows only `export async function NAME(` reports no offender
 * for any of the others, which is worse than reporting nothing at all: the
 * suite goes green and reads as coverage. So the rule is required to decide
 * every form the framework accepts, and a form it cannot decide has to fail
 * loudly rather than pass quietly.
 */
const declarationForms: readonly (readonly [string, string, string])[] = [
  [
    "a function declaration",
    [
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input);",
      "}",
    ].join("\n"),
    [
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  const current = await context();",
      "  return write(current, schema.parse(Object.fromEntries(formData)));",
      "}",
    ].join("\n"),
  ],
  [
    "an exported const arrow",
    [
      "export const saveAction = (_previous: State, formData: FormData) => {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return context().then((current) => write(current, input));",
      "};",
    ].join("\n"),
    [
      "export const saveAction = (_previous: State, formData: FormData) => {",
      "  const pending = context();",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return pending.then((current) => write(current, input));",
      "};",
    ].join("\n"),
  ],
  [
    "an exported const async arrow",
    [
      "export const saveAction = async (_previous: State, formData: FormData) => {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input);",
      "};",
    ].join("\n"),
    [
      "export const saveAction = async (_previous: State, formData: FormData) => {",
      "  const current = await context();",
      "  return write(current, schema.parse(Object.fromEntries(formData)));",
      "};",
    ].join("\n"),
  ],
  [
    "an exported const async arrow behind a return annotation",
    [
      "export const saveAction = async (",
      "  _previous: State,",
      "  formData: FormData,",
      "): Promise<{ ok: true } | { ok: false }> => {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input);",
      "};",
    ].join("\n"),
    [
      "export const saveAction = async (",
      "  _previous: State,",
      "  formData: FormData,",
      "): Promise<{ ok: true } | { ok: false }> => {",
      "  const current = await context();",
      "  return write(current, schema.parse(Object.fromEntries(formData)));",
      "};",
    ].join("\n"),
  ],
  [
    "an exported anonymous function expression",
    [
      "export const saveAction = async function (",
      "  _previous: State,",
      "  formData: FormData,",
      ") {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input);",
      "};",
    ].join("\n"),
    [
      "export const saveAction = async function (",
      "  _previous: State,",
      "  formData: FormData,",
      ") {",
      "  const current = await context();",
      "  return write(current, schema.parse(Object.fromEntries(formData)));",
      "};",
    ].join("\n"),
  ],
  [
    "an exported named function expression",
    [
      "export const saveAction = async function save(",
      "  _previous: State,",
      "  formData: FormData,",
      ") {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input);",
      "};",
    ].join("\n"),
    [
      "export const saveAction = async function save(",
      "  _previous: State,",
      "  formData: FormData,",
      ") {",
      "  const current = await context();",
      "  return write(current, schema.parse(Object.fromEntries(formData)));",
      "};",
    ].join("\n"),
  ],
  [
    "an expression-bodied arrow",
    [
      "export const saveAction = async (_previous: State, formData: FormData) =>",
      "  write(schema.parse(Object.fromEntries(formData)), await context());",
    ].join("\n"),
    [
      "export const saveAction = async (_previous: State, formData: FormData) =>",
      "  write(await context(), schema.parse(Object.fromEntries(formData)));",
    ].join("\n"),
  ],
  [
    "an arrow whose only parameter has no parentheses",
    [
      "export const saveAction = async formData =>",
      "  write(schema.parse(Object.fromEntries(formData)), await context());",
    ].join("\n"),
    [
      "export const saveAction = async formData =>",
      "  write(await context(), schema.parse(Object.fromEntries(formData)));",
    ].join("\n"),
  ],
  [
    "a declaration exported through an export list",
    [
      "async function saveAction(_previous: State, formData: FormData) {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input);",
      "}",
      "export { saveAction };",
    ].join("\n"),
    [
      "async function saveAction(_previous: State, formData: FormData) {",
      "  const current = await context();",
      "  return write(current, schema.parse(Object.fromEntries(formData)));",
      "}",
      "export { saveAction };",
    ].join("\n"),
  ],
  [
    "a binding exported through an export list",
    [
      "const saveAction = async (_previous: State, formData: FormData) => {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input);",
      "};",
      "export { saveAction };",
    ].join("\n"),
    [
      "const saveAction = async (_previous: State, formData: FormData) => {",
      "  const current = await context();",
      "  return write(current, schema.parse(Object.fromEntries(formData)));",
      "};",
      "export { saveAction };",
    ].join("\n"),
  ],
  [
    "a default-exported declaration",
    [
      "export default async function saveAction(",
      "  _previous: State,",
      "  formData: FormData,",
      ") {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input);",
      "}",
    ].join("\n"),
    [
      "export default async function saveAction(",
      "  _previous: State,",
      "  formData: FormData,",
      ") {",
      "  const current = await context();",
      "  return write(current, schema.parse(Object.fromEntries(formData)));",
      "}",
    ].join("\n"),
  ],
  [
    "a binding sent out as the default export",
    [
      "const saveAction = async (_previous: State, formData: FormData) => {",
      "  const input = schema.parse(Object.fromEntries(formData));",
      "  return write(await context(), input);",
      "};",
      "export default saveAction;",
    ].join("\n"),
    [
      "const saveAction = async (_previous: State, formData: FormData) => {",
      "  const current = await context();",
      "  return write(current, schema.parse(Object.fromEntries(formData)));",
      "};",
      "export default saveAction;",
    ].join("\n"),
  ],
];

describe("every declaration form a Server Action may be written in", () => {
  for (const [form, wrong, right] of declarationForms) {
    test(`reports ${form} that reads before it authorizes`, () => {
      expect(
        actionOrderings("x.ts", [helperPrelude, wrong].join("\n")).filter(
          readsBeforeAuthorizing,
        ),
      ).toEqual([
        {
          action: "saveAction",
          authorizedAt: expect.any(Number),
          file: "x.ts",
          readsSubmissionAt: expect.any(Number),
        },
      ]);
    });

    test(`clears ${form} once the two statements are swapped`, () => {
      expect(
        actionOrderings("y.ts", [helperPrelude, right].join("\n")).filter(
          readsBeforeAuthorizing,
        ),
      ).toEqual([]);
    });
  }

  test("resolves every value export of a module to a declaration", () => {
    // The completeness half. A form this reader cannot decide must not read as
    // a clean module: every name a `"use server"` module sends out has to turn
    // up as a declaration the rule judged, so the *next* form — whatever it is
    // — fails here instead of passing silently.
    const written = [
      helperPrelude,
      "export const saveAction = wrapped(async (_p: State, f: FormData) => {",
      "  return f;",
      "});",
    ].join("\n");

    expect(unresolvedExports("x.ts", written)).toEqual([
      { export: "saveAction", file: "x.ts" },
    ]);
  });
});

describe("the App Router's rate-limited Server Actions", () => {
  test("sweeps every module that declares actions and rate limits them", () => {
    // The survey's positive half. A reader that quietly stopped resolving would
    // report no offenders and read exactly like a compliant tree, so the
    // modules the console genuinely rate limits are named here and have to keep
    // turning up — with their actions found, not just their files.
    const swept = rateLimitedActionModules().map(({ file }) => file);

    for (const file of [...orderedModules, ...deferredModules]) {
      expect({ file, swept: swept.includes(file) }).toEqual({
        file,
        swept: true,
      });
    }
    expect(surveyOrderings().length).toBeGreaterThan(40);
  });

  /*
   * Its own budget, because it is slow without touching a database: it imports
   * every "use server" module, so Vite transforms each one's whole server
   * graph. In the forced gates of 2026-09-27 to 2026-09-29 it took 5.8–22.4s
   * where it passed, and overran this file's 30 seconds three times, at
   * 30.3s, 30.2s and 30.0s. 120 seconds is four times the budget it overran.
   */
  test("judges every action a module actually publishes", async () => {
    // The completeness half, driven by something that cannot share the reader's
    // blind spots. A declaration form neither line-anchored pattern matches
    // produces no ordering and no unresolved-export complaint either, so the
    // names are taken from the module itself — the same way the administration
    // views survey takes its views off the module rather than off a list — and
    // every function it publishes has to be one the rule judged.
    const unjudged: { export: string; file: string }[] = [];

    for (const { file, source } of serverActionModules()) {
      const published: Record<string, unknown> = await import(
        /* @vite-ignore */ moduleSpecifier(file)
      );
      const judged = judgedExports(source);

      for (const [name, value] of Object.entries(published)) {
        if (typeof value !== "function" || judged.has(name)) continue;
        unjudged.push({ export: name, file });
      }
    }

    expect(unjudged).toEqual([]);
  }, 120_000);

  test("classifies every module that declares Server Actions", () => {
    // The half that was missing. A `"use server"` module under `src/app/` that
    // neither rate limits in its own text nor forwards its submission somewhere
    // this reader can follow was previously omitted in silence — and omitted in
    // silence reads exactly like swept and clean.
    expect(unclassifiedActions()).toEqual([]);
    expect(delegatingActionModules().map(({ file }) => file)).toEqual([
      ...delegatingModules,
    ]);
  });

  test("follows each dispatcher to the declaration that reads the form", () => {
    // Pinned, because a follower that quietly stopped resolving would report no
    // offenders and read exactly like three compliant modules.
    expect(
      delegatedOrderings()
        .map(
          ({ action, dispatcher, file, forwardedBy }) =>
            `${dispatcher}#${forwardedBy} -> ${file}#${action}`,
        )
        .sort(),
    ).toEqual([
      "src/app/(app)/actions.ts#inviteMemberAction -> src/lib/administration-actions.ts#inviteMember",
      "src/app/(app)/settings/appearance/actions.ts#updateOrganizationAppearanceAction -> src/lib/appearance-actions.ts#updateOrganizationDefaults",
      "src/app/(app)/settings/appearance/actions.ts#updatePersonalAppearanceAction -> src/lib/appearance-actions.ts#updatePersonalPreferences",
      "src/app/(app)/settings/projects/actions.ts#createProjectAction -> src/lib/administration-actions.ts#createProject",
    ]);
  });

  test("authorizes before it reads a submission it was forwarded", () => {
    expect(delegatedOrderings().filter(readsBeforeAuthorizing)).toEqual([]);
  });

  test("resolves every export of every module it sweeps", () => {
    // The reader's own blind spots, made loud. An action written in a form this
    // reader cannot decide produces no ordering at all, and no ordering reads
    // exactly like a compliant one — so the export is named here instead, and
    // the next form nobody has written yet fails rather than passes.
    expect(
      rateLimitedActionModules().flatMap(({ file, source }) =>
        unresolvedExports(file, source),
      ),
    ).toEqual([]);
  });

  test("authorizes before it reads the submission", () => {
    expect(
      offenders().filter(({ file }) => !deferredModules.includes(file)),
    ).toEqual([]);
  });

  test("records the modules that still read first, and only those", () => {
    // Both directions. A module fixed without being struck off leaves a stale
    // exemption that would swallow the next regression in it, and a module that
    // violates without being named here was never reviewed at all.
    expect([...new Set(offenders().map(({ file }) => file))].sort()).toEqual(
      [...deferredModules].sort(),
    );
  });
});

describe("the framework's own control flow", () => {
  const guarded = [
    "async function context() {",
    "  return getApplicationContext();",
    "}",
  ].join("\n");

  test("reports a catch that would map the navigation to a state", () => {
    const swallows = [
      guarded,
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  try {",
      "    const current = await context();",
      "    return write(current, formData);",
      "  } catch (error) {",
      "    return errorState(error);",
      "  }",
      "}",
    ].join("\n");

    expect(sentinelSwallows("x.ts", swallows)).toEqual([
      { declaration: "saveAction", file: "x.ts" },
    ]);
  });

  test("clears the same catch once it hands the sentinel back first", () => {
    const rethrows = [
      guarded,
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  try {",
      "    const current = await context();",
      "    return write(current, formData);",
      "  } catch (error) {",
      "    unstable_rethrow(error);",
      "    return errorState(error);",
      "  }",
      "}",
    ].join("\n");

    expect(sentinelSwallows("x.ts", rethrows)).toEqual([]);
  });

  test("is not asked of a catch that can never be handed one", () => {
    // A boundary that turns a driver failure into a state is not this defect.
    const unrelated = [
      guarded,
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  const current = await context();",
      "  try {",
      "    return write(current, formData);",
      "  } catch (error) {",
      "    return errorState(error);",
      "  }",
      "}",
    ].join("\n");

    expect(sentinelSwallows("x.ts", unrelated)).toEqual([]);
  });

  test("counts a rethrow only as the handler's first statement", () => {
    const late = [
      guarded,
      "export async function saveAction(_previous: State, formData: FormData) {",
      "  try {",
      "    const current = await context();",
      "    return write(current, formData);",
      "  } catch (error) {",
      "    if (error instanceof DomainError) return errorState(error);",
      "    unstable_rethrow(error);",
      "    return errorState(error);",
      "  }",
      "}",
    ].join("\n");

    expect(sentinelSwallows("x.ts", late)).toEqual([
      { declaration: "saveAction", file: "x.ts" },
    ]);
  });

  test("lets no module that reaches the session swallow one", () => {
    expect(
      contextReachingModules().flatMap(({ file, source }) =>
        sentinelSwallows(file, source),
      ),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Every export of a `"use server"` module is an async function.
 * ------------------------------------------------------------------ */

/**
 * Next compiles each export of a `"use server"` module into an action
 * endpoint, and refuses the build for one that is not an async function:
 * "Server Actions must be async functions."
 *
 * The rule above this one cannot see such an export at all. It recognises an
 * action by its `async`, so a synchronous export is not an action judged
 * compliant — it is not an action, and the sweep passes without it. A helper
 * exported from the consent actions for a test to reach went green through
 * every gate here and failed the preview build, which is the first place the
 * framework's own rule was applied.
 *
 * Whole-module, not per-action: the framework's rule is about the module's
 * exports, so this reads them all, including values that are not functions.
 */
function asynchronousAt(source: string, name: string): boolean | null {
  for (const match of source.matchAll(functionHead)) {
    if ((match[2] ?? "") === name)
      return /\basync\s+function\b/u.test(match[0]);
  }
  for (const match of source.matchAll(bindingHead)) {
    if ((match[2] ?? "") !== name) continue;
    const equals = initializerStart(source, match.index + match[0].length);
    if (equals < 0) return false;

    return tokenAt(source, afterSpace(source, equals + 1), "async");
  }

  return null;
}

type SynchronousExport = {
  readonly file: string;
  readonly name: string;
  /** "value" when the reader resolved the declaration, "unknown" when not. */
  readonly kind: "unknown" | "value";
};

function synchronousExports(
  file: string,
  written: string,
): readonly SynchronousExport[] {
  const source = withoutStringContents(withoutComments(written));

  return valueExports(source).flatMap((name) => {
    const asynchronous = asynchronousAt(source, name);
    if (asynchronous === true) return [];

    // An export whose declaration this reader cannot find is reported rather
    // than assumed compliant: an absent verdict and a passing one are the same
    // artefact, and that equivalence is what let the defect ship.
    return [
      { file, kind: asynchronous === null ? "unknown" : "value", name },
    ] as const;
  });
}

function synchronouslyExported(): readonly SynchronousExport[] {
  return serverActionModules().flatMap(({ file, source }) =>
    synchronousExports(file, source),
  );
}

describe("what a `use server` module may export", () => {
  test.each([
    ["export function derive(hex: string) {\n  return hex;\n}", "derive"],
    ["export const derive = (hex: string) => hex;", "derive"],
    ["export const LIMIT = 10;", "LIMIT"],
    [
      "function derive(hex: string) {\n  return hex;\n}\nexport { derive };",
      "derive",
    ],
  ])("reports a synchronous export written as %j", (written, name) => {
    const source = [helperPrelude, written].join("\n");

    expect(
      synchronousExports("probe.ts", source).map((one) => one.name),
    ).toContain(name);
  });

  test.each([
    ["export async function act(formData: FormData) {\n  return formData;\n}"],
    ["export const act = async (formData: FormData) => formData;"],
  ])("passes an async export written as %j", (written) => {
    const source = [helperPrelude, written].join("\n");

    expect(synchronousExports("probe.ts", source)).toEqual([]);
  });

  test("every `use server` module in this tree exports only async functions", () => {
    expect(
      synchronouslyExported().map(
        (one) => `${one.file} ${one.name} (${one.kind})`,
      ),
    ).toEqual([]);
  });
});
