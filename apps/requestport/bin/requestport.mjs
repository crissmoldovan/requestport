#!/usr/bin/env node
// The `requestport` program. The workspace ships TypeScript source, so tsx
// loads it, as it does for requestport-jobs (packages/jobs/bin).
import { register } from "tsx/esm/api";

register();

const { runRequestPortCli } = await import("../src/cli.ts");

process.exit(await runRequestPortCli(process.argv.slice(2), process.env));
