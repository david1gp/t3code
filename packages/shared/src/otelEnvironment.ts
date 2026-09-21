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
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

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
 *
 * Padding is dropped for the same reason, before any value is compared: a shell
 * or a `.env` file can add it without the operator writing it, and reading `  `
 * as unset while reading ` true ` as a bad value would be two answers to one
 * question. The specification says nothing about whitespace, and other SDKs
 * trim before they compare.
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
 * The values the OpenTelemetry specification allows for a boolean it defines.
 * Quoted rather than paraphrased, because how narrow this is tends to read as
 * an oversight:
 *
 * > Any value that represents a Boolean MUST be set to true only by the
 * > case-insensitive string `"true"` [...] An implementation MUST NOT extend
 * > this definition and define additional values that are interpreted as true.
 *
 * So `OTEL_SDK_DISABLED=1`, `=yes` and `=on` are all false, and accepting them
 * is not ours to choose: a value read as affirmative here and as false by every
 * other SDK on the machine defeats the point of the variable having a standard
 * name. That is also why the specification asks for a warning on a value it
 * does not recognize, since a value that looks affirmative and is read as false
 * would otherwise leave an operator believing telemetry is off.
 */
const OtelSpecBoolean = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) => value === "true",
      encode: (value) => (value ? ("true" as const) : ("false" as const)),
    }),
  ),
);

/**
 * Compared in lower case because the specification accepts `TRUE`, and read as
 * an `Option` because an unrecognized value is a warning and a default rather
 * than a failure to start.
 */
const readOtelSpecBoolean = Schema.decodeUnknownOption(OtelSpecBoolean);

/**
 * A name of ours is not a name the specification defines, so the one-spelling
 * rule does not reach it and it answers to the values every other `T3CODE_*`
 * boolean answers to: the literals `Config.Boolean` reads, restated here
 * because effect does not export that schema in its types at this version.
 * Compared in lower case, because the standard name beside this one accepts
 * `TRUE` and ours being the stricter of the two would be the surprise.
 */
const CONFIG_BOOLEAN_TRUE = ["true", "yes", "on", "1", "y"] as const;
const CONFIG_BOOLEAN_FALSE = ["false", "no", "off", "0", "n"] as const;

const ConfigBoolean = Schema.Literals([...CONFIG_BOOLEAN_TRUE, ...CONFIG_BOOLEAN_FALSE]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) =>
        CONFIG_BOOLEAN_TRUE.includes(value as (typeof CONFIG_BOOLEAN_TRUE)[number]),
      encode: (value) => (value ? ("true" as const) : ("false" as const)),
    }),
  ),
);

const readConfigBoolean = Schema.decodeUnknownOption(ConfigBoolean);

const otelSpecBoolean = (name: string) =>
  optionalString(name).pipe(
    Config.map((raw): ReadBoolean<boolean> => {
      if (raw === undefined) {
        return { value: false, warnings: [] };
      }
      return Option.match(readOtelSpecBoolean(raw.toLowerCase()), {
        onSome: (value) => ({ value, warnings: [] }),
        onNone: () => ({
          value: false,
          warnings: [
            `${name}=${raw} was read as false; the OpenTelemetry specification recognizes only the string true, so use ${name}=true or T3CODE_${name} to say it any other way`,
          ],
        }),
      });
    }),
  );

/**
 * `undefined` means the name did not answer, either because it is unset or
 * because its value was unreadable, and the source under it decides instead. A
 * typo therefore costs that variable and nothing else.
 */
const configBoolean = (name: string) =>
  optionalString(name).pipe(
    Config.map((raw): ReadBoolean<boolean | undefined> => {
      if (raw === undefined) {
        return { value: undefined, warnings: [] };
      }
      return Option.match(readConfigBoolean(raw.toLowerCase()), {
        onSome: (value) => ({ value, warnings: [] }),
        onNone: () => ({
          value: undefined,
          warnings: [`${name}=${raw} is not a yes or a no and was ignored`],
        }),
      });
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
export const load: Effect.Effect<OtelEnvironment> = Config.all({
  t3: configBoolean("T3CODE_OTEL_SDK_DISABLED"),
  spec: otelSpecBoolean("OTEL_SDK_DISABLED"),
}).pipe(
  Effect.map(({ spec, t3 }) => {
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
  }),
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
