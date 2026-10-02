import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProviderWorkspaceSnapshot } from "./server.ts";

const decode = Schema.decodeUnknownSync(ServerProviderWorkspaceSnapshot);
const encode = Schema.encodeSync(ServerProviderWorkspaceSnapshot);
const workspace = {
  cwd: "/projects/workspace",
  checkedAt: "2026-10-01T19:00:00.000Z",
  slashCommands: [],
  skills: [],
};
const agent = {
  id: "agent",
  label: "Agent",
  description: "Workspace agents",
  type: "select",
  options: [
    { id: "project-review", label: "Project review", description: "Review", isDefault: true },
    { id: "build", label: "Build" },
  ],
  currentValue: "project-review",
};

function roundTrip(input: unknown) {
  return decode(JSON.parse(JSON.stringify(encode(decode(input)))));
}

describe("ServerProviderWorkspaceSnapshot model option overlays", () => {
  it("round-trips model identities and workspace agent choices/defaults", () => {
    const input = {
      ...workspace,
      modelOptionOverlays: [
        { slug: "openai/model-one", optionDescriptors: [agent] },
        { slug: "anthropic/model-two", optionDescriptors: [{ ...agent, currentValue: "build" }] },
      ],
    };

    expect(roundTrip(input)).toEqual(input);
  });

  it("keeps old snapshots optional without fabricating overlays or defaults", () => {
    const decoded = roundTrip(workspace);
    expect(decoded).toEqual(workspace);
    expect(Object.hasOwn(decoded, "modelOptionOverlays")).toBe(false);

    const input = {
      ...workspace,
      modelOptionOverlays: [
        {
          slug: "openai/model-one",
          optionDescriptors: [
            {
              id: "agent",
              label: "Agent",
              type: "select",
              options: [{ id: "build", label: "Build" }],
            },
          ],
        },
      ],
    };
    expect(roundTrip(input)).toEqual(input);
  });

  it("preserves empty overlays and explicit removal of a model's machine agent option", () => {
    expect(roundTrip({ ...workspace, modelOptionOverlays: [] })).toEqual({
      ...workspace,
      modelOptionOverlays: [],
    });
    const input = {
      ...workspace,
      modelOptionOverlays: [{ slug: "openai/model-one", optionDescriptors: [] }],
    };
    expect(roundTrip(input)).toEqual(input);
  });

  it.each([
    { slug: " ", optionDescriptors: [agent] },
    { slug: "openai/model-one" },
    { slug: "openai/model-one", optionDescriptors: [{ ...agent, type: "text" }] },
    { slug: "openai/model-one", optionDescriptors: [{ ...agent, currentValue: false }] },
    {
      slug: "openai/model-one",
      optionDescriptors: [
        { ...agent, options: [{ id: "build", label: "Build", isDefault: "yes" }] },
      ],
    },
  ])("rejects invalid model identities or existing option descriptor payloads: %j", (overlay) => {
    expect(() => decode({ ...workspace, modelOptionOverlays: [overlay] })).toThrow();
  });
});
