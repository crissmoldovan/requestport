import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_requestport_unconfigured",
  dirs: ["./src"],
  runtime: "node-22",
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 4,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 60_000,
      factor: 2,
      randomize: true,
    },
  },
});
