import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerModelsResolveForCwd } from "./providerModelsResolveForCwd.ts";

const variant: ProviderOptionDescriptor = {
  id: "variant",
  label: "Reasoning",
  type: "select",
  options: [{ id: "high", label: "High" }],
};
const machineAgent: ProviderOptionDescriptor = {
  id: "agent",
  label: "Agent",
  type: "select",
  options: [{ id: "build", label: "Build", isDefault: true }],
  currentValue: "build",
};
const workspaceAgent: ProviderOptionDescriptor = {
  id: "agent",
  label: "Agent",
  description: "Project-specific agents",
  type: "select",
  options: [
    { id: "project-review", label: "Project review", isDefault: true },
    { id: "build", label: "Build" },
  ],
  currentValue: "project-review",
};
const fastMode: ProviderOptionDescriptor = {
  id: "fastMode",
  label: "Fast",
  type: "boolean",
  currentValue: false,
};
const models: ServerProviderModel[] = [
  {
    slug: "openai/model-b",
    name: "Model B",
    shortName: "B",
    subProvider: "OpenAI",
    aliases: ["b"],
    badge: "new",
    isCustom: false,
    isDefault: true,
    metadata: {
      limits: { context: 200_000 },
      tools: true,
      pricing: {
        unit: "usd_per_million_tokens",
        base: { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } },
      },
    },
    capabilities: { optionDescriptors: [variant, machineAgent, fastMode] },
  },
  { slug: "anthropic/model-a", name: "Model A", isCustom: true, capabilities: null },
];
const workspace: ServerProviderWorkspaceSnapshot = {
  cwd: "/projects/one",
  checkedAt: "2026-10-01T19:00:00.000Z",
  slashCommands: [],
  skills: [],
  modelOptionOverlays: [{ slug: "openai/model-b", optionDescriptors: [workspaceAgent] }],
};

function providerCreate(
  workspaceSnapshots?: ServerProvider["workspaceSnapshots"],
  machineModels: ServerProvider["models"] = models,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("opencode-main"),
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: "2.0.18",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-01T19:00:00.000Z",
    models: machineModels,
    slashCommands: [],
    skills: [],
    ...(workspaceSnapshots ? { workspaceSnapshots } : {}),
  };
}

describe("providerModelsResolveForCwd", () => {
  it("replaces only the matching model's agent descriptor, preserving facts, variants, and order", () => {
    const provider = providerCreate([workspace]);
    const result = providerModelsResolveForCwd(provider, workspace.cwd);

    expect(result.map((model) => model.slug)).toEqual(models.map((model) => model.slug));
    expect(result[0]).toEqual({
      ...models[0],
      capabilities: { optionDescriptors: [variant, workspaceAgent, fastMode] },
    });
    expect(result[0]?.metadata).toBe(models[0]?.metadata);
    expect(result[0]?.capabilities?.optionDescriptors?.[0]).toBe(variant);
    expect(result[0]?.capabilities?.optionDescriptors?.[2]).toBe(fastMode);
    expect(result[1]).toBe(models[1]);
    expect(provider.models).toBe(models);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([variant, machineAgent, fastMode]);
  });

  it.each([undefined, null, "", "/projects/missing", "/projects/one/"])(
    "does not borrow another workspace's agents when cwd is absent or unmatched: %j",
    (cwd) => {
      const provider = providerCreate([workspace]);
      expect(providerModelsResolveForCwd(provider, cwd)).toBe(provider.models);
    },
  );

  it("returns the machine catalog unchanged for old snapshots or absent/empty overlays", () => {
    const { modelOptionOverlays: _overlays, ...oldWorkspace } = workspace;
    for (const provider of [
      providerCreate(),
      providerCreate([oldWorkspace]),
      providerCreate([{ ...workspace, modelOptionOverlays: [] }]),
    ]) {
      expect(providerModelsResolveForCwd(provider, workspace.cwd)).toBe(provider.models);
    }
  });

  it("uses the matching cwd and model slice rather than the first cached workspace", () => {
    const secondAgent = { ...workspaceAgent, currentValue: "build" };
    const secondWorkspace = {
      ...workspace,
      cwd: "/projects/two",
      modelOptionOverlays: [{ slug: "anthropic/model-a", optionDescriptors: [secondAgent] }],
    };
    const provider = providerCreate([workspace, secondWorkspace]);
    const result = providerModelsResolveForCwd(provider, secondWorkspace.cwd);

    expect(result[0]).toBe(models[0]);
    expect(result[1]).toEqual({
      ...models[1],
      capabilities: { optionDescriptors: [secondAgent] },
    });
  });

  it("does not inherit a machine agent default when the workspace descriptor omits it", () => {
    const agent: ProviderOptionDescriptor = {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "project-review", label: "Project review" }],
    };
    const provider = providerCreate([
      {
        ...workspace,
        modelOptionOverlays: [{ slug: "openai/model-b", optionDescriptors: [agent] }],
      },
    ]);
    const result = providerModelsResolveForCwd(provider, workspace.cwd);

    expect(result[0]?.capabilities?.optionDescriptors).toEqual([variant, agent, fastMode]);
    expect(
      Object.hasOwn(result[0]?.capabilities?.optionDescriptors?.[1] ?? {}, "currentValue"),
    ).toBe(false);
  });

  it("adds an agent descriptor to null/empty capabilities without synthesizing other options", () => {
    for (const capabilities of [null, {}, { optionDescriptors: [variant] }]) {
      const model = { ...models[1]!, capabilities };
      const provider = providerCreate(
        [
          {
            ...workspace,
            modelOptionOverlays: [{ slug: model.slug, optionDescriptors: [workspaceAgent] }],
          },
        ],
        [model],
      );
      expect(providerModelsResolveForCwd(provider, workspace.cwd)).toEqual([
        {
          ...model,
          capabilities: {
            optionDescriptors: [...(capabilities?.optionDescriptors ?? []), workspaceAgent],
          },
        },
      ]);
    }
  });

  it("removes a machine agent only for an explicit matching empty slice", () => {
    const provider = providerCreate([
      {
        ...workspace,
        modelOptionOverlays: [
          { slug: "openai/model-b", optionDescriptors: [] },
          { slug: "anthropic/model-a", optionDescriptors: [] },
        ],
      },
    ]);
    const result = providerModelsResolveForCwd(provider, workspace.cwd);
    expect(result[0]?.capabilities?.optionDescriptors).toEqual([variant, fastMode]);
    expect(result[1]).toBe(models[1]);
    expect(result[1]?.capabilities).toBeNull();
  });

  it("ignores unknown model slugs/aliases and does not overlay non-agent options", () => {
    const provider = providerCreate([
      {
        ...workspace,
        modelOptionOverlays: [
          { slug: "b", optionDescriptors: [workspaceAgent] },
          { slug: "workspace-only/model", optionDescriptors: [workspaceAgent] },
          { slug: "anthropic/model-a", optionDescriptors: [variant, fastMode] },
          {
            slug: "openai/model-b",
            optionDescriptors: [
              workspaceAgent,
              { ...variant, options: [{ id: "low", label: "Low" }] },
            ],
          },
        ],
      },
    ]);
    const result = providerModelsResolveForCwd(provider, workspace.cwd);
    expect(result).toHaveLength(models.length);
    expect(result[0]?.capabilities?.optionDescriptors).toEqual([variant, workspaceAgent, fastMode]);
    expect(result[1]).toBe(models[1]);
  });

  it("isolates same-cwd catalogs by the supplied provider instance/environment snapshot", () => {
    const secondAgent = { ...workspaceAgent, currentValue: "build" };
    const firstEnvironment = providerCreate([workspace]);
    const secondEnvironment = providerCreate([
      {
        ...workspace,
        modelOptionOverlays: [{ slug: "openai/model-b", optionDescriptors: [secondAgent] }],
      },
    ]);
    const secondInstance = {
      ...providerCreate([workspace]),
      instanceId: ProviderInstanceId.make("opencode-other"),
      workspaceSnapshots: [],
    };

    expect(
      providerModelsResolveForCwd(firstEnvironment, workspace.cwd)[0]?.capabilities
        ?.optionDescriptors?.[1],
    ).toBe(workspaceAgent);
    expect(
      providerModelsResolveForCwd(secondEnvironment, workspace.cwd)[0]?.capabilities
        ?.optionDescriptors?.[1],
    ).toBe(secondAgent);
    expect(providerModelsResolveForCwd(secondInstance, workspace.cwd)).toBe(secondInstance.models);
    expect(
      providerModelsResolveForCwd(firstEnvironment, workspace.cwd)[0]?.capabilities
        ?.optionDescriptors?.[1],
    ).toBe(workspaceAgent);
  });
});
