import {
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerProviderSlashCommand } from "@t3tools/contracts";

/** Read native invocation names without binding or starting an extension session. */
export async function piExtensionCommandsForResources(
  cwd: string,
  resources: LoadExtensionsResult,
): Promise<ReadonlyArray<ServerProviderSlashCommand>> {
  if (!resources.extensions.some((extension) => extension.commands.size > 0)) return [];
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const runner = new ExtensionRunner(
    resources.extensions,
    resources.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(runtime),
  );
  return runner.getRegisteredCommands().map((command) => {
    const description = command.description?.trim();
    return {
      name: command.invocationName,
      ...(description ? { description } : {}),
    };
  });
}
