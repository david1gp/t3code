import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildModelOptions, resolveNewTaskModelSelection } from "./modelOptions";
import { applyProviderOptionSelection, resolveProviderOptionDescriptors } from "./providerOptions";

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
function configCreate(projectAgent = "project-review"): ServerConfig {
  const provider: ServerProvider = {
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
  return { providers: [provider] } as unknown as ServerConfig;
}
const selection: ModelSelection = {
  instanceId,
  model: "model-b",
  options: [
    { id: "variant", value: "high" },
    { id: "agent", value: "build" },
  ],
};

describe("mobile workspace model options", () => {
  it("offers project-only agents in thread/new-task settings while retaining machine models and variants", () => {
    const options = buildModelOptions(configCreate(), selection, "/project/worktree");
    expect(options.map((option) => option.selection.model)).toEqual(["model-b", "model-a"]);
    expect(options[0]?.metadata).toBe(metadata);
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: options[0]?.capabilities,
      selections: selection.options,
    });
    expect(descriptors).toEqual([
      { ...variant, currentValue: "high" },
      { ...agent("project-review"), currentValue: "build" },
    ]);
    expect(
      applyProviderOptionSelection(
        descriptors,
        { id: "agent", value: "project-review" },
        selection.options,
      ),
    ).toEqual([
      { id: "variant", value: "high" },
      { id: "agent", value: "project-review" },
    ]);
    expect(options[0]?.selection).toEqual(selection);
    const projectSelection = {
      ...selection,
      options: [
        { id: "variant", value: "high" },
        { id: "agent", value: "project-review" },
      ],
    };
    expect(
      buildModelOptions(configCreate(), projectSelection, "/project/worktree")[0]?.selection,
    ).toEqual(projectSelection);
  });

  it("keeps workspace defaults implicit and retains project/draft selection precedence", () => {
    const options = buildModelOptions(configCreate(), null, "/project/worktree");
    expect(options[0]?.selection).toEqual({ instanceId, model: "model-b" });
    const projectDefault = { ...selection, options: [{ id: "agent", value: "project-review" }] };
    const input = {
      draftSelection: null,
      projectDefaultSelection: projectDefault,
      stickySelection: selection,
      modelOptions: options,
    };
    expect(resolveNewTaskModelSelection(input)).toBe(projectDefault);
    expect(resolveNewTaskModelSelection({ ...input, draftSelection: selection })).toBe(selection);
  });

  it("keeps global settings machine-scoped and resolves fresh cwd/environment values without a shared cache", () => {
    const local = configCreate();
    const oldSnapshot = {
      ...local,
      providers: local.providers.map((provider) => ({ ...provider, workspaceSnapshots: [] })),
    };
    expect(buildModelOptions(oldSnapshot, null, "/project/worktree")[0]?.capabilities).toBe(
      local.providers[0]?.models[0]?.capabilities,
    );
    for (const cwd of [undefined, null, "", "/project", "/project/worktree/"]) {
      expect(buildModelOptions(local, null, cwd)[0]?.capabilities).toBe(
        local.providers[0]?.models[0]?.capabilities,
      );
    }
    expect(
      buildModelOptions(configCreate("remote-review"), null, "/project/worktree")[0]?.capabilities
        ?.optionDescriptors,
    ).toEqual([variant, agent("remote-review")]);
    expect(
      buildModelOptions(local, null, "/project/worktree")[0]?.capabilities?.optionDescriptors,
    ).toEqual([variant, agent("project-review")]);
    expect(buildModelOptions(local, null)[0]?.capabilities).toBe(
      local.providers[0]?.models[0]?.capabilities,
    );
  });

  it("preserves full explicit selections when the model is dropped from machine inventory", () => {
    const config = configCreate();
    const dropped = {
      ...config,
      providers: config.providers.map((provider) => ({ ...provider, models: [] })),
    };
    expect(buildModelOptions(dropped, selection, "/project/worktree")[0]?.selection).toBe(
      selection,
    );
  });
});
