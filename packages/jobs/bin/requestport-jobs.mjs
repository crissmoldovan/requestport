#!/usr/bin/env node
// The Postgres job worker. The workspace ships TypeScript source, so tsx
// loads it, as it does for the RequestPort CLI.
import { register } from "tsx/esm/api";

register();

const { runJobWorkerCli } = await import("../src/cli.ts");

process.exit(await runJobWorkerCli(process.argv.slice(2), process.env));
