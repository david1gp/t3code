// @effect-diagnostics nodeBuiltinImport:off - Builds an isolated Node fixture for the Pi SDK.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import { build } from "vite-plus";
import serverConfig from "../../../vite.config.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

it("loads a preset extension in a Node-targeted server bundle", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-bundle-test-"));
  try {
    const extension = NodePath.join(directory, "preset.ts");
    const entry = NodePath.join(directory, "entry.mjs");
    const outdir = NodePath.join(directory, "dist");
    await NodeFSP.symlink(
      NodePath.resolve(import.meta.dirname, "../../../node_modules"),
      NodePath.join(directory, "node_modules"),
      "dir",
    );
    await NodeFSP.writeFile(
      extension,
      `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

export default function presetExtension(pi: ExtensionAPI): void {
  pi.registerShortcut(Key.ctrlShift("u"), {
    description: "Cycle presets",
    handler: async () => {},
  });
  pi.registerCommand("preset", {
    description: "Switch preset",
    handler: async () => {},
  });
}
`,
    );
    await NodeFSP.writeFile(
      entry,
      `import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
const { extensions, errors } = await discoverAndLoadExtensions([${JSON.stringify(extension)}], ${JSON.stringify(directory)}, ${JSON.stringify(directory)});
if (errors.length || !extensions.some((extension) => extension.commands.has("preset"))) {
  throw new Error("Bundled Pi failed to register preset command: " + JSON.stringify(errors));
}
`,
    );

    // Build only this fixture with Rolldown, avoiding a Bun binary or a full server
    // build. The production pack define selects Pi's embedded extension loader.
    const bundledNode = serverConfig.pack?.define?.PI_BUNDLED_NODE;
    expect(bundledNode).toBe("true");
    await build({
      configFile: false,
      root: directory,
      logLevel: "silent",
      define: { PI_BUNDLED_NODE: bundledNode },
      build: {
        ssr: entry,
        outDir: outdir,
        target: "node22",
        rolldownOptions: {
          input: entry,
          platform: "node",
          output: { format: "es", entryFileNames: "entry.mjs" },
        },
      },
    });
    await execFile(process.execPath, [NodePath.join(outdir, "entry.mjs")]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
