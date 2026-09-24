import { isExternalCliDependency } from "./cli-external-packages.ts";

export function cliExternalizePluginCreate(): Bun.Plugin {
  return {
    name: "externalize-cli-runtime-dependencies",
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path }) =>
        isExternalCliDependency(path) ? { path, external: true } : undefined,
      );
    },
  };
}
