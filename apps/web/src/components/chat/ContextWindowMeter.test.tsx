import { EventId, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

const usage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 27_000, maxTokens: 272_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!usage) {
  throw new Error("The context window test fixture did not produce a snapshot.");
}

describe("ContextWindowMeter", () => {
  it("keeps the hover popover open while the pointer moves to the compact button", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={usage} displayMode="detailed" onCompact={() => {}} />,
    );

    expect(markup).toContain('data-close-delay="150"');
    expect(markup).toContain("Compact context");
  });

  it("closes an informational hover popover without delay", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} displayMode="simple" />);

    expect(markup).toContain('data-close-delay="0"');
    expect(markup).toContain(">27k<");
    expect(markup).not.toContain("Compact context");
  });

  it("shows percentage and used/maximum tokens in detailed mode", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={usage} displayMode="detailed" />,
    );

    expect(markup).toContain(">9.9% · 27k/272k<");
  });

  it("shows the unavailable explanation instead of the compact action", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={usage}
        displayMode="detailed"
        onCompact={() => {}}
        compactDisabled
        compactDisabledReason="Send or clear your draft before compacting"
      />,
    );

    expect(markup).toContain(">Send or clear your draft before compacting<");
    expect(markup).not.toContain("Compact context");
    expect(markup).not.toContain('aria-label="Send or clear your draft before compacting"');
  });
});
