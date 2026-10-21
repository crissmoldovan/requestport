import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

import type { NotificationViewModel } from "../view-model.js";

type QuestionModel = Extract<NotificationViewModel, { kind: "question" }>;

export function QuestionEmail({ model }: { model: QuestionModel }) {
  return (
    <Html>
      <Head />
      <Preview>Input needed for {model.requestKey}</Preview>
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
          <Text
            style={{
              color: "#e85d3f",
              fontSize: "12px",
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            RequestPort · human input
          </Text>
          <Heading style={{ fontSize: "24px" }}>
            {model.requestKey}: {model.requestTitle}
          </Heading>
          <Text>
            {model.recipientName}, an agent or maintainer needs a decision for{" "}
            {model.targetProjectName}.
          </Text>
          {model.reason ? (
            <Text style={{ fontWeight: 700 }}>{model.reason}</Text>
          ) : null}
          <Section
            style={{ borderLeft: "3px solid #e85d3f", paddingLeft: "16px" }}
          >
            <Text>{model.question}</Text>
          </Section>
          {model.deadlineAt ? (
            <Text>Requested by {new Date(model.deadlineAt).toUTCString()}</Text>
          ) : null}
          <Button
            href={model.deepLink}
            style={{
              backgroundColor: "#191b1d",
              color: "#fff",
              padding: "10px 16px",
            }}
          >
            Answer in RequestPort
          </Button>
          <Text style={{ color: "#676b6e", fontSize: "12px" }}>
            RequestPort remains the canonical record. Replying to this email
            does not answer the question.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
