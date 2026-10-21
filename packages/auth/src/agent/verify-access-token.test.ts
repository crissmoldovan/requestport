import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, test } from "vitest";

import { createAgentAccessTokenVerifier } from "./verify-access-token.js";

const issuer = "https://requestport.com";
const mcp = `${issuer}/mcp`;
const api = `${issuer}/api/v1`;

let sign: (claims: Record<string, unknown>) => Promise<string>;
let signWithoutExpiry: (claims: Record<string, unknown>) => Promise<string>;
let jwks: { keys: unknown[] };

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: "EdDSA",
    kid: "k1",
  };
  jwks = { keys: [publicJwk] };
  sign = async (claims) => {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuedAt();
    // A case that supplies its own expiry means it, so the default must not
    // overwrite it — which is how the expired case first passed by accident.
    if (claims.exp === undefined) jwt.setExpirationTime("15m");

    return await jwt.sign(privateKey);
  };
  signWithoutExpiry = async (claims) =>
    await new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuedAt()
      .sign(privateKey);
});

function verifier() {
  return createAgentAccessTokenVerifier({
    audiences: [mcp, api],
    issuer,
    jwks: async () => jwks,
  });
}

describe("an agent's access token", () => {
  test.each([
    ["the MCP resource", mcp],
    ["the API resource", api],
  ])("verifies when its audience is %s", async (_name, audience) => {
    // The audience Better Auth's own endpoint rejects, because it compares
    // against the issuer's origin rather than the resource.
    const token = await sign({
      aud: audience,
      azp: "client",
      iss: issuer,
      sub: "person",
    });

    await expect(verifier()(token)).resolves.toMatchObject({ aud: audience });
  });

  test("is refused when it names an audience this server does not answer", async () => {
    const token = await sign({
      aud: "https://elsewhere.example/mcp",
      azp: "client",
      iss: issuer,
      sub: "person",
    });

    await expect(verifier()(token)).resolves.toBeNull();
  });

  test("is refused when another issuer minted it", async () => {
    const token = await sign({
      aud: mcp,
      azp: "client",
      iss: "https://elsewhere.example",
      sub: "person",
    });

    await expect(verifier()(token)).resolves.toBeNull();
  });

  test("is refused when it has expired", async () => {
    const token = await sign({
      aud: mcp,
      azp: "client",
      exp: Math.floor(Date.now() / 1_000) - 60,
      iss: issuer,
      sub: "person",
    });

    await expect(verifier()(token)).resolves.toBeNull();
  });

  /**
   * Signed by this issuer's own key, for this resource, and with no `exp` —
   * which `jwtVerify` checks only when present. Every token the provider mints
   * carries one, so a token without it is refused here rather than accepted as
   * one that never expires.
   */
  test("is refused when it carries no expiry", async () => {
    const token = await signWithoutExpiry({
      aud: mcp,
      azp: "client",
      iss: issuer,
      sub: "person",
    });

    await expect(verifier()(token)).resolves.toBeNull();
  });

  test("is refused when nothing in the key set signed it", async () => {
    const token = await sign({
      aud: mcp,
      azp: "client",
      iss: issuer,
      sub: "person",
    });
    const stranger = createAgentAccessTokenVerifier({
      audiences: [mcp, api],
      issuer,
      jwks: async () => ({ keys: [] }),
    });

    await expect(stranger(token)).resolves.toBeNull();
  });
});

/**
 * A server that cannot read its own keys has not been handed a bad token.
 *
 * Retrieval used to be inside the same `catch` as verification, so a database
 * blip or an unreadable key set answered the agent with "unauthenticated" —
 * the same answer a forged credential gets. A client that believes that
 * discards a perfectly good token and takes its person back through consent
 * for nothing, and the outage looks like a credential problem to everyone
 * looking at it.
 */
describe("when the key set cannot be read", () => {
  test("says the server is at fault, not the credential", async () => {
    const token = await sign({
      aud: mcp,
      azp: "client",
      iss: issuer,
      sub: "person",
    });
    const broken = createAgentAccessTokenVerifier({
      audiences: [mcp, api],
      issuer,
      jwks: async () => {
        throw new Error("the keys could not be read");
      },
    });

    await expect(broken(token)).rejects.toMatchObject({
      code: "configuration_error",
    });
  });

  test("says the same for a key set that cannot be parsed", async () => {
    const token = await sign({
      aud: mcp,
      azp: "client",
      iss: issuer,
      sub: "person",
    });
    const malformed = createAgentAccessTokenVerifier({
      audiences: [mcp, api],
      issuer,
      jwks: async () =>
        ({ keys: "not a list" }) as unknown as { keys: unknown[] },
    });

    await expect(malformed(token)).rejects.toMatchObject({
      code: "configuration_error",
    });
  });

  test("still refuses a token the readable key set did not sign", async () => {
    // Unchanged: an empty key set is a readable answer, and a token nothing in
    // it signed is a token this server will not take.
    const token = await sign({
      aud: mcp,
      azp: "client",
      iss: issuer,
      sub: "person",
    });
    const empty = createAgentAccessTokenVerifier({
      audiences: [mcp, api],
      issuer,
      jwks: async () => ({ keys: [] }),
    });

    await expect(empty(token)).resolves.toBeNull();
  });
});
