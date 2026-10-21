import { z } from "zod";

const ClientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

export const clientEnv = ClientEnvSchema.parse(process.env);
