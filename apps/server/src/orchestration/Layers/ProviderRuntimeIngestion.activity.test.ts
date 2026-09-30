import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});

describe("runtimeEventToActivities reported turn cost", () => {
  const provisional = (totalCostUsd: number, eventId: string) =>
    ({
      ...base,
      provider: ProviderDriverKind.make("opencode"),
      type: "turn.cost.updated",
      eventId: EventId.make(eventId),
      turnId: TurnId.make("turn-1"),
      payload: {
        totalCostUsd,
        costModel: "provider/model-at-turn",
        costSessionId: "session-at-turn",
      },
    }) satisfies ProviderRuntimeEvent;

  const completed = (totalCostUsd?: number) =>
    ({
      ...base,
      provider: ProviderDriverKind.make("opencode"),
      type: "turn.completed",
      eventId: EventId.make(`evt-cost-${String(totalCostUsd)}`),
      turnId: TurnId.make("turn-1"),
      payload: {
        state: "completed",
        costModel: "provider/model-at-turn",
        costSessionId: "session-at-turn",
        ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      },
    }) satisfies ProviderRuntimeEvent;

  it("leaves a provisional cost untouched when completion reports no amount", () => {
    const zeroCost = runtimeEventToActivities(completed(0));
    const missingCost = runtimeEventToActivities(completed());
    const priorProvisional = runtimeEventToActivities(provisional(0.12, "evt-cost-prior"))[0];

    expect(zeroCost).toHaveLength(1);
    expect(zeroCost[0]).toMatchObject({
      kind: "usage.cost",
      id: "usage-cost:thread-1:turn-1",
      turnId: "turn-1",
      payload: {
        totalCostUsd: 0,
        status: "final",
        model: "provider/model-at-turn",
        providerSessionId: "session-at-turn",
      },
    });
    expect(missingCost).toEqual([]);
    expect(priorProvisional).toMatchObject({
      id: "usage-cost:thread-1:turn-1",
      payload: { totalCostUsd: 0.12, status: "provisional" },
    });
  });

  it("does not persist invalid reported amounts", () => {
    expect(runtimeEventToActivities(completed(-1))).toEqual([]);
    expect(runtimeEventToActivities(completed(Number.NaN))).toEqual([]);
    expect(runtimeEventToActivities(completed(Number.POSITIVE_INFINITY))).toEqual([]);
    expect(runtimeEventToActivities(provisional(-1, "evt-cost-invalid"))).toEqual([]);
    expect(runtimeEventToActivities(provisional(Number.NaN, "evt-cost-nan"))).toEqual([]);
  });

  it("replaces repeated provisional updates with the final turn cost activity", () => {
    const observation = provisional(0.12, "evt-cost-first");
    const first = runtimeEventToActivities(observation)[0];
    const duplicate = runtimeEventToActivities(observation)[0];
    const repeated = runtimeEventToActivities(provisional(0.24, "evt-cost-repeated"))[0];
    const final = runtimeEventToActivities(completed(0.3))[0];

    expect(first).toMatchObject({
      id: "usage-cost:thread-1:turn-1",
      kind: "usage.cost",
      payload: { totalCostUsd: 0.12, status: "provisional" },
    });
    expect(duplicate).toEqual(first);
    expect(repeated?.id).toBe(first?.id);
    expect(repeated?.payload).toMatchObject({ totalCostUsd: 0.24, status: "provisional" });
    expect(final?.id).toBe(first?.id);
    expect(final?.payload).toMatchObject({ totalCostUsd: 0.3, status: "final" });
  });

  it("maps a valid late final snapshot to the same identity and rejects invalid final amounts", () => {
    const initial = runtimeEventToActivities(provisional(0.12, "evt-cost-initial"))[0];
    const late = runtimeEventToActivities({
      ...provisional(0.3, "evt-cost-late"),
      payload: { ...provisional(0.3, "evt-cost-late").payload, status: "final" },
    })[0];
    expect(late?.id).toBe(initial?.id);
    expect(late?.payload).toMatchObject({
      totalCostUsd: 0.3,
      status: "final",
      model: "provider/model-at-turn",
      providerSessionId: "session-at-turn",
    });
    expect(
      runtimeEventToActivities({
        ...provisional(Number.NaN, "evt-invalid-final"),
        payload: { totalCostUsd: Number.NaN, status: "final" },
      }),
    ).toEqual([]);
  });

  it("does not create an OpenCode usage activity for another provider's completion", () => {
    expect(
      runtimeEventToActivities({ ...completed(1), provider: ProviderDriverKind.make("claude") }),
    ).toEqual([]);
  });
});

describe("runtimeEventToActivities tool streaming persistence", () => {
  const accumulatedStdout = [
    "first line of output",
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join("\n");
  const streamingData = {
    toolCallId: "tool-call-1",
    kind: "execute",
    command: "blender --render",
    rawOutput: { stdout: accumulatedStdout },
    content: [{ type: "content", content: { type: "text", text: accumulatedStdout } }],
  };

  it("persists tool.updated with the wire projection of data, not the accumulated stream", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-tool-streaming-updated"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        detail: accumulatedStdout,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("inProgress");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists the full terminal payload on tool.completed", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.data).toEqual(streamingData);
  });
});
