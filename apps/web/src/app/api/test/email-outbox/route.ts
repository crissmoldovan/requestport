import { createFakeEmailOutboxHandlers } from "../../../../test/fake-email-outbox.js";

const handlers = createFakeEmailOutboxHandlers();

export const DELETE = handlers.DELETE;
export const POST = handlers.POST;
