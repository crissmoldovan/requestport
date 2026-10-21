import { livenessResponse } from "@requestport/server/health";

export const dynamic = "force-dynamic";

export function GET() {
  return livenessResponse();
}
