import * as FileSystem from "node:fs/promises";
import * as Module from "node:module";
import * as Path from "node:path";
import * as Url from "node:url";

import { DEVELOPMENT_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { cliExternalizePluginCreate } from "./lib/cliExternalizePluginCreate.ts";
import { loadRepoEnv } from "./lib/public-config.ts";

const repoRoot = Path.resolve(import.meta.dir, "..");
const webRoot = Path.join(repoRoot, "apps/web");
const serverRoot = Path.join(repoRoot, "apps/server");
const serverDist = Path.join(serverRoot, "dist");
const webRequire = Module.createRequire(Path.join(webRoot, "package.json"));
const vite = await import(Url.pathToFileURL(webRequire.resolve("vite")).href);

// Keep Vite's config and plugin loading intact, but call its installed JS API
// directly so this production path does not depend on the vp CLI.
process.chdir(webRoot);
await vite.build({
  configFile: Path.join(webRoot, "vite.config.ts"),
  root: webRoot,
});

const repoEnv = loadRepoEnv();
const serverPackage = await Bun.file(Path.join(serverRoot, "package.json")).json();
const version = typeof serverPackage.version === "string" ? serverPackage.version : "";
const cliBuildChannel = /^[^-+]+-(?:nightly|preview)\./.test(version) ? "nightly" : "latest";

await FileSystem.rm(serverDist, { recursive: true, force: true });
const serverBuild = await Bun.build({
  entrypoints: [
    Path.join(serverRoot, "src/bin.ts"),
    Path.join(serverRoot, "src/claude-history-worker.ts"),
  ],
  outdir: serverDist,
  target: "node",
  format: "esm",
  splitting: true,
  sourcemap: "external",
  naming: {
    entry: "[name].mjs",
    chunk: "[name]-[hash].mjs",
  },
  banner: "#!/usr/bin/env node",
  define: {
    __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
    __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),
    __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
      repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
    ),
    __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
      repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
    ),
    __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
      repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
    ),
    __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
      repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
    ),
    __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
      repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
    ),
  },
  plugins: [cliExternalizePluginCreate()],
});

if (!serverBuild.success) {
  for (const log of serverBuild.logs) console.error(log);
  process.exitCode = 1;
  throw new Error("Bun server bundle failed");
}

const clientTarget = Path.join(serverDist, "client");
await FileSystem.cp(Path.join(webRoot, "dist"), clientTarget, { recursive: true });
for (const override of DEVELOPMENT_ICON_OVERRIDES) {
  const sourcePath = Path.join(repoRoot, override.sourceRelativePath);
  const targetPath = Path.join(serverRoot, override.targetRelativePath);
  await FileSystem.access(sourcePath);
  await FileSystem.access(targetPath);
  await FileSystem.copyFile(sourcePath, targetPath);
}

console.log("Built web app and Node-targeted server in apps/server/dist");
