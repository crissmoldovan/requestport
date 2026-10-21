import { EmptyState, Panel, PanelHeader, Row } from "@cueplusplus/ui/chrome";
import { Stack } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import { createAgentManagementRepository } from "@requestport/db";
import { agentScopes } from "@requestport/domain";
import { KeyRound } from "lucide-react";
import { notFound } from "next/navigation";

import {
  AgentConsentDecision,
  AgentConsentDenial,
} from "../../../components/agent-consent-form.js";
import { Page, PageSection } from "../../../components/page-layout.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";
import {
  approveAgentConsentAction,
  denyAgentConsentAction,
} from "./actions.js";
import { newAgentPrincipalValue } from "./consent-action-state.js";

type ConsentSearchParams = Record<string, string | string[] | undefined>;

function queryString(searchParams: ConsentSearchParams) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        query.append(key, entry);
      });
    } else if (value !== undefined) query.set(key, value);
  }
  return query.toString();
}

/**
 * Whether the authorization request has already lapsed.
 *
 * Better Auth signs this query with an `exp`, ten minutes out, and refuses it
 * afterwards. Until now nothing here looked: a person could read the whole
 * provisioning warning, approve eleven minutes later, and be told the
 * connection could not be authorized — with no mention of time and nothing to
 * do about it. That happened, and cost an hour to diagnose from the outside.
 *
 * This reads the parameter and nothing else. It does **not** verify the
 * signature, so it cannot say a request is genuine — only that one which
 * claims an expiry has passed it. A forged `exp` makes this page refuse a
 * request the authorization server would have refused anyway, which is the
 * harmless direction; the server remains the only thing that decides whether
 * a request is real.
 */
function hasLapsed(params: ConsentSearchParams) {
  const exp = typeof params.exp === "string" ? Number(params.exp) : Number.NaN;
  if (!Number.isFinite(exp) || exp <= 0) return false;
  return exp * 1_000 <= Date.now();
}

export default async function AgentConsentPage({
  searchParams,
}: {
  searchParams: Promise<ConsentSearchParams>;
}) {
  /**
   * The query is read here, by the only surface in this segment given it — and
   * not in time to be carried anywhere.
   *
   * The segment layout runs the same gate, but it does not run *before* this
   * one: Next renders a layout and its page concurrently, the layout receiving
   * its child as an element it has not yet resolved. So this call is not a
   * re-read of a settled decision — it is this screen's own gate, and it is
   * what stops an unauthenticated request seeing consent content here. The
   * layout's gate stands on its own for the same reason, and both are proved
   * failable by their own tests rather than by each other.
   *
   * What neither can do is carry the authorization. Whichever redirect wins the
   * race goes to a bare `/sign-in`, because a layout is given no `searchParams`
   * and this page loses the race as often as it wins it. So an unauthenticated
   * *GET* of this screen still drops the request the agent is waiting on.
   * `oauth/layout.tsx` records what closing that would take. The *POST* out of
   * this screen is carried, by `actions.ts`, out of the submission — that half
   * is closed.
   */
  const [params, application] = await Promise.all([
    searchParams,
    getApplicationContext(),
  ]);
  const oauthQuery = queryString(params);
  const clientId = typeof params.client_id === "string" ? params.client_id : "";
  const requestedScopes =
    typeof params.scope === "string"
      ? params.scope
          .split(" ")
          .filter((scope) => (agentScopes as readonly string[]).includes(scope))
      : [];
  if (!clientId || !oauthQuery) notFound();
  /**
   * Said before the page is built, not after the person has read it.
   *
   * Everything below describes a grant they are about to approve. Drawing all
   * of it for a request that can no longer be approved is the part that wastes
   * their time — the refusal afterwards was never the expensive half.
   */
  if (hasLapsed(params)) {
    return (
      <main>
        <Page
          description="Authorization requests are short-lived, so a link left open stops working."
          eyebrow="Authorization"
          title="This request has expired"
          width="form"
        >
          <PageSection labelledBy="oauth-expired-heading">
            <Panel>
              <EmptyState
                hint="Ask the agent to start the connection again. Nothing was authorized and nothing was changed."
                icon={KeyRound}
                title="Start the connection again"
              />
            </Panel>
          </PageSection>
        </Page>
      </main>
    );
  }
  const storage = webStorage();
  const options = await createAgentManagementRepository(
    storage.db,
  ).getConsentOptions(application.session.user.id, clientId);
  /**
   * A provisioning request is approved against an organization, not a project.
   *
   * Its capability is organization-wide, it names no project, and requiring one
   * is what made an organization's first project impossible to create over MCP
   * — there was nothing to bind a grant to, so the screen gave up. Recognised
   * by the scope being exactly this one, because the scope is exclusive: a
   * request mixing it with anything else is not a provisioning request and must
   * not be shown as one.
   */
  const provisioning =
    requestedScopes.length === 1 && requestedScopes[0] === "project:provision";
  /**
   * Asked for alongside anything else, it can never be granted.
   *
   * The binder refuses the combination outright — a provisioning grant may
   * carry no other scope. Drawing an ordinary, approvable project screen for
   * it meant a person could fill the whole form in and be refused on submit
   * for a reason that was decided before the page was drawn.
   */
  const impossibleScopeMix =
    !provisioning && requestedScopes.includes("project:provision");
  /*
    A request naming no capability this server grants.

    The list above is filtered to the scopes RequestPort understands, and a
    request that names none of them — `openid offline_access` and nothing else,
    say — used to leave every control on the screen. A person could choose an
    organization, name a principal and press Allow, and the binder would refuse
    it for a reason decided before the page was drawn. The same shape as the
    impossible mix, one field over, so it ends the same way.
  */
  const noGrantableScope = requestedScopes.length === 0;
  if (impossibleScopeMix || noGrantableScope) {
    return (
      <main>
        <Page
          description={
            noGrantableScope
              ? "This request names no capability RequestPort grants, so there is nothing here to approve."
              : "A provisioning grant is organization-wide and exclusive, so it cannot be combined with project scopes."
          }
          eyebrow="Authorization"
          title="This request cannot be approved"
          width="form"
        >
          <PageSection labelledBy="oauth-impossible-heading">
            <Panel>
              <EmptyState
                hint={
                  noGrantableScope
                    ? "Ask the agent to request the RequestPort scopes it needs. Scopes this server does not grant are ignored, and a request made only of them has nothing to approve."
                    : "Ask the agent to request project:provision on its own, or to request only the project scopes it needs."
                }
                icon={KeyRound}
                title={
                  noGrantableScope
                    ? "No RequestPort scope requested"
                    : "project:provision may carry no other scope"
                }
              />
              {/*
                And an answer for the agent. There is nothing to approve here,
                but the client is waiting on its callback: denial is what ends
                that wait instead of letting it time out on silence.
              */}
              <AgentConsentDenial
                clientId={clientId}
                deny={denyAgentConsentAction}
                oauthQuery={oauthQuery}
              />
            </Panel>
          </PageSection>
        </Page>
      </main>
    );
  }
  if (!options) notFound();
  /*
    Nothing to bind to is not nothing at this address.

    A person with an account, a membership and a valid signed request, whose
    organization simply has no project yet, was shown the generic "Nothing
    lives at this address" — the same page as a typo. They had done nothing
    wrong, nothing on the screen said what was missing, and the agent waiting
    on its callback was told nothing either. What is missing is knowable here,
    so it is said, and denial ends the agent's wait.
  */
  const nothingToBind = provisioning
    ? !options.organizations.length
    : !options.projects.length;
  if (nothingToBind) {
    return (
      <main>
        <Page
          description="This connection needs somewhere to live, and there is nowhere to put it yet."
          eyebrow="Authorization"
          title="This connection has nowhere to go"
          width="form"
        >
          <PageSection labelledBy="oauth-nothing-to-bind-heading">
            <Panel>
              <EmptyState
                hint={
                  provisioning
                    ? "A provisioning grant is organization-wide, and it can only be approved by an owner or an administrator. Ask somebody who administers this organization to connect the agent."
                    : "This agent asks for access to a project, and there is no project here you maintain. Create one, or ask to be added to an existing one, and start the connection again."
                }
                icon={KeyRound}
                title={
                  provisioning
                    ? "No organization you administer"
                    : "No project to bind this to"
                }
              />
              <AgentConsentDenial
                clientId={clientId}
                deny={denyAgentConsentAction}
                oauthQuery={oauthQuery}
              />
            </Panel>
          </PageSection>
        </Page>
      </main>
    );
  }
  const proposedName = options.client.name?.trim() || "Connected agent";
  const proposedSlug = proposedName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63);
  /**
   * What the person is choosing between.
   *
   * A provisioning grant binds to an organization and no project, so the value
   * carries an empty project half — the same `organizationId:projectId` shape
   * the action already parses, with nothing after the colon. That keeps one
   * parser rather than two, and makes "no project" explicit in the submitted
   * value instead of inferred from its absence.
   */
  const projectOptions = provisioning
    ? options.organizations.map((organization) => ({
        label: organization.name,
        value: `${organization.id}:`,
      }))
    : options.projects.map((project) => ({
        label: `${project.organizationName} / ${project.name}`,
        value: `${project.organizationId}:${project.id}`,
      }));
  /**
   * Lanes carried their project, and none are offered without one.
   *
   * `options.lanes` spans every project this person manages, and the form drew
   * all of them whatever was selected. A lane from another project is refused
   * by the binder as invalid, and any lane at all is refused for a
   * provisioning grant — which names no project — so the screen offered two
   * ways to be told "you do not have permission to authorize this connection"
   * for choices it had just presented as available. The project each belongs
   * to travels with it so the form can offer only the ones that apply.
   */
  const laneOptions = provisioning
    ? []
    : options.lanes.map((lane) => ({
        label: `${
          options.projects.find((project) => project.id === lane.projectId)
            ?.name ?? "Project"
        } / ${lane.name}`,
        projectId: lane.projectId,
        value: lane.id,
      }));
  /**
   * A principal serves this grant, or it is not offered.
   *
   * The binder requires an organization-scoped principal for a provisioning
   * grant, and for any other grant one belonging to the project being bound.
   * Offering the rest produced the same false refusal the lanes did.
   */
  const principalOptions = [
    {
      label: "Create a new agent principal",
      // Created to fit whatever binding is chosen, so neither half confines it.
      organizationId: null,
      projectId: null,
      value: newAgentPrincipalValue,
    },
    ...options.agents
      .filter((agent) =>
        provisioning
          ? agent.projectId === null
          : agent.projectId === null ||
            options.projects.some((project) => project.id === agent.projectId),
      )
      .map((agent) => ({
        label: `${agent.organizationName} / ${agent.displayName}`,
        // Both halves of the binding, because the binder scopes by both. A
        // principal belongs to one organization, and an organization-scoped
        // one from another organization is refused exactly as a lane from
        // another project is.
        organizationId: agent.organizationId,
        projectId: agent.projectId,
        value: agent.id,
      })),
  ];

  return (
    <main>
      <Page
        description="An external agent wants delegated access to RequestPort. Confirm the exact identity, project, and capabilities before continuing."
        eyebrow="Authorization"
        title="Connect an agent"
        width="form"
      >
        <PageSection labelledBy="oauth-client-heading">
          <Stack direction="column" gap={5}>
            <Panel>
              <PanelHeader
                title={
                  <span id="oauth-client-heading">
                    Untrusted client metadata
                  </span>
                }
              />
              <Row>
                <span>{options.client.name ?? "Unnamed OAuth client"}</span>
                <Chip tone="neutral">{options.client.clientId}</Chip>
              </Row>
              <Row>
                <span>
                  {options.client.uri ?? "No client website supplied"}
                </span>
              </Row>
            </Panel>
            <Panel>
              <PanelHeader title="Requested capabilities" />
              {provisioning ? (
                /**
                 * Said in words, because the scope string does not say it.
                 *
                 * This is the most powerful grant the system issues, and a
                 * person shown only `project:provision` cannot know that it
                 * creates projects anywhere in the organization and mints
                 * credentials for any of them — including projects that already
                 * hold real work. Consent that does not describe what is being
                 * consented to is a formality rather than a decision.
                 */
                <Row>
                  <Stack direction="column" gap={2}>
                    <strong>
                      This agent will act as you, across this whole
                      organization.
                    </strong>
                    <span>
                      It can create projects, and issue credentials for any
                      project in the organization — including ones that already
                      hold work. It cannot read or change that work itself: it
                      holds no other capability, and every credential it issues
                      is a separate, visible one.
                    </span>
                    <span>
                      Revoking this grant revokes every credential it issued, in
                      one act. That is the way to undo it.
                    </span>
                  </Stack>
                </Row>
              ) : null}
              {requestedScopes.length === 0 ? (
                <EmptyState
                  hint="RequestPort refuses a token when no agent scope is requested."
                  icon={KeyRound}
                  title="No RequestPort scope requested"
                />
              ) : (
                requestedScopes.map((scope) => (
                  <Row key={scope}>
                    <Chip tone="accent">{scope}</Chip>
                  </Row>
                ))
              )}
            </Panel>
            {/*
              No id is passed for a proposed principal, and none should be.
              This page is rendered afresh on every attempt, so anything minted
              here differs between an attempt and its retry — and the consent's
              idempotency receipt covers the proposed principal, so a moving id
              makes every retry conflict with the attempt before it, for good.
              Retrying is the only thing a person can do at that point, and it
              could never work. The action derives the id from the signed query
              and the person instead.
            */}
            <AgentConsentDecision
              approve={approveAgentConsentAction}
              clientId={clientId}
              deny={denyAgentConsentAction}
              laneOptions={laneOptions}
              oauthQuery={oauthQuery}
              principalOptions={principalOptions}
              projectOptions={projectOptions}
              proposedName={proposedName}
              proposedSlug={
                proposedSlug.length >= 2 ? proposedSlug : "connected-agent"
              }
            />
          </Stack>
        </PageSection>
      </Page>
    </main>
  );
}
