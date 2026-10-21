import { databaseProjectVariables } from "../../scripts/hosted-deployment.mjs";

for (const key of [
  "REQUESTPORT_PREVIEW_DATABASE_URL",
  // A Preview's database project, where the hosted deployment names one.
  ...(databaseProjectVariables === null
    ? []
    : [databaseProjectVariables.preview]),
  "REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID",
  "REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET",
  "REQUESTPORT_PREVIEW_RESEND_API_KEY",
  "REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL",
  "REQUESTPORT_WORKSPACE_KEK",
  "REQUESTPORT_WORKSPACE_KEK_VERSION",
  "REQUESTPORT_WORKSPACE_KEK_PREVIOUS",
  "REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION",
  "REQUESTPORT_WEBHOOK_KEK",
  "REQUESTPORT_WEBHOOK_KEK_VERSION",
  "REQUESTPORT_WEBHOOK_KEK_PREVIOUS",
  "REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION",
  "REQUESTPORT_WEBHOOK_SIGNING_KEY",
  "REQUESTPORT_SLACK_SIGNING_SECRET",
  "REQUESTPORT_SLACK_CLIENT_ID",
  "REQUESTPORT_SLACK_CLIENT_SECRET",
  "REQUESTPORT_SLACK_STATE_SECRET",
  "RESEND_WEBHOOK_SECRET",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_PROJECT_REF",
  /*
   * The deployed worker sets no REQUESTPORT_DATABASE_DRIVER — none of its
   * Trigger.dev environments did when read on 2026-09-27 — so it runs the
   * driver packages/db selects when the variable is unset (`DEFAULT_DRIVER`
   * in packages/db/src/hosted-driver.ts: the hosted driver in the private
   * tree, pg in the public one), and these tests import every worker module
   * to prove that loads. The local gate sets `pg` for every workspace, and a
   * developer's `.env.local` may too; removed here, the modules load under
   * the driver the worker actually runs. No test here opens a connection: the
   * DATABASE_URL below is a stand-in, and VERCEL_ENV's empty value already
   * keeps packages/db from pointing the hosted driver at a local proxy.
   */
  "REQUESTPORT_DATABASE_DRIVER",
]) {
  delete process.env[key];
}

Object.assign(process.env, {
  NODE_ENV: "test",
  VERCEL_ENV: "",
  BETTER_AUTH_SECRET: "requestport-test-secret-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://requestport:requestport@localhost/requestport",
  GITHUB_CLIENT_ID: "requestport-test-client",
  GITHUB_CLIENT_SECRET: "requestport-test-secret",
  RESEND_API_KEY: "requestport-test-key",
  RESEND_FROM_EMAIL: "test@example.invalid",
});
