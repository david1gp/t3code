import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities } from "@t3tools/contracts";

import { applyProviderOptionSelection, resolveProviderOptionDescriptors } from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([{ id: "serviceTier", value: "priority" }]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("updates generic boolean options", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });

  it("selects a Pi preset without serializing unset thinking and preserves explicit thinking", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "preset",
          label: "Preset",
          type: "select",
          options: [
            { id: "build", label: "Build" },
            { id: "delegate", label: "Delegate" },
          ],
        },
        {
          id: "thinkingLevel",
          label: "Thinking",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
      ],
    };
    const descriptors = resolveProviderOptionDescriptors({ capabilities, selections: undefined });

    expect(applyProviderOptionSelection(descriptors, { id: "preset", value: "build" })).toEqual([
      { id: "preset", value: "build" },
    ]);

    const selected = [{ id: "thinkingLevel", value: "high" }];
    const selectedDescriptors = resolveProviderOptionDescriptors({
      capabilities,
      selections: selected,
    });
    expect(
      applyProviderOptionSelection(
        selectedDescriptors,
        { id: "preset", value: "delegate" },
        selected,
      ),
    ).toEqual([
      { id: "preset", value: "delegate" },
      { id: "thinkingLevel", value: "high" },
    ]);
  });
});
