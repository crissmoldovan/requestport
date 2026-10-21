import { describe, expect, test } from "vitest";

import document from "../generated/openapi.json";

const { GET } = await import("./route.js");

describe("GET /docs/api/openapi.json", () => {
  test("serves the committed OpenAPI document as JSON, unchanged", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(
      /^application\/json\b/u,
    );
    await expect(response.json()).resolves.toEqual(document);
  });
});
