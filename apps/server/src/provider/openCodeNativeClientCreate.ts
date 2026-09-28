import { OpenCode, type OpenCodeClient } from "@opencode/client";

export function openCodeNativeClientCreate(input: {
  readonly url: string;
  readonly serverPassword?: string;
  readonly fetch?: typeof globalThis.fetch;
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl: input.url,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.serverPassword === undefined
      ? {}
      : {
          headers: {
            Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
          },
        }),
  });
}
