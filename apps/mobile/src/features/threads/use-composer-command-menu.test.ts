import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act, createElement, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
  useComposerCommandMenu,
} from "./use-composer-command-menu";

describe("mobile slash commands", () => {
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: true,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    // A provider switch can invalidate an open menu before a tap arrives.
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});

describe("mobile provider command and skill menu", () => {
  const overlappingNames = ["assets", "code-style", "commits"];
  const skillNames = [...overlappingNames, "agent-browser", "test-t3-app"];
  let root: Root;
  let menu: ReturnType<typeof useComposerCommandMenu>;
  let draftMessage: string;
  let changeDraftMessage: (value: string) => void;

  function MenuProbe({ driver }: { driver: ProviderDriverKind }) {
    const [draft, setDraft] = useState("/");
    const selectedProviderStatus = {
      instanceId: ProviderInstanceId.make("custom-instance"),
      driver,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [
        ...overlappingNames.map((name) => ({ name })),
        ...Array.from({ length: 41 }, (_, index) => ({ name: `template-${index}` })),
      ],
      skills: [
        ...skillNames.map((name) => ({
          name,
          path: `/skills/${name}/SKILL.md`,
          enabled: true,
          userInvocationOnly: true,
        })),
        { name: "disabled", path: "/skills/disabled/SKILL.md", enabled: false },
        {
          name: "agent-only",
          path: "/skills/agent-only/SKILL.md",
          enabled: true,
          userInvocable: false,
        },
      ],
    } satisfies ServerProvider;
    const state = useComposerCommandMenu({
      draftMessage: draft,
      ownerKey: null,
      environmentId: null,
      projectCwd: null,
      selectedProviderStatus,
      hasThread: true,
      hasCompactableConversation: true,
      onChangeDraftMessage: setDraft,
    });
    useLayoutEffect(() => {
      menu = state;
      draftMessage = draft;
      changeDraftMessage = setDraft;
    });
    return null;
  }

  beforeEach(() => {
    // Reuse the web hook-test event target: the probe renders no host nodes.
    const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it.each(["pi", "opencode"])(
    "offers all 44 commands and 5 skills as distinct selectable rows for %s",
    async (kind) => {
      await act(() =>
        root.render(createElement(MenuProbe, { driver: ProviderDriverKind.make(kind) })),
      );

      expect(menu.items.filter((item) => item.type === "provider-slash-command")).toHaveLength(44);
      expect(menu.items.filter((item) => item.type === "skill")).toHaveLength(5);
      expect(new Set(menu.items.map((item) => item.id)).size).toBe(menu.items.length);

      for (const name of overlappingNames) {
        await act(() => changeDraftMessage("/"));
        const command = menu.items.find((item) => item.id === `pcmd:${name}`);
        const skill = menu.items.find((item) => item.id === `skill:${name}`);
        expect(command).toMatchObject({ type: "provider-slash-command", label: `/${name}` });
        expect(skill).toMatchObject({ type: "skill", label: `skill:${name}` });
        if (!command || !skill) throw new Error(`Expected both ${name} menu rows`);

        await act(() => menu.onSelect(command));
        expect(draftMessage).toBe(`/${name} `);
        expect(menu.selection).toEqual({ start: name.length + 2, end: name.length + 2 });

        await act(() => changeDraftMessage("/"));
        await act(() => menu.onSelect(skill));
        expect(draftMessage).toBe(`$${name} `);
        expect(menu.selection).toEqual({ start: name.length + 2, end: name.length + 2 });
      }
    },
  );

  it.each(["codex", "claudeAgent"])(
    "still offers only skill aliases for same-named commands for %s",
    async (kind) => {
      await act(() =>
        root.render(createElement(MenuProbe, { driver: ProviderDriverKind.make(kind) })),
      );

      expect(menu.items.filter((item) => item.type === "provider-slash-command")).toHaveLength(41);
      expect(menu.items.filter((item) => item.type === "skill")).toHaveLength(5);
      for (const name of overlappingNames) {
        expect(menu.items.some((item) => item.id === `pcmd:${name}`)).toBe(false);
        expect(menu.items.some((item) => item.id === `skill:${name}`)).toBe(true);
      }
    },
  );
});
