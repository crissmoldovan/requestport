import { createLogger, createMetricSink } from "@requestport/config";

const environment =
  process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";

export const webLogger = createLogger({
  service: "requestport-web",
  environment,
});

export const webMetrics = createMetricSink({
  service: "requestport-web",
  environment,
});
