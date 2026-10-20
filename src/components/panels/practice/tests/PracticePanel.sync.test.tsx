import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import * as opening from "@/components/files/opening";
import PracticePanel from "@/components/panels/practice/PracticePanel";
import {
  activeTabAtom,
  currentEvalOpenAtom,
  currentInvisibleAtom,
  currentShowCommentsAtom,
  deckAtomFamily,
  type PracticeData,
  type PracticeState,
  practiceAutoDifficultyAtom,
  practiceSessionStatsAtom,
  practiceStateAtom,
  tabsAtom,
} from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import type { Tab } from "@/utils/tabs";
import { defaultTree, findFen, getNodeAtPath } from "@/utils/treeReducer";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/components/panels/practice/RepertoireInfo", () => ({ default: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let renderer: Root;
let container: HTMLDivElement;
let atoms: ReturnType<typeof createStore>;
let tree: ReturnType<typeof createTreeStore>;
let deckAtom: ReturnType<typeof deckAtomFamily>;
let syncSpy: MockInstance<typeof opening.syncDeck>;
let storageSpy: MockInstance<Storage["setItem"]>;
let storageKey: string;
let id = 0;

function seedDeck() {
  const { root, headers } = tree.getState();
  const positions = opening.buildFromTree(
    root,
    headers.orientation || "white",
    headers.start || [],
  );
  for (const [index, position] of positions.entries()) {
    position.card = {
      ...position.card,
      due: new Date("2026-10-01T00:00:00Z"),
      last_review: new Date("2026-09-26T00:00:00Z"),
      stability: 5 + index,
      difficulty: 4 + index,
      elapsed_days: 2,
      scheduled_days: 5,
      reps: 7 + index,
      lapses: 1,
      state: 2,
    };
  }
  const logs: PracticeData["logs"] = positions.map(({ fen, card }) => ({
    fen,
    rating: 3,
    state: 2,
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    last_elapsed_days: 1,
    scheduled_days: card.scheduled_days,
    review: new Date("2026-09-26T00:00:00Z"),
  }));
  atoms.set(deckAtom, { positions, logs });
  // Hydrate the persisted fixture through the real adapter before taking mount snapshots.
  const unsubscribe = atoms.sub(deckAtom, () => {});
  unsubscribe();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  // Only isolated jsdom storage is used, never native files or application data.
  localStorage.clear();
  sessionStorage.clear();
  atoms = createStore();
  tree = createTreeStore(undefined, defaultTree());
  tree.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6", "Bb5"] });
  tree.getState().goToMove([0, 0]);
  tree.getState().makeMoves({ payload: ["Bc4"] });
  tree.getState().goToMove([0, 0]);
  const file = `/synthetic/practice-metadata-${++id}.pgn`;
  const tab: Tab = {
    name: "Synthetic practice metadata",
    value: `practice-metadata-${id}`,
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        name: "synthetic.pgn",
        path: file,
        numGames: 1,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
      },
    },
  };
  atoms.set(tabsAtom, [tab]);
  atoms.set(activeTabAtom, tab.value);
  deckAtom = deckAtomFamily({ file, game: 0 });
  storageKey = `deck-${file}-0`;
  seedDeck();
  syncSpy = vi.spyOn(opening, "syncDeck");
  storageSpy = vi.spyOn(Storage.prototype, "setItem");
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    renderer.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <TreeStateContext.Provider value={tree}>
            <PracticePanel />
          </TreeStateContext.Provider>
        </MantineProvider>
      </Provider>,
    );
  });
}

function stored() {
  return JSON.parse(localStorage.getItem(storageKey)!);
}

function deckWrites() {
  return storageSpy.mock.calls.filter(([key]) => key === storageKey);
}

function expectPreserved(before: PracticeData) {
  const after = atoms.get(deckAtom);
  const surviving = before.positions.filter(({ fen }) =>
    after.positions.some((position) => position.fen === fen),
  );
  for (const previous of surviving) {
    const position = after.positions.find(({ fen }) => fen === previous.fen);
    expect(position?.card).toEqual(previous.card);
  }
  expect(after.logs).toEqual(before.logs);
  expect(stored()).toEqual(JSON.parse(JSON.stringify(after)));
  expect(stored().logs).toEqual(JSON.parse(JSON.stringify(before.logs)));
}

it("synchronizes a matching existing deck once on normal mount without rewriting storage", async () => {
  const root = tree.getState().root;
  const before = atoms.get(deckAtom);
  const persistedBefore = localStorage.getItem(storageKey);
  expect(before.positions).toHaveLength(2);
  await mount();
  expect(tree.getState().root).toBe(root);
  expect(syncSpy).toHaveBeenCalledExactlyOnceWith(before.positions, root, "white", []);
  expect(atoms.get(deckAtom).positions).toEqual(before.positions);
  expect(localStorage.getItem(storageKey)).toBe(persistedBefore);
  expect(deckWrites()).toHaveLength(0);
  expectPreserved(before);
});

it("initializes an empty deck normally from an unchanged root", async () => {
  atoms.set(deckAtom, { positions: [], logs: [] });
  storageSpy.mockClear();
  const root = tree.getState().root;
  const expected = opening.buildFromTree(root, "white", []);
  await mount();
  expect(tree.getState().root).toBe(root);
  expect(atoms.get(deckAtom)).toEqual({ positions: expected, logs: [] });
  expect(stored()).toEqual(JSON.parse(JSON.stringify({ positions: expected, logs: [] })));
  expect(deckWrites()).toHaveLength(1);
  expect(syncSpy).not.toHaveBeenCalled();
});

it("publishes orientation-only setHeaders changes to the deck and storage without changing the root or logs", async () => {
  await mount();
  const root = tree.getState().root;
  const before = atoms.get(deckAtom);
  const expected = opening.buildFromTree(root, "black", []);
  expect(expected.map(({ answer }) => answer)).toEqual(["e5", "Nc6"]);
  syncSpy.mockClear();
  storageSpy.mockClear();
  await act(async () => {
    tree.getState().setHeaders({ ...tree.getState().headers, orientation: "black" });
  });
  expect(tree.getState().root).toBe(root);
  expect(atoms.get(deckAtom).positions).toEqual(expected);
  expect(syncSpy).toHaveBeenCalledExactlyOnceWith(before.positions, root, "black", []);
  expect(deckWrites()).toHaveLength(1);
  expectPreserved(before);
});

it("publishes setStart changes using the existing excluded-start semantics and preserves surviving schedules and logs", async () => {
  await mount();
  const root = tree.getState().root;
  const before = atoms.get(deckAtom);
  const start = [0, 0];
  const selectedFen = getNodeAtPath(root, start).fen;
  const survivingFen = getNodeAtPath(root, [0, 0, 0, 0]).fen;
  // Characterize the current helper boundary, not a request to include the start node.
  expect(opening.buildFromTree(root, "white", start).map(({ fen }) => fen)).toEqual([survivingFen]);
  expect(before.positions.map(({ fen }) => fen)).toEqual([selectedFen, survivingFen]);
  syncSpy.mockClear();
  storageSpy.mockClear();
  await act(async () => tree.getState().setStart(start));
  expect(tree.getState().root).toBe(root);
  expect(atoms.get(deckAtom).positions).toEqual([before.positions[1]]);
  expect(syncSpy).toHaveBeenCalledExactlyOnceWith(before.positions, root, "white", start);
  expect(deckWrites()).toHaveLength(1);
  expectPreserved(before);

  const narrowed = atoms.get(deckAtom);
  await act(async () => tree.getState().setStart([]));
  expect(tree.getState().root).toBe(root);
  expect(atoms.get(deckAtom).positions.map(({ fen }) => fen)).toEqual([selectedFen, survivingFen]);
  expect(syncSpy).toHaveBeenCalledTimes(2);
  expect(deckWrites()).toHaveLength(2);
  expectPreserved(narrowed);
});

it("preserves historical logs when a start change empties the deck and restoring start initializes cards again", async () => {
  await mount();
  const root = tree.getState().root;
  const before = atoms.get(deckAtom);
  const start = [0, 0, 0, 0];
  expect(before.logs).toHaveLength(2);
  expect(opening.buildFromTree(root, "white", start)).toEqual([]);
  syncSpy.mockClear();
  storageSpy.mockClear();
  await act(async () => tree.getState().setStart(start));
  expect(tree.getState().root).toBe(root);
  expect(atoms.get(deckAtom).positions).toEqual([]);
  expectPreserved(before);
  await act(async () => tree.getState().setStart([]));
  expect(tree.getState().root).toBe(root);
  expect(atoms.get(deckAtom).positions).toEqual(opening.buildFromTree(root, "white", []));
  // No cards survive the empty intermediate deck. Historical reviews must still survive.
  expect(atoms.get(deckAtom).logs).toEqual(before.logs);
  expect(stored()).toEqual(JSON.parse(JSON.stringify(atoms.get(deckAtom))));
  expect(stored().logs).toEqual(JSON.parse(JSON.stringify(before.logs)));
  expect(syncSpy).toHaveBeenCalledTimes(1);
  expect(deckWrites()).toHaveLength(2);
});

it("does not resynchronize or write for equivalent default values or unrelated headers", async () => {
  await mount();
  const root = tree.getState().root;
  const before = atoms.get(deckAtom);
  const persistedBefore = localStorage.getItem(storageKey);
  syncSpy.mockClear();
  storageSpy.mockClear();
  await act(async () => {
    tree.getState().setHeaders({ ...tree.getState().headers, orientation: "white", start: [] });
  });
  await act(async () => tree.getState().setStart([]));
  await act(async () => {
    tree.getState().setHeaders({ ...tree.getState().headers, event: "Changed event" });
  });
  await act(async () => {
    tree
      .getState()
      .setHeaders({ ...tree.getState().headers, orientation: undefined, start: undefined });
  });
  expect(tree.getState().root).toBe(root);
  expect(atoms.get(deckAtom)).toBe(before);
  expect(localStorage.getItem(storageKey)).toBe(persistedBefore);
  expect(syncSpy).not.toHaveBeenCalled();
  expect(deckWrites()).toHaveLength(0);
});

it("does not resynchronize or write for equal explicit orientation and nonempty start paths", async () => {
  tree.getState().setHeaders({ ...tree.getState().headers, orientation: "black", start: [0] });
  seedDeck();
  await mount();
  const root = tree.getState().root;
  const before = atoms.get(deckAtom);
  const persistedBefore = localStorage.getItem(storageKey);
  syncSpy.mockClear();
  storageSpy.mockClear();
  await act(async () => {
    tree.getState().setHeaders({ ...tree.getState().headers, orientation: "black", start: [0] });
  });
  await act(async () => tree.getState().setStart([0]));
  await act(async () => {
    tree.getState().setHeaders({ ...tree.getState().headers, event: "Another event" });
  });
  expect(tree.getState().root).toBe(root);
  expect(atoms.get(deckAtom)).toBe(before);
  expect(localStorage.getItem(storageKey)).toBe(persistedBefore);
  expect(syncSpy).not.toHaveBeenCalled();
  expect(deckWrites()).toHaveLength(0);
  expectPreserved(before);
});

async function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

async function pressKey(key: string, code: string) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true }));
  });
}

async function advance(milliseconds: number) {
  await act(async () => vi.advanceTimersByTime(milliseconds));
}

// Board is not mounted. Seed exactly its selection fields, using the real tree move
// action for correct answers. Rating buttons, hotkeys and timers are not mocked.
async function selectPosition(phase: PracticeState["phase"], positionIndex = 0) {
  const position = atoms.get(deckAtom).positions[positionIndex];
  const path = findFen(position.fen, tree.getState().root);
  await act(async () => {
    tree.getState().goToMove(path);
    tree.getState().setPracticePath(path);
    atoms.set(currentInvisibleAtom, true);
    atoms.set(currentShowCommentsAtom, false);
    atoms.set(currentEvalOpenAtom, false);
    if (phase === "correct") tree.getState().makeMove({ payload: position.answer });
    atoms.set(practiceStateAtom, {
      phase,
      currentFen: position.fen,
      answer: position.answer,
      positionIndex,
      timeTaken: 1200,
      ...(phase === "incorrect" ? { playedMove: "d4" } : {}),
    });
  });
}

function stoppedSnapshot() {
  return {
    state: atoms.get(practiceStateAtom),
    session: atoms.get(practiceSessionStatsAtom),
    path: tree.getState().practicePath,
    invisible: atoms.get(currentInvisibleAtom),
    comments: atoms.get(currentShowCommentsAtom),
    evaluation: atoms.get(currentEvalOpenAtom),
  };
}

const stopped = {
  state: { phase: "idle" },
  session: {
    mode: "anki",
    remainingPositions: [],
    correct: 0,
    incorrect: 0,
    streak: 0,
    bestStreak: 0,
  },
  path: null,
  invisible: false,
  comments: true,
  evaluation: true,
};

async function flipOrientation() {
  await act(async () => {
    tree.getState().setHeaders({ ...tree.getState().headers, orientation: "black" });
  });
}

it("stops a correct selection before publishing an orientation replacement and ignores its rating hotkey", async () => {
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  await selectPosition("correct");
  expect(atoms.get(practiceStateAtom).answer).toBe("Nf3");
  const publications: ReturnType<typeof stoppedSnapshot>[] = [];
  const unsubscribe = atoms.sub(deckAtom, () => publications.push(stoppedSnapshot()));
  await flipOrientation();
  unsubscribe();
  expect(atoms.get(deckAtom).positions[0].answer).toBe("e5");
  await pressKey("3", "Digit3");
  // The rejected candidate appends a review of Black's e5 for White's Nf3.
  expectPreserved(before);
  expect(publications).toEqual([stopped]);
  expect(stoppedSnapshot()).toEqual(stopped);
  expect(container.textContent).not.toContain("Board.Practice.HowDifficult");
});

it("stops a correct selection before a start change shifts index one to zero", async () => {
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  await selectPosition("correct", 1);
  expect(atoms.get(practiceStateAtom).answer).toBe("Bb5");
  const publications: ReturnType<typeof stoppedSnapshot>[] = [];
  const unsubscribe = atoms.sub(deckAtom, () => publications.push(stoppedSnapshot()));
  await act(async () => tree.getState().setStart([0, 0]));
  unsubscribe();
  expect(atoms.get(deckAtom).positions).toEqual([before.positions[1]]);
  expect(publications).toEqual([stopped]);
  await pressKey("3", "Digit3");
  expectPreserved(before);
  expect(stoppedSnapshot()).toEqual(stopped);
});

it("cancels pending automatic rating when orientation changes at 299ms", async () => {
  atoms.set(practiceAutoDifficultyAtom, "3");
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  await selectPosition("correct");
  await advance(299);
  expect(atoms.get(deckAtom).logs).toEqual(before.logs);
  await flipOrientation();
  await advance(1);
  await advance(300);
  expectPreserved(before);
  expect(stoppedSnapshot()).toEqual(stopped);
});

it("cancels pending full-mode advance and clears the entire remaining queue", async () => {
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  await clickButton("Board.Practice.PracticeFullRepertoire");
  expect(atoms.get(practiceSessionStatsAtom).remainingPositions).toEqual([0, 1]);
  await selectPosition("correct");
  await advance(299);
  await flipOrientation();
  await advance(1);
  await advance(300);
  expect(stoppedSnapshot()).toEqual(stopped);
  expectPreserved(before);
});

it.each([
  ["waiting", "orientation"],
  ["waiting", "start"],
  ["incorrect", "orientation"],
  ["incorrect", "start"],
] as const)("stops %s practice for an effective %s change", async (phase, change) => {
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  await clickButton("Board.Practice.PracticeFullRepertoire");
  await selectPosition(phase);
  if (change === "orientation") await flipOrientation();
  else await act(async () => tree.getState().setStart([0, 0]));
  await pressKey(" ", "Space");
  await advance(1000);
  expect(stoppedSnapshot()).toEqual(stopped);
  expectPreserved(before);
});

it("keeps a correct session for equivalent defaults and unrelated headers, then rates through the hotkey", async () => {
  await mount();
  await selectPosition("correct");
  const selected = stoppedSnapshot();
  const before = structuredClone(atoms.get(deckAtom));
  syncSpy.mockClear();
  storageSpy.mockClear();
  await act(async () => {
    tree.getState().setHeaders({ ...tree.getState().headers, orientation: "white", start: [] });
  });
  await act(async () => tree.getState().setStart([]));
  await act(async () => {
    tree.getState().setHeaders({ ...tree.getState().headers, event: "Unrelated event" });
  });
  await act(async () => {
    tree
      .getState()
      .setHeaders({ ...tree.getState().headers, orientation: undefined, start: undefined });
  });
  expect(stoppedSnapshot()).toEqual(selected);
  expect(syncSpy).not.toHaveBeenCalled();
  expect(deckWrites()).toHaveLength(0);
  await pressKey("3", "Digit3");
  expect(atoms.get(deckAtom).logs).toHaveLength(before.logs.length + 1);
  expect(atoms.get(deckAtom).logs.at(-1)).toMatchObject({
    fen: before.positions[0].fen,
    rating: 3,
  });
  expect(atoms.get(practiceSessionStatsAtom).correct).toBe(1);
});

it("keeps pending automatic rating for equal explicit orientation and nonempty start paths", async () => {
  tree.getState().setHeaders({ ...tree.getState().headers, orientation: "black", start: [0] });
  seedDeck();
  atoms.set(practiceAutoDifficultyAtom, "3");
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  await selectPosition("correct");
  const selected = stoppedSnapshot();
  await advance(299);
  syncSpy.mockClear();
  await act(async () => tree.getState().setStart([0]));
  await act(async () => {
    tree.getState().setHeaders({
      ...tree.getState().headers,
      orientation: "black",
      start: [0],
      event: "Another event",
    });
  });
  expect(stoppedSnapshot()).toEqual(selected);
  expect(syncSpy).not.toHaveBeenCalled();
  await advance(1);
  expect(atoms.get(deckAtom).logs).toHaveLength(before.logs.length + 1);
  expect(atoms.get(deckAtom).logs.at(-1)).toMatchObject({
    fen: before.positions[0].fen,
    rating: 3,
  });
});

it("does not stop for a root-only change caused by a real correct move", async () => {
  // A persisted legal answer absent from the tree exercises the existing answer-only
  // sync behavior without fixing it. Playing that answer really adds a tree node.
  atoms.set(deckAtom, (previous) => ({
    ...previous,
    positions: previous.positions.map((position, index) =>
      index === 0 ? { ...position, answer: "d4" } : position,
    ),
  }));
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  const root = JSON.stringify(tree.getState().root);
  const headers = tree.getState().headers;
  syncSpy.mockClear();
  await selectPosition("correct");
  expect(JSON.stringify(tree.getState().root)).not.toBe(root);
  expect(tree.getState().headers).toBe(headers);
  expect(syncSpy).toHaveBeenCalledTimes(1);
  expect(atoms.get(practiceStateAtom)).toMatchObject({
    phase: "correct",
    answer: "d4",
    positionIndex: 0,
  });
  expect(tree.getState().practicePath).toEqual([0, 0]);
  await clickButton("Board.Practice.Good");
  expect(atoms.get(deckAtom).logs).toHaveLength(before.logs.length + 1);
  expect(atoms.get(deckAtom).logs.at(-1)).toMatchObject({
    fen: before.positions[0].fen,
    rating: 3,
  });
});

it("still rates an uninvalidated correct card through the manual button", async () => {
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  await selectPosition("correct", 1);
  await clickButton("Board.Practice.Good");
  const after = atoms.get(deckAtom);
  expect(after.logs.slice(0, before.logs.length)).toEqual(before.logs);
  expect(after.logs).toHaveLength(before.logs.length + 1);
  expect(after.logs.at(-1)).toMatchObject({ fen: before.positions[1].fen, rating: 3 });
  expect(after.positions[1].card.reps).toBe(before.positions[1].card.reps + 1);
  expect(atoms.get(practiceSessionStatsAtom).correct).toBe(1);
  expect(stored()).toEqual(JSON.parse(JSON.stringify(after)));
});

it("still rates an uninvalidated correct card automatically at 300ms", async () => {
  atoms.set(practiceAutoDifficultyAtom, "3");
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  await selectPosition("correct", 1);
  await advance(299);
  expect(atoms.get(deckAtom).logs).toEqual(before.logs);
  await advance(1);
  const after = atoms.get(deckAtom);
  expect(after.logs.slice(0, before.logs.length)).toEqual(before.logs);
  expect(after.logs).toHaveLength(before.logs.length + 1);
  expect(after.logs.at(-1)).toMatchObject({ fen: before.positions[1].fen, rating: 3 });
  expect(after.positions[1].card.reps).toBe(before.positions[1].card.reps + 1);
  expect(atoms.get(practiceSessionStatsAtom).correct).toBe(1);
  expect(stored()).toEqual(JSON.parse(JSON.stringify(after)));
});

it("preserves the existing Stop button semantics without resetting deck history", async () => {
  await mount();
  const before = atoms.get(deckAtom);
  await clickButton("Board.Practice.PracticeFullRepertoire");
  await clickButton("Common.Stop");
  expect(stoppedSnapshot()).toEqual(stopped);
  expect(atoms.get(deckAtom)).toBe(before);
  expectPreserved(before);
});

it("stops for an effective start change even when deck membership is unchanged", async () => {
  await mount();
  const before = structuredClone(atoms.get(deckAtom));
  await selectPosition("correct");
  storageSpy.mockClear();
  await act(async () => tree.getState().setStart([0]));
  expect(atoms.get(deckAtom)).toEqual(before);
  expect(deckWrites()).toHaveLength(0);
  expect(stoppedSnapshot()).toEqual(stopped);
  await pressKey("3", "Digit3");
  expectPreserved(before);
});

it.each(["anki", "full"] as const)(
  "cancels the %s timer rescheduled by a simultaneous root and metadata change",
  async (mode) => {
    atoms.set(practiceAutoDifficultyAtom, "3");
    await mount();
    const before = structuredClone(atoms.get(deckAtom));
    if (mode === "full") await clickButton("Board.Practice.PracticeFullRepertoire");
    await selectPosition("correct");
    await advance(299);
    const root = tree.getState().root;
    const publications: ReturnType<typeof stoppedSnapshot>[] = [];
    const unsubscribe = atoms.sub(deckAtom, () => publications.push(stoppedSnapshot()));
    await act(async () => {
      tree.getState().makeMove({ payload: "a6" });
      tree.getState().setHeaders({ ...tree.getState().headers, orientation: "black" });
    });
    unsubscribe();
    expect(tree.getState().root).not.toBe(root);
    expect(publications).toEqual([stopped]);
    await advance(1000);
    expect(stoppedSnapshot()).toEqual(stopped);
    expectPreserved(before);
  },
);
