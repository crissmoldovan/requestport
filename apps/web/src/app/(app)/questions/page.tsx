import { randomUUID } from "node:crypto";

import { createRequestQueryRepository } from "@requestport/db";
import { redirect } from "next/navigation";

import { QuestionQueueView } from "../../../components/request-workflow.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";

export default async function QuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const context = await getApplicationContext();
  if (!context.currentOrganization) redirect("/");
  const storage = webStorage();
  const requestQueries = createRequestQueryRepository(storage.db);
  const page = await requestQueries.listOpenQuestions({
    userId: context.session.user.id,
    organizationId: context.currentOrganization.id,
    cursor: (await searchParams).cursor,
  });
  return (
    <QuestionQueueView
      answerKeys={Object.fromEntries(
        page.items.map((question) => [
          question.id,
          `web:answer:${randomUUID()}`,
        ]),
      )}
      page={page}
    />
  );
}
