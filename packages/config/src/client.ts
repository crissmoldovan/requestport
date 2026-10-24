import { z } from "zod";

/*
  zod 4.4.3's `z.url()`, on zod 4.6.7: valid when the trimmed input parses
  as a URL, and then the trimmed input, a tab or newline inside it kept.
  `@requestport/domain`'s `shared/zod-compat.ts` holds the same helper and
  says what moved; this entry imports nothing but zod.
*/
function parsesAsUrl(value: string) {
  return URL.canParse(value.trim());
}

function trimmedUrl() {
  return z
    .stringFormat("url", parsesAsUrl)
    .overwrite((value) => (parsesAsUrl(value) ? value.trim() : value));
}

const ClientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: trimmedUrl(),
});

export const clientEnv = ClientEnvSchema.parse(process.env);
