import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { openCodeNativeClientCreate } from "./openCodeNativeClientCreate.ts";
import { OpenCodeRuntimeError, verifyOpenCodeServerVersion } from "./opencodeRuntime.ts";

const NATIVE_MINIMUM_VERSION = "2.0.18";
const serverInfo = Schema.Struct({
  version: Schema.String,
  pid: Schema.Int,
  urls: Schema.Array(Schema.String),
  paths: Schema.Struct({ tmp: Schema.String }),
});
const decodeServerInfo = Schema.decodeUnknownExit(serverInfo);

/** Probe each connection separately; the legacy SDK is used only when the native route is absent. */
export const openCodeProtocolProbe = (input: {
  readonly url: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly fetch?: typeof fetch;
}): Effect.Effect<
  { readonly protocol: "native" | "legacy"; readonly version: string },
  OpenCodeRuntimeError
> =>
  Effect.gen(function* () {
    const operation = "server.info";
    let responseStatus: number | undefined;
    let responseOk = false;
    let responseContentType = "";
    const nativeFetch: typeof fetch = async (request, init) => {
      const response = await (input.fetch ?? fetch)(request, { ...init, redirect: "manual" });
      responseStatus = response.status;
      responseOk = response.ok;
      responseContentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      return response;
    };
    const client = openCodeNativeClientCreate({
      url: input.url,
      ...(input.serverPassword === undefined ? {} : { serverPassword: input.serverPassword }),
      fetch: nativeFetch,
    });
    const body = yield* Effect.tryPromise({
      try: (signal) =>
        client.server.info({ signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }),
      catch: (cause) => {
        if (responseStatus === 404 || (responseOk && responseContentType.includes("text/html"))) {
          return new OpenCodeRuntimeError({
            operation,
            detail: "Native server info route is absent.",
            cause,
          });
        }
        if (responseStatus !== undefined && !responseOk) {
          return new OpenCodeRuntimeError({
            operation,
            detail: `OpenCode server info returned HTTP ${responseStatus}; refusing legacy fallback.`,
            cause,
          });
        }
        return new OpenCodeRuntimeError({
          operation,
          detail: "Could not read the OpenCode server info endpoint.",
          cause,
        });
      },
    }).pipe(
      Effect.catchIf(
        () => responseStatus === 404 || (responseOk && responseContentType.includes("text/html")),
        () => Effect.succeed(null),
      ),
    );
    if (body === null) {
      const client = createOpencodeClient({
        baseUrl: input.url,
        directory: input.directory,
        ...(input.serverPassword !== undefined
          ? {
              headers: {
                Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
              },
            }
          : {}),
        throwOnError: true,
      });
      const version = yield* verifyOpenCodeServerVersion(client);
      return { protocol: "legacy", version } as const;
    }
    if (
      !responseContentType.includes("application/json") &&
      !responseContentType.includes("+json")
    ) {
      return yield* new OpenCodeRuntimeError({
        operation,
        detail: "OpenCode server info did not return JSON.",
      });
    }
    const decoded = decodeServerInfo(body);
    if (Exit.isFailure(decoded)) {
      return yield* new OpenCodeRuntimeError({
        operation,
        detail: "Invalid native server info response.",
      });
    }
    const info = decoded.value;
    if (
      info.pid < 0 ||
      parseSemver(info.version) === null ||
      compareSemverVersions(info.version, NATIVE_MINIMUM_VERSION) < 0
    ) {
      return yield* new OpenCodeRuntimeError({
        operation,
        detail: `Unsupported native OpenCode server version (requires v${NATIVE_MINIMUM_VERSION} or newer).`,
      });
    }
    return { protocol: "native", version: info.version } as const;
  });
