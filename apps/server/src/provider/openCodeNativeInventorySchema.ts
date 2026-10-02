import { Agent, Command, Config, Location, Model, Provider, Skill } from "@opencode/client/effect";
import * as Schema from "effect/Schema";

// The native boundary validates complete official inventory records, independently
// of the smaller snapshots supplied by T3's inventory cache and test doubles.
export const openCodeNativeInventorySchema = {
  provider: Schema.toEncoded(Location.response(Schema.Array(Provider.Info))),
  model: Schema.toEncoded(Location.response(Schema.Array(Model.Info))),
  agent: Schema.toEncoded(Location.response(Schema.Array(Agent.Info))),
  skill: Schema.toEncoded(Location.response(Schema.Array(Skill.Info))),
  command: Schema.toEncoded(Location.response(Schema.Array(Command.Info))),
  // Unlike the other inventory endpoints, config.get returns a bare ordered list.
  config: Schema.Array(Config.Entry),
} as const;

type Projection<T, K extends keyof T> = Pick<T, K> & Partial<Omit<T, K>>;
type ProviderInfo = (typeof openCodeNativeInventorySchema.provider.Type.data)[number];
type ModelInfo = (typeof openCodeNativeInventorySchema.model.Type.data)[number];
type AgentInfo = (typeof openCodeNativeInventorySchema.agent.Type.data)[number];
type SkillInfo = (typeof openCodeNativeInventorySchema.skill.Type.data)[number];
type CommandInfo = (typeof openCodeNativeInventorySchema.command.Type.data)[number];

export type OpenCodeNativeInventory = {
  readonly configuredModel?: typeof Model.Ref.Encoded;
  readonly provider: ReadonlyArray<
    Projection<ProviderInfo, "id" | "name" | "activation" | "package">
  >;
  readonly model: ReadonlyArray<
    Omit<
      Projection<
        ModelInfo,
        "id" | "modelID" | "providerID" | "name" | "enabled" | "status" | "variants"
      >,
      "limit" | "capabilities" | "cost"
    > &
      Partial<Pick<ModelInfo, "limit" | "capabilities" | "cost">>
  >;
  readonly agent: ReadonlyArray<Projection<AgentInfo, "id" | "name" | "mode" | "hidden">>;
  readonly skill: ReadonlyArray<Projection<SkillInfo, "id" | "name" | "path">>;
  readonly command: ReadonlyArray<CommandInfo>;
};
