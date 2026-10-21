import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import type {
  AuthorizedCommandContext,
  EncryptedEnvelope,
  EnvelopeEncryption,
} from "@requestport/domain";
import { afterEach, describe, expect, test } from "vitest";

import {
  createWebhookManagementService,
  deliverWebhook,
  type EndpointResolver,
  isForbiddenAddress,
  resolveWebhookEndpoint,
  type WebhookManagementRepository,
  type WebhookSubscriptionRecord,
} from "./index.js";

/*
 * The operator's opt-in for private and loopback webhook receivers (Plan 13,
 * H.10; the owner's H question 9, ruling 175; its shape, ruling 176). The
 * policy takes the switch as an input, `privateReceivers`, and reads no
 * environment. Off, which is every caller that does not pass it, it judges
 * exactly as it did before the switch existed. On, it admits loopback
 * (127.0.0.0/8, ::1), RFC 1918 (10/8, 172.16/12, 192.168/16), shared address
 * space (100.64/10) and IPv6 unique-local (fc00::/7), and nothing else:
 * link-local, the cloud metadata addresses the policy names inside those
 * ranges, unspecified, multicast, broadcast and the other reserved ranges
 * stay refused. The named metadata addresses are the known ones, not every
 * address a cloud may place in those ranges: any other is admitted on. A
 * receiver whose every address is admitted private may use http under the
 * production policy too; every other receiver keeps the rules it had.
 *
 * Nothing here leaves the machine: addresses come from a stand-in resolver
 * or from an IP literal, which the default resolver answers without a query,
 * and the only sockets opened are to servers this file starts on 127.0.0.1.
 */

/** The ranges the switch admits: off refused, on admitted. Edges included. */
const admittedClasses: Array<[string, string[]]> = [
  ["loopback 127.0.0.0/8", ["127.0.0.1", "127.255.255.254"]],
  ["loopback ::1", ["::1"]],
  ["RFC 1918 10.0.0.0/8", ["10.0.0.0", "10.255.255.255"]],
  ["RFC 1918 172.16.0.0/12", ["172.16.0.1", "172.31.255.254"]],
  ["RFC 1918 192.168.0.0/16", ["192.168.0.1", "192.168.255.254"]],
  ["shared address space 100.64.0.0/10", ["100.64.0.1", "100.127.255.254"]],
  ["unique-local fc00::/7", ["fc00::1", "fdff:ffff::1"]],
  [
    "the same, IPv4-mapped",
    ["::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:192.168.0.1"],
  ],
];

/** What the switch never admits: refused off and on. */
const alwaysRefusedClasses: Array<[string, string[]]> = [
  ["link-local 169.254.0.0/16", ["169.254.0.1", "169.254.255.254"]],
  ["link-local fe80::/10", ["fe80::1", "febf::ffff"]],
  [
    "cloud metadata on link-local",
    ["169.254.169.254", "169.254.170.2", "::ffff:169.254.169.254"],
  ],
  [
    // Inside ranges the switch admits, so named one by one, and only those
    // known (a list, not every address a cloud may place there): Alibaba
    // Cloud's ECS metadata service (in 100.64.0.0/10), and AWS's IPv6 IMDS,
    // EKS Pod Identity Agent, Google Compute Engine's, Oracle Cloud's and
    // Scaleway's IPv6 metadata services (in fc00::/7).
    "known cloud metadata inside admitted ranges",
    [
      "100.100.100.200",
      "::ffff:100.100.100.200",
      "fd00:ec2::254",
      "fd00:ec2::23",
      "fd20:ce::254",
      "fd00:c1::a9fe:a9fe",
      "fd00:42::42",
    ],
  ],
  ["unspecified and this-network", ["0.0.0.0", "0.1.2.3", "::"]],
  ["multicast", ["224.0.0.1", "239.255.255.255", "ff02::1"]],
  ["broadcast and 240.0.0.0/4", ["255.255.255.255", "240.0.0.1"]],
  [
    "other reserved IPv4",
    ["192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1"],
  ],
  [
    "other reserved IPv6",
    [
      "100::1",
      "2001::1",
      "2001:db8::1",
      "2002::1",
      "3fff::1",
      "64:ff9b::a00:1",
      "64:ff9b:1::1",
    ],
  ],
  ["not an address", ["not-an-address", "10.0.0", "fc00::g"]],
];

/** Public addresses at the admitted ranges' edges: admitted off and on. */
const publicEdges = [
  "9.255.255.255",
  "11.0.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "126.255.255.255",
  "128.0.0.0",
  "172.15.255.255",
  "172.32.0.0",
  "192.167.255.255",
  "192.169.0.0",
  "93.184.216.34",
  "2606:2800:220:1:248:1893:25c8:1946",
];

/**
 * Outside the admitted ranges the switch changes no verdict, whatever today's
 * rule answers. Some of these today's rule admits although they are not
 * public: the unassigned space either side of fc00::/7, site-local fec0::/10
 * and the IPv4-compatible ::a.b.c.d form (H.10's recount, track-h.md). That
 * is the rule as it stands, not this switch's to change, so it is held equal
 * here rather than pinned as right.
 */
const outsideTheSwitch = [
  "fbff:ffff::1",
  "fe00::1",
  "fec0::1",
  "::127.0.0.1",
  "::10.0.0.1",
  "169.254.169.254",
  "224.0.0.1",
  "93.184.216.34",
];

describe("the address rule", () => {
  test.each(admittedClasses)(
    "%s: refused with the switch off, admitted with it on",
    (_name, addresses) => {
      for (const address of addresses) {
        expect(isForbiddenAddress(address), address).toBe(true);
        expect(
          isForbiddenAddress(address, { privateReceivers: false }),
          address,
        ).toBe(true);
        expect(
          isForbiddenAddress(address, { privateReceivers: true }),
          address,
        ).toBe(false);
      }
    },
  );

  test.each(alwaysRefusedClasses)(
    "%s: refused with the switch off and with it on",
    (_name, addresses) => {
      for (const address of addresses) {
        expect(isForbiddenAddress(address), address).toBe(true);
        expect(
          isForbiddenAddress(address, { privateReceivers: true }),
          address,
        ).toBe(true);
      }
    },
  );

  test("public addresses at the admitted ranges' edges are admitted either way", () => {
    for (const address of publicEdges) {
      expect(isForbiddenAddress(address), address).toBe(false);
      expect(
        isForbiddenAddress(address, { privateReceivers: true }),
        address,
      ).toBe(false);
    }
  });

  test("outside the admitted ranges, the switch on answers what it answers off", () => {
    for (const address of outsideTheSwitch) {
      expect(
        isForbiddenAddress(address, { privateReceivers: true }),
        address,
      ).toBe(isForbiddenAddress(address));
    }
  });
});

const resolveTo =
  (...addresses: string[]): EndpointResolver =>
  async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? (6 as const) : (4 as const),
    }));

async function verdict(
  url: string,
  options: Parameters<typeof resolveWebhookEndpoint>[1],
) {
  try {
    const { addresses } = await resolveWebhookEndpoint(url, options);
    return `admitted ${addresses.map((row) => row.address).join(",")}`;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("the scheme rule, under the production policy", () => {
  test("http to a receiver whose every address is private: refused off, admitted on", async () => {
    const resolver = resolveTo("192.168.1.5", "fd12:3456::5");
    expect(await verdict("http://lan.example/hook", { resolver })).toBe(
      "https_required",
    );
    expect(
      await verdict("http://lan.example/hook", {
        resolver,
        privateReceivers: true,
      }),
    ).toBe("admitted 192.168.1.5,fd12:3456::5");
    expect(
      await verdict("http://localhost/hook", {
        resolver: resolveTo("127.0.0.1", "::1"),
        privateReceivers: true,
      }),
    ).toBe("admitted 127.0.0.1,::1");
  });

  test("http to a public receiver: refused off and on", async () => {
    for (const privateReceivers of [false, true]) {
      expect(
        await verdict("http://hooks.example.com/hook", {
          resolver: resolveTo("93.184.216.34"),
          privateReceivers,
        }),
      ).toBe("https_required");
    }
  });

  test("a name resolving to one private and one public address is judged by the rule: https admitted on, http refused on, both refused off", async () => {
    const resolver = resolveTo("10.0.0.5", "93.184.216.34");
    expect(
      await verdict("https://mixed.example/hook", {
        resolver,
        privateReceivers: true,
      }),
    ).toBe("admitted 10.0.0.5,93.184.216.34");
    expect(
      await verdict("http://mixed.example/hook", {
        resolver,
        privateReceivers: true,
      }),
    ).toBe("https_required");
    expect(await verdict("https://mixed.example/hook", { resolver })).toBe(
      "unsafe_endpoint_address",
    );
    expect(await verdict("http://mixed.example/hook", { resolver })).toBe(
      "https_required",
    );
  });

  test("a private name with one link-local or metadata address is refused on, over https and http", async () => {
    for (const extra of ["169.254.169.254", "fd00:ec2::254"]) {
      const resolver = resolveTo("10.0.0.5", extra);
      expect(
        await verdict("https://mixed.example/hook", {
          resolver,
          privateReceivers: true,
        }),
      ).toBe("unsafe_endpoint_address");
      expect(
        await verdict("http://mixed.example/hook", {
          resolver,
          privateReceivers: true,
        }),
      ).toBe("https_required");
    }
  });

  test("https to a private receiver: refused off, admitted on", async () => {
    const resolver = resolveTo("10.0.0.5");
    expect(await verdict("https://lan.example/hook", { resolver })).toBe(
      "unsafe_endpoint_address",
    );
    expect(
      await verdict("https://lan.example/hook", {
        resolver,
        privateReceivers: true,
      }),
    ).toBe("admitted 10.0.0.5");
  });

  test("the port rule, under the production policy: with the switch on, a receiver whose every address is private may use any port; a public or mixed one may not; off, unchanged (ruling 179)", async () => {
    const loopback = resolveTo("127.0.0.1");
    expect(
      await verdict("http://localhost:8080/hook", {
        resolver: loopback,
        privateReceivers: true,
      }),
    ).toBe("admitted 127.0.0.1");
    expect(
      await verdict("https://lan.example:8443/hook", {
        resolver: resolveTo("192.168.1.5", "fd12:3456::5"),
        privateReceivers: true,
      }),
    ).toBe("admitted 192.168.1.5,fd12:3456::5");
    expect(
      await verdict("https://public.example:8443/hook", {
        resolver: resolveTo("93.184.216.34"),
        privateReceivers: true,
      }),
    ).toBe("unsafe_endpoint_port");
    expect(
      await verdict("https://mixed.example:8443/hook", {
        resolver: resolveTo("10.0.0.5", "93.184.216.34"),
        privateReceivers: true,
      }),
    ).toBe("unsafe_endpoint_port");
    expect(
      await verdict("https://localhost:8443/hook", { resolver: loopback }),
    ).toBe("unsafe_endpoint_port");
    expect(
      await verdict("http://localhost:8080/hook", {
        resolver: loopback,
        privateReceivers: true,
        production: false,
      }),
    ).toBe("admitted 127.0.0.1");
  });

  test("no answer, credentials, a query or a fragment are refused on, as off", async () => {
    expect(
      await verdict("http://lan.example/hook", {
        resolver: resolveTo(),
        privateReceivers: true,
      }),
    ).toBe("unsafe_endpoint_address");
    for (const url of [
      "http://user:pass@lan.example/hook",
      "http://lan.example/hook?token=1",
      "http://lan.example/hook#x",
    ]) {
      expect(
        await verdict(url, {
          resolver: resolveTo("192.168.1.5"),
          privateReceivers: true,
        }),
      ).toBe("unsafe_endpoint_url");
    }
    expect(
      await verdict("ftp://lan.example/hook", {
        resolver: resolveTo("192.168.1.5"),
        privateReceivers: true,
      }),
    ).toBe("https_required");
  });
});

/* A receiver on 127.0.0.1, on a port the system chooses. */
type Receiver = { port: number; requests: string[]; close(): Promise<void> };
const receivers: Receiver[] = [];

async function startReceiver(
  respond: (response: import("node:http").ServerResponse) => void = (
    response,
  ) => {
    response.statusCode = 204;
    response.end();
  },
): Promise<Receiver> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => respond(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const receiver = {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  receivers.push(receiver);
  return receiver;
}

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
});

const delivery = {
  eventId: "018f0000-0000-7000-8000-0000000f1001",
  deliveryId: "018f0000-0000-7000-8000-0000000f1002",
  attempt: 1,
  schemaVersion: 1,
  keyId: "whk_private",
  secret: "private-receiver-secret",
  payload: { type: "request.submitted.v1" },
};

describe("delivery", () => {
  test.each([false, undefined])(
    "to a loopback receiver, under production %j: refused off before its addresses are recorded, admitted on",
    async (production) => {
      const endpointUrl = "http://receiver.test/hook";
      const resolver = resolveTo("127.0.0.1");
      const recorded: string[][] = [];
      const onResolved = async ({ addresses }: { addresses: string[] }) => {
        recorded.push(addresses);
        throw new Error("admitted");
      };

      await expect(
        deliverWebhook({
          ...delivery,
          endpointUrl,
          resolver,
          production,
          onResolved,
        }),
      ).rejects.toThrow(
        production === false ? "unsafe_endpoint_address" : "https_required",
      );
      expect(recorded).toEqual([]);

      await expect(
        deliverWebhook({
          ...delivery,
          endpointUrl,
          resolver,
          production,
          privateReceivers: true,
          onResolved,
        }),
      ).rejects.toThrow("admitted");
      expect(recorded).toEqual([["127.0.0.1"]]);
    },
  );

  test("DNS rebinding: a name public at registration and private at delivery is refused at delivery with the switch off", async () => {
    const receiver = await startReceiver();
    const endpointUrl = `http://rebinding.test:${receiver.port}/hook`;
    let resolved = 0;

    await expect(
      resolveWebhookEndpoint(endpointUrl, {
        production: false,
        resolver: resolveTo("93.184.216.34"),
      }),
    ).resolves.toMatchObject({ addresses: [{ address: "93.184.216.34" }] });
    await expect(
      deliverWebhook({
        ...delivery,
        endpointUrl,
        production: false,
        resolver: resolveTo("127.0.0.1"),
        onResolved: async () => {
          resolved += 1;
        },
      }),
    ).rejects.toThrow("unsafe_endpoint_address");
    expect(resolved).toBe(0);
    expect(receiver.requests).toEqual([]);
  });

  test("with the switch on, an http receiver private at registration and public at delivery is refused at delivery", async () => {
    await expect(
      resolveWebhookEndpoint("http://lan.example/hook", {
        privateReceivers: true,
        resolver: resolveTo("192.168.1.5"),
      }),
    ).resolves.toMatchObject({ addresses: [{ address: "192.168.1.5" }] });
    await expect(
      deliverWebhook({
        ...delivery,
        endpointUrl: "http://lan.example/hook",
        privateReceivers: true,
        resolver: resolveTo("93.184.216.34"),
        onResolved: async () => {
          throw new Error("reached_the_socket");
        },
      }),
    ).rejects.toThrow("https_required");
  });

  test("DNS rebinding with the switch on: a name private at registration and a metadata address at delivery is refused at delivery", async () => {
    await expect(
      resolveWebhookEndpoint("https://lan.example/hook", {
        privateReceivers: true,
        resolver: resolveTo("10.0.0.5"),
      }),
    ).resolves.toMatchObject({ addresses: [{ address: "10.0.0.5" }] });
    for (const metadata of ["169.254.169.254", "fd00:ec2::254"]) {
      await expect(
        deliverWebhook({
          ...delivery,
          endpointUrl: "https://lan.example/hook",
          privateReceivers: true,
          resolver: resolveTo(metadata),
          onResolved: async () => {
            throw new Error("reached_the_socket");
          },
        }),
      ).rejects.toThrow("unsafe_endpoint_address");
    }
  });

  test("each redirect is judged by the same rule, over real sockets under Node's default autoselection: with the switch on, a hop to another private receiver is followed and a hop to a metadata address refused", async () => {
    const target = await startReceiver();
    const toPrivate = await startReceiver((response) => {
      response.statusCode = 302;
      response.setHeader("location", `http://lan.test:${target.port}/landed`);
      response.end();
    });
    const toMetadata = await startReceiver((response) => {
      response.statusCode = 307;
      response.setHeader("location", "http://metadata.test/latest/meta-data/");
      response.end();
    });
    const resolver: EndpointResolver = async (hostname) =>
      hostname === "metadata.test"
        ? [{ address: "169.254.169.254", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];

    const followed = await deliverWebhook({
      ...delivery,
      endpointUrl: `http://receiver.test:${toPrivate.port}/hook`,
      resolver,
      production: false,
      privateReceivers: true,
    });
    expect(followed.status).toBe(204);
    expect(target.requests).toEqual(["POST /landed"]);

    await expect(
      deliverWebhook({
        ...delivery,
        endpointUrl: `http://receiver.test:${toMetadata.port}/hook`,
        resolver,
        production: false,
        privateReceivers: true,
      }),
    ).rejects.toThrow("unsafe_endpoint_address");
    expect(toMetadata.requests).toEqual(["POST /hook"]);
  });
});

describe("registration and the endpoint's verification", () => {
  const organizationId = "018f0000-0000-7000-8000-0000000f2001";
  const subscriptionId = "018f0000-0000-7000-8000-0000000f2002";
  const userId = "018f0000-0000-7000-8000-0000000f2003";
  const context: AuthorizedCommandContext = {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(["webhook:manage"]),
    credentialId: "session_1",
    correlationId: "correlation-1",
  };
  const envelope: EncryptedEnvelope = {
    ciphertext: new Uint8Array([1]),
    nonce: new Uint8Array([2]),
    wrappedDek: new Uint8Array([3]),
    kekVersion: "v1",
  };
  const encryption: EnvelopeEncryption = {
    encrypt: async () => envelope,
    decrypt: async <T>() => ({ secret: "plaintext-secret" }) as T,
    rewrap: async (sealed) => sealed,
  };

  function service(
    options: {
      privateReceivers?: boolean;
      production?: boolean;
      endpointUrl?: string;
    } = {},
  ) {
    const repository = {
      canManage: async () => true,
      validateScope: async () => true,
      create: async (input: WebhookSubscriptionRecord) => ({
        record: input,
        secretCiphertext: envelope,
        keyId: input.currentSecretKeyId,
        overlapEndsAt: null,
        replayed: false,
      }),
      find: async (): Promise<WebhookSubscriptionRecord> => ({
        id: subscriptionId,
        organizationId,
        projectId: null,
        name: "Private receiver",
        endpointUrl: options.endpointUrl ?? "https://hooks.example.com/x",
        eventTypes: [],
        projectIds: [],
        laneIds: [],
        requestTypes: [],
        status: "pending_verification",
        version: 1,
        currentSecretCiphertext: envelope,
        currentSecretKeyId: "whk_current",
        nextSecretCiphertext: null,
        nextSecretKeyId: null,
        overlapEndsAt: null,
        verifiedAt: null,
        createdBy: userId,
        createdAt: new Date("2026-10-09T00:00:00.000Z"),
        updatedAt: new Date("2026-10-09T00:00:00.000Z"),
      }),
      markVerified: async () => ({ version: 2, replayed: false }),
    } as Partial<WebhookManagementRepository> as WebhookManagementRepository;
    return createWebhookManagementService({
      repository,
      encryption,
      fingerprintSecret: "webhook-test-fingerprint-secret-0123456789",
      ...(options.production === undefined
        ? {}
        : { production: options.production }),
      ...(options.privateReceivers === undefined
        ? {}
        : { privateReceivers: options.privateReceivers }),
    });
  }

  let key = 0;
  const nextKey = () => {
    key += 1;
    return `create-private-${key}-0000`;
  };
  const create = (built: ReturnType<typeof service>, endpointUrl: string) =>
    built
      .create(
        context,
        { organizationId, name: "Private receiver", endpointUrl },
        { idempotencyKey: nextKey(), expectedVersion: 0 },
      )
      .then(
        (result) => `created ${result.subscription.endpointUrl}`,
        (error: Error) => error.message,
      );

  // IP literals: the default resolver answers them without a DNS query.
  test("registration admits a private receiver only with the switch on, under the production policy", async () => {
    expect(await create(service(), "https://10.0.0.5/hook")).toBe(
      "unsafe_endpoint_address",
    );
    expect(
      await create(
        service({ privateReceivers: false }),
        "https://10.0.0.5/hook",
      ),
    ).toBe("unsafe_endpoint_address");
    expect(
      await create(
        service({ privateReceivers: true }),
        "https://10.0.0.5/hook",
      ),
    ).toBe("created https://10.0.0.5/hook");
    expect(
      await create(
        service({ privateReceivers: true }),
        "http://192.168.1.5/hook",
      ),
    ).toBe("created http://192.168.1.5/hook");
    expect(await create(service(), "http://192.168.1.5/hook")).toBe(
      "https_required",
    );
  });

  test("registration refuses on what the switch never admits, and http to a public receiver", async () => {
    const on = service({ privateReceivers: true });
    expect(await create(on, "http://169.254.169.254/latest")).toBe(
      "https_required",
    );
    expect(await create(on, "https://169.254.169.254/latest")).toBe(
      "unsafe_endpoint_address",
    );
    expect(await create(on, "https://100.100.100.200/latest")).toBe(
      "unsafe_endpoint_address",
    );
    expect(await create(on, "http://93.184.216.34/hook")).toBe(
      "https_required",
    );
  });

  test("verification, over a real socket under Node's default autoselection, delivers to a loopback receiver only with the switch on", async () => {
    const receiver = await startReceiver();
    const endpointUrl = `http://127.0.0.1:${receiver.port}/hook`;
    const meta = {
      idempotencyKey: "verify-private-0001",
      expectedVersion: 1,
    };
    const input = { organizationId, id: subscriptionId };

    await expect(
      service({ production: false, endpointUrl }).verify(context, input, meta),
    ).rejects.toThrow("unsafe_endpoint_address");
    expect(receiver.requests).toEqual([]);

    await expect(
      service({
        production: false,
        endpointUrl,
        privateReceivers: true,
      }).verify(context, input, meta),
    ).resolves.toMatchObject({ verified: true });
    expect(receiver.requests).toEqual(["POST /hook"]);
  });
});

describe("the switch is an input", () => {
  test("no module of the package reads the environment: the switch arrives as privateReceivers or not at all", () => {
    const modules = readdirSync(import.meta.dirname).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );

    expect(modules).toContain("endpoint-policy.ts");
    for (const file of modules) {
      expect(
        readFileSync(join(import.meta.dirname, file), "utf8"),
        file,
      ).not.toMatch(
        /\bprocess\s*(?:\.\s*env\b|\[\s*["'`]env)|import\.meta\.env/u,
      );
    }
  });
});
