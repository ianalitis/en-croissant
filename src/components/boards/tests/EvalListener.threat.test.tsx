// @vitest-environment jsdom
import { Accordion, MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { INITIAL_FEN } from "chessops/fen";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import type { BestMoves, BestMovesPayload, commands } from "@/bindings";
import DetachedEval from "@/components/common/DetachedEval";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import BestMovesPanel from "@/components/panels/analysis/BestMoves";
import {
  activeTabAtom,
  bestMovesFamily,
  currentDetachedEngineAtom,
  currentThreatAtom,
  engineMovesFamily,
  engineProgressFamily,
  enginesAtom,
  tabEngineSettingsFamily,
  tabsAtom,
} from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import { getVariationLine } from "@/utils/chess";
import { positionFromFen, swapMove } from "@/utils/chessops";
import type { LocalEngine } from "@/utils/engines";
import { defaultTree } from "@/utils/treeReducer";
import EvalListener from "../EvalListener";

const mocks = vi.hoisted(() => ({
  getBestMoves: vi.fn<typeof commands.getBestMoves>(),
  stopEngine: vi.fn<typeof commands.stopEngine>(),
  listen:
    vi.fn<(callback: (event: { payload: BestMovesPayload }) => void) => Promise<() => void>>(),
  readTextFile: vi.fn<() => Promise<string>>(),
}));
// Only native I/O and unrelated leaf editors are mocked. Requests, event handling,
// cache selection, Mantine rendering, Jotai, Zustand and throttling stay real.
vi.mock("@/bindings", () => ({
  commands: { getBestMoves: mocks.getBestMoves, stopEngine: mocks.stopEngine },
  events: { bestMovesPayload: { listen: mocks.listen } },
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/test-app",
  resolve: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 0 },
  exists: async () => true,
  mkdir: vi.fn(),
  readTextFile: mocks.readTextFile,
  writeTextFile: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-log", () => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/panels/analysis/EngineSettingsForm", () => ({ default: () => null }));
vi.mock("@/components/panels/analysis/AnalysisRow", () => ({
  default: ({ moves, threat, fen }: { moves: string[]; threat: boolean; fen: string }) => (
    <tr data-analysis-row data-threat={String(threat)} data-fen={fen}>
      <td>{moves.join(" ")}</td>
    </tr>
  ),
}));

const engine: LocalEngine = {
  id: "threat-engine",
  type: "local",
  name: "Threat test engine",
  version: "1",
  path: "/synthetic/engine",
  loaded: true,
};
const tab = "threat-test";
const beforeCheck = "4k3/8/8/8/8/8/R7/4K3 w - - 0 1";
const inCheck = "4k3/8/8/8/8/8/4R3/4K3 b - - 1 1";
const normalLine: BestMovesPayload["bestLines"][number] = {
  nodes: 1000,
  depth: 12,
  score: { value: { type: "cp", value: 125 }, wdl: null },
  uciMoves: ["e8d7"],
  sanMoves: ["Kd7"],
  multipv: 1,
  nps: 500,
};
const threatLine: BestMovesPayload["bestLines"][number] = {
  ...normalLine,
  score: { value: { type: "cp", value: 999 }, wdl: null },
  uciMoves: ["d7c6"],
  sanMoves: ["Kc6"],
};
const cacheAtom = engineMovesFamily({ engine: engine.id, tab });
const progressAtom = engineProgressFamily({ engine: engine.id, tab });
const callbacks = new Set<(event: { payload: BestMovesPayload }) => void>();
let atoms: ReturnType<typeof createStore>;
let tree: ReturnType<typeof createTreeStore>;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  sessionStorage.clear();
  callbacks.clear();
  mocks.readTextFile.mockResolvedValue(JSON.stringify([engine]));
  mocks.getBestMoves.mockResolvedValue({ status: "ok", data: null });
  mocks.stopEngine.mockResolvedValue({ status: "ok", data: null });
  vi.spyOn(notifications, "show").mockReturnValue("test-notification");
  mocks.listen.mockImplementation(async (callback) => {
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
    };
  });
  atoms = createStore();
  atoms.set(tabsAtom, [
    { value: tab, name: "Threat test", type: "analysis", gameOrigin: { kind: "none" } },
    { value: "other-tab", name: "Other tab", type: "analysis", gameOrigin: { kind: "none" } },
  ]);
  atoms.set(activeTabAtom, tab);
  atoms.set(currentThreatAtom, true);
  atoms.set(currentDetachedEngineAtom, engine.id);
  atoms.set(tabEngineSettingsFamily({ engineId: engine.id, tab }), {
    enabled: true,
    settings: [],
    go: { t: "Infinite" },
    synced: false,
  });
  tree = createTreeStore(undefined, defaultTree(beforeCheck));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Consumers() {
  const state = useStore(tree);
  return (
    <>
      <Accordion value="engine">
        <Accordion.Item value="engine">
          <BestMovesPanel
            id={0}
            engine={engine}
            fen={state.root.fen}
            moves={getVariationLine(state.root, state.position)}
            halfMoves={state.currentNode().halfMoves}
            dragHandleProps={{}}
            orientation="white"
          />
        </Accordion.Item>
      </Accordion>
      <div data-detached>
        <DetachedEval />
      </div>
    </>
  );
}

async function mount(view: "listener" | "consumers" | "both") {
  await act(async () => {
    await atoms.set(enginesAtom, [engine]);
    root.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <TreeStateContext.Provider value={tree}>
            {view !== "consumers" && <EvalListener />}
            {view !== "listener" && <Consumers />}
          </TreeStateContext.Provider>
        </MantineProvider>
      </Provider>,
    );
  });
  await flushRequest();
}

async function flushRequest() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

function position() {
  const state = tree.getState();
  const fen = state.root.fen;
  const moves = getVariationLine(state.root, state.position);
  const finalFen = state.currentNode().fen;
  return {
    fen,
    moves,
    finalFen,
    normalKey: `${fen}:${moves.join(",")}`,
    threatKey: `${swapMove(finalFen)}:`,
  };
}

function setupCheck(source: "root" | "moves") {
  if (source === "root") tree.getState().setFen(inCheck);
  else tree.getState().makeMoves({ payload: ["Re2+"] });
  expect(tree.getState().currentNode().fen).toBe(inCheck);
}

function seedBothCaches() {
  const { normalKey, threatKey } = position();
  atoms.set(
    cacheAtom,
    new Map([
      [normalKey, [normalLine]],
      [threatKey, [threatLine]],
    ]),
  );
}

function expectRequest(fen: string, moves: string[]) {
  expect(mocks.getBestMoves).toHaveBeenLastCalledWith(
    engine.id,
    engine.path,
    tab,
    { t: "Infinite" },
    { fen, moves, extraOptions: [] },
  );
  // Check the actual submitted root, not just our fixture. A swapped checked
  // position fails Chess.fromSetup with OppositeCheck.
  expect(positionFromFen(mocks.getBestMoves.mock.lastCall![4].fen)[1]).toBeNull();
}

function expectConsumers(line: BestMoves, threat: boolean) {
  const row = container.querySelector("[data-analysis-row]");
  expect(row).not.toBeNull();
  expect.soft(row!.textContent).toBe(line.sanMoves.join(" "));
  expect.soft(row!.getAttribute("data-threat")).toBe(String(threat));
  expect
    .soft(row!.getAttribute("data-fen"))
    .toBe(threat ? swapMove(position().finalFen) : position().finalFen);
  const detached = container.querySelector("[data-detached]")!;
  expect.soft(detached.textContent).toContain(line.sanMoves.join(" "));
  expect.soft(detached.textContent).toContain(threat ? "+9.99" : "+1.25");
}

async function emit(fen: string, moves: string[], line = normalLine) {
  expect(callbacks.size).toBe(1);
  await act(async () => {
    for (const callback of callbacks) {
      callback({
        payload: { engine: engine.id, tab, fen, moves, bestLines: [line], progress: 73 },
      });
    }
  });
}

it.each(["root", "moves"] as const)(
  "requests normal evaluation for %s check and removes stale swapped cache on an event",
  async (source) => {
    setupCheck(source);
    seedBothCaches();
    const { fen, moves, normalKey, threatKey } = position();
    await mount("listener");
    expectRequest(fen, moves);
    await emit(fen, moves);
    expect(atoms.get(cacheAtom).get(normalKey)).toEqual([normalLine]);
    expect(atoms.get(cacheAtom).has(threatKey)).toBe(false);
    expect(atoms.get(progressAtom)).toBe(73);
    expect(tree.getState().currentNode().score).toEqual(normalLine.score);
    expect(atoms.get(bestMovesFamily({ fen, gameMoves: moves })).get(0)?.[0].pv).toEqual(
      normalLine.uciMoves,
    );
    expect(atoms.get(currentThreatAtom)).toBe(true);
  },
);

const maiaError =
  "MAIA_OBJECTIVE_ANALYSIS_UNSUPPORTED: Maia scores are model-derived. Choose another analysis engine. Maia remains available as an opponent.";
const settingsAtom = tabEngineSettingsFamily({ engineId: engine.id, tab });

it("maia_score pauses only the current tab engine, clears transient data, and retries only on manual enable", async () => {
  const otherTabSettings = tabEngineSettingsFamily({ engineId: engine.id, tab: "other-tab" });
  const otherEngineSettings = tabEngineSettingsFamily({ engineId: "other-engine", tab });
  for (const atom of [otherTabSettings, otherEngineSettings]) {
    atoms.set(atom, { ...atoms.get(settingsAtom) });
  }
  const otherCache = engineMovesFamily({ engine: engine.id, tab: "other-tab" });
  atoms.set(otherCache, new Map([["untouched", [normalLine]]]));
  seedBothCaches();
  atoms.set(progressAtom, 63);
  tree.getState().setScore(normalLine.score);
  const savedRoot = tree.getState().root;
  mocks.getBestMoves.mockResolvedValue({ status: "error", error: maiaError });
  await mount("listener");
  expect(atoms.get(settingsAtom).enabled).toBe(false);
  expect(atoms.get(cacheAtom).size).toBe(0);
  expect(atoms.get(progressAtom)).toBe(0);
  expect(tree.getState().root).toBe(savedRoot);
  expect(await atoms.get(enginesAtom)).toEqual([engine]);
  expect(atoms.get(otherTabSettings).enabled).toBe(true);
  expect(atoms.get(otherEngineSettings).enabled).toBe(true);
  expect(atoms.get(otherCache).get("untouched")).toEqual([normalLine]);
  expect(notifications.show).toHaveBeenCalledTimes(1);
  expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: maiaError }));
  await act(async () => {
    tree.getState().makeMoves({ payload: ["Re2+"] });
    atoms.set(currentThreatAtom, false);
  });
  await flushRequest();
  expect(mocks.getBestMoves).toHaveBeenCalledTimes(1);
  expect(notifications.show).toHaveBeenCalledTimes(1);
  await act(async () => atoms.set(settingsAtom, (prev) => ({ ...prev, enabled: true })));
  await flushRequest();
  expect(mocks.getBestMoves).toHaveBeenCalledTimes(2);
  expect(atoms.get(settingsAtom).enabled).toBe(false);
  expect(notifications.show).toHaveBeenCalledTimes(2);
});

it.each(["ordinary failure", `Wrapped ${maiaError}`, "MAIA_OBJECTIVE_ANALYSIS_UNSUPPORTEDish"])(
  "maia_score handles non-prefix error without pausing or clearing: %s",
  async (error) => {
    seedBothCaches();
    atoms.set(progressAtom, 63);
    const cache = atoms.get(cacheAtom);
    mocks.getBestMoves.mockResolvedValue({ status: "error", error });
    await mount("listener");
    expect(atoms.get(settingsAtom).enabled).toBe(true);
    expect(atoms.get(cacheAtom)).toBe(cache);
    expect(atoms.get(progressAtom)).toBe(63);
    expect(notifications.show).toHaveBeenCalledTimes(1);
  },
);

it("maia_score catches thrown native failures without disabling the engine", async () => {
  mocks.getBestMoves.mockRejectedValue(new Error("native invocation failed"));
  await mount("listener");
  expect(atoms.get(settingsAtom).enabled).toBe(true);
});

it.each(["tab", "engine", "settings", "go", "position", "enabled"] as const)(
  "maia_score ignores stale rejection after %s changes, even before the next throttled request",
  async (change) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof commands.getBestMoves>>>();
    mocks.getBestMoves.mockReturnValueOnce(pending.promise);
    await mount("listener");
    await act(async () => {
      seedBothCaches();
      atoms.set(progressAtom, 63);
    });
    const cache = atoms.get(cacheAtom);
    const otherTab = "other-tab";
    const otherSettings = tabEngineSettingsFamily({ engineId: engine.id, tab: otherTab });
    atoms.set(otherSettings, { ...atoms.get(settingsAtom) });
    await act(async () => {
      if (change === "tab") atoms.set(activeTabAtom, otherTab);
      if (change === "engine")
        await atoms.set(enginesAtom, [{ ...engine, path: "/synthetic/replacement" }]);
      if (change === "settings")
        atoms.set(settingsAtom, (prev) => ({ ...prev, settings: [{ name: "Hash", value: 32 }] }));
      if (change === "go")
        atoms.set(settingsAtom, (prev) => ({ ...prev, go: { t: "Depth", c: 4 } }));
      if (change === "position") tree.getState().makeMoves({ payload: ["Re2+"] });
      if (change === "enabled") atoms.set(settingsAtom, (prev) => ({ ...prev, enabled: false }));
    });
    await act(async () => pending.resolve({ status: "error", error: maiaError }));
    expect(atoms.get(settingsAtom).enabled).toBe(change !== "enabled");
    expect(atoms.get(otherSettings).enabled).toBe(true);
    expect(atoms.get(cacheAtom)).toBe(cache);
    expect(atoms.get(progressAtom)).toBe(63);
  },
);

it("maia_score stale rejection cannot clear a newer successful request", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof commands.getBestMoves>>>();
  mocks.getBestMoves.mockReturnValueOnce(pending.promise);
  await mount("listener");
  mocks.getBestMoves.mockResolvedValue({ status: "ok", data: [82, [normalLine]] });
  await act(async () => atoms.set(settingsAtom, (prev) => ({ ...prev, go: { t: "Depth", c: 3 } })));
  await flushRequest();
  const cache = atoms.get(cacheAtom);
  expect(cache.get(position().threatKey)).toEqual([normalLine]);
  await act(async () => pending.resolve({ status: "error", error: maiaError }));
  expect(atoms.get(settingsAtom).enabled).toBe(true);
  expect(atoms.get(cacheAtom)).toBe(cache);
  expect(atoms.get(progressAtom)).toBe(82);
});

it.each(["tab", "engine", "settings"] as const)(
  "maia_score ignores a rejection in the same turn as a %s change before React commits",
  async (change) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof commands.getBestMoves>>>();
    mocks.getBestMoves.mockReturnValueOnce(pending.promise);
    await mount("listener");
    await act(async () => {
      seedBothCaches();
      atoms.set(progressAtom, 63);
    });
    const cache = atoms.get(cacheAtom);
    await act(async () => {
      if (change === "tab") atoms.set(activeTabAtom, "other-tab");
      if (change === "engine")
        void atoms.set(enginesAtom, [{ ...engine, path: "/synthetic/replacement" }]);
      if (change === "settings")
        atoms.set(settingsAtom, (prev) => ({ ...prev, settings: [{ name: "Hash", value: 64 }] }));
      pending.resolve({ status: "error", error: maiaError });
      await pending.promise;
    });
    expect(atoms.get(settingsAtom).enabled).toBe(true);
    expect(atoms.get(cacheAtom)).toBe(cache);
    expect(atoms.get(progressAtom)).toBe(63);
  },
);

it.each(["root", "moves"] as const)(
  "renders normal BestMoves and DetachedEval caches for %s check despite a stale threat entry",
  async (source) => {
    setupCheck(source);
    seedBothCaches();
    await mount("consumers");
    expectConsumers(normalLine, false);
    expect(atoms.get(currentThreatAtom)).toBe(true);
  },
);

it("keeps non-check threat analysis, falls back during check, and resumes threat after leaving check", async () => {
  seedBothCaches();
  await mount("both");
  expectRequest(swapMove(position().finalFen), []);
  expectConsumers(threatLine, true);
  await act(async () => {
    tree.getState().makeMoves({ payload: ["Re2+"] });
    seedBothCaches();
  });
  await flushRequest();
  expectRequest(beforeCheck, ["a2e2"]);
  expectConsumers(normalLine, false);
  await act(async () => {
    tree.getState().makeMoves({ payload: ["Kd7"] });
    seedBothCaches();
  });
  await flushRequest();
  expectRequest(swapMove(position().finalFen), []);
  expectConsumers(threatLine, true);
  expect(atoms.get(currentThreatAtom)).toBe(true);
  expect(mocks.getBestMoves).toHaveBeenCalledTimes(3);
});

it.each(["root", "history"] as const)(
  "refreshes event cleanup when %s changes but the threat request and final FEN stay the same",
  async (change) => {
    tree.getState().setFen(INITIAL_FEN);
    tree.getState().makeMoves({ payload: ["Nf3", "Nf6", "Ng1", "Ng8"] });
    const old = position();
    // Keep firstEngineWithLines stable so its dependency cannot mask the stale closure.
    const nextKey = change === "root" ? `${old.finalFen}:` : `${INITIAL_FEN}:b1c3,b8c6,c3b1,c6b8`;
    atoms.set(
      cacheAtom,
      new Map([
        [old.normalKey, [normalLine]],
        [nextKey, [normalLine]],
        [old.threatKey, [threatLine]],
      ]),
    );
    await mount("listener");
    await act(async () => {
      if (change === "root") tree.getState().setFen(old.finalFen);
      else {
        tree.getState().goToStart();
        tree.getState().makeMoves({ payload: ["Nc3", "Nc6", "Nb1", "Nb8"] });
      }
    });
    expect(position().normalKey).toBe(nextKey);
    expect(position().finalFen).toBe(old.finalFen);
    await emit(swapMove(old.finalFen), [], threatLine);
    expect(atoms.get(cacheAtom).has(nextKey)).toBe(false);
    expect(atoms.get(cacheAtom).get(old.normalKey)).toEqual([normalLine]);
    expect(atoms.get(cacheAtom).get(old.threatKey)).toEqual([threatLine]);
    expect(atoms.get(progressAtom)).toBe(73);
    expect(tree.getState().currentNode().score).toEqual(threatLine.score);
  },
);
