import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as OtelEnvironment from "./otelEnvironment.ts";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

describe("OtelEnvironment", () => {
  it.effect("stays enabled when nothing is configured", () =>
    Effect.gen(function* () {
      const resolved = yield* OtelEnvironment.load.pipe(withEnv({}));
      assert.strictEqual(resolved.disabled, false);
      assert.deepStrictEqual(resolved.warnings, []);
    }),
  );

  it.effect("OTEL_SDK_DISABLED disables only on the exact string true", () =>
    Effect.gen(function* () {
      const trueValue = yield* OtelEnvironment.load.pipe(withEnv({ OTEL_SDK_DISABLED: "true" }));
      assert.isTrue(trueValue.disabled);

      const upper = yield* OtelEnvironment.load.pipe(withEnv({ OTEL_SDK_DISABLED: "True" }));
      assert.isTrue(upper.disabled);

      const numeric = yield* OtelEnvironment.load.pipe(withEnv({ OTEL_SDK_DISABLED: "1" }));
      assert.isFalse(numeric.disabled);

      const yes = yield* OtelEnvironment.load.pipe(withEnv({ OTEL_SDK_DISABLED: "yes" }));
      assert.isFalse(yes.disabled);
    }),
  );

  it.effect("T3CODE_OTEL_SDK_DISABLED accepts the wider T3 Code affirmatives", () =>
    Effect.gen(function* () {
      const numeric = yield* OtelEnvironment.load.pipe(withEnv({ T3CODE_OTEL_SDK_DISABLED: "1" }));
      assert.isTrue(numeric.disabled);

      const yes = yield* OtelEnvironment.load.pipe(withEnv({ T3CODE_OTEL_SDK_DISABLED: "yes" }));
      assert.isTrue(yes.disabled);

      const off = yield* OtelEnvironment.load.pipe(withEnv({ T3CODE_OTEL_SDK_DISABLED: "off" }));
      assert.isFalse(off.disabled);
    }),
  );

  it.effect("an unreadable T3CODE_OTEL_SDK_DISABLED warns and falls through", () =>
    Effect.gen(function* () {
      const resolved = yield* OtelEnvironment.load.pipe(
        withEnv({ T3CODE_OTEL_SDK_DISABLED: "maybe", OTEL_SDK_DISABLED: "true" }),
      );
      assert.isTrue(resolved.disabled);
      assert.include(resolved.warnings.join("\n"), "T3CODE_OTEL_SDK_DISABLED=maybe");
    }),
  );

  it.effect("T3CODE_OTEL_SDK_DISABLED=false overrides an ambient OTEL_SDK_DISABLED=true", () =>
    Effect.gen(function* () {
      const resolved = yield* OtelEnvironment.load.pipe(
        withEnv({ T3CODE_OTEL_SDK_DISABLED: "false", OTEL_SDK_DISABLED: "true" }),
      );
      assert.isFalse(resolved.disabled);
      assert.deepStrictEqual(resolved.warnings, []);
    }),
  );

  it.effect("a set but blank value means unset", () =>
    Effect.gen(function* () {
      const resolved = yield* OtelEnvironment.load.pipe(
        withEnv({ T3CODE_OTEL_SDK_DISABLED: "  ", OTEL_SDK_DISABLED: "true" }),
      );
      assert.isTrue(resolved.disabled);
      assert.deepStrictEqual(resolved.warnings, [
        "OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it; set T3CODE_OTEL_SDK_DISABLED=false to export anyway",
      ]);
    }),
  );

  it.effect("names the switch that turned telemetry off", () =>
    Effect.gen(function* () {
      const viaT3 = yield* OtelEnvironment.load.pipe(withEnv({ T3CODE_OTEL_SDK_DISABLED: "true" }));
      assert.deepStrictEqual(viaT3.warnings, [
        "T3CODE_OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it",
      ]);

      const viaSpec = yield* OtelEnvironment.load.pipe(withEnv({ OTEL_SDK_DISABLED: "true" }));
      assert.deepStrictEqual(viaSpec.warnings, [
        "OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it; set T3CODE_OTEL_SDK_DISABLED=false to export anyway",
      ]);
    }),
  );
});
