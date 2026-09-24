import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { UsageSource, UsageProviderKind } from "./usage.ts";

const decodeProvider = Schema.decodeSync(UsageProviderKind);
const decodeUsageSource = Schema.decodeSync(UsageSource);

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
});
