import { createHmac } from "node:crypto";

import { DomainError } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import {
  createRateLimiter,
  RATE_LIMIT_POLICIES,
  type RateLimitConsumption,
  type RateLimiterOptions,
  rateLimitFingerprint,
  requestIp,
} from "./rate-limit.js";

test("the seven classes keep today's policies", () => {
  expect(RATE_LIMIT_POLICIES).toEqual({
    auth_initiation: { limit: 10, windowSeconds: 600 },
    token: { limit: 60, windowSeconds: 60 },
    mutation: { limit: 120, windowSeconds: 60 },
    slack_workspace: { limit: 300, windowSeconds: 60 },
    slack_user: { limit: 30, windowSeconds: 60 },
    webhook_admin: { limit: 30, windowSeconds: 60 },
    import_ingestion: { limit: 60, windowSeconds: 60 },
  });
});

describe("rateLimitFingerprint", () => {
  test("is the HMAC-SHA256, under the key, of the parts trimmed and lower-cased, a missing one as '-', joined by NUL", () => {
    const expected = createHmac("sha256", "the-key")
      .update(["203.0.113.7", "-", "-", "person@example.test"].join("\u0000"))
      .digest("hex");

    expect(
      rateLimitFingerprint("the-key", [
        " 203.0.113.7 ",
        null,
        undefined,
        "Person@Example.TEST",
      ]),
    ).toBe(expected);
  });

  test("differs under another key", () => {
    expect(rateLimitFingerprint("one", ["part"])).not.toBe(
      rateLimitFingerprint("two", ["part"]),
    );
  });
});

/** A limiter over recording collaborators, and what each was asked, in order. */
function recordingLimiter(
  answer: { allowed: boolean; remaining: number; retryAfterSeconds: number },
  overrides: Partial<RateLimiterOptions> = {},
) {
  const asked: string[] = [];
  const consumed: RateLimitConsumption[] = [];
  const counted: unknown[][] = [];
  let key = "first-key";
  let environment = "test";
  const limiter = createRateLimiter({
    repository: () => {
      asked.push("repository");
      return {
        consume: async (input) => {
          asked.push("consume");
          consumed.push(input);
          return answer;
        },
      };
    },
    fingerprintKey: () => {
      asked.push("fingerprintKey");
      return key;
    },
    environment: () => {
      asked.push("environment");
      return environment;
    },
    metrics: {
      count: (...args) => {
        asked.push("metrics.count");
        counted.push(args);
      },
    },
    ...overrides,
  });
  return {
    limiter,
    asked,
    consumed,
    counted,
    setKey: (next: string) => {
      key = next;
    },
    setEnvironment: (next: string) => {
      environment = next;
    },
  };
}

describe("createRateLimiter", () => {
  test("reads nothing as it is made", () => {
    const { asked } = recordingLimiter({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 1,
    });

    expect(asked).toEqual([]);
  });

  test("reads its key each time it fingerprints", () => {
    const { limiter, asked, setKey } = recordingLimiter({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 1,
    });

    const first = limiter.fingerprint("203.0.113.7");
    setKey("second-key");
    const second = limiter.fingerprint("203.0.113.7");

    expect(asked).toEqual(["fingerprintKey", "fingerprintKey"]);
    expect(first).toBe(rateLimitFingerprint("first-key", ["203.0.113.7"]));
    expect(second).toBe(rateLimitFingerprint("second-key", ["203.0.113.7"]));
  });

  test("builds its repository and reads its label for each decision, consumes the class's policy and the cost, counts the decision, and answers the repository's result", async () => {
    const answer = { allowed: true, remaining: 9, retryAfterSeconds: 4 };
    const { limiter, asked, consumed, counted, setEnvironment } =
      recordingLimiter(answer);

    const result = await limiter.enforce({
      endpointClass: "auth_initiation",
      fingerprint: "fp-1",
      cost: 3,
    });
    setEnvironment("production");
    await limiter.enforce({ endpointClass: "token", fingerprint: "fp-2" });

    expect(result).toBe(answer);
    expect(asked).toEqual([
      "repository",
      "environment",
      "consume",
      "metrics.count",
      "repository",
      "environment",
      "consume",
      "metrics.count",
    ]);
    // The consumption's members in this order, `cost` present when it was
    // not given: the pre-move goldens record it as the repository received it.
    expect(consumed.map((input) => Object.keys(input))).toEqual([
      [
        "environment",
        "endpointClass",
        "principalFingerprint",
        "limit",
        "windowSeconds",
        "cost",
      ],
      [
        "environment",
        "endpointClass",
        "principalFingerprint",
        "limit",
        "windowSeconds",
        "cost",
      ],
    ]);
    expect(consumed).toEqual([
      {
        environment: "test",
        endpointClass: "auth_initiation",
        principalFingerprint: "fp-1",
        limit: 10,
        windowSeconds: 600,
        cost: 3,
      },
      {
        environment: "production",
        endpointClass: "token",
        principalFingerprint: "fp-2",
        limit: 60,
        windowSeconds: 60,
        cost: undefined,
      },
    ]);
    expect(counted).toEqual([
      [
        "rate_limit.decision_total",
        1,
        { endpointClass: "auth_initiation", status: "allowed" },
      ],
      [
        "rate_limit.decision_total",
        1,
        { endpointClass: "token", status: "allowed" },
      ],
    ]);
  });

  test("a denial is counted, then refused as rate_limited with the repository's retry-after", async () => {
    const { limiter, counted } = recordingLimiter({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 17,
    });

    const refusal = await limiter
      .enforce({ endpointClass: "mutation", fingerprint: "fp" })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({
      code: "rate_limited",
      message: "Too many requests",
      details: { retryAfterSeconds: 17 },
    });
    expect(counted).toEqual([
      [
        "rate_limit.decision_total",
        1,
        { endpointClass: "mutation", status: "denied" },
      ],
    ]);
  });

  test("takes its policies from the options when they are given", async () => {
    const policies = {
      ...RATE_LIMIT_POLICIES,
      token: { limit: 2, windowSeconds: 5 },
    };
    const { limiter, consumed } = recordingLimiter(
      { allowed: true, remaining: 1, retryAfterSeconds: 1 },
      { policies },
    );

    await limiter.enforce({ endpointClass: "token", fingerprint: "fp" });

    expect(consumed[0]).toMatchObject({ limit: 2, windowSeconds: 5 });
  });

  test("a repository that throws reaches the caller, and nothing is counted", async () => {
    const count = vi.fn();
    const { limiter } = recordingLimiter(
      { allowed: true, remaining: 1, retryAfterSeconds: 1 },
      {
        repository: () => ({
          consume: async () => {
            throw new Error("connection refused");
          },
        }),
        metrics: { count },
      },
    );

    await expect(
      limiter.enforce({ endpointClass: "token", fingerprint: "fp" }),
    ).rejects.toThrow("connection refused");
    expect(count).not.toHaveBeenCalled();
  });
});

describe("requestIp", () => {
  const ip = (headers: Record<string, string>) =>
    requestIp(new Request("https://requestport.test/", { headers }));

  test("reads x-vercel-forwarded-for's first entry first", () => {
    expect(
      ip({
        "x-vercel-forwarded-for": " 203.0.113.7 , 10.0.0.1",
        "x-forwarded-for": "198.51.100.9",
      }),
    ).toBe("203.0.113.7");
  });

  test("then x-forwarded-for's first entry", () => {
    expect(ip({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" })).toBe(
      "198.51.100.9",
    );
  });

  test("and answers unknown without either", () => {
    expect(ip({})).toBe("unknown");
  });
});
