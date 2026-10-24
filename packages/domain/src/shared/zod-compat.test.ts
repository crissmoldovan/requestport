import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  emailPattern,
  isoDatetime,
  isoDatetimePattern,
  trimmedUrl,
  utf16Max,
  utf16Min,
} from "./zod-compat.js";

/*
  Each helper held to zod 4.4.3's own answers, recorded as literals: what
  `safeParse` returned for each input (the value, or every issue without its
  `input`), what `z.toJSONSchema` wrote, the sources of 4.4.3's datetime
  and email patterns, and its English for the messages zod 4.5 reworded
  (`english443`). They were recorded by building the same schemas
  natively (`z.string().max(5)` where `z.string().check(utf16Max(5))` stands
  here, `z.iso.datetime()`, `z.url()`, `z.email()`) and running them on zod
  4.4.3 with no other zod loaded in the process: every zod copy in
  a process shares one global configuration, English messages included.
*/

type Answer =
  | { input: unknown; success: true; data: unknown }
  | { input: unknown; success: false; issues: unknown[] };

const recorded: {
  patterns: { datetime: string; email: string };
  cases: Record<string, Answer[]>;
  jsonSchemas: Record<string, unknown>;
  messages: Record<string, string[]>;
} = {
  patterns: {
    datetime:
      "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
    email:
      "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
  },
  cases: {
    max: [
      {
        input: "abcde",
        success: true,
        data: "abcde",
      },
      {
        input: "abcdef",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_big",
            maximum: 5,
            inclusive: true,
            path: [],
            message: "Too big: expected string to have <=5 characters",
          },
        ],
      },
      {
        input: "\u{1F600}\u{1F600}",
        success: true,
        data: "\u{1F600}\u{1F600}",
      },
      {
        input: "a\u{1F600}\u{1F600}",
        success: true,
        data: "a\u{1F600}\u{1F600}",
      },
      {
        input: "\u{1F600}\u{1F600}\u{1F600}",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_big",
            maximum: 5,
            inclusive: true,
            path: [],
            message: "Too big: expected string to have <=5 characters",
          },
        ],
      },
      {
        input: "ab\u{1F600}\u{1F600}",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_big",
            maximum: 5,
            inclusive: true,
            path: [],
            message: "Too big: expected string to have <=5 characters",
          },
        ],
      },
      {
        input: 7,
        success: false,
        issues: [
          {
            expected: "string",
            code: "invalid_type",
            path: [],
            message: "Invalid input: expected string, received number",
          },
        ],
      },
    ],
    maxMessage: [
      {
        input: "abc",
        success: true,
        data: "abc",
      },
      {
        input: "\u{1F600}\u{1F600}",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_big",
            maximum: 3,
            inclusive: true,
            path: [],
            message: "at most three",
          },
        ],
      },
    ],
    maxAbort: [
      {
        input: "aa",
        success: true,
        data: "aa",
      },
      {
        input: "\u{1F600}\u{1F600}",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_big",
            maximum: 2,
            inclusive: true,
            path: [],
            message: "Too big: expected string to have <=2 characters",
          },
        ],
      },
      {
        input: "bbb",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_big",
            maximum: 2,
            inclusive: true,
            path: [],
            message: "Too big: expected string to have <=2 characters",
          },
        ],
      },
    ],
    min: [
      {
        input: "abcd",
        success: true,
        data: "abcd",
      },
      {
        input: "abc",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_small",
            minimum: 4,
            inclusive: true,
            path: [],
            message: "Too small: expected string to have >=4 characters",
          },
        ],
      },
      {
        input: "\u{1F600}\u{1F600}",
        success: true,
        data: "\u{1F600}\u{1F600}",
      },
      {
        input: "\u{1F600}",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_small",
            minimum: 4,
            inclusive: true,
            path: [],
            message: "Too small: expected string to have >=4 characters",
          },
        ],
      },
      {
        input: "a\u{1F600}",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_small",
            minimum: 4,
            inclusive: true,
            path: [],
            message: "Too small: expected string to have >=4 characters",
          },
        ],
      },
      {
        input: "ab\u{1F600}",
        success: true,
        data: "ab\u{1F600}",
      },
      {
        input: "",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_small",
            minimum: 4,
            inclusive: true,
            path: [],
            message: "Too small: expected string to have >=4 characters",
          },
        ],
      },
    ],
    minMessage: [
      {
        input: "\u{1F600}",
        success: false,
        issues: [
          {
            origin: "string",
            code: "too_small",
            minimum: 4,
            inclusive: true,
            path: [],
            message: "at least four",
          },
        ],
      },
      {
        input: "\u{1F600}\u{1F600}",
        success: true,
        data: "\u{1F600}\u{1F600}",
      },
    ],
    datetime: [
      {
        input: "2026-10-05T12:30Z",
        success: true,
        data: "2026-10-05T12:30Z",
      },
      {
        input: "2026-10-05T12:30:15Z",
        success: true,
        data: "2026-10-05T12:30:15Z",
      },
      {
        input: "2026-10-05T12:30:15.123456789Z",
        success: true,
        data: "2026-10-05T12:30:15.123456789Z",
      },
      {
        input: "2026-10-05T12:30:15+01:00",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "datetime",
            pattern:
              "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$/",
            path: [],
            message: "Invalid ISO datetime",
          },
        ],
      },
      {
        input: "2026-10-05T12:30",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "datetime",
            pattern:
              "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$/",
            path: [],
            message: "Invalid ISO datetime",
          },
        ],
      },
      {
        input: "2026-10-05",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "datetime",
            pattern:
              "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$/",
            path: [],
            message: "Invalid ISO datetime",
          },
        ],
      },
      {
        input: "2026-02-30T12:00Z",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "datetime",
            pattern:
              "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$/",
            path: [],
            message: "Invalid ISO datetime",
          },
        ],
      },
      {
        input: "2024-02-29T00:00Z",
        success: true,
        data: "2024-02-29T00:00Z",
      },
      {
        input: "2026-10-05T24:00Z",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "datetime",
            pattern:
              "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$/",
            path: [],
            message: "Invalid ISO datetime",
          },
        ],
      },
    ],
    url: [
      {
        input: "https://example.com/a",
        success: true,
        data: "https://example.com/a",
      },
      {
        input: "  https://example.com/a  ",
        success: true,
        data: "https://example.com/a",
      },
      {
        input: "https://exa\tmple.com/",
        success: true,
        data: "https://exa\tmple.com/",
      },
      {
        input: "https://example.com/\na",
        success: true,
        data: "https://example.com/\na",
      },
      {
        input: "mailto:someone@example.com",
        success: true,
        data: "mailto:someone@example.com",
      },
      {
        input: "not a url",
        success: false,
        issues: [
          {
            code: "invalid_format",
            format: "url",
            path: [],
            message: "Invalid URL",
          },
        ],
      },
      {
        input: "",
        success: false,
        issues: [
          {
            code: "invalid_format",
            format: "url",
            path: [],
            message: "Invalid URL",
          },
        ],
      },
    ],
    urlStartsWith: [
      {
        input: "https://github.com/a/b",
        success: true,
        data: "https://github.com/a/b",
      },
      {
        input: "h\tttps://github.com/a/b",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "starts_with",
            prefix: "https://",
            path: [],
            message: 'Invalid string: must start with "https://"',
          },
        ],
      },
      {
        input: "http://github.com/a/b",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "starts_with",
            prefix: "https://",
            path: [],
            message: 'Invalid string: must start with "https://"',
          },
        ],
      },
    ],
    email: [
      {
        input: "a@example.com",
        success: true,
        data: "a@example.com",
      },
      {
        input: "user+tag@sub.example.co",
        success: true,
        data: "user+tag@sub.example.co",
      },
      {
        input: "a..b@example.com",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "email",
            pattern:
              "/^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/",
            path: [],
            message: "Invalid email address",
          },
        ],
      },
      {
        input: ".a@example.com",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "email",
            pattern:
              "/^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/",
            path: [],
            message: "Invalid email address",
          },
        ],
      },
      {
        input: "a@b.c",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "email",
            pattern:
              "/^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/",
            path: [],
            message: "Invalid email address",
          },
        ],
      },
      {
        input: "a b@example.com",
        success: false,
        issues: [
          {
            origin: "string",
            code: "invalid_format",
            format: "email",
            pattern:
              "/^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/",
            path: [],
            message: "Invalid email address",
          },
        ],
      },
    ],
  },
  jsonSchemas: {
    max: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      maxLength: 5,
    },
    maxMessage: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      maxLength: 3,
    },
    maxAbort: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      maxLength: 2,
      pattern: "^a+$",
    },
    min: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      minLength: 4,
    },
    minMessage: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      minLength: 4,
    },
    datetime: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      format: "date-time",
      pattern:
        "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
    },
    url: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      format: "uri",
    },
    urlStartsWith: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      format: "uri",
      pattern: "^https:\\/\\/.*",
    },
    email: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      format: "email",
      pattern:
        "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
    },
  },
  messages: {
    "z.number() on Infinity": [
      "Invalid input: expected number, received number",
    ],
    "z.number().int() on -Infinity": [
      "Invalid input: expected number, received number",
    ],
    "z.string() on Infinity": [
      "Invalid input: expected string, received number",
    ],
    "z.object() on -Infinity": [
      "Invalid input: expected object, received number",
    ],
    'z.coerce.number() on "Infinity"': [
      "Invalid input: expected number, received number",
    ],
    "z.array().length(1) on []": [
      "Too small: expected array to have >=1 items",
    ],
    "z.array().length(1) on two": ["Too big: expected array to have <=1 items"],
    'z.string().length(2) on "abc"': [
      "Too big: expected string to have <=2 characters",
    ],
    "z.number() on NaN": ["Invalid input: expected number, received NaN"],
    "z.string() on 1": ["Invalid input: expected string, received number"],
  },
};

/**
 * The schemas whose English `recorded.messages` holds. They are built the
 * same way on both zods: the English is not a schema's.
 */
const messageSchemas: Record<string, [() => z.ZodType, unknown]> = {
  "z.number() on Infinity": [() => z.number(), Number.POSITIVE_INFINITY],
  "z.number().int() on -Infinity": [
    () => z.number().int(),
    Number.NEGATIVE_INFINITY,
  ],
  "z.string() on Infinity": [() => z.string(), Number.POSITIVE_INFINITY],
  "z.object() on -Infinity": [
    () => z.object({ a: z.string() }),
    Number.NEGATIVE_INFINITY,
  ],
  'z.coerce.number() on "Infinity"': [() => z.coerce.number(), "Infinity"],
  "z.array().length(1) on []": [() => z.array(z.string()).length(1), []],
  "z.array().length(1) on two": [
    () => z.array(z.string()).length(1),
    ["a", "b"],
  ],
  'z.string().length(2) on "abc"': [() => z.string().length(2), "abc"],
  "z.number() on NaN": [() => z.number(), Number.NaN],
  "z.string() on 1": [() => z.string(), 1],
};

/** Each case's schema on this zod, built with the helpers. */
const schemas: Record<string, () => z.ZodType> = {
  max: () => z.string().check(utf16Max(5)),
  maxMessage: () => z.string().check(utf16Max(3, "at most three")),
  maxAbort: () =>
    z
      .string()
      .check(utf16Max(2, { abort: true }))
      .regex(/^a+$/),
  min: () => z.string().check(utf16Min(4)),
  minMessage: () => z.string().check(utf16Min(4, "at least four")),
  datetime: () => isoDatetime(),
  url: () => trimmedUrl(),
  urlStartsWith: () => trimmedUrl().startsWith("https://"),
  email: () => z.email({ pattern: emailPattern }),
};

function answer(input: unknown, schema: z.ZodType): Answer {
  const result = schema.safeParse(input);
  if (result.success) return { input, success: true, data: result.data };
  return {
    input,
    success: false,
    issues: result.error.issues.map((issue) => {
      const { input: _input, ...rest } = issue as typeof issue & {
        input?: unknown;
      };
      return rest;
    }),
  };
}

describe("zod-compat's helpers give zod 4.4.3's answers", () => {
  test("the patterns are 4.4.3's, character for character", () => {
    expect(isoDatetimePattern.source).toBe(recorded.patterns.datetime);
    expect(emailPattern.source).toBe(recorded.patterns.email);
  });

  test.each(Object.keys(recorded.cases))(
    "%s: every input parses as on 4.4.3",
    (name) => {
      const build = schemas[name];
      if (!build) throw new Error(`no schema for ${name}`);
      const cases = recorded.cases[name] ?? [];
      expect(cases.length).toBeGreaterThan(0);
      expect(
        cases.map((recordedCase) => answer(recordedCase.input, build())),
      ).toEqual(cases);
    },
  );

  test.each(
    Object.keys(recorded.jsonSchemas).filter(
      (name) => name !== "urlStartsWith",
    ),
  )("%s: the JSON Schema is 4.4.3's", (name) => {
    const build = schemas[name];
    if (!build) throw new Error(`no schema for ${name}`);
    expect(z.toJSONSchema(build())).toEqual(recorded.jsonSchemas[name]);
  });

  test.each(Object.keys(recorded.messages))(
    "%s: the message is 4.4.3's English, which zod-compat installs",
    (name) => {
      const entry = messageSchemas[name];
      if (!entry) throw new Error(`no schema for ${name}`);
      const [build, input] = entry;
      const result = build().safeParse(input);
      expect(
        result.success ? [] : result.error.issues.map((issue) => issue.message),
      ).toEqual(recorded.messages[name]);
    },
  );

  test("a URL with a prefix: the JSON Schema is 4.4.3's once its format is given back", () => {
    // zod 4.6 writes the last format a string's checks name, and a
    // `startsWith` check names `starts_with`, so packages/mcp gives the
    // format back with `.meta({ format: "uri" })`, as here.
    expect(z.toJSONSchema(trimmedUrl().startsWith("https://"))).toMatchObject({
      format: "starts_with",
    });
    expect(
      z.toJSONSchema(
        trimmedUrl().startsWith("https://").meta({ format: "uri" }),
      ),
    ).toEqual(recorded.jsonSchemas.urlStartsWith);
  });
});
