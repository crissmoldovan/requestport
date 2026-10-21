import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";

import type { NotificationViewModel } from "../view-model.js";

type InvitationModel = Extract<NotificationViewModel, { kind: "invitation" }>;

export function InvitationEmail({ model }: { model: InvitationModel }) {
  return (
    <Html>
      <Head />
      <Preview>
        You are invited to {model.organizationName} on RequestPort
      </Preview>
      <Body
        style={{
          backgroundColor: "#f4f4f1",
          color: "#191b1d",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <Container
          style={{
            backgroundColor: "#fff",
            margin: "32px auto",
            maxWidth: "560px",
            padding: "24px",
          }}
        >
          <Text
            style={{
              color: "#e85d3f",
              fontSize: "12px",
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            RequestPort · invitation
          </Text>
          <Heading style={{ fontSize: "24px" }}>
            Join {model.organizationName}
          </Heading>
          <Text>
            You were invited as {model.role}. Sign in with this email address or
            its matching GitHub account before{" "}
            {new Date(model.expiresAt).toUTCString()}.
          </Text>
          <Button
            href={model.deepLink}
            style={{
              backgroundColor: "#191b1d",
              color: "#fff",
              padding: "10px 16px",
            }}
          >
            Sign in to RequestPort
          </Button>
          <Text style={{ color: "#676b6e", fontSize: "12px" }}>
            The invitation contains no sign-in token. Request a fresh magic link
            on the sign-in page if you use email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
