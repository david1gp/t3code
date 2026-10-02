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
const configDecode = Schema.decodeUnknownExit(openCodeNativeInventorySchema.config);

/** Load native location resources without replacing the machine-wide model catalog. */
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

    const config = Effect.tryPromise({
      // v2.0.18's Solid location.config.list cache is backed by this public transport.
      try: (signal) =>
        client.config.get(
          { location: { directory: input.directory } },
          {
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(NATIVE_INVENTORY_REQUEST_TIMEOUT_MS),
            ]),
          },
        ),
      catch: (cause) =>
        new OpenCodeRuntimeError({
          operation: "config.get",
          detail: statuses.has("/api/config")
            ? `Native inventory request returned HTTP ${statuses.get("/api/config")}.`
            : "Native inventory request failed.",
          cause,
        }),
    }).pipe(
      Effect.flatMap((body) => {
        const decoded = configDecode(body);
        if (Exit.isFailure(decoded)) {
          return Effect.fail(
            new OpenCodeRuntimeError({
              operation: "config.get",
              detail: "Invalid native configuration response.",
            }),
          );
        }
        // Config.latest: sources are lowest-to-highest priority; absent fields do
        // not erase earlier selections. Agent.Info already contains agent overrides.
        const entry = decoded.value.findLast(
          (entry) => entry.type === "document" && entry.info.model !== undefined,
        );
        const selected = entry?.type === "document" ? entry.info.model : undefined;
        return Effect.succeed(
          selected
            ? {
                id: selected.model,
                providerID: selected.providerID,
                ...(selected.variant === undefined ? {} : { variant: selected.variant }),
              }
            : undefined,
        );
      }),
    );
    // Workspace loads need agents/config/skills/commands, never models/providers.
    const [agent, skill, command, configuredModel] = yield* Effect.all(
      [
        read(
          "agent",
          (signal) => client.agent.list({ location: { directory: input.directory } }, { signal }),
          Schema.decodeUnknownExit(openCodeNativeInventorySchema.agent),
        ),
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
        config,
      ],
      { concurrency: "unbounded" },
    );
    const workspace = { agent, skill, command, ...(configuredModel ? { configuredModel } : {}) };
    if (input.workspaceOnly) return { provider: [], model: [], ...workspace };
    const [provider, model] = yield* Effect.all(
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
      ],
      { concurrency: "unbounded" },
    );
    return { provider, model, ...workspace };
  });
