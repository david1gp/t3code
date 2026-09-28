import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  buildInitialPiProviderSnapshot,
  buildPiProviderSnapshot,
  piAuthFromSdk,
  piModelsFromSdk,
} from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("Pi provider catalog", () => {
  it("converts valid distinct provider/model records and ignores malformed entries", () => {
    expect(
      piModelsFromSdk([
        { provider: "anthropic", id: "claude-3", name: "Claude 3" },
        { provider: "anthropic", id: "claude-3", name: "duplicate" },
        { provider: "openai", id: "gpt-5", name: "GPT-5" },
      ]).map(({ slug, name }) => ({ slug, name })),
    ).toEqual([
      { slug: "anthropic/claude-3", name: "Claude 3" },
      { slug: "openai/gpt-5", name: "GPT-5" },
    ]);
  });

  it.effect(
    "keeps an unavailable SDK warning and unknown auth without inventing model availability",
    () =>
      Effect.gen(function* () {
        const settings = decodePiSettings({ enabled: true });
        const snapshot = yield* buildPiProviderSnapshot({
          settings,
          models: [],
          installed: false,
          message: "Pi unavailable",
        });
        expect(snapshot).toMatchObject({
          enabled: true,
          installed: false,
          status: "warning",
          auth: { status: "unknown" },
          models: [],
          message: "Pi unavailable",
        });
      }),
  );

  it("maps SDK credential availability to provider auth without exposing credentials", () => {
    const runtime = {
      getRegisteredProviderIds: () => ["anthropic", "openai"],
      getProviderAuthStatus: (provider: string) => ({ configured: provider === "anthropic" }),
    };
    expect(piAuthFromSdk(runtime)).toEqual({ status: "authenticated" });
    expect(
      piAuthFromSdk({
        ...runtime,
        getProviderAuthStatus: () => ({ configured: false }),
      }),
    ).toEqual({ status: "unauthenticated" });
  });

  it.effect("defaults Pi to disabled with no fabricated catalog", () =>
    Effect.gen(function* () {
      const settings = decodePiSettings({});
      const snapshot = yield* buildInitialPiProviderSnapshot(settings);
      expect(snapshot).toMatchObject({
        enabled: false,
        status: "disabled",
        auth: { status: "unknown" },
        models: [],
      });
    }),
  );
});
