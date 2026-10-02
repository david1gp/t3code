import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

const ModelPriceRates = {
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
};

/** Provider-reported model facts, independent of selectable picker options. */
export const ModelMetadata = Schema.Struct({
  limits: Schema.optional(
    Schema.Struct({
      context: Schema.optional(NonNegativeInt),
      input: Schema.optional(NonNegativeInt),
      output: Schema.optional(NonNegativeInt),
    }),
  ),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Array(Schema.String)),
      output: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  tools: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  /** Provider request/image constraints, distinct from input token limits. */
  inputLimits: Schema.optional(
    Schema.Struct({
      maxRequestBytes: Schema.optional(NonNegativeInt),
      images: Schema.optional(
        Schema.Struct({
          maxPerMessage: Schema.optional(NonNegativeInt),
          maxPerRequest: Schema.optional(NonNegativeInt),
          resize: Schema.optional(
            Schema.Struct({
              maxWidth: Schema.optional(NonNegativeInt),
              maxHeight: Schema.optional(NonNegativeInt),
              maxBytes: Schema.optional(NonNegativeInt),
              jpegQuality: Schema.optional(Schema.Finite),
            }),
          ),
        }),
      ),
    }),
  ),
  pricing: Schema.optional(
    Schema.Struct({
      unit: Schema.Literal("usd_per_million_tokens"),
      base: Schema.optional(Schema.Struct(ModelPriceRates)),
      /**
       * Request-wide rates: the highest threshold strictly below total input
       * usage (including cache reads/writes) applies to the entire request,
       * not just tokens above the threshold. Native context tier sizes and
       * Pi inputTokensAbove have this same meaning. Missing tiers are unknown;
       * an empty array is a reported absence of tiers.
       */
      tiers: Schema.optional(
        Schema.Array(
          Schema.Struct({
            inputTokensAbove: NonNegativeInt,
            ...ModelPriceRates,
          }),
        ),
      ),
    }),
  ),
  /** Best-effort prompt cache lifetimes in seconds; omitted tiers are unknown. */
  promptCacheSeconds: Schema.optional(
    Schema.Struct({
      short: Schema.optional(Schema.Finite),
      long: Schema.optional(Schema.Finite),
    }),
  ),
});
export type ModelMetadata = typeof ModelMetadata.Type;
