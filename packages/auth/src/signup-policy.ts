export type SignupDecision =
  | {
      allowed: true;
      reason: "existing_user" | "invitation" | "allowlist";
      invitationId?: string;
    }
  | { allowed: false; reason: "signup_disabled" | "expired" | "revoked" };

export type InvitationEligibility = {
  id: string;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
};

export type AllowlistEligibility = {
  status: string;
  expiresAt: Date | null;
};

export interface SignupPolicyRepository {
  findExistingUser(normalizedEmail: string): Promise<{ id: string } | null>;
  findInvitations(normalizedEmail: string): Promise<InvitationEligibility[]>;
  findAllowlistEntries(
    normalizedEmail: string,
  ): Promise<AllowlistEligibility[]>;
}

export class SignupPolicyDeniedError extends Error {
  readonly reason: Extract<SignupDecision, { allowed: false }>["reason"];

  constructor(reason: SignupPolicyDeniedError["reason"]) {
    super("Signup is not allowed");
    this.name = "SignupPolicyDeniedError";
    this.reason = reason;
  }
}

export function normalizeSignupEmail(email: string) {
  return email.trim().normalize("NFC").toLowerCase();
}

export function createSignupPolicy({
  repository,
  now,
}: {
  repository: SignupPolicyRepository;
  now: () => Date;
}) {
  return {
    async assertSignupAllowed(email: string): Promise<SignupDecision> {
      const normalizedEmail = normalizeSignupEmail(email);
      const existingUser = await repository.findExistingUser(normalizedEmail);
      if (existingUser) {
        return { allowed: true, reason: "existing_user" };
      }

      const [invitations, allowlistEntries] = await Promise.all([
        repository.findInvitations(normalizedEmail),
        repository.findAllowlistEntries(normalizedEmail),
      ]);
      const currentTime = now();

      const activeInvitation = invitations.find(
        (invitation) =>
          invitation.acceptedAt === null &&
          invitation.revokedAt === null &&
          invitation.expiresAt > currentTime,
      );
      if (activeInvitation) {
        return {
          allowed: true,
          reason: "invitation",
          invitationId: activeInvitation.id,
        };
      }

      const activeAllowlist = allowlistEntries.find(
        (entry) =>
          entry.status === "active" &&
          (entry.expiresAt === null || entry.expiresAt > currentTime),
      );
      if (activeAllowlist) {
        return { allowed: true, reason: "allowlist" };
      }

      const hasRevokedEligibility =
        invitations.some((invitation) => invitation.revokedAt !== null) ||
        allowlistEntries.some((entry) => entry.status === "revoked");
      if (hasRevokedEligibility) {
        throw new SignupPolicyDeniedError("revoked");
      }

      const hasExpiredEligibility =
        invitations.some(
          (invitation) =>
            invitation.acceptedAt === null &&
            invitation.expiresAt <= currentTime,
        ) ||
        allowlistEntries.some(
          (entry) =>
            entry.status === "active" &&
            entry.expiresAt !== null &&
            entry.expiresAt <= currentTime,
        );
      if (hasExpiredEligibility) {
        throw new SignupPolicyDeniedError("expired");
      }

      throw new SignupPolicyDeniedError("signup_disabled");
    },
  };
}
