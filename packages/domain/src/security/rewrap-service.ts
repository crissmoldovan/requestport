import { type MetricSink, noopMetricSink } from "../observability/metrics.js";
import { DomainError } from "../shared/errors.js";
import type {
  EncryptedEnvelope,
  EnvelopeEncryption,
} from "./envelope-encryption.js";

export type RewrapRecord = {
  id: string;
  organizationId: string;
  telemetrySchemaVersion: number;
  envelope: EncryptedEnvelope;
};

export interface RewrapRepository {
  listBatch(
    fromVersion: string,
    afterId: string | null,
    limit: number,
  ): Promise<RewrapRecord[]>;
  replaceWrappedKey(input: {
    id: string;
    fromVersion: string;
    envelope: EncryptedEnvelope;
  }): Promise<boolean>;
  quarantine(input: { id: string; reason: string }): Promise<void>;
  countVersion(version: string): Promise<number>;
}

export async function rewrapWorkspaceTelemetry(input: {
  repository: RewrapRepository;
  encryption: EnvelopeEncryption;
  fromVersion: string;
  toVersion: string;
  batchSize?: number;
  aad(record: RewrapRecord): Uint8Array;
  metrics?: MetricSink;
}) {
  if (
    !input.fromVersion ||
    !input.toVersion ||
    input.fromVersion === input.toVersion
  )
    throw new Error("Distinct key versions are required");
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 100, 1_000));
  let afterId: string | null = null;
  let rewrapped = 0;
  let quarantined = 0;
  while (true) {
    const rows = await input.repository.listBatch(
      input.fromVersion,
      afterId,
      batchSize,
    );
    if (!rows.length) break;
    for (const row of rows) {
      afterId = row.id;
      try {
        await input.encryption.decrypt<unknown>(row.envelope, input.aad(row));
        const envelope = await input.encryption.rewrap(
          row.envelope,
          input.toVersion,
        );
        if (
          await input.repository.replaceWrappedKey({
            id: row.id,
            fromVersion: input.fromVersion,
            envelope,
          })
        )
          rewrapped += 1;
      } catch (error) {
        if (
          error instanceof DomainError &&
          (error.code === "forbidden" || error.code === "validation_failed")
        ) {
          await input.repository.quarantine({
            id: row.id,
            reason: "encrypted_telemetry_authentication_failed",
          });
          quarantined += 1;
          continue;
        }
        throw error;
      }
    }
    if (rows.length < batchSize) break;
  }
  const remainingFromVersion = await input.repository.countVersion(
    input.fromVersion,
  );
  const metrics = input.metrics ?? noopMetricSink;
  metrics.count("encryption.rewrap_total", rewrapped, { status: "rewrapped" });
  metrics.count("encryption.rewrap_total", quarantined, {
    status: "quarantined",
  });
  metrics.gauge("encryption.rewrap_total", remainingFromVersion, {
    status: "remaining",
  });
  return { rewrapped, quarantined, remainingFromVersion };
}
