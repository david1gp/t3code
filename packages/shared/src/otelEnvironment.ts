/**
 * otelEnvironment: the OpenTelemetry kill switch, read the way the
 * specification says to read it.
 *
 * Every process that exports telemetry needs to agree on what turns it off,
 * so this is read by both the server and the desktop app rather than each
 * inventing its own check. `T3CODE_OTEL_SDK_DISABLED` is read here because it
 * is the same setting as `OTEL_SDK_DISABLED`, asked of T3 Code's own name
 * first: a machine that already exports `OTEL_SDK_DISABLED` for every other
 * process on it can still opt T3 Code back in without touching the ambient
 * variable everything else depends on.
 *
 * An unrecognized value is a warning followed by the default, never a
 * refusal to start and never a silently different behavior.
 *
 * @module otelEnvironment
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface OtelEnvironment {
  /**
   * Whether anything is exported at all, by any route. `T3CODE_OTEL_SDK_DISABLED`
   * answers it, and `OTEL_SDK_DISABLED` answers it only when T3 Code's own name
   * is unset. So `T3CODE_OTEL_SDK_DISABLED=false` is how a machine that exports
   * `OTEL_SDK_DISABLED` for everything else keeps T3 Code exporting.
   */
  readonly disabled: boolean;
  /**
   * Values that were named but could not be used, each already phrased for a
   * human. The specification requires a warning for a value the implementation
   * does not recognize, and these are collected rather than logged here so the
   * caller reports them once, at startup, where someone is looking.
   */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * A set but blank value is not an answer. It is how a machine clears a variable
 * it inherited without being able to unset it, so taking one as an answer would
 * suppress the source under it that could have been used instead.
 */
const blankAsUnset = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => blankAsUnset(Option.getOrUndefined(value))),
  );

interface ReadBoolean<Value> {
  readonly value: Value;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * The specification defines exactly one true value, the case-insensitive
 * string `true`, and says an implementation must not extend that list. So a
 * value that reads as affirmative anywhere else is false here, and the
 * specification asks for a warning when it happens, because being read as the
 * opposite of what it looks like is the whole problem with these values.
 *
 * Only `false`, empty and unset are quiet: those are the ways of saying no
 * that the specification recognizes.
 */
const specBoolean = (name: string) =>
  optionalString(name).pipe(
    Effect.map((raw): ReadBoolean<boolean> => {
      if (raw === undefined) {
        return { value: false, warnings: [] };
      }
      const value = raw.toLowerCase();
      if (value === "true") {
        return { value: true, warnings: [] };
      }
      if (value === "false") {
        return { value: false, warnings: [] };
      }
      return {
        value: false,
        warnings: [
          `${name}=${raw} was read as false; the OpenTelemetry specification recognizes only the string true, so use ${name}=true or T3CODE_${name} to say it any other way`,
        ],
      };
    }),
  );

/**
 * A `T3CODE_*` name is ours, so it answers to everything the rest of T3 Code's
 * own variables answer to, which is what `Config.Boolean` accepts. `undefined`
 * means the name did not answer, either because it is unset or because its
 * value was unreadable, and the source under it decides instead. A typo
 * therefore costs that variable and nothing else.
 */
const T3_AFFIRMATIVE = ["true", "yes", "on", "1", "y"];
const T3_NEGATIVE = ["false", "no", "off", "0", "n"];

const t3Boolean = (name: string) =>
  optionalString(name).pipe(
    Effect.map((raw): ReadBoolean<boolean | undefined> => {
      if (raw === undefined) {
        return { value: undefined, warnings: [] };
      }
      const value = raw.toLowerCase();
      if (T3_AFFIRMATIVE.includes(value)) {
        return { value: true, warnings: [] };
      }
      if (T3_NEGATIVE.includes(value)) {
        return { value: false, warnings: [] };
      }
      return {
        value: undefined,
        warnings: [`${name}=${raw} is not a yes or a no and was ignored`],
      };
    }),
  );

/**
 * Whichever name switched export off is the one worth naming, because it is
 * the one the reader has to go and unset. An ambient `OTEL_SDK_DISABLED` is
 * the case where that is not obvious and where the answer is not to unset
 * anything, so the message carries the override with it.
 */
const disabledBy = (name: string) =>
  name === "OTEL_SDK_DISABLED"
    ? "OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it; set T3CODE_OTEL_SDK_DISABLED=false to export anyway"
    : `${name} is set, so no telemetry is exported, whatever configured it`;

/**
 * Read the environment. Never fails: a variable T3 Code cannot honor leaves
 * the switch at its default rather than taking the process down with it.
 */
export const load: Effect.Effect<OtelEnvironment> = Effect.gen(function* () {
  const t3 = yield* t3Boolean("T3CODE_OTEL_SDK_DISABLED");
  const spec = yield* specBoolean("OTEL_SDK_DISABLED");
  // One setting under two names: T3 Code's own answers it, and the standard
  // name answers it only when ours is unset.
  const disabled = t3.value ?? spec.value;
  return {
    disabled,
    warnings: [
      ...new Set([
        ...t3.warnings,
        // The standard name's own complaint is worth hearing even when T3
        // Code's name answered instead, because the value is still wrong.
        ...spec.warnings,
        ...(disabled
          ? [disabledBy(t3.value === true ? "T3CODE_OTEL_SDK_DISABLED" : "OTEL_SDK_DISABLED")]
          : []),
      ]),
    ],
  };
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not read the OpenTelemetry environment", cause).pipe(
      Effect.as({ disabled: false, warnings: [] }),
    ),
  ),
);

/** An environment that asked for nothing, for tests and for the pairing CLI. */
export const none: OtelEnvironment = {
  disabled: false,
  warnings: [],
};
