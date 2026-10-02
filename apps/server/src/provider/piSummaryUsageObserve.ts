import type {
  AgentSession,
  BranchSummaryEntry,
  CompactionResult,
} from "@earendil-works/pi-coding-agent";

type SummaryUsage = NonNullable<CompactionResult["usage"]>;
type Observation = Readonly<{
  entryId: string;
  kind: "compaction" | "branch_summary";
  usage: Readonly<Omit<SummaryUsage, "cost"> & { cost?: Readonly<SummaryUsage["cost"]> }>;
  usageSource: "compaction-result" | "persisted-entry";
  reason?: "manual" | "threshold" | "overflow";
  modelIdentity?: Readonly<{
    provider: string;
    model: string;
    source: "session-model-at-compaction-start";
  }>;
}>;

/** Observe new paid summaries, not history, assistant messages, child results, or session totals. */
export function piSummaryUsageObserve(
  session: Pick<AgentSession, "sessionManager" | "subscribe" | "model">,
  onUsage: (observation: Observation) => void,
) {
  const seenEntries = new Set(
    session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "compaction" || entry.type === "branch_summary")
      .map((entry) => entry.id),
  );
  const seenResults = new WeakSet<CompactionResult>();
  let modelIdentity: Observation["modelIdentity"];
  let disposed = false;

  const report = (
    entryId: string,
    kind: Observation["kind"],
    usage: SummaryUsage | undefined,
    usageSource: Observation["usageSource"],
    metadata: Pick<Observation, "reason" | "modelIdentity"> = {},
  ) => {
    if (disposed || seenEntries.has(entryId)) return;
    seenEntries.add(entryId);
    // Keep known tokens even if a provider omitted cost; never synthesize zero cost.
    if (!usage) return;
    const { cost, ...tokens } = usage;
    onUsage(
      Object.freeze({
        entryId,
        kind,
        usageSource,
        ...metadata,
        usage: Object.freeze({
          ...tokens,
          ...(cost === undefined ? {} : { cost: Object.freeze({ ...cost }) }),
        }),
      }),
    );
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction_start") {
      const model = session.model;
      modelIdentity = model
        ? Object.freeze({
            provider: model.provider,
            model: model.id,
            source: "session-model-at-compaction-start" as const,
          })
        : undefined;
      return;
    }
    if (event.type !== "compaction_end") return;
    const identity = modelIdentity;
    modelIdentity = undefined;
    if (event.aborted || !event.result || seenResults.has(event.result)) return;
    const result = event.result;
    seenResults.add(result);
    // 0.87.1 persists before compaction_end, but the event has no entry ID.
    // Match the newest active-branch entry, not SDK session_compact's first summary-text match.
    const entry = session.sessionManager
      .getBranch()
      .findLast(
        (candidate) =>
          candidate.type === "compaction" &&
          candidate.summary === result.summary &&
          candidate.firstKeptEntryId === result.firstKeptEntryId &&
          candidate.tokensBefore === result.tokensBefore,
      );
    if (entry?.type !== "compaction") return;
    report(
      entry.id,
      "compaction",
      result.usage ?? entry.usage,
      result.usage ? "compaction-result" : "persisted-entry",
      {
        reason: event.reason,
        // Extension summaries need not use the selected session model.
        ...(identity && !entry.fromHook ? { modelIdentity: identity } : {}),
      },
    );
  });

  return {
    // navigateTree returns summaryEntry and emits only an extension session_tree hook,
    // not an AgentSession event. Call here at that public result/hook boundary.
    observeBranchSummary: (entry: BranchSummaryEntry) => {
      const persisted = session.sessionManager.getEntry(entry.id);
      if (persisted?.type !== "branch_summary") return;
      report(persisted.id, "branch_summary", persisted.usage, "persisted-entry");
    },
    unsubscribe: () => {
      disposed = true;
      unsubscribe();
    },
  };
}
