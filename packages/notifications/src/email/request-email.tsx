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

type RequestModel = Extract<NotificationViewModel, { kind: "request" }>;

export function RequestEmail({ model }: { model: RequestModel }) {
  return (
    <Html>
      <Head />
      <Preview>{model.requestKey} updated</Preview>
      <Body
        style={{
          backgroundColor: "#f4f4f1",
          color: "#191b1d",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <Container
          style={{
            margin: "32px auto",
            maxWidth: "560px",
            padding: "24px",
            backgroundColor: "#fff",
          }}
        >
          <Text style={{ color: "#e85d3f", fontSize: "12px", fontWeight: 700 }}>
            REQUESTPORT
          </Text>
          <Heading style={{ fontSize: "24px" }}>
            {model.requestKey}: {model.requestTitle}
          </Heading>
          <Text>
            {model.reason ??
              `Activity was recorded for ${model.targetProjectName}.`}
          </Text>
          <Button
            href={model.deepLink}
            style={{
              backgroundColor: "#191b1d",
              color: "#fff",
              padding: "10px 16px",
            }}
          >
            Open request
          </Button>
        </Container>
      </Body>
    </Html>
  );
}
