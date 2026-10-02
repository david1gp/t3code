import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ModelCapabilities } from "./model.ts";
import { ModelMetadata } from "./ModelMetadata.ts";
import { ServerProviderModel } from "./server.ts";

const decodeModel = Schema.decodeUnknownSync(ServerProviderModel);
const encodeModel = Schema.encodeSync(ServerProviderModel);
const decodeCapabilities = Schema.decodeUnknownSync(ModelCapabilities);

const model = {
  slug: "provider/model",
  name: "Model",
  isCustom: false,
  capabilities: null,
};

function modelRoundTrip(input: unknown) {
  return decodeModel(JSON.parse(JSON.stringify(encodeModel(decodeModel(input)))));
}

describe("ServerProviderModel factual metadata", () => {
  it("round-trips native limits, arbitrary modalities, tool support, and request-wide pricing", () => {
    // Native ModelInfo.cost tier.size is a strict total-input threshold, not
    // a context limit or a marginal per-token pricing bracket.
    const metadata = {
      limits: { context: 1_000_000, input: 800_000, output: 64_000 },
      modalities: { input: ["text", "image", "audio"], output: ["text"] },
      tools: true,
      pricing: {
        unit: "usd_per_million_tokens",
        base: { input: 2, output: 12, cache: { read: 0.2, write: 2.5 } },
        tiers: [
          {
            inputTokensAbove: 200_000,
            input: 4,
            output: 18,
            cache: { read: 0.4, write: 5 },
          },
          {
            inputTokensAbove: 500_000,
            input: 6,
            output: 24,
            cache: { read: 0.6, write: 7.5 },
          },
        ],
      },
    } satisfies ModelMetadata;

    const input = { ...model, metadata };
    expect(modelRoundTrip(input)).toEqual(input);
  });

  it("round-trips Pi facts without inventing tool support, output modalities, or an input token limit", () => {
    const metadata = {
      limits: { context: 200_000, output: 32_000 },
      modalities: { input: ["text", "image"] },
      reasoning: false,
      inputLimits: {
        maxRequestBytes: 20_000_000,
        images: {
          maxPerMessage: 10,
          maxPerRequest: 20,
          resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 5_000_000, jpegQuality: 85 },
        },
      },
      pricing: {
        unit: "usd_per_million_tokens",
        base: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        tiers: [
          {
            inputTokensAbove: 100_000,
            input: 6,
            output: 22.5,
            cache: { read: 0.6, write: 7.5 },
          },
        ],
      },
      promptCacheSeconds: { short: 300 },
    } satisfies ModelMetadata;

    const input = { ...model, metadata };
    expect(modelRoundTrip(input)).toEqual(input);
  });

  it.each([
    {},
    { limits: {} },
    { limits: { context: 0, input: 0, output: 0 } },
    { modalities: {} },
    { modalities: { input: [], output: [] } },
    { tools: false, reasoning: false },
    { inputLimits: {} },
    { inputLimits: { images: { resize: {} } } },
    { pricing: { unit: "usd_per_million_tokens" } },
    { pricing: { unit: "usd_per_million_tokens", tiers: [] } },
    {
      pricing: {
        unit: "usd_per_million_tokens",
        base: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      },
    },
    {
      pricing: {
        unit: "usd_per_million_tokens",
        tiers: [
          { inputTokensAbove: 200_000, input: 4, output: 18, cache: { read: 0.4, write: 5 } },
        ],
      },
    },
    { promptCacheSeconds: {} },
    { promptCacheSeconds: { long: 0 } },
  ])("preserves omitted and explicitly empty/zero metadata without defaults: %j", (metadata) => {
    const input = { ...model, metadata };
    expect(modelRoundTrip(input)).toEqual(input);
  });

  it("preserves old models with no metadata and leaves picker capabilities unchanged", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "reasoning",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High" }],
        },
      ],
    };
    expect(modelRoundTrip(model)).toEqual(model);
    expect(modelRoundTrip({ ...model, capabilities })).toEqual({ ...model, capabilities });
    expect(decodeCapabilities({})).toEqual({});
    expect(decodeCapabilities(capabilities)).toEqual(capabilities);
    expect(() => decodeModel({ ...model, capabilities: undefined })).toThrow();
  });

  it("keeps picker choices separate from factual reasoning/tool support", () => {
    const input = {
      ...model,
      capabilities: {
        optionDescriptors: [
          { id: "tools", label: "Enable tools", type: "boolean", currentValue: true },
        ],
      },
      metadata: { tools: false, reasoning: true },
    };
    expect(modelRoundTrip(input)).toEqual(input);
  });

  it.each([
    { limits: { context: -1 } },
    { limits: { input: 1.5 } },
    { limits: { output: Infinity } },
    { tools: "unknown" },
    { modalities: { input: [false] } },
    { pricing: { unit: "usd_per_token" } },
    {
      pricing: {
        unit: "usd_per_million_tokens",
        base: { input: Infinity, output: 1, cache: { read: 0, write: 0 } },
      },
    },
    {
      pricing: {
        unit: "usd_per_million_tokens",
        tiers: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
      },
    },
    {
      pricing: {
        unit: "usd_per_million_tokens",
        tiers: [{ inputTokensAbove: -1, input: 1, output: 1, cache: { read: 0, write: 0 } }],
      },
    },
    { promptCacheSeconds: { short: NaN } },
  ])("rejects invalid factual metadata: %j", (metadata) => {
    expect(() => decodeModel({ ...model, metadata })).toThrow();
  });
});
