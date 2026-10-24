import { z } from "zod";

/*
  zod 4.4.3's rules, on zod 4.6.7.

  RequestPort 0.2.0 parsed every input on zod 4.4.3 (4.5.4 in `auth`). zod
  4.5 and 4.6 changed four string rules that reach the API, each a fix in
  zod's own terms:
  - `.min()`, `.max()` and `.length()` on a string count Unicode code points
    where they counted UTF-16 code units (zod #6441). `.max(200)` accepts 200
    emoji, 400 units, which 0.2.0 refused, and `.min(n)` with `n` of 2 or
    more refuses some inputs it accepted. There is no helper for
    `.length()`, which no string schema in this repository uses;
  - `z.iso.datetime()` requires seconds (zod #6457), refusing
    `2026-10-05T12:30Z`, which 0.2.0 accepted;
  - `z.url()` answers with every tab and newline removed from the input,
    where 4.4.3 answered with the input trimmed and otherwise as sent;
  - `z.email()`'s pattern lost its lookaheads (zod #6573). It accepts the
    same addresses, but the pattern an issue and a JSON Schema carry is
    another string.

  Each helper here answers as 4.4.3 did: the same inputs accepted, with the
  same value; the same issues for the rest; the same JSON Schema from
  `z.toJSONSchema`. `zod-compat.test.ts` holds each to 4.4.3's answers,
  recorded as literals.

  Two more of 4.4.3's answers are kept here, neither a schema's:
  - its English, in two messages zod 4.5 reworded (`english443`, installed
    when this module loads);
  - an own `__proto__` key dropped, which a strict object now refuses
    (`dropOwnProtoKeys`, for the REST and MCP transports).
*/

/**
 * `.check(utf16Max(n))` where `.max(n)` would go on a string: zod's own
 * `max_length` check, measuring `value.length` as 4.4.3 did.
 */
export function utf16Max(
  maximum: number,
  params?: Parameters<typeof z.maxLength>[1],
) {
  const check = z.maxLength(maximum, params);
  const def = check._zod.def;
  check._zod.check = (payload) => {
    const input = payload.value;
    if (input.length <= def.maximum) return;
    payload.issues.push({
      origin: z.core.util.getLengthableOrigin(input),
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst: check,
      continue: !def.abort,
    });
  };
  return check;
}

/**
 * `.check(utf16Min(n))` where `.min(n)` would go on a string, for `n` of 2 or
 * more (a string has at least one code point exactly when it has at least
 * one code unit, so `.min(1)` answers the same on both zods).
 */
export function utf16Min(
  minimum: number,
  params?: Parameters<typeof z.minLength>[1],
) {
  const check = z.minLength(minimum, params);
  const def = check._zod.def;
  check._zod.check = (payload) => {
    const input = payload.value;
    if (input.length >= def.minimum) return;
    payload.issues.push({
      origin: z.core.util.getLengthableOrigin(input),
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst: check,
      continue: !def.abort,
    });
  };
  return check;
}

/**
 * zod 4.4.3's `z.iso.datetime()` pattern: a calendar date, `T`, hours and
 * minutes, seconds and their fraction optional, then `Z`.
 */
export const isoDatetimePattern =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/;

/**
 * `z.iso.datetime()` with 4.4.3's pattern, so a time without seconds is
 * still accepted. zod's types leave `pattern` out of a datetime's
 * parameters, but its constructor keeps one it is given
 * (`def.pattern ??= regexes.datetime(def)`), so the issue, the format and
 * the JSON Schema are a datetime's, with this pattern.
 */
export function isoDatetime() {
  const params: Record<string, unknown> = { pattern: isoDatetimePattern };
  return z.iso.datetime(params as z.core.$ZodISODateTimeParams);
}

function parsesAsUrl(value: string) {
  return URL.canParse(value.trim());
}

/**
 * `z.url()` as 4.4.3 answered it: valid when the trimmed input parses as a
 * URL, and then the trimmed input, tabs and newlines kept. The issue for an
 * input that does not parse is 4.4.3's (`invalid_format`, `format: "url"`),
 * and the JSON Schema is `{ "type": "string", "format": "uri" }`.
 */
export function trimmedUrl() {
  return z
    .stringFormat("url", parsesAsUrl)
    .overwrite((value) => (parsesAsUrl(value) ? value.trim() : value));
}

/**
 * zod 4.4.3's `z.regexes.email`, for `z.email({ pattern: emailPattern })`,
 * character for character: its source is what an issue and a JSON Schema
 * carry.
 */
export const emailPattern =
  // biome-ignore lint/complexity/noUselessEscapeInRegex: 4.4.3's escapes, kept so the source matches.
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

const english = z.locales.en().localeError;

/**
 * zod's English as 4.4.3 wrote it. zod 4.5 reworded two of its messages,
 * and 4.6 kept them:
 * - a value of the wrong type that is a non-finite number is named by its
 *   value, `received Infinity` or `received -Infinity`, where 4.4.3 wrote
 *   `received number`;
 * - an exact length (`.length(n)`) reads `exactly n` where 4.4.3 wrote
 *   `<=n` or `>=n`.
 * Every other message is 4.6.7's English as it stands, which is 4.4.3's for
 * every issue a schema in this repository raises (the English locale's other
 * changes name formats 4.4.3 did not have, and `z.xor`, which nothing here
 * uses).
 */
export function english443(issue: z.core.$ZodRawIssue) {
  if (
    issue.code === "invalid_type" &&
    (issue.input === Number.POSITIVE_INFINITY ||
      issue.input === Number.NEGATIVE_INFINITY)
  )
    return english({ ...issue, input: 0 });
  if ((issue.code === "too_big" || issue.code === "too_small") && issue.exact)
    return english({ ...issue, exact: false });
  return english(issue);
}

/*
  Every zod copy in a process shares one configuration
  (`globalThis.__zod_globalConfig`), its English among it. zod 4.4.3 put its
  own English there when it loaded, whatever was there before; 4.5 and later
  put theirs only where none is. So 0.2.0, which loaded 4.4.3 beside
  `auth`'s and Better Auth's 4.5.4, spoke 4.4.3's English in every message,
  theirs included. This puts 4.4.3's words back, for every schema in the
  process, when the domain loads, as 4.4.3 did.
*/
z.config({ localeError: english443 });

/**
 * Deletes every own `__proto__` key in a parsed JSON value, at every depth,
 * and returns the value.
 *
 * zod 4.4.3 dropped an own `__proto__` key wherever an object, a record or
 * `z.json()` parsed one, strict objects included; 4.5 and later make a
 * strict object refuse it (`unrecognized_keys`), and drop it everywhere
 * else. Only `z.unknown()` and `z.any()` keep one, on both. The domain's and
 * the MCP tools' input schemas use neither, and the REST envelope's `input`
 * holds its values as `z.unknown()` only until the command's own schema
 * parses them, so a transport that drops the key before its schemas run
 * answers as 0.2.0 did. Run it after any count of the body's values, which
 * saw the key.
 */
export function dropOwnProtoKeys<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (Object.hasOwn(current, "__proto__"))
      Reflect.deleteProperty(current, "__proto__");
    for (const key of Object.keys(current))
      stack.push((current as Record<string, unknown>)[key]);
  }
  return value;
}
