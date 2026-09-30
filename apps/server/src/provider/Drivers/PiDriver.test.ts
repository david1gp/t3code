// @effect-diagnostics nodeBuiltinImport:off - SDK resource-loader fixture uses temporary Node paths.
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CONFIG_DIR_NAME, ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { PiDriver, piResourcesForCwd } from "./PiDriver.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  // Bundling relocates Pi's package-relative VERSION lookup to the server package.
  // Keep native SDK discovery and resource loading; only simulate that version mismatch.
  return { ...actual, VERSION: "0.0.42" };
});

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeLegacyPiSettings = Schema.decodeUnknownSync(PiSettings);

function skillWrite(directory: string, name: string, description: string, extra = "") {
  const path = NodePath.join(directory, name, "SKILL.md");
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(
    path,
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\nSkill body`,
  );
  return path;
}

function settingsWrite(directory: string, settings: { skills?: string[]; prompts?: string[] }) {
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "settings.json"), JSON.stringify(settings));
}

describe("Pi built-in driver", () => {
  let root: string;
  let home: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-resource-catalog-"));
    home = NodePath.join(root, "home");
    agentDir = NodePath.join(home, CONFIG_DIR_NAME, "agent");
    cwd = NodePath.join(root, "workspace");
    NodeFS.mkdirSync(agentDir, { recursive: true });
    // Bound ancestor .agents discovery to the isolated workspace.
    NodeFS.mkdirSync(NodePath.join(cwd, ".git"), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("registers Pi with SDK-only settings", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "pi")).toBe(true);
    expect(decodePiSettings({})).toMatchObject({
      enabled: true,
      customModels: [],
    });
    expect(PiSettings.fields).not.toHaveProperty("binaryPath");
    expect(decodeLegacyPiSettings({ binaryPath: "/old/pi", enabled: true })).toEqual({
      enabled: true,
      customModels: [],
    });
  });

  it("discovers global and cwd project prompt templates through Pi's resource loader", async () => {
    const globalPrompts = NodePath.join(agentDir, "prompts");
    const projectPrompts = NodePath.join(cwd, CONFIG_DIR_NAME, "prompts");
    NodeFS.mkdirSync(globalPrompts, { recursive: true });
    NodeFS.mkdirSync(projectPrompts, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(globalPrompts, "review.md"),
      '---\ndescription: Global review\nargument-hint: "<file>"\n---\nReview $1',
    );
    NodeFS.writeFileSync(NodePath.join(globalPrompts, "shared.md"), "Global collision");
    NodeFS.writeFileSync(
      NodePath.join(projectPrompts, "deploy.md"),
      '---\ndescription: Project deploy\nargument-hint: "[target]"\n---\nDeploy $1',
    );
    NodeFS.writeFileSync(NodePath.join(projectPrompts, "shared.md"), "Project collision");
    const resources = await piResourcesForCwd(cwd);
    expect(resources.slashCommands).toEqual([
      { name: "deploy", description: "Project deploy", input: { hint: "[target]" } },
      { name: "shared", description: "Project collision" },
      { name: "review", description: "Global review", input: { hint: "<file>" } },
    ]);
    expect(resources.skills).toEqual([]);
  });

  it("publishes native extension invocation names and lets extension commands win over templates", async () => {
    const extensions = NodePath.join(agentDir, "extensions");
    const prompts = NodePath.join(agentDir, "prompts");
    NodeFS.mkdirSync(extensions, { recursive: true });
    NodeFS.mkdirSync(prompts, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prompts, "review.md"), "Template review");
    NodeFS.writeFileSync(NodePath.join(prompts, "deploy.md"), "Deploy template");
    NodeFS.writeFileSync(
      NodePath.join(extensions, "first.js"),
      `export default function (pi) {
        pi.registerCommand("review", { description: "Extension review", handler: async () => {} });
        pi.registerCommand("inspect", { description: "First inspect", handler: async () => {} });
        pi.on("session_start", () => { throw new Error("Discovery must not start a session"); });
      }`,
    );
    NodeFS.writeFileSync(
      NodePath.join(extensions, "second.js"),
      `export default function (pi) {
        pi.registerCommand("inspect", { description: "Second inspect", handler: async () => {} });
      }`,
    );

    const resources = await piResourcesForCwd(cwd);
    expect(resources.slashCommands).toEqual([
      { name: "review", description: "Extension review" },
      { name: "inspect:1", description: "First inspect" },
      { name: "inspect:2", description: "Second inspect" },
      { name: "deploy", description: "Deploy template" },
    ]);
    expect(resources.skills).toEqual([]);
  });

  it("discovers global and project Pi and .agents skills, preserving collisions and same-name prompts", async () => {
    const globalSkills = NodePath.join(agentDir, "skills");
    const projectSkills = NodePath.join(cwd, CONFIG_DIR_NAME, "skills");
    skillWrite(globalSkills, "assets", "Global assets");
    const assets = skillWrite(projectSkills, "assets", "Project assets");
    const codeStyle = skillWrite(globalSkills, "code-style", "Global code style");
    const commits = skillWrite(
      NodePath.join(cwd, ".agents", "skills"),
      "commits",
      "Project commits",
    );
    const agentBrowser = skillWrite(
      NodePath.join(home, ".agents", "skills"),
      "agent-browser",
      "Global browser",
    );
    const prompts = NodePath.join(agentDir, "prompts");
    NodeFS.mkdirSync(prompts, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prompts, "assets.md"), "Assets prompt");

    const resources = await piResourcesForCwd(cwd);
    expect(resources.slashCommands).toEqual([{ name: "assets", description: "Assets prompt" }]);
    expect(resources.skills).toEqual([
      {
        name: "assets",
        path: assets,
        description: "Project assets",
        enabled: true,
        scope: "project",
      },
      {
        name: "commits",
        path: commits,
        description: "Project commits",
        enabled: true,
        scope: "project",
      },
      {
        name: "code-style",
        path: codeStyle,
        description: "Global code style",
        enabled: true,
        scope: "user",
      },
      {
        name: "agent-browser",
        path: agentBrowser,
        description: "Global browser",
        enabled: true,
        scope: "user",
      },
    ]);
  });

  it("deduplicates symlinks to the same skill without replacing native paths and ignores broken links", async () => {
    const canonicalSkills = NodePath.join(root, "shared-skills");
    const canonicalPath = skillWrite(canonicalSkills, "assets", "Shared assets");
    // Different directory-derived names prove real-path dedup, not just name collisions.
    NodeFS.writeFileSync(canonicalPath, "---\ndescription: Shared assets\n---\nSkill body");
    const globalSkills = NodePath.join(agentDir, "skills");
    const agentsSkills = NodePath.join(home, ".agents", "skills");
    const projectSkills = NodePath.join(cwd, CONFIG_DIR_NAME, "skills");
    for (const [directory, alias] of [
      [globalSkills, "global-assets"],
      [agentsSkills, "agent-assets"],
      [projectSkills, "project-assets"],
    ] as const) {
      NodeFS.mkdirSync(directory, { recursive: true });
      NodeFS.symlinkSync(NodePath.dirname(canonicalPath), NodePath.join(directory, alias), "dir");
    }
    NodeFS.symlinkSync(
      NodePath.join(root, "missing"),
      NodePath.join(globalSkills, "broken"),
      "dir",
    );
    settingsWrite(agentDir, { skills: [canonicalPath] });

    const resources = await piResourcesForCwd(cwd);
    const nativePath = NodePath.join(projectSkills, "project-assets", "SKILL.md");
    expect(NodeFS.realpathSync(nativePath)).toBe(canonicalPath);
    expect(resources.skills).toEqual([
      {
        name: "project-assets",
        path: nativePath,
        description: "Shared assets",
        enabled: true,
        scope: "project",
      },
    ]);
  });

  it("honors global and project resource settings without treating model-invocation-disabled skills as unloaded", async () => {
    const globalSkills = NodePath.join(agentDir, "skills");
    const projectConfig = NodePath.join(cwd, CONFIG_DIR_NAME);
    const projectSkills = NodePath.join(projectConfig, "skills");
    skillWrite(globalSkills, "disabled-global", "Excluded global");
    skillWrite(projectSkills, "disabled-project", "Excluded project");
    const manual = skillWrite(
      globalSkills,
      "manual",
      "Explicit-only skill",
      "disable-model-invocation: true\n",
    );
    const configured = skillWrite(
      NodePath.join(root, "configured"),
      "configured",
      "Configured project skill",
    );
    settingsWrite(agentDir, { skills: ["-skills/disabled-global"] });
    settingsWrite(projectConfig, {
      skills: ["-skills/disabled-project", configured],
      prompts: ["-prompts/disabled.md"],
    });
    const prompts = NodePath.join(projectConfig, "prompts");
    NodeFS.mkdirSync(prompts, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prompts, "disabled.md"), "Excluded prompt");

    expect(await piResourcesForCwd(cwd)).toEqual({
      slashCommands: [],
      skills: [
        {
          name: "configured",
          path: configured,
          description: "Configured project skill",
          enabled: true,
          scope: "project",
        },
        {
          name: "manual",
          path: manual,
          description: "Explicit-only skill",
          enabled: true,
          scope: "user",
        },
      ],
    });
  });

  it.effect("uses the embedded SDK pin, not relocated VERSION, when discovery fails", () =>
    Effect.gen(function* () {
      expect(VERSION).toBe("0.0.42");
      vi.spyOn(ModelRuntime, "create").mockRejectedValue(new Error("Model catalog unavailable"));
      const instance = yield* PiDriver.create({
        instanceId: ProviderInstanceId.make("pi-version-test"),
        displayName: "Pi version test",
        environment: [],
        enabled: true,
        config: decodePiSettings({ enabled: true }),
      });
      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot).toMatchObject({
        instanceId: "pi-version-test",
        installed: true,
        version: "0.87.1",
        message: "The embedded Pi SDK model catalog could not be read.",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(cwd, { prefix: "t3-pi-version-snapshot-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(false),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "publishes loaded skills and prompt commands together in the cwd provider snapshot",
    () =>
      Effect.gen(function* () {
        skillWrite(NodePath.join(agentDir, "skills"), "assets", "Global assets skill");
        const path = skillWrite(
          NodePath.join(cwd, CONFIG_DIR_NAME, "skills"),
          "assets",
          "Project assets skill",
        );
        const prompts = NodePath.join(agentDir, "prompts");
        const projectPrompts = NodePath.join(cwd, CONFIG_DIR_NAME, "prompts");
        NodeFS.mkdirSync(prompts, { recursive: true });
        NodeFS.mkdirSync(projectPrompts, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(prompts, "assets.md"),
          "---\ndescription: Global assets prompt\n---\nGlobal assets body",
        );
        NodeFS.writeFileSync(
          NodePath.join(projectPrompts, "assets.md"),
          "---\ndescription: Project assets prompt\n---\nProject assets body",
        );
        // A disabled provider skips model/auth discovery, keeping this a resource-only test.
        const instance = yield* PiDriver.create({
          instanceId: ProviderInstanceId.make("pi-resource-test"),
          displayName: "Pi resource test",
          environment: [],
          enabled: false,
          config: decodePiSettings({ enabled: false }),
        });
        const snapshot = yield* instance.snapshotForCwd!(cwd);
        expect(snapshot).toMatchObject({
          instanceId: "pi-resource-test",
          enabled: false,
          slashCommands: [{ name: "assets", description: "Project assets prompt" }],
          skills: [
            {
              name: "assets",
              path,
              description: "Project assets skill",
              enabled: true,
              scope: "project",
            },
          ],
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          // The requested workspace differs from the server cwd.
          ServerConfig.layerTest(root, { prefix: "t3-pi-resource-snapshot-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provideMerge(
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                shouldRunScopeWork: () => Effect.succeed(false),
              }),
            ),
          ),
        ),
      ),
  );
});
