import type {
  FoundationQueryRepository,
  OrganizationAccess,
} from "@requestport/domain";

export type CurrentOrganizationContext = {
  currentOrganization: OrganizationAccess | null;
  organizations: OrganizationAccess[];
};

export async function resolveCurrentOrganization({
  preferredOrganizationId,
  query,
  userId,
}: {
  preferredOrganizationId: string | undefined;
  query: FoundationQueryRepository;
  userId: string;
}): Promise<CurrentOrganizationContext> {
  const organizations = await query.listActiveOrganizationsForUser(userId);
  const preferred = preferredOrganizationId
    ? organizations.find(
        (organization) => organization.id === preferredOrganizationId,
      )
    : undefined;
  return {
    currentOrganization: preferred ?? organizations[0] ?? null,
    organizations,
  };
}
