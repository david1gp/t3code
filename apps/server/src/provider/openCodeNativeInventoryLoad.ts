import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { openCodeNativeClientCreate } from "./openCodeNativeClientCreate.ts";
import {
  type OpenCodeNativeInventory,
  openCodeNativeInventorySchema,
} from "./openCodeNativeInventorySchema.ts";
import { OpenCodeRuntimeError } from "./opencodeRuntime.ts";

const NATIVE_INVENTORY_REQUEST_TIMEOUT_MS = 5_000;

/** Load the five v2 inventory endpoints through the typed client, preserving the requested location. */
export const openCodeNativeInventoryLoad = (input: {
  readonly url: string;
  readonly serverPassword?: string;
  readonly directory: string;
  readonly fetch?: typeof fetch;
  readonly workspaceOnly?: boolean;
}): Effect.Effect<OpenCodeNativeInventory, OpenCodeRuntimeError> =>
  Effect.gen(function* () {
    const statuses = new Map<string, number>();
    const client = openCodeNativeClientCreate({
      ...input,
      fetch: async (request, init) => {
        const response = await (input.fetch ?? fetch)(request, init);
        statuses.set(new URL(String(request)).pathname, response.status);
        return response;
      },
    });
    const read = <T>(
      key: string,
      request: (signal: AbortSignal) => Promise<unknown>,
      decode: (body: unknown) => Exit.Exit<
        {
          readonly location: { readonly directory: string };
          readonly data: ReadonlyArray<T>;
        },
        unknown
      >,
    ) =>
      Effect.tryPromise({
        try: (signal) =>
          request(
            AbortSignal.any([signal, AbortSignal.timeout(NATIVE_INVENTORY_REQUEST_TIMEOUT_MS)]),
          ),
        catch: (cause) =>
          new OpenCodeRuntimeError({
            operation: `${key}.list`,
            detail:
              statuses.get(`/api/${key}`) === undefined
                ? "Native inventory request failed."
                : `Native inventory request returned HTTP ${statuses.get(`/api/${key}`)}.`,
            cause,
          }),
      }).pipe(
        Effect.flatMap((body) => {
          const decoded = decode(body);
          if (Exit.isFailure(decoded) || decoded.value.location.directory !== input.directory) {
            return Effect.fail(
              new OpenCodeRuntimeError({
                operation: `${key}.list`,
                detail: "Invalid native inventory response or mismatched location.",
              }),
            );
          }
          return Effect.succeed(decoded.value.data);
        }),
      );

    // Skills and commands are location-dependent; keep the complete inventory
    // authoritative for status, and avoid unnecessary model/provider requests for cwd snapshots.
    const [skill, command] = yield* Effect.all(
      [
        read(
          "skill",
          (signal) => client.skill.list({ location: { directory: input.directory } }, { signal }),
          Schema.decodeUnknownExit(openCodeNativeInventorySchema.skill),
        ),
        read(
          "command",
          (signal) => client.command.list({ location: { directory: input.directory } }, { signal }),
          Schema.decodeUnknownExit(openCodeNativeInventorySchema.command),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (input.workspaceOnly) return { provider: [], model: [], agent: [], skill, command };
    const [provider, model, agent] = yield* Effect.all(
      [
        read(
          "provider",
          (signal) =>
            client.provider.list({ location: { directory: input.directory } }, { signal }),
          Schema.decodeUnknownExit(openCodeNativeInventorySchema.provider),
        ),
        read(
          "model",
          (signal) => client.model.list({ location: { directory: input.directory } }, { signal }),
          Schema.decodeUnknownExit(openCodeNativeInventorySchema.model),
        ),
        read(
          "agent",
          (signal) => client.agent.list({ location: { directory: input.directory } }, { signal }),
          Schema.decodeUnknownExit(openCodeNativeInventorySchema.agent),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return { provider, model, agent, skill, command };
  });
