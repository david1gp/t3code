import * as Schema from "effect/Schema";

const envelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    location: Schema.Struct({ directory: Schema.String }),
    data: Schema.Array(data),
  });

// OpenCode v2.0.18 /api inventory envelopes. Decode only the fields used by T3;
// the server may add opaque provider settings, permissions, and model pricing.
export const openCodeNativeInventorySchema = {
  provider: envelope(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      activation: Schema.Literals(["auto", "enabled", "disabled"]),
      package: Schema.String,
    }),
  ),
  model: envelope(
    Schema.Struct({
      id: Schema.String,
      modelID: Schema.String,
      providerID: Schema.String,
      name: Schema.String,
      enabled: Schema.Boolean,
      status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
      variants: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
  agent: envelope(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      mode: Schema.Literals(["subagent", "primary", "all"]),
      hidden: Schema.Boolean,
    }),
  ),
  skill: envelope(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      path: Schema.String,
      description: Schema.optionalKey(Schema.String),
      autoinvoke: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  command: envelope(
    Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) }),
  ),
} as const;

export type OpenCodeNativeInventory = {
  readonly [K in keyof typeof openCodeNativeInventorySchema]: Schema.Schema.Type<
    (typeof openCodeNativeInventorySchema)[K]
  >["data"];
};
