import { describe, expect, test } from "vitest";

import { agentScopes } from "./agents/agent-types.js";
import { collaborationCommandInputSchemas } from "./collaboration/collaboration-commands.js";
import { createCoreCommandRegistry } from "./core/core-commands.js";
import { AtomicCommandBus } from "./shared/command.js";
import type { TransactionManager } from "./shared/unit-of-work.js";
import { workCommandInputSchemas } from "./work/work-commands.js";

/*
  The three free-form JSON inputs a command takes, bounded where REST and MCP
  both parse them (ruling 237 item 3): `post_work_update`'s `evidence`,
  `attach_artifact`'s `provenance` and `answer_question`'s `structuredValue`.
  Each is bounded three ways: the elements its free-form values hold (every
  array element and object key, at every level, as the MCP SDK counts them),
  how deep each value nests from its own root, and the bytes of the input's
  compact JSON.

  Each bound's case sends a value at the bound, which the schema accepts,
  and one past it, which the schema refuses at the input's own path, with a
  message naming the input and the bound and `params` naming the bound and
  its value; the other cases show what stays and what is not counted. These
  call the schema's own `safeParse`. The last describe sends each value past
  each bound through an `AtomicCommandBus`, and sees the refusal's details
  name the input, the bound and its value.
*/

const organizationId = "018f0000-0000-7000-8000-0000000f0001";

const zeros = (count: number) => Array.from({ length: count }, () => 0);

/** `[[[…[0]…]]]`, its innermost zero at depth `levels`. */
function nested(levels: number): unknown {
  let value: unknown = 0;
  for (let level = 0; level < levels; level += 1) value = [value];
  return value;
}

const workUpdate = (evidence: unknown) => ({
  organizationId,
  workSessionId: "018f0000-0000-7000-8000-0000000f0002",
  kind: "progress",
  bodyMd: "Progress.",
  evidence,
});

const artifact = (provenance: unknown) => ({
  organizationId,
  requestId: "018f0000-0000-7000-8000-0000000f0003",
  kind: "log",
  externalUrl: "https://example.com/artifact",
  provenance,
});

const answer = (structuredValue: unknown) => ({
  organizationId,
  questionId: "018f0000-0000-7000-8000-0000000f0004",
  bodyMd: "Answer.",
  structuredValue,
  sourceChannel: "mcp",
});

const evidenceSchema = workCommandInputSchemas.post_work_update;
const provenanceSchema = collaborationCommandInputSchemas.attach_artifact;
const answerSchema = collaborationCommandInputSchemas.answer_question;

/** The issues a refused parse reports, as path and message, and `params` where an issue has them. */
function refusal(
  schema: { safeParse: (input: unknown) => unknown },
  input: unknown,
) {
  const result = schema.safeParse(input) as {
    success: boolean;
    error?: {
      issues: Array<{
        path: PropertyKey[];
        message: string;
        params?: Record<string, unknown>;
      }>;
    };
  };
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    ...(issue.params === undefined ? {} : { params: issue.params }),
  }));
}

function accepts(
  schema: { safeParse: (input: unknown) => unknown },
  input: unknown,
) {
  const result = schema.safeParse(input) as {
    success: boolean;
    error?: unknown;
  };
  expect(result.success, JSON.stringify(result.error)).toBe(true);
}

describe("post_work_update's evidence: 10,000 elements across its field values, depth 8 each, 262,144 bytes", () => {
  const elements = {
    path: "evidence",
    message:
      "Work evidence field values may hold at most 10,000 elements in all",
    params: { bound: "elements", maximum: 10_000 },
  };
  const depth = {
    path: "evidence",
    message: "A work evidence field value may nest at most 8 levels deep",
    params: { bound: "depth", maximum: 8 },
  };
  const bytes = {
    path: "evidence",
    message: "Work evidence may take at most 262,144 bytes as compact JSON",
    params: { bound: "bytes", maximum: 262_144 },
  };

  test("elements: 10,000 in one field value is accepted, 10,001 refused", () => {
    accepts(evidenceSchema, workUpdate([{ data: zeros(10_000) }]));
    expect(
      refusal(evidenceSchema, workUpdate([{ data: zeros(10_001) }])),
    ).toEqual([elements]);
  });

  test("elements: the bound is across the whole array, not per record or per field", () => {
    accepts(
      evidenceSchema,
      workUpdate([{ a: zeros(5_000) }, { b: zeros(4_000), c: zeros(1_000) }]),
    );
    expect(
      refusal(
        evidenceSchema,
        workUpdate([{ a: zeros(5_000) }, { b: zeros(4_000), c: zeros(1_001) }]),
      ),
    ).toEqual([elements]);
  });

  test("elements: the records and their fields are not counted against it", () => {
    const records = Array.from({ length: 100 }, (_, record) =>
      Object.fromEntries(
        Array.from({ length: 64 }, (_, field) => [`field${field}`, record]),
      ),
    );
    (records[0] as Record<string, unknown>).field0 = zeros(10_000);
    accepts(evidenceSchema, workUpdate(records));
  });

  test("depth: a field value nesting 8 deep is accepted, 9 refused", () => {
    accepts(evidenceSchema, workUpdate([{ data: nested(8) }]));
    expect(refusal(evidenceSchema, workUpdate([{ data: nested(9) }]))).toEqual([
      depth,
    ]);
  });

  test("bytes: 262,144 bytes of compact JSON are accepted, 262,145 refused", () => {
    // `[{"data":"…"}]` is the string's length and 13.
    const at = [{ data: "x".repeat(262_144 - 13) }];
    expect(new TextEncoder().encode(JSON.stringify(at)).byteLength).toBe(
      262_144,
    );
    accepts(evidenceSchema, workUpdate(at));
    expect(
      refusal(evidenceSchema, workUpdate([{ data: "x".repeat(262_144 - 12) }])),
    ).toEqual([bytes]);
  });

  test("the key count and the sensitive-content check stay", () => {
    expect(
      refusal(
        evidenceSchema,
        workUpdate([
          Object.fromEntries(
            Array.from({ length: 65 }, (_, field) => [`field${field}`, 0]),
          ),
        ]),
      ),
    ).toEqual([
      {
        path: "evidence.0",
        message: "Each evidence record may contain at most 64 fields",
      },
    ]);
    expect(
      refusal(
        evidenceSchema,
        workUpdate([{ password: "correct-horse-battery" }]),
      ),
    ).toEqual([
      {
        path: "evidence.0",
        message: "Work evidence contains private or secret material",
      },
    ]);
  });
});

describe("attach_artifact's provenance: 2,000 elements across its field values, depth 8 each, 65,536 bytes", () => {
  const elements = {
    path: "provenance",
    message:
      "Artifact provenance field values may hold at most 2,000 elements in all",
    params: { bound: "elements", maximum: 2_000 },
  };
  const depth = {
    path: "provenance",
    message:
      "An artifact provenance field value may nest at most 8 levels deep",
    params: { bound: "depth", maximum: 8 },
  };
  const bytes = {
    path: "provenance",
    message:
      "Artifact provenance may take at most 65,536 bytes as compact JSON",
    params: { bound: "bytes", maximum: 65_536 },
  };

  test("elements: 2,000 across its field values is accepted, 2,001 refused; its 64 keys are not counted", () => {
    const keys = Object.fromEntries(
      Array.from({ length: 63 }, (_, field) => [`field${field}`, 0]),
    );
    accepts(provenanceSchema, artifact({ ...keys, data: zeros(2_000) }));
    accepts(provenanceSchema, artifact({ a: zeros(1_000), b: zeros(1_000) }));
    expect(
      refusal(provenanceSchema, artifact({ a: zeros(1_000), b: zeros(1_001) })),
    ).toEqual([elements]);
  });

  test("depth: a field value nesting 8 deep is accepted, 9 refused", () => {
    accepts(provenanceSchema, artifact({ data: nested(8) }));
    expect(refusal(provenanceSchema, artifact({ data: nested(9) }))).toEqual([
      depth,
    ]);
  });

  test("bytes: 65,536 bytes of compact JSON are accepted, 65,537 refused", () => {
    // `{"data":"…"}` is the string's length and 11.
    const at = { data: "x".repeat(65_536 - 11) };
    expect(new TextEncoder().encode(JSON.stringify(at)).byteLength).toBe(
      65_536,
    );
    accepts(provenanceSchema, artifact(at));
    expect(
      refusal(provenanceSchema, artifact({ data: "x".repeat(65_536 - 10) })),
    ).toEqual([bytes]);
  });

  test("the key count and the sensitive-content check stay", () => {
    expect(
      refusal(
        provenanceSchema,
        artifact(
          Object.fromEntries(
            Array.from({ length: 65 }, (_, field) => [`field${field}`, 0]),
          ),
        ),
      ),
    ).toEqual([
      {
        path: "provenance",
        message: "Artifact provenance may contain at most 64 fields",
      },
    ]);
    expect(
      refusal(
        provenanceSchema,
        artifact({ password: "correct-horse-battery" }),
      ),
    ).toEqual([
      {
        path: "provenance",
        message: "Artifact provenance contains private or secret material",
      },
    ]);
  });
});

describe("answer_question's structuredValue: 2,000 elements, depth 8, 65,536 bytes", () => {
  const elements = {
    path: "structuredValue",
    message: "A structured answer may hold at most 2,000 elements",
    params: { bound: "elements", maximum: 2_000 },
  };
  const depth = {
    path: "structuredValue",
    message: "A structured answer may nest at most 8 levels deep",
    params: { bound: "depth", maximum: 8 },
  };
  const bytes = {
    path: "structuredValue",
    message:
      "A structured answer may take at most 65,536 bytes as compact JSON",
    params: { bound: "bytes", maximum: 65_536 },
  };

  test("elements: 2,000 are accepted, 2,001 refused; its own keys are counted", () => {
    accepts(answerSchema, answer(zeros(2_000)));
    accepts(answerSchema, answer({ choice: zeros(1_999) }));
    expect(refusal(answerSchema, answer(zeros(2_001)))).toEqual([elements]);
    expect(refusal(answerSchema, answer({ choice: zeros(2_000) }))).toEqual([
      elements,
    ]);
  });

  test("depth: a value nesting 8 deep is accepted, 9 refused", () => {
    accepts(answerSchema, answer(nested(8)));
    expect(refusal(answerSchema, answer(nested(9)))).toEqual([depth]);
  });

  test("bytes: 65,536 bytes of compact JSON are accepted, 65,537 refused", () => {
    // A string's compact JSON is its length and its two quotes.
    accepts(answerSchema, answer("x".repeat(65_536 - 2)));
    expect(refusal(answerSchema, answer("x".repeat(65_536 - 1)))).toEqual([
      bytes,
    ]);
  });

  test("null and an absent value are accepted, and the sensitive-content check stays", () => {
    accepts(answerSchema, answer(null));
    accepts(answerSchema, { ...answer(null), structuredValue: undefined });
    expect(
      refusal(answerSchema, answer({ password: "correct-horse-battery" })),
    ).toEqual([
      {
        path: "structuredValue",
        message: "Structured answer contains private or secret material",
      },
    ]);
  });
});

/*
  The same refusals through an `AtomicCommandBus` over the core registry,
  the bus REST and MCP both hand these commands to. Its transaction manager
  records each call, so an empty record shows the refusal came from the
  parse, before the command's transaction.
*/

const transacted: string[] = [];

const transactions: TransactionManager = {
  run: async <T>(): Promise<T> => {
    transacted.push("transaction");
    return { output: { accepted: true }, events: [] } as T;
  },
};

const bus = new AtomicCommandBus({
  registry: createCoreCommandRegistry(),
  transactions,
  fingerprintSecret: "free-form-inputs-fingerprint-secret",
});

const agentContext = {
  actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f0005" },
  organizationId,
  projectId: "018f0000-0000-7000-8000-0000000f0006",
  laneIds: new Set<string>(),
  scopes: new Set<string>(agentScopes),
  credentialId: "free-form-inputs-credential",
  authorizationId: "free-form-inputs-authorization",
  correlationId: "018f0000-0000-7000-8000-0000000f0007",
};

/** The details of the DomainError `name` with `input` is refused with. */
async function busRefusal(name: string, input: unknown) {
  transacted.length = 0;
  const refused = await bus
    .execute({
      name,
      input,
      context: agentContext as never,
      meta: { idempotencyKey: "free-form-inputs-bus-0001", expectedVersion: 0 },
    })
    .then(
      () => undefined,
      (error: unknown) => error as { code?: string; details?: unknown },
    );
  expect(transacted).toEqual([]);
  return { code: refused?.code, details: refused?.details };
}

const busCases = [
  {
    name: "post_work_update",
    field: "evidence",
    bound: "elements",
    maximum: 10_000,
    input: workUpdate([{ data: zeros(10_001) }]),
  },
  {
    name: "post_work_update",
    field: "evidence",
    bound: "depth",
    maximum: 8,
    input: workUpdate([{ data: nested(9) }]),
  },
  {
    name: "post_work_update",
    field: "evidence",
    bound: "bytes",
    maximum: 262_144,
    input: workUpdate([{ data: "x".repeat(262_144 - 12) }]),
  },
  {
    name: "attach_artifact",
    field: "provenance",
    bound: "elements",
    maximum: 2_000,
    input: artifact({ a: zeros(1_000), b: zeros(1_001) }),
  },
  {
    name: "attach_artifact",
    field: "provenance",
    bound: "depth",
    maximum: 8,
    input: artifact({ data: nested(9) }),
  },
  {
    name: "attach_artifact",
    field: "provenance",
    bound: "bytes",
    maximum: 65_536,
    input: artifact({ data: "x".repeat(65_536 - 10) }),
  },
  {
    name: "answer_question",
    field: "structuredValue",
    bound: "elements",
    maximum: 2_000,
    input: answer(zeros(2_001)),
  },
  {
    name: "answer_question",
    field: "structuredValue",
    bound: "depth",
    maximum: 8,
    input: answer(nested(9)),
  },
  {
    name: "answer_question",
    field: "structuredValue",
    bound: "bytes",
    maximum: 65_536,
    input: answer("x".repeat(65_536 - 1)),
  },
] as const;

describe("through AtomicCommandBus, a refusal names the input, the bound and its maximum", () => {
  test.each(busCases)(
    "$name: $field past its $bound is refused validation_failed with { field, bound, maximum }",
    async ({ name, field, bound, maximum, input }) => {
      expect(await busRefusal(name, input)).toEqual({
        code: "validation_failed",
        details: { field, bound, maximum },
      });
    },
  );

  test("a refusal by the key count or the sensitive-content check names the field alone", async () => {
    expect(
      await busRefusal(
        "post_work_update",
        workUpdate([
          Object.fromEntries(
            Array.from({ length: 65 }, (_, field) => [`field${field}`, 0]),
          ),
        ]),
      ),
    ).toEqual({ code: "validation_failed", details: { field: "evidence.0" } });
    expect(
      await busRefusal(
        "attach_artifact",
        artifact({ password: "correct-horse-battery" }),
      ),
    ).toEqual({ code: "validation_failed", details: { field: "provenance" } });
    expect(
      await busRefusal(
        "answer_question",
        answer({ password: "correct-horse-battery" }),
      ),
    ).toEqual({
      code: "validation_failed",
      details: { field: "structuredValue" },
    });
  });
});
