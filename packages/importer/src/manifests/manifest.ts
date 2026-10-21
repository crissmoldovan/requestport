import { createHash } from "node:crypto";
import { canonicalJson } from "@requestport/domain";

export function freezeImportManifest(input: unknown) {
  const canonical = canonicalJson(input);
  return {
    canonical,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}
