// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { INITIAL_FEN } from "chessops/fen";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import type { commands, MoveAnalysis } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { enginesAtom, referenceDbAtom } from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import type { LocalEngine } from "@/utils/engines";
import { defaultTree } from "@/utils/treeReducer";
import ReportModal from "../ReportModal";

const mocks = vi.hoisted(() => ({
  analyzeGame: vi.fn<typeof commands.analyzeGame>(),
  readTextFile: vi.fn<() => Promise<string>>(),
}));
// Native I/O only. Form validation, notifications, Jotai and tree mutation are real.
vi.mock("@/bindings", () => ({ commands: { analyzeGame: mocks.analyzeGame } }));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/test-app",
  resolve: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 0 },
  exists: async () => true,
  mkdir: vi.fn<() => void>(),
  readTextFile: mocks.readTextFile,
  writeTextFile: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-log", () => ({
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn<() => void>() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const engine: LocalEngine = {
  id: "report-engine",
  type: "local",
  name: "Report engine",
  version: "1",
  path: "/synthetic/report-engine",
  loaded: true,
};
const maiaError =
  "MAIA_OBJECTIVE_ANALYSIS_UNSUPPORTED: Maia scores are model-derived. Choose another analysis engine. Maia remains available as an opponent.";
const analysis: MoveAnalysis[] = [
  {
    best: [
      {
        nodes: 10,
        depth: 1,
        score: { value: { type: "cp", value: 42 }, wdl: null },
        uciMoves: ["e2e4"],
        sanMoves: ["e4"],
        multipv: 1,
        nps: 10,
      },
    ],
    novelty: false,
    is_sacrifice: false,
  },
];
let root: Root;
let container: HTMLDivElement;
let atoms: ReturnType<typeof createStore>;
let tree: ReturnType<typeof createTreeStore>;
let close: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  sessionStorage.clear();
  mocks.readTextFile.mockResolvedValue(JSON.stringify([engine]));
  atoms = createStore();
  atoms.set(referenceDbAtom, "/synthetic/reference");
  tree = createTreeStore(undefined, defaultTree(INITIAL_FEN));
  close = vi.fn<() => void>();
  vi.spyOn(notifications, "show");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    notifications.clean();
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function View() {
  const inProgress = useStore(tree, (state) => state.report.inProgress);
  return (
    <>
      <div data-progress>{String(inProgress)}</div>
      <ReportModal
        tab="report-test"
        initialFen={INITIAL_FEN}
        moves={[]}
        reportingMode
        closeReportingMode={close}
        setInProgress={tree.getState().setReportInProgress}
      />
      <Notifications />
    </>
  );
}

async function submit() {
  await act(async () => {
    await atoms.set(enginesAtom, [engine]);
    root.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <TreeStateContext.Provider value={tree}>
            <View />
          </TreeStateContext.Provider>
        </MantineProvider>
      </Provider>,
    );
  });
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.analyzeGame).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-progress]")?.textContent).toBe("true");
}

it.each(["returned", "thrown"] as const)(
  "maia_score report displays %s failure and always clears progress",
  async (kind) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof commands.analyzeGame>>>();
    mocks.analyzeGame.mockReturnValue(pending.promise);
    const savedRoot = tree.getState().root;
    await submit();
    await act(async () => {
      if (kind === "returned") pending.resolve({ status: "error", error: maiaError });
      else pending.reject(new Error("Native report invocation failed"));
    });
    const message = kind === "returned" ? maiaError : "Native report invocation failed";
    expect(document.body.textContent).toContain(message);
    expect(notifications.show).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-progress]")?.textContent).toBe("false");
    expect(tree.getState().root).toBe(savedRoot);
  },
);

it("maia_score ordinary report still applies analysis and clears progress without error notification", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof commands.analyzeGame>>>();
  mocks.analyzeGame.mockReturnValue(pending.promise);
  const addAnalysis = vi.spyOn(tree.getState(), "addAnalysis");
  await submit();
  await act(async () => pending.resolve({ status: "ok", data: analysis }));
  expect(addAnalysis).toHaveBeenCalledWith(analysis, { showVariations: true });
  expect(tree.getState().root.score).toEqual(analysis[0].best[0].score);
  expect(container.querySelector("[data-progress]")?.textContent).toBe("false");
  expect(notifications.show).not.toHaveBeenCalled();
});
