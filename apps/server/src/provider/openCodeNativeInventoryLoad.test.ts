import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerProviderModel } from "@t3tools/contracts";

import { openCodeNativeInventoryLoad } from "./openCodeNativeInventoryLoad.ts";
import { openCodeNativeInventoryMap } from "./openCodeNativeInventoryMap.ts";
import { openCodeNativeInventoryDefaultsResolve } from "./openCodeNativeInventoryDefaultsResolve.ts";
import { openCodeNativeInventorySchema } from "./openCodeNativeInventorySchema.ts";

const directory = "/work/project";
const location = { directory };
const fixtures = {
  config: [],
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
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        time: { released: 0 },
        cost: [
          {
            input: 2.5,
            output: 10,
            cache: { read: 0.25, write: 3.75 },
          },
          {
            tier: { type: "context", size: 200_000 },
            input: 5,
            output: 20,
            cache: { read: 0.5, write: 7.5 },
          },
        ],
        limit: { context: 128000, output: 16000 },
      },
      {
        id: "off",
        modelID: "off",
        providerID: "openai",
        name: "Off",
        enabled: false,
        status: "active",
        variants: [],
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        time: { released: 0 },
        cost: [],
        limit: { context: 128000, output: 16000 },
      },
    ],
  },
  agent: {
    location,
    data: [
      // v2 names are display labels; sessions must be created with the id.
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
      },
      {
        id: "hidden",
        name: "hidden",
        mode: "primary",
        hidden: true,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
      },
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
        content: "Review changes carefully.",
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
const decodeServerProviderModel = Schema.decodeSync(ServerProviderModel);
const encodeServerProviderModel = Schema.encodeSync(ServerProviderModel);

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
    NodeAssert.deepEqual(requested.toSorted(), [
      "agent",
      "command",
      "config",
      "model",
      "provider",
      "skill",
    ]);
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
      agents.options.map((entry) => [entry.id, entry.label]),
      [["build", "Build"]],
    );
    NodeAssert.equal(agents.currentValue, "build");
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
    const model = mapped.models[0];
    NodeAssert.ok(model);
    const contractRoundTrip = decodeServerProviderModel(encodeServerProviderModel(model));
    NodeAssert.deepEqual(contractRoundTrip.metadata, {
      limits: { context: 128000, output: 16000 },
      modalities: { input: ["text", "image"], output: ["text"] },
      tools: true,
      pricing: {
        unit: "usd_per_million_tokens",
        base: {
          input: 2.5,
          output: 10,
          cache: { read: 0.25, write: 3.75 },
        },
        tiers: [
          {
            inputTokensAbove: 200_000,
            input: 5,
            output: 20,
            cache: { read: 0.5, write: 7.5 },
          },
        ],
      },
    });
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

it("preserves an empty native cost catalog without adding pricing defaults", () => {
  const mapped = openCodeNativeInventoryMap({
    provider: fixtures.provider.data,
    model: [{ ...fixtures.model.data[0]!, cost: [] }],
    agent: [],
    skill: [],
    command: [],
  });
  NodeAssert.deepEqual(mapped.models[0]?.metadata, {
    limits: { context: 128000, output: 16000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    tools: true,
  });
});

it("omits metadata records absent from sparse native inventory", () => {
  const {
    limit: _limit,
    capabilities: _capabilities,
    cost: _cost,
    ...model
  } = fixtures.model.data[0]!;
  const inventory = {
    provider: fixtures.provider.data,
    model: [model],
    agent: [],
    skill: [],
    command: [],
  } satisfies import("./openCodeNativeInventorySchema.ts").OpenCodeNativeInventory;
  const mapped = openCodeNativeInventoryMap({
    ...inventory,
  });
  NodeAssert.deepEqual(mapped.models[0]?.metadata, {});
});

it("maps the first native primary agent as default even when build is available", () => {
  const mapped = openCodeNativeInventoryMap({
    provider: fixtures.provider.data,
    model: fixtures.model.data,
    agent: [
      { id: "review", name: "Review", mode: "primary", hidden: false },
      { id: "build", name: "Build", mode: "primary", hidden: false },
      { id: "plan", name: "Plan", mode: "primary", hidden: false },
    ],
    skill: fixtures.skill.data,
    command: fixtures.command.data,
  });
  const agents = mapped.models[0]?.capabilities?.optionDescriptors?.find(
    (entry) => entry.id === "agent",
  );
  NodeAssert.ok(agents?.type === "select");
  NodeAssert.equal(agents.currentValue, "review");
  NodeAssert.deepEqual(
    agents.options.map((entry) => [entry.id, entry.isDefault === true]),
    [
      ["review", true],
      ["build", false],
      ["plan", false],
    ],
  );
});

it.effect("does not infer a default from a singleton high variant", () =>
  Effect.gen(function* () {
    const inventory = yield* openCodeNativeInventoryLoad({
      url: "http://localhost:4120",
      directory,
      fetch: async (request) => {
        const key = new URL(String(request)).pathname.slice(
          "/api/".length,
        ) as keyof typeof fixtures;
        if (key !== "model") return Response.json(fixtures[key]);
        const fixture = fixtures.model;
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
        if (key !== "model") return Response.json(fixtures[key]);
        const fixture = fixtures.model;
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

it.effect("loads cwd agents, skills and commands without requesting models or providers", () =>
  Effect.gen(function* () {
    const requested: string[] = [];
    const agents = [
      { ...fixtures.agent.data[0], id: "review", name: "Review" },
      { ...fixtures.agent.data[0], id: "build", name: "Build" },
      { ...fixtures.agent.data[0], id: "plan", name: "Plan" },
    ];
    const workspace = yield* openCodeNativeInventoryLoad({
      url: "http://localhost:4120",
      directory,
      workspaceOnly: true,
      fetch: async (request) => {
        const url = new URL(String(request));
        const key = url.pathname.slice("/api/".length) as keyof typeof fixtures;
        NodeAssert.equal(url.searchParams.get("location[directory]"), directory);
        requested.push(key);
        return Response.json(key === "agent" ? { location, data: agents } : fixtures[key]);
      },
    });
    NodeAssert.deepEqual(requested.toSorted(), ["agent", "command", "config", "skill"]);
    NodeAssert.deepEqual(workspace, {
      provider: [],
      model: [],
      agent: agents,
      skill: fixtures.skill.data,
      command: fixtures.command.data,
    });
  }),
);

it.effect("resolves the latest defined native configuration through the pinned public schema", () =>
  Effect.gen(function* () {
    const config = [
      { type: "document", path: "/global/opencode.json", info: { model: "openai/global#low" } },
      { type: "directory", path: "/project/.opencode" },
      { type: "document", info: { model: "custom/family/model#high" } },
      { type: "document", info: { default_agent: "ignored-config-agent" } },
    ];
    const inventory = yield* openCodeNativeInventoryLoad({
      url: "http://localhost:4120",
      directory,
      workspaceOnly: true,
      fetch: async (request) => {
        const url = new URL(String(request));
        NodeAssert.equal(url.searchParams.get("location[directory]"), directory);
        const key = url.pathname.slice("/api/".length) as keyof typeof fixtures;
        return Response.json(key === "config" ? config : fixtures[key]);
      },
    });
    NodeAssert.deepEqual(inventory.configuredModel, {
      providerID: "custom",
      id: "family/model",
      variant: "high",
    });
    NodeAssert.deepEqual(openCodeNativeInventoryDefaultsResolve(inventory), {
      defaultAgent: "build",
      agent: "build",
      model: { providerID: "custom", id: "family/model", variant: "high" },
      modelSource: "config",
    });
    NodeAssert.deepEqual(inventory.model, []);
    NodeAssert.deepEqual(inventory.provider, []);
  }),
);

it("keeps explicit and saved T3 preferences ahead of selected-agent and native config models", () => {
  const model = { providerID: "native", id: "configured" };
  const agentModel = { providerID: "native", id: "review", variant: "high" };
  const inventory = {
    provider: [],
    model: [],
    skill: [],
    command: [],
    configuredModel: model,
    agent: [
      { id: "hidden", name: "Hidden", mode: "primary" as const, hidden: true, model },
      { id: "helper", name: "Helper", mode: "subagent" as const, hidden: false, model },
      { id: "review", name: "Review", mode: "all" as const, hidden: false, model: agentModel },
      { id: "build", name: "Build", mode: "primary" as const, hidden: false },
    ],
  };
  NodeAssert.deepEqual(openCodeNativeInventoryDefaultsResolve(inventory), {
    defaultAgent: "review",
    agent: "review",
    model: agentModel,
    modelSource: "agent",
  });
  NodeAssert.deepEqual(openCodeNativeInventoryDefaultsResolve(inventory, { agent: "build" }), {
    defaultAgent: "review",
    agent: "build",
    model,
    modelSource: "config",
  });
  const saved = { model: { providerID: "t3", id: "saved", variant: "low" }, agent: "build" };
  const explicit = { model: { providerID: "t3", id: "explicit" } };
  NodeAssert.deepEqual(openCodeNativeInventoryDefaultsResolve(inventory, { saved }), {
    defaultAgent: "review",
    agent: "build",
    model: saved.model,
    modelSource: "saved",
  });
  NodeAssert.deepEqual(openCodeNativeInventoryDefaultsResolve(inventory, { explicit, saved }), {
    defaultAgent: "review",
    agent: "build",
    model: explicit.model,
    modelSource: "explicit",
  });
  NodeAssert.deepEqual(
    openCodeNativeInventoryDefaultsResolve({
      provider: [],
      model: [],
      skill: [],
      command: [],
      agent: [],
    }),
    {
      defaultAgent: undefined,
      agent: undefined,
      model: undefined,
      modelSource: undefined,
    },
  );
});

it.effect("retains the pinned Agent.Info model override ahead of the configured fallback", () =>
  Effect.gen(function* () {
    const inventory = yield* openCodeNativeInventoryLoad({
      url: "http://localhost:4120",
      directory,
      workspaceOnly: true,
      fetch: async (request) => {
        const key = new URL(String(request)).pathname.slice(
          "/api/".length,
        ) as keyof typeof fixtures;
        if (key === "config")
          return Response.json([{ type: "document", info: { model: "openai/fallback#low" } }]);
        if (key === "agent")
          return Response.json({
            location,
            data: [
              {
                ...fixtures.agent.data[0],
                model: { providerID: "native", id: "review", variant: "high" },
              },
            ],
          });
        return Response.json(fixtures[key]);
      },
    });
    NodeAssert.deepEqual(openCodeNativeInventoryDefaultsResolve(inventory), {
      defaultAgent: "build",
      agent: "build",
      model: { providerID: "native", id: "review", variant: "high" },
      modelSource: "agent",
    });
    NodeAssert.deepEqual(inventory.configuredModel, {
      providerID: "openai",
      id: "fallback",
      variant: "low",
    });
  }),
);

for (const [kind, body] of [
  ["unexpected envelope", { location, data: [] }],
  ["invalid model selection", [{ type: "document", info: { model: "not-a-provider-model" } }]],
] as const) {
  it.effect(`rejects native config with ${kind} instead of silently clearing the default`, () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        openCodeNativeInventoryLoad({
          url: "http://localhost:4120",
          directory,
          workspaceOnly: true,
          fetch: async (request) => {
            const key = new URL(String(request)).pathname.slice(
              "/api/".length,
            ) as keyof typeof fixtures;
            return Response.json(key === "config" ? body : fixtures[key]);
          },
        }),
      );
      NodeAssert.equal(error.operation, "config.get");
      NodeAssert.match(error.detail, /Invalid native configuration/);
    }),
  );
}

it.effect(
  "reports a rejected native configuration endpoint without falling back to empty defaults",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        openCodeNativeInventoryLoad({
          url: "http://localhost:4120",
          directory,
          workspaceOnly: true,
          fetch: async (request) => {
            const key = new URL(String(request)).pathname.slice(
              "/api/".length,
            ) as keyof typeof fixtures;
            return key === "config"
              ? Response.json({}, { status: 401 })
              : Response.json(fixtures[key]);
          },
        }),
      );
      NodeAssert.equal(error.operation, "config.get");
      NodeAssert.match(error.detail, /HTTP 401/);
    }),
);

it("overlays only project agent options onto the ordered machine model inventory", () => {
  const machine = openCodeNativeInventoryMap({
    provider: fixtures.provider.data,
    model: fixtures.model.data,
    agent: fixtures.agent.data,
    skill: [],
    command: [],
  }).models;
  const workspace = openCodeNativeInventoryMap(
    {
      provider: [],
      model: [],
      skill: [],
      command: [],
      agent: [
        { id: "project-review", name: "Project Review", mode: "all", hidden: false },
        ...fixtures.agent.data,
      ],
    },
    machine,
  );
  NodeAssert.deepEqual(
    workspace.models.map(({ capabilities: _capabilities, ...rest }) => rest),
    machine.map(({ capabilities: _capabilities, ...rest }) => rest),
  );
  NodeAssert.deepEqual(
    workspace.models[0]?.capabilities?.optionDescriptors?.find((entry) => entry.id === "variant"),
    machine[0]?.capabilities?.optionDescriptors?.find((entry) => entry.id === "variant"),
  );
  const agents = workspace.models[0]?.capabilities?.optionDescriptors?.find(
    (entry) => entry.id === "agent",
  );
  NodeAssert.ok(agents?.type === "select");
  NodeAssert.equal(agents.currentValue, "project-review");
  NodeAssert.deepEqual(
    agents.options.map((entry) => entry.id),
    ["project-review", "build"],
  );
  NodeAssert.equal(
    machine[0]?.capabilities?.optionDescriptors?.find((entry) => entry.id === "agent")
      ?.currentValue,
    "build",
  );
  NodeAssert.deepEqual(
    workspace.models.map((model) => model.metadata),
    machine.map((model) => model.metadata),
  );
});

it.effect("rejects mismatched inventory locations and failed endpoints", () =>
  Effect.gen(function* () {
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

for (const failure of ["wrong cwd", "invalid agents", "HTTP 401"] as const) {
  it.effect(`rejects workspace-only agent inventory with ${failure}`, () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        openCodeNativeInventoryLoad({
          url: "http://localhost:4120",
          directory,
          workspaceOnly: true,
          fetch: async (request) => {
            const key = new URL(String(request)).pathname.slice(
              "/api/".length,
            ) as keyof typeof fixtures;
            if (key !== "agent") return Response.json(fixtures[key]);
            if (failure === "HTTP 401") return Response.json({}, { status: 401 });
            return Response.json(
              failure === "wrong cwd"
                ? { location: { directory: "/other" }, data: fixtures.agent.data }
                : { location, data: [{ name: "review" }] },
            );
          },
        }),
      );
      NodeAssert.equal(error.operation, "agent.list");
      NodeAssert.match(
        error.detail,
        failure === "HTTP 401" ? /HTTP 401/ : /Invalid native inventory/,
      );
    }),
  );
}

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
      if (url.pathname === "/api/config") {
        return Response.json([
          { type: "document", info: { model: "native/global#low" } },
          {
            type: "document",
            info: {
              model: { providerID: "native", model: requestedDirectory.slice(1), variant: "high" },
            },
          },
          { type: "document", info: {} },
        ]);
      }
      return Response.json({
        location: { directory: requestedDirectory },
        data:
          url.pathname === "/api/skill"
            ? [
                {
                  id: "review",
                  name: "review",
                  path: `${requestedDirectory}/SKILL.md`,
                  content: "Review",
                },
              ]
            : url.pathname === "/api/agent"
              ? [
                  {
                    id: `${requestedDirectory.slice(1)}-review`,
                    name: "Review",
                    mode: "primary",
                    hidden: false,
                    request: { settings: {}, headers: {}, body: {} },
                    permissions: [],
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
    NodeAssert.deepEqual(
      first.agent.map((agent) => agent.id),
      ["first-review"],
    );
    NodeAssert.deepEqual(
      second.agent.map((agent) => agent.id),
      ["second-review"],
    );
    NodeAssert.deepEqual(first.configuredModel, {
      providerID: "native",
      id: "first",
      variant: "high",
    });
    NodeAssert.deepEqual(second.configuredModel, {
      providerID: "native",
      id: "second",
      variant: "high",
    });
    NodeAssert.equal(requests.length, 8);
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
