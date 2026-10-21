export type ParsedLegacyRecord = {
  recordIndex: number;
  kind: "request" | "response" | "handoff" | "research" | "unknown";
  legacyKey?: { namespace: string; normalizedKey: string };
  title?: string;
  bodyMarkdown: string;
  statusClaim?: string;
  acceptanceCriteria: string[];
  referencedPaths: string[];
  relatedLegacyKeys: string[];
  confidence: Record<string, number>;
  warnings: string[];
};
