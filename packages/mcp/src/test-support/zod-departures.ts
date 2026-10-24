import type { z } from "zod";

/*
  A copy of `@requestport/domain`'s `test-support/zod-departures.ts`, which
  is outside this package's `rootDir`.

  Where a schema would answer differently from zod 4.4.3, the zod RequestPort
  0.2.0 published its API on, for the four string rules
  `@requestport/domain`'s `zod-compat.ts` keeps. Each rule is probed on the check itself, not
  read from its name:
  - a string's `max_length` check is handed `n` emoji (`n` code points, 2n
    UTF-16 units): 4.4.3 refused them;
  - a string's `min_length` check of 2 or more is handed `ceil(n / 2)` emoji
    (at least `n` units, fewer than `n` code points): 4.4.3 accepted them;
  - a string's `length_equals` check has no UTF-16 helper at all;
  - a `datetime` format must carry 4.4.3's pattern, which leaves seconds
    optional, compared with 4.4.3's source written out below rather than
    with the helper's;
  - a `url` format, with every `overwrite` check after it on the same
    string, must hand back a URL with a tab inside it as it was sent (4.6.7's
    `z.url()` removes the tab);
  - an `email` format must carry 4.4.3's pattern, compared the same way.
  It walks every schema a schema reaches (objects, arrays, records' keys and
  values, unions, wrappers, pipes, lazy getters), once each.
*/

type Check = {
  _zod: {
    def: {
      check?: string;
      format?: string;
      maximum?: number;
      minimum?: number;
      pattern?: RegExp;
    };
    check?: (payload: { value: unknown; issues: unknown[] }) => unknown;
  };
};

type Node = {
  _zod: { def: Record<string, unknown> & { type: string; checks?: Check[] } };
};

const emoji = "\u{1F600}";

/** zod 4.4.3's `z.iso.datetime()` pattern source, recorded from 4.4.3. */
const datetimePattern443 =
  "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$";

/** zod 4.4.3's `z.regexes.email` source, recorded from 4.4.3. */
const emailPattern443 =
  "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$";

function probe(check: Check, value: string) {
  const payload = { value, issues: [] as unknown[] };
  check._zod.check?.(payload);
  return payload;
}

function departuresOfCheck(check: Check, path: string): string[] {
  const def = check._zod.def;
  if (def.check === "max_length" && (def.maximum ?? 0) >= 1) {
    const maximum = def.maximum ?? 0;
    return probe(check, emoji.repeat(maximum)).issues.length === 0
      ? [`${path}: max_length ${maximum} counts code points`]
      : [];
  }
  if (def.check === "min_length" && (def.minimum ?? 0) >= 2) {
    const minimum = def.minimum ?? 0;
    return probe(check, emoji.repeat(Math.ceil(minimum / 2))).issues.length > 0
      ? [`${path}: min_length ${minimum} counts code points`]
      : [];
  }
  if (def.check === "length_equals")
    return [`${path}: length_equals has no UTF-16 helper`];
  if (def.check !== "string_format") return [];
  if (def.format === "datetime" && def.pattern?.source !== datetimePattern443)
    return [`${path}: datetime requires seconds`];
  if (def.format === "email" && def.pattern?.source !== emailPattern443)
    return [`${path}: email carries another pattern`];
  return [];
}

/**
 * A `url` format among a string's checks, run with every `overwrite` check
 * after it, in order, on a URL with a tab inside it: 4.4.3 handed it back as
 * sent. The string's other checks are left out, so a prefix or a pattern of
 * its own does not refuse the probe.
 */
function departuresOfUrl(checks: Check[], path: string): string[] {
  const at = checks.findIndex(
    (check) =>
      check._zod.def.check === "string_format" &&
      check._zod.def.format === "url",
  );
  if (at < 0) return [];
  const sent = "https://exa\tmple.com/";
  const payload = { value: sent as unknown, issues: [] as unknown[] };
  for (const [index, check] of checks.entries()) {
    if (index < at) continue;
    if (index > at && check._zod.def.check !== "overwrite") continue;
    check._zod.check?.(payload);
  }
  return payload.issues.length > 0 || payload.value !== sent
    ? [`${path}: url removes a tab`]
    : [];
}

/**
 * Every place under `schema` that answers differently from zod 4.4.3, as
 * `path: rule`. Empty when the whole tree keeps 4.4.3's string rules.
 */
export function zod443Departures(schema: z.ZodType, root = "$"): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: Node | undefined, path: string) => {
    if (!node?._zod || seen.has(node)) return;
    seen.add(node);
    const def = node._zod.def;
    if (def.type === "string") {
      const own =
        typeof def.check === "string" ? [node as unknown as Check] : [];
      const checks = [...own, ...(def.checks ?? [])];
      for (const check of checks) found.push(...departuresOfCheck(check, path));
      found.push(...departuresOfUrl(checks, path));
      return;
    }
    const child = (key: string) => def[key] as Node | undefined;
    switch (def.type) {
      case "object": {
        const shape = def.shape as Record<string, Node>;
        for (const key of Object.keys(shape))
          visit(shape[key], `${path}.${key}`);
        visit(child("catchall"), `${path}[*]`);
        return;
      }
      case "array":
      case "set":
        visit(child("element") ?? child("valueType"), `${path}[]`);
        return;
      case "record":
      case "map":
        visit(child("keyType"), `${path}{key}`);
        visit(child("valueType"), `${path}{value}`);
        return;
      case "tuple":
        (def.items as Node[]).forEach((item, at) => {
          visit(item, `${path}[${at}]`);
        });
        visit(child("rest"), `${path}[...]`);
        return;
      case "union":
        (def.options as Node[]).forEach((option, at) => {
          visit(option, `${path}|${at}`);
        });
        return;
      case "intersection":
        visit(child("left"), path);
        visit(child("right"), path);
        return;
      case "pipe":
        visit(child("in"), path);
        visit(child("out"), path);
        return;
      case "lazy":
        visit((def.getter as () => Node)(), path);
        return;
      default:
        visit(child("innerType"), path);
    }
  };
  visit(schema as unknown as Node, root);
  return found;
}
