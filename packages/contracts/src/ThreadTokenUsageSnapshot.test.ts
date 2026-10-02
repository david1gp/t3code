import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent, ThreadTokenUsageSnapshot } from "./providerRuntime.ts";

const decode = Schema.decodeUnknownSync(ThreadTokenUsageSnapshot);
const encode = Schema.encodeSync(ThreadTokenUsageSnapshot);
const eventDecode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const eventEncode = Schema.encodeSync(ProviderRuntimeEvent);

describe("ThreadTokenUsageSnapshot context availability", () => {
  it.each([
    { usedTokens: 0 },
    { usedTokens: 12_000, maxTokens: 200_000 },
    { contextUsageStatus: "reported", usedTokens: 12_000 },
    { contextUsageStatus: "estimated", usedTokens: 4_000, compactsAutomatically: false },
    { contextUsageStatus: "unknown" },
    { contextUsageStatus: "unknown", maxTokens: 200_000, compactsAutomatically: false },
  ])("round trips occupancy without inventing absent provider fields: %j", (usage) => {
    expect(encode(decode(usage))).toEqual(usage);
    const event = {
      type: "thread.token-usage.updated",
      eventId: "context-availability",
      provider: "pi",
      threadId: "thread-1",
      createdAt: "2026-10-01T00:00:00.000Z",
      payload: { usage },
    };
    expect(eventEncode(eventDecode(event))).toEqual(event);
  });

  it.each([
    {},
    { contextUsageStatus: "reported" },
    { contextUsageStatus: "estimated" },
    { contextUsageStatus: "unknown", usedTokens: 0 },
    { contextUsageStatus: "unknown", usedTokens: 12_000 },
    { contextUsageStatus: "unavailable" },
    { usedTokens: -1 },
    { usedTokens: Infinity },
    { usedTokens: 1.5 },
  ])("rejects contradictory or malformed occupancy: %j", (usage) => {
    expect(() => decode(usage)).toThrow();
  });
});
