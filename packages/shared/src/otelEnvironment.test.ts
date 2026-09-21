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

  it.effect("warns about a value the specification reads as the opposite of its meaning", () =>
    Effect.gen(function* () {
      const affirmative = yield* OtelEnvironment.load.pipe(withEnv({ OTEL_SDK_DISABLED: "yes" }));
      assert.isFalse(affirmative.disabled);
      assert.include(affirmative.warnings.join("\n"), "OTEL_SDK_DISABLED=yes was read as false");

      const spelled = yield* OtelEnvironment.load.pipe(withEnv({ OTEL_SDK_DISABLED: "false" }));
      assert.isFalse(spelled.disabled);
      assert.deepStrictEqual(spelled.warnings, []);
    }),
  );

  it.effect("keeps complaining about a bad standard value when T3 Code's name answered", () =>
    Effect.gen(function* () {
      const resolved = yield* OtelEnvironment.load.pipe(
        withEnv({ T3CODE_OTEL_SDK_DISABLED: "false", OTEL_SDK_DISABLED: "yes" }),
      );
      assert.isFalse(resolved.disabled);
      assert.include(resolved.warnings.join("\n"), "OTEL_SDK_DISABLED=yes was read as false");
    }),
  );

  it.effect("T3CODE_OTEL_SDK_DISABLED accepts the values every T3CODE_* boolean accepts", () =>
    Effect.gen(function* () {
      const numeric = yield* OtelEnvironment.load.pipe(withEnv({ T3CODE_OTEL_SDK_DISABLED: "1" }));
      assert.isTrue(numeric.disabled);

      const yes = yield* OtelEnvironment.load.pipe(withEnv({ T3CODE_OTEL_SDK_DISABLED: "yes" }));
      assert.isTrue(yes.disabled);

      const off = yield* OtelEnvironment.load.pipe(withEnv({ T3CODE_OTEL_SDK_DISABLED: "off" }));
      assert.isFalse(off.disabled);

      // Config.Boolean's literals, because the specification constrains the
      // names it defines and not ours, and T3 Code's own variables should not
      // disagree with each other about what a yes looks like.
      const shortYes = yield* OtelEnvironment.load.pipe(withEnv({ T3CODE_OTEL_SDK_DISABLED: "y" }));
      assert.isTrue(shortYes.disabled);

      const shortNo = yield* OtelEnvironment.load.pipe(withEnv({ T3CODE_OTEL_SDK_DISABLED: "n" }));
      assert.isFalse(shortNo.disabled);

      // The standard name is case-insensitive by specification, so ours cannot
      // be the stricter of the two.
      const shouted = yield* OtelEnvironment.load.pipe(
        withEnv({ T3CODE_OTEL_SDK_DISABLED: "TRUE" }),
      );
      assert.isTrue(shouted.disabled);
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

  it.effect("padding around a value is not part of the value", () =>
    Effect.gen(function* () {
      // The specification is silent on whitespace, and other SDKs read a
      // boolean as trim then compare, so a variable a shell or .env file padded
      // still says what the operator wrote. Reading "  " as unset and " true "
      // as a bad value would also be two different answers to the same
      // question.
      const padded = yield* OtelEnvironment.load.pipe(withEnv({ OTEL_SDK_DISABLED: " true " }));
      assert.isTrue(padded.disabled);

      const paddedBad = yield* OtelEnvironment.load.pipe(withEnv({ OTEL_SDK_DISABLED: " yes " }));
      assert.isFalse(paddedBad.disabled);
      assert.deepStrictEqual(paddedBad.warnings, [
        "OTEL_SDK_DISABLED=yes was read as false; the OpenTelemetry specification recognizes only the string true, so use OTEL_SDK_DISABLED=true or T3CODE_OTEL_SDK_DISABLED to say it any other way",
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
