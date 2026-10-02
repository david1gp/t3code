import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { getComposerProviderState } from "./components/chat/composerProviderState";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
} from "./modelSelection";
import { deriveProviderInstanceEntries } from "./providerInstances";

const instanceId = ProviderInstanceId.make("opencode");
const variant: ProviderOptionDescriptor = {
  id: "variant",
  label: "Variant",
  type: "select",
  options: [{ id: "high", label: "High", isDefault: true }],
};
const agent = (id: string): ProviderOptionDescriptor => ({
  id: "agent",
  label: "Agent",
  type: "select",
  currentValue: id,
  options: [
    { id, label: id, isDefault: true },
    { id: "build", label: "Build" },
  ],
});
const metadata = { limits: { context: 128_000 }, tools: true };
function providerCreate(projectAgent = "project-review"): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-01T19:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "model-b",
        name: "B",
        isCustom: false,
        isDefault: true,
        metadata,
        capabilities: { optionDescriptors: [variant, agent("machine")] },
      },
      { slug: "model-a", name: "A", isCustom: false, capabilities: null },
    ],
    workspaceSnapshots: [
      {
        cwd: "/project/worktree",
        checkedAt: "2026-10-01T19:00:00.000Z",
        slashCommands: [],
        skills: [],
        modelOptionOverlays: [
          { slug: "model-b", optionDescriptors: [agent(projectAgent)] },
          { slug: "not-in-machine-inventory", optionDescriptors: [agent("absent")] },
        ],
      },
    ],
  };
}
const selection: ModelSelection = {
  instanceId,
  model: "model-b",
  options: [
    { id: "variant", value: "high" },
    { id: "agent", value: "build" },
  ],
};

describe("workspace model selection", () => {
  it("uses exact cwd provider traits in composers without replacing machine model order or metadata", () => {
    const provider = providerCreate();
    const entry = deriveProviderInstanceEntries([provider], "/project/worktree")[0]!;
    expect(entry.models.map((model) => model.slug)).toEqual(["model-b", "model-a"]);
    expect(entry.models[0]?.metadata).toBe(metadata);
    expect(entry.models[0]?.capabilities?.optionDescriptors).toEqual([
      variant,
      agent("project-review"),
    ]);
    expect(entry.models[1]).toBe(provider.models[1]);
    const state = getComposerProviderState({
      provider: entry.driverKind,
      model: selection.model,
      models: entry.models,
      modelOptions: selection.options,
      planModeEnabled: true,
    });
    expect(state.modelOptionsForDispatch).toEqual(selection.options);
    expect(
      getCustomModelOptionsByInstance(
        DEFAULT_UNIFIED_SETTINGS,
        [provider],
        instanceId,
        selection.model,
        "/project/worktree",
      )
        .get(instanceId)
        ?.map((model) => model.slug),
    ).toEqual(["model-b", "model-a"]);
  });

  it("leaves workspace defaults implicit and preserves saved agent/variant precedence in project settings", () => {
    const provider = providerCreate();
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, textGenerationModelSelection: selection };
    expect(resolveAppModelSelectionState(settings, [provider], "/project/worktree")).toEqual(
      selection,
    );
    const projectSelection = {
      ...selection,
      options: [
        { id: "variant", value: "high" },
        { id: "agent", value: "project-review" },
      ],
    };
    expect(
      resolveAppModelSelectionState(
        { ...settings, textGenerationModelSelection: projectSelection },
        [provider],
        "/project/worktree",
      ),
    ).toEqual(projectSelection);
    const entry = deriveProviderInstanceEntries([provider], "/project/worktree")[0]!;
    expect(
      getComposerProviderState({
        provider: entry.driverKind,
        model: selection.model,
        models: entry.models,
        modelOptions: undefined,
        planModeEnabled: true,
      }).modelOptionsForDispatch,
    ).toBeUndefined();
  });

  it("does not borrow a cached workspace or another environment's same instance id", () => {
    const local = providerCreate();
    const remote = providerCreate("remote-review");
    const oldSnapshot = { ...local, workspaceSnapshots: [] };
    expect(deriveProviderInstanceEntries([oldSnapshot], "/project/worktree")[0]?.models).toBe(
      local.models,
    );
    for (const cwd of [undefined, null, "", "/project", "/project/worktree/"]) {
      expect(deriveProviderInstanceEntries([local], cwd)[0]?.models).toBe(local.models);
    }
    expect(
      deriveProviderInstanceEntries([remote], "/project/worktree")[0]?.models[0]?.capabilities
        ?.optionDescriptors,
    ).toEqual([variant, agent("remote-review")]);
    expect(
      deriveProviderInstanceEntries([local], "/project/worktree")[0]?.models[0]?.capabilities
        ?.optionDescriptors,
    ).toEqual([variant, agent("project-review")]);
    expect(deriveProviderInstanceEntries([local])[0]?.models).toBe(local.models);
  });

  it("preserves the full explicit selection when a model disappears, including workspace-only agents", () => {
    const provider = { ...providerCreate(), models: [] };
    const saved = {
      ...selection,
      options: [
        { id: "variant", value: "high" },
        { id: "agent", value: "project-review" },
      ],
    };
    const entry = deriveProviderInstanceEntries([provider], "/project/worktree")[0]!;
    expect(
      getComposerProviderState({
        provider: entry.driverKind,
        model: saved.model,
        models: entry.models,
        modelOptions: saved.options,
        planModeEnabled: true,
      }).modelOptionsForDispatch,
    ).toEqual(saved.options);
    expect(
      resolveAppModelSelectionForInstance(
        instanceId,
        DEFAULT_UNIFIED_SETTINGS,
        [provider],
        saved.model,
        { preserveUnavailableSelection: true },
      ),
    ).toBe(saved.model);
  });
});
