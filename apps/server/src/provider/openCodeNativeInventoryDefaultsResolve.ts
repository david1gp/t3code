import type { OpenCodeNativeInventory } from "./openCodeNativeInventorySchema.ts";

type Model = NonNullable<OpenCodeNativeInventory["configuredModel"]>;
type Preference = { readonly model: Model; readonly agent?: string };

/** Resolve defaults after adapter validation, without treating a default as a saved T3 choice. */
export const openCodeNativeInventoryDefaultsResolve = (
  inventory: OpenCodeNativeInventory,
  input: {
    readonly explicit?: Preference;
    readonly saved?: Preference;
    readonly agent?: string;
  } = {},
) => {
  // Agent.list orders the native resolved visible primary/all default first.
  const defaultAgent = inventory.agent.find(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  )?.id;
  const agent = input.explicit?.agent ?? input.saved?.agent ?? input.agent ?? defaultAgent;
  if (input.explicit) {
    return { defaultAgent, agent, model: input.explicit.model, modelSource: "explicit" as const };
  }
  if (input.saved) {
    return { defaultAgent, agent, model: input.saved.model, modelSource: "saved" as const };
  }
  const agentModel = inventory.agent.find((item) => item.id === agent)?.model;
  if (agentModel) {
    return { defaultAgent, agent, model: agentModel, modelSource: "agent" as const };
  }
  return {
    defaultAgent,
    agent,
    model: inventory.configuredModel,
    modelSource: inventory.configuredModel ? ("config" as const) : undefined,
  };
};
