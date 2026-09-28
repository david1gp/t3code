import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { openCodeNativeInventoryLoad } from "./openCodeNativeInventoryLoad.ts";
import { openCodeNativeInventoryMap } from "./openCodeNativeInventoryMap.ts";
import { openCodeNativeInventorySchema } from "./openCodeNativeInventorySchema.ts";

const directory = "/work/project";
const location = { directory };
const fixtures = {
  provider: {
    location,
    data: [
      {
        id: "openai",
        name: "OpenAI",
        activation: "enabled",
        package: "@ai-sdk/openai",
      },
    ],
  },
  model: {
    location,
    data: [
      {
        id: "gpt-5",
        modelID: "gpt-5",
        providerID: "openai",
        name: "GPT-5",
        enabled: true,
        status: "active",
        variants: [{ id: "low" }, { id: "medium" }],
      },
      {
        id: "off",
        modelID: "off",
        providerID: "openai",
        name: "Off",
        enabled: false,
        status: "active",
        variants: [],
      },
    ],
  },
  agent: {
    location,
    data: [
      { id: "build", name: "build", mode: "primary", hidden: false },
      { id: "hidden", name: "hidden", mode: "primary", hidden: true },
    ],
  },
  skill: {
    location,
    data: [
      {
        id: "review",
        name: "review",
        path: "/work/project/.opencode/skills/review/SKILL.md",
        description: "Review changes",
        autoinvoke: true,
      },
    ],
  },
  command: {
    location,
    data: [{ name: "review", description: "Review changes" }, { name: "compact" }],
  },
} satisfies {
  [K in keyof typeof openCodeNativeInventorySchema]: Schema.Schema.Type<
    (typeof openCodeNativeInventorySchema)[K]
  >;
};

it.effect("loads typed v2 inventory envelopes with per-request cwd and credentials", () =>
  Effect.gen(function* () {
    const requested: string[] = [];
    const inventory = yield* openCodeNativeInventoryLoad({
      url: "http://localhost:4120",
      directory,
      serverPassword: "instance-password",
      fetch: async (request, init) => {
        const url = new URL(String(request));
        const key = url.pathname.slice("/api/".length) as keyof typeof fixtures;
        NodeAssert.equal(url.searchParams.get("location[directory]"), directory);
        NodeAssert.equal(
          new Headers(init?.headers).get("Authorization"),
          `Basic ${Buffer.from("opencode:instance-password").toString("base64")}`,
        );
        requested.push(key);
        return Response.json(fixtures[key]);
      },
    });
    NodeAssert.deepEqual(requested.toSorted(), ["agent", "command", "model", "provider", "skill"]);
    const mapped = openCodeNativeInventoryMap(inventory);
    NodeAssert.equal(mapped.connectedCount, 1);
    NodeAssert.deepEqual(
      mapped.models.map((model) => model.slug),
      ["openai/gpt-5"],
    );
    const agents = mapped.models[0]?.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === "agent",
    );
    NodeAssert.ok(agents?.type === "select");
    NodeAssert.deepEqual(
      agents.options.map((entry) => entry.id),
      ["build"],
    );
    const reasoning = mapped.models[0]?.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === "variant",
    );
    NodeAssert.ok(reasoning?.type === "select");
    NodeAssert.deepEqual(
      reasoning.options.map((entry) => entry.id),
      ["low", "medium"],
    );
    NodeAssert.ok(reasoning.options.every((entry) => !entry.isDefault));
    NodeAssert.equal(reasoning.currentValue, undefined);
    NodeAssert.deepEqual(
      mapped.skills.map((skill) => skill.path),
      ["/work/project/.opencode/skills/review/SKILL.md"],
    );
    NodeAssert.deepEqual(
      mapped.slashCommands.map((command) => command.name),
      ["compact", "review"],
    );
  }),
);

it.effect("does not infer a default from a singleton high variant", () =>
  Effect.gen(function* () {
    const inventory = yield* openCodeNativeInventoryLoad({
      url: "http://localhost:4120",
      directory,
      fetch: async (request) => {
        const key = new URL(String(request)).pathname.slice(
          "/api/".length,
        ) as keyof typeof fixtures;
        const fixture = fixtures[key];
        if (key !== "model") return Response.json(fixture);
        return Response.json({
          ...fixture,
          data: fixture.data.map((model) => ({
            ...model,
            variants: [{ id: "high" }],
          })),
        });
      },
    });
    const mapped = openCodeNativeInventoryMap(inventory);
    const reasoning = mapped.models[0]?.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === "variant",
    );
    NodeAssert.ok(reasoning?.type === "select");
    NodeAssert.deepEqual(reasoning.options, [{ id: "high", label: "High" }]);
    NodeAssert.equal(reasoning.currentValue, undefined);
  }),
);

it.effect("does not invent model variants when the native inventory has none", () =>
  Effect.gen(function* () {
    const inventory = yield* openCodeNativeInventoryLoad({
      url: "http://localhost:4120",
      directory,
      fetch: async (request) => {
        const key = new URL(String(request)).pathname.slice(
          "/api/".length,
        ) as keyof typeof fixtures;
        const fixture = fixtures[key];
        if (key !== "model") return Response.json(fixture);
        return Response.json({
          ...fixture,
          data: fixture.data.map((model) => ({ ...model, variants: [] })),
        });
      },
    });
    const mapped = openCodeNativeInventoryMap(inventory);
    const descriptors = mapped.models[0]?.capabilities?.optionDescriptors ?? [];
    NodeAssert.equal(
      descriptors.some((entry) => entry.id === "variant"),
      false,
    );
    NodeAssert.deepEqual(descriptors.find((entry) => entry.id === "agent")?.id, "agent");
  }),
);

it.effect(
  "loads only workspace inventory and rejects mismatched locations and failed endpoints",
  () =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const fetchWorkspace: typeof fetch = async (request) => {
        const key = new URL(String(request)).pathname.slice(
          "/api/".length,
        ) as keyof typeof fixtures;
        requested.push(key);
        return Response.json(fixtures[key]);
      };
      const workspace = yield* openCodeNativeInventoryLoad({
        url: "http://localhost:4120",
        directory,
        workspaceOnly: true,
        fetch: fetchWorkspace,
      });
      NodeAssert.deepEqual(requested.toSorted(), ["command", "skill"]);
      NodeAssert.equal(workspace.model.length, 0);
      const wrongLocation = yield* Effect.flip(
        openCodeNativeInventoryLoad({
          url: "http://localhost:4120",
          directory,
          fetch: async () => Response.json({ location: { directory: "/other" }, data: [] }),
        }),
      );
      NodeAssert.match(wrongLocation.detail, /mismatched location/);
      const failed = yield* Effect.flip(
        openCodeNativeInventoryLoad({
          url: "http://localhost:4120",
          directory,
          fetch: async () => Response.json({}, { status: 401 }),
        }),
      );
      NodeAssert.match(failed.detail, /HTTP 401/);
    }),
);

it.effect("aborts a native provider inventory request at its deadline", () =>
  Effect.gen(function* () {
    let providerSignal: AbortSignal | undefined;
    const failure = yield* Effect.flip(
      openCodeNativeInventoryLoad({
        url: "http://localhost:4120",
        directory,
        fetch: async (request, init) => {
          const key = new URL(String(request)).pathname.slice(
            "/api/".length,
          ) as keyof typeof fixtures;
          if (key === "provider") {
            const signal = init?.signal;
            providerSignal = signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
              if (signal === undefined || signal === null) {
                reject(new Error("Expected provider inventory request signal."));
                return;
              }
              const abort = () => reject(signal.reason);
              if (signal.aborted) {
                abort();
                return;
              }
              signal.addEventListener("abort", abort, { once: true });
            });
          }
          return Response.json(fixtures[key]);
        },
      }),
    );
    NodeAssert.equal(failure.operation, "provider.list");
    NodeAssert.match(failure.detail, /request failed/);
    NodeAssert.ok(providerSignal?.aborted);
  }),
);

it.effect("keeps two instance passwords and workspace directories isolated", () =>
  Effect.gen(function* () {
    const requests: Array<{
      origin: string;
      directory: string;
      authorization: string | null;
    }> = [];
    const fetchInventory: typeof fetch = async (request, init) => {
      const url = new URL(String(request));
      const requestedDirectory = url.searchParams.get("location[directory]") ?? "";
      requests.push({
        origin: url.origin,
        directory: requestedDirectory,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return Response.json({
        location: { directory: requestedDirectory },
        data:
          url.pathname === "/api/skill"
            ? [
                {
                  id: "review",
                  name: "review",
                  path: `${requestedDirectory}/SKILL.md`,
                },
              ]
            : [{ name: "review" }],
      });
    };
    const [first, second] = yield* Effect.all([
      openCodeNativeInventoryLoad({
        url: "http://localhost:4001",
        serverPassword: "first",
        directory: "/first",
        workspaceOnly: true,
        fetch: fetchInventory,
      }),
      openCodeNativeInventoryLoad({
        url: "http://localhost:4002",
        serverPassword: "second",
        directory: "/second",
        workspaceOnly: true,
        fetch: fetchInventory,
      }),
    ]);
    NodeAssert.deepEqual(
      first.skill.map((skill) => skill.path),
      ["/first/SKILL.md"],
    );
    NodeAssert.deepEqual(
      second.skill.map((skill) => skill.path),
      ["/second/SKILL.md"],
    );
    NodeAssert.equal(requests.length, 4);
    for (const request of requests) {
      const password = request.origin.endsWith(":4001") ? "first" : "second";
      NodeAssert.equal(request.directory, `/${password}`);
      NodeAssert.equal(
        request.authorization,
        `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      );
    }
  }),
);
