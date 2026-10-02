import type { ProviderInstanceId, ServerProviderWorkspaceSnapshot } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * Driver-owned sender for the successful initialized session's resources.
 * Publish the successful bound session's canonical cwd after bind and preset/model
 * initialization, initial lifecycle drain, and ownership transfer. Map actual
 * registered invocation names ahead of prompt templates
 * (piPromptTemplatesToSlashCommands), retain static commands, and map loaded skills
 * with piSkillsToServerProviderSkills. Never bind another session for publication.
 */
export interface PiAdapterFactoryOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly publishInitializedResources?: (
    resources: Pick<
      ServerProviderWorkspaceSnapshot,
      "cwd" | "slashCommands" | "skills" | "checkedAt"
    >,
  ) => Effect.Effect<void>;
}
