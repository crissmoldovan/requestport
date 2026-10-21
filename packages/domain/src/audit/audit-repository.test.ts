import { describe, expect, test } from "vitest";

import { DomainError } from "../shared/errors.js";
import {
  type AuditAction,
  type AuditTargetType,
  auditActions,
  auditActionTargets,
  auditRecordRow,
  auditTargetTypes,
} from "./audit-repository.js";

function baseInput(action: AuditAction, targetType: AuditTargetType) {
  return {
    organizationId: null,
    actor: { type: "user", userId: "user_1" } as const,
    action,
    targetType,
    targetId: "target_1",
    reason: "Fixed reason",
    fieldNames: ["theme"],
    correlationId: "correlation_1",
  };
}

describe("audit action targets", () => {
  test("pairs every declared action with a declared target", () => {
    // `satisfies` only proves this at compile time, and the map is hand
    // written. A runtime total check is what catches an action added to the
    // union without a pairing, or a pairing edited to an unknown target.
    expect(Object.keys(auditActionTargets).sort()).toEqual(
      [...auditActions].sort(),
    );
    for (const action of auditActions) {
      expect(auditTargetTypes).toContain(auditActionTargets[action]);
    }
    expect(new Set(auditActions).size).toBe(auditActions.length);
    expect(new Set(auditTargetTypes).size).toBe(auditTargetTypes.length);
  });

  test("keeps both appearance actions on their own target types", () => {
    expect(auditActionTargets["appearance.personal_preferences_updated"]).toBe(
      "user_appearance",
    );
    expect(auditActionTargets["appearance.organization_defaults_updated"]).toBe(
      "organization_appearance",
    );
  });
});

describe("audit record row", () => {
  test("projects each allowed action onto its own target", () => {
    for (const action of auditActions) {
      const targetType = auditActionTargets[action];
      expect(auditRecordRow(baseInput(action, targetType))).toMatchObject({
        action,
        targetType,
        actorType: "user",
        actorId: "user_1",
      });
    }
  });

  test("rejects every action filed under another action's target", () => {
    for (const action of auditActions) {
      for (const targetType of auditTargetTypes) {
        if (targetType === auditActionTargets[action]) continue;
        // `security_audit_records` is append-only, so a mismatched row would
        // make the trail permanently unqueryable by target.
        expect(() => auditRecordRow(baseInput(action, targetType))).toThrow(
          expect.objectContaining({ code: "validation_failed" }),
        );
      }
    }
  });

  test("refuses an unauthenticated actor", () => {
    expect(() =>
      auditRecordRow({
        ...baseInput("project.created", "project"),
        actor: { type: "unauthenticated" },
      }),
    ).toThrow(DomainError);
    expect(() =>
      auditRecordRow({
        ...baseInput("project.created", "project"),
        actor: { type: "unauthenticated" },
      }),
    ).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  test("records the system actor by its fixed name", () => {
    expect(
      auditRecordRow({
        ...baseInput("organization.owner_bootstrapped", "organization"),
        actor: { type: "system", system: "bootstrap-owner-cli" },
      }),
    ).toMatchObject({ actorType: "system", actorId: "bootstrap-owner-cli" });
  });

  // Plan 13, F.2.7: an operator credential is recorded as the service it is,
  // `operator:<lineage>`, never as its member (F3-2); no other service is.
  test("records an operator credential as the service actor it is, and refuses any other service", () => {
    expect(
      auditRecordRow({
        ...baseInput("organization.invitation_created", "invitation"),
        actor: { type: "service", id: "operator:lineage_1" },
      }),
    ).toMatchObject({ actorType: "service", actorId: "operator:lineage_1" });
    for (const id of ["requestport-worker", "operator:", ""])
      expect(
        () =>
          auditRecordRow({
            ...baseInput("organization.invitation_created", "invitation"),
            actor: { type: "service", id },
          }),
        id,
      ).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  test("copies the field names rather than aliasing the caller's array", () => {
    const fieldNames = ["theme"];
    const row = auditRecordRow({
      ...baseInput(
        "appearance.organization_defaults_updated",
        "organization_appearance",
      ),
      fieldNames,
    });
    fieldNames.push("mode");
    expect(row.fieldNames).toEqual(["theme"]);
  });
});
