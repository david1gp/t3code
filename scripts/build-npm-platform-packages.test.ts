import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CLI_ARCHIVE_PLATFORM_KEYS } from "@t3tools/shared/cliRelease";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildNpmPlatformPackages,
  NpmPackagesArchivesMissingError,
  npmLauncherPackageManifest,
  npmPlatformPackageManifest,
  npmPlatformPackageName,
} from "./build-npm-platform-packages.ts";

const VERSION = "1.2.3";
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const KEYS = ["linux-x64", "darwin-arm64"] as const;

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: Record<string, string> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env ?? {} }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

/** A tar.gz laid out like build-cli-archive.ts writes, with a stub `t3` that echoes its args. */
const makeFakeArchives = Effect.fn("test.makeFakeArchives")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-packages-test-" });
  const archivesDir = path.join(root, "archives");
  yield* fs.makeDirectory(archivesDir);
  for (const key of KEYS) {
    const stem = `t3-${VERSION}-${key}`;
    const stage = path.join(root, "stage", key);
    const contentDir = path.join(stage, stem);
    for (const dir of [
      "client",
      "resource-monitor",
      "node_modules/node-pty",
      "node_modules/@ff-labs/fff-node",
    ]) {
      yield* fs.makeDirectory(path.join(contentDir, dir), { recursive: true });
    }
    yield* fs.writeFileString(
      path.join(contentDir, "node_modules/node-pty/package.json"),
      '{ "name": "node-pty", "version": "1.1.0" }\n',
    );
    yield* fs.writeFileString(
      path.join(contentDir, "node_modules/@ff-labs/fff-node/package.json"),
      '{ "name": "@ff-labs/fff-node", "version": "0.9.4" }\n',
    );
    yield* fs.writeFileString(path.join(contentDir, "client/index.html"), "<html></html>\n");
    yield* fs.writeFileString(
      path.join(contentDir, "t3"),
      `#!/bin/sh\necho "stub ${key} $*"\nexit 7\n`,
    );
    yield* fs.chmod(path.join(contentDir, "t3"), 0o755);
    const exit = yield* run("tar", ["-czf", path.join(archivesDir, `${stem}.tar.gz`), stem], {
      cwd: stage,
    });
    assert.equal(exit.exitCode, 0, exit.stderr);
  }
  yield* fs.writeFileString(path.join(archivesDir, "SHA256SUMS"), "");
  return { root, archivesDir, outputDir: path.join(root, "out") };
});

it.layer(NodeServices.layer)("build-npm-platform-packages", (it) => {
  it("declares five public platform packages at the exact launcher version", () => {
    const launcher = npmLauncherPackageManifest(VERSION, CLI_ARCHIVE_PLATFORM_KEYS);
    const platformNames = CLI_ARCHIVE_PLATFORM_KEYS.map(npmPlatformPackageName);
    assert.equal(launcher.name, "@adaptive-ds/t3code");
    assert.deepStrictEqual(launcher.publishConfig, { access: "public" });
    assert.isFalse("private" in launcher);
    assert.deepStrictEqual(launcher.optionalDependencies, {
      "@adaptive-ds/t3code-darwin-arm64": VERSION,
      "@adaptive-ds/t3code-linux-arm64": VERSION,
      "@adaptive-ds/t3code-linux-x64": VERSION,
      "@adaptive-ds/t3code-win32-arm64": VERSION,
      "@adaptive-ds/t3code-win32-x64": VERSION,
    });
    for (const key of CLI_ARCHIVE_PLATFORM_KEYS) {
      const platform = npmPlatformPackageManifest(key, VERSION, {});
      assert.include(platformNames, platform.name);
      assert.equal(platform.version, launcher.version);
      assert.deepStrictEqual(platform.publishConfig, { access: "public" });
      assert.isFalse("private" in platform);
    }
  });

  it.effect("refuses a partial release unless --allow-missing is passed", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFakeArchives();
      const error = yield* buildNpmPlatformPackages({
        ...fixture,
        version: VERSION,
        allowMissing: false,
      }).pipe(Effect.flip);
      assert.instanceOf(error, NpmPackagesArchivesMissingError);
      assert.deepStrictEqual((error as NpmPackagesArchivesMissingError).missing, [
        "linux-arm64",
        "win32-arm64",
        "win32-x64",
      ]);
    }),
  );

  it.effect("builds platform packages and a launcher that execs the installed one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFakeArchives();
      const outputs = yield* buildNpmPlatformPackages({
        ...fixture,
        version: VERSION,
        allowMissing: true,
      });
      // Platform packages in CLI_ARCHIVE_PLATFORM_KEYS order, launcher last.
      assert.deepStrictEqual(
        outputs.map((output) => output.name),
        [
          "@adaptive-ds/t3code-darwin-arm64",
          "@adaptive-ds/t3code-linux-x64",
          "@adaptive-ds/t3code",
        ],
      );
      for (const output of outputs) {
        assert.isTrue(yield* fs.exists(output.tarball), output.tarball);
        const publishDryRun = yield* run(
          "npm",
          ["publish", "--dry-run", "--access", "public", output.tarball],
          { cwd: fixture.outputDir, env: { PATH: process.env.PATH ?? "" } },
        );
        assert.equal(publishDryRun.exitCode, 0, publishDryRun.stderr);
      }

      const linuxDir = path.join(fixture.outputDir, "@adaptive-ds/t3code-linux-x64");
      const linuxManifest = yield* decodeManifest(
        yield* fs.readFileString(path.join(linuxDir, "package.json")),
      );
      assert.equal(linuxManifest.name, "@adaptive-ds/t3code-linux-x64");
      assert.equal(linuxManifest.version, VERSION);
      assert.deepStrictEqual(linuxManifest.publishConfig, { access: "public" });
      assert.isUndefined(linuxManifest.private);
      assert.deepStrictEqual(linuxManifest.repository, {
        type: "git",
        url: "https://github.com/david1gp/t3code",
      });
      assert.deepStrictEqual(linuxManifest.os, ["linux"]);
      assert.deepStrictEqual(linuxManifest.cpu, ["x64"]);
      assert.deepStrictEqual(linuxManifest.files, [
        "t3",
        "t3.exe",
        "client",
        "resource-monitor",
        "node_modules",
      ]);
      assert.equal(linuxManifest.preferUnplugged, true);
      assert.isUndefined(linuxManifest.bin);
      // The shipped node_modules is declared, or npm prunes it as extraneous
      // on the next install in the same project and the executable breaks.
      assert.deepStrictEqual(linuxManifest.dependencies, {
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
      });
      assert.deepStrictEqual(linuxManifest.bundleDependencies, ["@ff-labs/fff-node", "node-pty"]);
      // Archive contents sit at the package root, not under the archive stem.
      assert.isTrue(yield* fs.exists(path.join(linuxDir, "client/index.html")));
      // A root README, or npm would display a bundled dependency's.
      assert.include(
        yield* fs.readFileString(path.join(linuxDir, "README.md")),
        "# @adaptive-ds/t3code-linux-x64",
      );
      assert.isTrue(yield* fs.exists(path.join(linuxDir, "node_modules/node-pty")));
      assert.equal(Number((yield* fs.stat(path.join(linuxDir, "t3"))).mode) & 0o111, 0o111);

      const darwinManifest = yield* decodeManifest(
        yield* fs.readFileString(
          path.join(fixture.outputDir, "@adaptive-ds/t3code-darwin-arm64/package.json"),
        ),
      );
      assert.deepStrictEqual(darwinManifest.os, ["darwin"]);
      assert.deepStrictEqual(darwinManifest.cpu, ["arm64"]);

      const launcherDir = path.join(fixture.outputDir, "@adaptive-ds/t3code");
      const launcherManifest = yield* decodeManifest(
        yield* fs.readFileString(path.join(launcherDir, "package.json")),
      );
      assert.equal(launcherManifest.name, "@adaptive-ds/t3code");
      assert.equal(launcherManifest.version, VERSION);
      assert.deepStrictEqual(launcherManifest.publishConfig, { access: "public" });
      assert.isUndefined(launcherManifest.private);
      assert.deepStrictEqual(launcherManifest.bin, { t3: "./bin/t3.js" });
      assert.deepStrictEqual(launcherManifest.files, ["bin", "dist"]);
      assert.deepStrictEqual(launcherManifest.optionalDependencies, {
        "@adaptive-ds/t3code-darwin-arm64": VERSION,
        "@adaptive-ds/t3code-linux-x64": VERSION,
      });
      assert.isUndefined(launcherManifest.engines);
      assert.isTrue(yield* fs.exists(path.join(launcherDir, "bin/t3.js")));

      // The scratch dirs must not be left behind next to the packages.
      const outputEntries = yield* fs.readDirectory(fixture.outputDir);
      assert.deepStrictEqual(outputEntries.sort(), ["@adaptive-ds", "t3code.tgz"]);

      const partialPublish = yield* run(
        process.execPath,
        ["apps/server/scripts/cli.ts", "publish", "--packages-dir", fixture.outputDir, "--dry-run"],
        { cwd: yield* path.fromFileUrl(new URL("..", import.meta.url)) },
      );
      assert.notEqual(partialPublish.exitCode, 0);
      assert.include(partialPublish.stdout + partialPublish.stderr, "t3code-linux-arm64.tgz");

      // The tarball is what gets published: it must carry node_modules (which
      // `npm publish <dir>` would strip) under npm's `package/` root, with the
      // executable bit intact.
      const listing = yield* run(
        "tar",
        ["-tzvf", path.join(fixture.outputDir, "@adaptive-ds/t3code-linux-x64.tgz")],
        { cwd: fixture.outputDir },
      );
      assert.equal(listing.exitCode, 0, listing.stderr);
      const lines = listing.stdout.split("\n");
      assert.isTrue(lines.some((line) => line.endsWith(" package/node_modules/node-pty/")));
      assert.isTrue(lines.some((line) => line.endsWith(" package/package.json")));
      assert.isTrue(
        lines.some((line) => /^-rwxr-xr-x .* package\/t3$/.test(line)),
        listing.stdout,
      );

      // Unpack the published tarballs under node_modules; do not exercise the
      // staging directories, which npm never installs.
      const installedNodeModules = path.join(fixture.root, "installed", "node_modules");
      const scopedDir = path.join(installedNodeModules, "@adaptive-ds");
      yield* fs.makeDirectory(scopedDir, { recursive: true });
      for (const output of outputs.slice(0, -1)) {
        const unpackPlatform = yield* run("tar", ["-xf", output.tarball, "-C", scopedDir], {
          cwd: fixture.root,
        });
        assert.equal(unpackPlatform.exitCode, 0, unpackPlatform.stderr);
        yield* fs.rename(
          path.join(scopedDir, "package"),
          path.join(installedNodeModules, output.name),
        );
      }
      const hostPlatform = yield* HostProcessPlatform;
      const hostArch = yield* HostProcessArchitecture;
      const env = { ...process.env, NODE_PATH: installedNodeModules } as Record<string, string>;
      if (KEYS.some((key) => key === `${hostPlatform}-${hostArch}`)) {
        // Exercise both entry points from the exact tarball that gets published.
        const installedLauncher = path.join(fixture.root, "installed-launcher");
        yield* fs.makeDirectory(installedLauncher);
        const unpack = yield* run(
          "tar",
          ["-xf", path.join(fixture.outputDir, "t3code.tgz"), "-C", installedLauncher],
          {
            cwd: fixture.root,
          },
        );
        assert.equal(unpack.exitCode, 0, unpack.stderr);
        const passthrough = yield* run(process.execPath, ["bin/t3.js", "serve", "--port", "1234"], {
          cwd: path.join(installedLauncher, "package"),
          env,
        });
        assert.equal(
          passthrough.stdout.trim(),
          `stub ${hostPlatform}-${hostArch} serve --port 1234`,
        );
        assert.equal(passthrough.exitCode, 7);

        // Already-installed service updaters use the legacy entry point.
        const legacy = yield* run(
          process.execPath,
          [
            "dist/bin.mjs",
            "__service-preflight",
            "--database-path",
            "a database.sqlite",
            "--launcher-protocol",
            "2",
          ],
          { cwd: path.join(installedLauncher, "package"), env },
        );
        assert.equal(
          legacy.stdout.trim(),
          `stub ${hostPlatform}-${hostArch} __service-preflight --database-path a database.sqlite --launcher-protocol 2`,
        );
        assert.equal(legacy.exitCode, 7);
      }

      const unsupported = yield* run(process.execPath, ["bin/t3.js", "--version"], {
        cwd: launcherDir,
        env: { ...env, NODE_PATH: path.join(fixture.root, "nowhere") },
      });
      assert.equal(unsupported.exitCode, 1);
      assert.include(unsupported.stderr, "linux-x64");
      assert.include(unsupported.stderr, "win32-arm64");
      assert.include(unsupported.stderr, "https://github.com/david1gp/t3code/releases");
    }),
  );
});
