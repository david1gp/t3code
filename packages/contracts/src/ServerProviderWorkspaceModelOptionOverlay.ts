import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionDescriptor } from "./model.ts";

/** A workspace option slice, keyed by the exact machine-catalog model slug. */
export const ServerProviderWorkspaceModelOptionOverlay = Schema.Struct({
  slug: TrimmedNonEmptyString,
  // Currently only the agent option is overlaid. Its existing descriptor
  // carries defaults; an empty slice explicitly removes the machine agent.
  optionDescriptors: Schema.Array(ProviderOptionDescriptor),
});
export type ServerProviderWorkspaceModelOptionOverlay =
  typeof ServerProviderWorkspaceModelOptionOverlay.Type;
