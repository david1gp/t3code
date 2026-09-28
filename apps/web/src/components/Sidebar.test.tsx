import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  params: {} as Partial<Record<"environmentId" | "threadId" | "draftId", string>>,
  grouped: false,
  projects: [] as EnvironmentProject[],
  threads: [],
  environments: [],
  configs: new Map(),
  keybindings: [],
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => {
    if (atom === primaryServerKeybindingsAtom) return state.keybindings;
    if (atom === environmentServerConfigsAtom) return state.configs;
    return null;
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: ({ select }: { select: (params: typeof state.params) => unknown }) =>
    select(state.params),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  useProjects: () => state.projects,
  useThreadShells: () => state.threads,
  useAllEnvironmentProjectSnapshotsReady: () => true,
}));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: state.environments }),
  usePrimaryEnvironmentId: () => EnvironmentId.make("paired"),
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ClientSettings) => unknown) =>
    select({ ...DEFAULT_CLIENT_SETTINGS, sidebarGroupThreadsByProject: state.grouped }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("../hooks/useThreadActions", () => ({ useThreadActions: () => ({}) }));
vi.mock("../hooks/useHandleNewThread", () => ({ useHandleNewThread: () => ({}) }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/queries", () => ({ useThreadSearch: () => ({ matches: [] }) }));
vi.mock("../hooks/useNowMinute", () => ({ useNowMinute: () => 0 }));
vi.mock("../shortcutModifierState", () => ({
  useShortcutModifierState: () => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  }),
}));
vi.mock("../hooks/useTerminalFocus", () => ({ useTerminalFocus: () => false }));
// The renderer has no DOM; keep the sidebar/draft logic real and omit chrome/portals.
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));
vi.mock("./sidebar/SidebarThreadHeader", () => ({
  SidebarThreadHeader: () => null,
  SidebarHeaderIconButton: () => null,
}));
vi.mock("./ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  SidebarContent: ({ children }: { children: ReactNode }) => children,
  SidebarGroup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { createMemoryStorage } from "../lib/storage";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { useUiStateStore } from "../uiStateStore";
import Sidebar from "./Sidebar";

const draftId = DraftId.make("unsent-draft");
const environmentId = EnvironmentId.make("paired");
const projectId = ProjectId.make("project");
let renderer: ReactTestRenderer | undefined;

async function sidebarRender() {
  await act(async () => {
    if (renderer) renderer.update(<Sidebar />);
    else renderer = create(<Sidebar />);
  });
}

function sidebarDraftPreview() {
  return renderer!.root
    .findByProps({ "data-testid": "sidebar-draft-row" })
    .findAllByType("div")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join("");
}

beforeEach(() => {
  state.params = {};
  state.grouped = false;
  state.projects = [];
  useUiStateStore.setState(useUiStateStore.getInitialState(), true);
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const localStorage = createMemoryStorage();
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { localStorage, setTimeout, clearTimeout }),
  );
  vi.stubGlobal("document", Object.assign(new EventTarget(), { querySelector: () => null }));
  vi.stubGlobal("navigator", { platform: "Linux" });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  useUiStateStore.setState(useUiStateStore.getInitialState(), true);
  vi.unstubAllGlobals();
});

it("renders the paired sidebar without an active thread or draft route", async () => {
  await sidebarRender();
  expect(renderer!.root.findByType("span").children).toEqual(["No projects yet"]);
});

it.each([false, true])(
  "freezes an open draft preview and refreshes it after leaving the draft route (grouped: %s)",
  async (grouped) => {
    state.grouped = grouped;
    state.projects = [
      {
        environmentId,
        id: projectId,
        title: "Paired project",
        workspaceRoot: "/workspace/project",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
      },
    ];
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId);
    store.setPrompt(draftId, "Original unsent prompt");
    await sidebarRender();
    expect(sidebarDraftPreview()).toBe("Original unsent prompt");

    state.params = { draftId };
    await sidebarRender();
    await act(async () => store.setPrompt(draftId, "Edited unsent prompt"));
    expect(sidebarDraftPreview()).toBe("Original unsent prompt");

    state.params = { environmentId, threadId: "server-thread" };
    await sidebarRender();
    expect(sidebarDraftPreview()).toBe("Edited unsent prompt");
  },
);
