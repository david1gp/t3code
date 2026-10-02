import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { UsageBucket, UsageSource, UsageProviderKind } from "./usage.ts";

const decodeProvider = Schema.decodeSync(UsageProviderKind);
const decodeUsageSource = Schema.decodeSync(UsageSource);
const decodeUsageBucket = Schema.decodeSync(UsageBucket);

describe("Usage contract", () => {
  it("accepts OpenCode as a provider and carries its partial-coverage description", () => {
    expect(decodeProvider("opencode")).toBe("opencode");
    const source = decodeUsageSource({
      fingerprint: {
        hostId: "host",
        provider: "opencode",
        resolvedHomePath: "T3 Code recorded turns",
        volumeId: "",
      },
      status: "ok",
      scannedFiles: 0,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
      description:
        "Reported costs from OpenCode turns recorded by T3 Code; not OpenCode subscription spend.",
    });

    expect(source.description).toContain("recorded by T3 Code");
  });

  it.each(["ok", "partial"] as const)(
    "preserves Pi source identity and %s coverage status",
    (status) => {
      expect(decodeProvider("pi")).toBe("pi");
      const input = {
        fingerprint: {
          hostId: "host",
          provider: "pi",
          resolvedHomePath: "T3 Code recorded turns",
          volumeId: "",
        },
        status,
        scannedFiles: 0,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
        description: "Reported API-equivalent costs from Pi turns recorded by T3 Code.",
      } as const;

      expect(decodeUsageSource(input)).toEqual(input);
    },
  );

  it("preserves a Pi cost-only bucket without fabricating token totals", () => {
    const input = {
      day: "2026-10-01",
      provider: "pi",
      model: "example-model",
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: 1.25,
      cacheSavingsUsd: 0,
      costSource: "providerReported",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    } as const;

    expect(decodeUsageBucket(input)).toEqual(input);
  });
});
