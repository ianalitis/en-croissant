import { Chessground as NativeChessground } from "@lichess-org/chessground";
import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Chess } from "chessops";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { createStore, Provider } from "jotai";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BoardAnalysis from "@/components/boards/BoardAnalysis";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  activeTabAtom,
  autoPromoteAtom,
  autoSaveAtom,
  currentEvalOpenAtom,
  currentInvisibleAtom,
  currentPracticeTabAtom,
  currentShowCommentsAtom,
  currentTabSelectedAtom,
  deckAtomFamily,
  eraseDrawablesOnClickAtom,
  practiceAutoDifficultyAtom,
  practiceSessionStatsAtom,
  practiceStateAtom,
  tabsAtom,
} from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import type { Tab } from "@/utils/tabs";
import { defaultTree } from "@/utils/treeReducer";

// Observe the real native board, without replacing its legal destination or move dispatch.
vi.mock("@lichess-org/chessground", async (importOriginal) => {
  const native = await importOriginal<typeof import("@lichess-org/chessground")>();
  return { ...native, Chessground: vi.fn<typeof NativeChessground>(native.Chessground) };
});
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn<typeof import("@tauri-apps/plugin-log").error>().mockResolvedValue(undefined),
  warn: vi.fn<typeof import("@tauri-apps/plugin-log").warn>().mockResolvedValue(undefined),
  info: vi.fn<typeof import("@tauri-apps/plugin-log").info>().mockResolvedValue(undefined),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn<typeof import("@/utils/sound").playSound>() }));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn<typeof notifications.show>() },
}));
vi.mock("@mantine/core", async (original) => ({
  ...(await original<typeof import("@mantine/core")>()),
  Portal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@tanstack/react-router", () => ({
  useLoaderData: () => ({ documentDir: "/synthetic" }),
}));
// Keep the real BoardAnalysis hotkeys, practice-tab wiring, Board and PracticePanel.
// Unrelated engine, notation and panel UI does not participate in these drills.
vi.mock("@/components/common/DetachedEval", () => ({ default: () => null }));
vi.mock("@/components/common/GameNotation", () => ({ default: () => null }));
vi.mock("@/components/common/MoveControls", () => ({ default: () => null }));
vi.mock("@/components/panels/analysis/AnalysisPanel", () => ({ default: () => null }));
vi.mock("@/components/panels/annotation/AnnotationPanel", () => ({ default: () => null }));
vi.mock("@/components/panels/database/DatabasePanel", () => ({ default: () => null }));
vi.mock("@/components/panels/info/InfoPanel", () => ({ default: () => null }));
vi.mock("@/components/boards/BoardControls", () => ({ default: () => null }));
vi.mock("@/components/boards/EditingCard", () => ({ default: () => null }));
vi.mock("@/components/boards/EvalListener", () => ({ default: () => null }));
vi.mock("@/components/panels/practice/RepertoireInfo", () => ({ default: () => null }));
vi.mock("@/components/databases/FideInfo", () => ({ default: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const fixtures = [
  {
    color: "white",
    fen: "8/6Pk/5K2/8/8/8/8/8 w - - 0 1",
    from: "g7",
    to: "g8",
    answer: "g8=Q+",
    wrong: "g8=B+",
  },
  {
    color: "black",
    fen: "8/8/8/8/8/5k2/6pK/8 b - - 0 1",
    from: "g2",
    to: "g1",
    answer: "g1=Q+",
    wrong: "g1=B+",
  },
] as const;
const native = vi.mocked(NativeChessground);
let renderer: Root;
let container: HTMLDivElement;
let atoms: ReturnType<typeof createStore>;
let tree: ReturnType<typeof createTreeStore>;
let deckAtom: ReturnType<typeof deckAtomFamily>;
let storageKey: string;
let id = 0;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn<MediaQueryList["addEventListener"]>(),
    removeEventListener: vi.fn<MediaQueryList["removeEventListener"]>(),
  }));
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
  atoms = createStore();
  atoms.set(autoPromoteAtom, false);
  atoms.set(autoSaveAtom, false);
  atoms.set(eraseDrawablesOnClickAtom, true);
  atoms.set(practiceAutoDifficultyAtom, "none");
  const file = `/synthetic/practice-root-${++id}.pgn`;
  const tab: Tab = {
    name: "Synthetic root practice",
    value: `practice-root-${id}`,
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        name: "root.pgn",
        path: file,
        numGames: 1,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
      },
    },
  };
  atoms.set(tabsAtom, [tab]);
  atoms.set(activeTabAtom, tab.value);
  atoms.set(currentTabSelectedAtom, "practice");
  atoms.set(currentPracticeTabAtom, "train");
  deckAtom = deckAtomFamily({ file, game: 0 });
  storageKey = `deck-${file}-0`;
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

function legalMove(fen: string, san: string) {
  const position = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  const move = parseSan(position, san);
  expect(move).toBeDefined();
  expect(position.isLegal(move!)).toBe(true);
  expect(makeSan(position, move!)).toBe(san);
  position.play(move!);
  return makeFen(position.toSetup());
}

async function mount(fen: string, answer: string, orientation?: "white" | "black") {
  legalMove(fen, answer);
  tree = createTreeStore(undefined, defaultTree(fen));
  tree.getState().makeMove({ payload: answer });
  if (orientation) tree.getState().setHeaders({ ...tree.getState().headers, orientation });
  // Begin at the leaf, so Start must navigate to the root rather than inheriting it.
  expect(tree.getState().position).toEqual([0]);
  await act(async () => {
    renderer.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <TreeStateContext.Provider value={tree}>
            <BoardAnalysis />
          </TreeStateContext.Provider>
        </MantineProvider>
      </Provider>,
    );
  });
}

async function clickButton(label: string) {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}

function board() {
  expect(native).toHaveBeenCalledTimes(1);
  return native.mock.results[0].value;
}

async function play(from: Key, to: Key) {
  const api = board();
  expect(api.state.movable.color).toBe(api.state.turnColor);
  expect(api.state.movable.dests?.get(from)).toContain(to);
  await act(async () => {
    api.selectSquare(from);
    api.selectSquare(to);
    await vi.advanceTimersByTimeAsync(1);
  });
}

for (const fixture of fixtures) {
  it.each([
    ["anki", "correct"],
    ["anki", "incorrect"],
    ["full", "correct"],
    ["full", "incorrect"],
  ] as const)(
    `${fixture.color} root: real Start, board and promotion handle %s %s practice`,
    async (mode, result) => {
      legalMove(fixture.fen, fixture.wrong);
      // Absent orientation remains White. Black must be explicitly selected, never inferred.
      await mount(fixture.fen, fixture.answer, fixture.color === "black" ? "black" : undefined);
      expect(tree.getState().root.halfMoves).toBe(fixture.color === "black" ? 1 : 0);
      const before = structuredClone(atoms.get(deckAtom));
      expect(before.positions).toHaveLength(1);
      expect(before.positions[0]).toMatchObject({
        fen: fixture.fen,
        answer: fixture.answer,
        card: { reps: 0 },
      });
      expect(before.logs).toEqual([]);
      const persistedBefore = localStorage.getItem(storageKey);
      await clickButton(
        mode === "full" ? "Board.Practice.PracticeFullRepertoire" : "Board.Practice.StartPractice",
      );
      expect(atoms.get(practiceStateAtom)).toEqual({ phase: "waiting", currentFen: fixture.fen });
      expect(tree.getState().position).toEqual([]);
      expect(tree.getState().practicePath).toEqual([]);
      expect(atoms.get(currentInvisibleAtom)).toBe(true);
      expect(atoms.get(currentShowCommentsAtom)).toBe(false);
      expect(atoms.get(currentEvalOpenAtom)).toBe(false);
      expect(board().state.orientation).toBe(fixture.color);
      expect(board().getFen()).toBe(fixture.fen.split(" ")[0]);
      await play(fixture.from, fixture.to);
      expect(atoms.get(practiceStateAtom).phase).toBe("waiting");
      expect(atoms.get(deckAtom)).toEqual(before);
      const role = result === "correct" ? "queen" : "bishop";
      const promotion = container
        .querySelector(`button .${fixture.color}.${role}`)
        ?.closest("button");
      expect(promotion).not.toBeNull();
      await act(async () => promotion!.click());
      expect(atoms.get(practiceStateAtom)).toMatchObject({
        phase: result,
        currentFen: fixture.fen,
        answer: fixture.answer,
        positionIndex: 0,
        ...(result === "incorrect" ? { playedMove: fixture.wrong } : {}),
      });
      const answered = atoms.get(practiceStateAtom);
      const expectedFen =
        result === "correct" ? legalMove(fixture.fen, fixture.answer) : fixture.fen;
      expect(tree.getState().currentNode().fen).toBe(expectedFen);
      expect(atoms.get(deckAtom).logs).toHaveLength(
        mode === "anki" && result === "incorrect" ? 1 : 0,
      );
      expect(
        vi.mocked(notifications.show).mock.calls.map(([notification]) => notification.color),
      ).toEqual(result === "incorrect" ? ["red"] : []);
      if (result === "correct") {
        if (mode === "anki") await clickButton("Board.Practice.Good");
        else await act(async () => vi.advanceTimersByTimeAsync(300));
      } else {
        await act(async () => vi.advanceTimersByTimeAsync(500));
      }
      // The existing practicePath guard blocks wrong-answer goToNext at the drill position.
      expect(tree.getState().currentNode().fen).toBe(expectedFen);
      expect(atoms.get(practiceStateAtom)).toEqual(
        result === "incorrect" ? answered : { phase: "idle" },
      );
      expect(atoms.get(practiceSessionStatsAtom)).toMatchObject({
        correct: result === "correct" ? 1 : 0,
        incorrect: result === "incorrect" ? 1 : 0,
      });
      if (mode === "full" && result === "incorrect")
        await clickButton("Board.Practice.NextPosition");
      const after = atoms.get(deckAtom);
      const expectedReview = {
        positions: [{ ...before.positions[0], card: expect.objectContaining({ reps: 1 }) }],
        logs: [expect.objectContaining({ fen: fixture.fen, rating: result === "correct" ? 3 : 1 })],
      };
      expect(after).toEqual(mode === "full" ? before : expectedReview);
      expect(
        JSON.stringify(after.positions[0].card) === JSON.stringify(before.positions[0].card),
      ).toBe(mode === "full");
      expect(localStorage.getItem(storageKey)).toBe(
        mode === "full" ? persistedBefore : JSON.stringify(after),
      );
      expect(atoms.get(practiceSessionStatsAtom).remainingPositions).toEqual([]);
      expect(atoms.get(practiceStateAtom).phase).toBe(
        mode === "anki" && result === "incorrect" ? "incorrect" : "idle",
      );
    },
  );
}

it("does not infer Black orientation from a black-to-move FEN", async () => {
  await mount(fixtures[1].fen, fixtures[1].answer);
  expect(tree.getState().headers.orientation).toBeUndefined();
  expect(atoms.get(deckAtom).positions).toEqual([]);
  expect(atoms.get(practiceStateAtom).phase).toBe("idle");
  expect(board().state.orientation).toBe("white");
});

it("starts an ordinary one-ply repertoire at its root and accepts the real e4 move", async () => {
  await mount(INITIAL_FEN, "e4");
  expect(atoms.get(deckAtom).positions).toHaveLength(1);
  await clickButton("Board.Practice.StartPractice");
  expect(tree.getState().practicePath).toEqual([]);
  await play("e2", "e4");
  expect(atoms.get(practiceStateAtom)).toMatchObject({
    phase: "correct",
    currentFen: INITIAL_FEN,
    answer: "e4",
    positionIndex: 0,
  });
  await clickButton("Board.Practice.Good");
  expect(atoms.get(deckAtom).logs[0]).toMatchObject({ fen: INITIAL_FEN, rating: 3 });
});

const shapeFixtures: { name: string; path: number[]; from: Key; to: Key }[] = [
  { name: "root", path: [], from: "e2", to: "e4" },
  { name: "nonroot", path: [0, 0], from: "g1", to: "f3" },
];

async function mountShapes(fixture: (typeof shapeFixtures)[number], dirty = false) {
  await mount(INITIAL_FEN, "e4");
  const shapes: DrawShape[] = [
    { orig: fixture.from, dest: fixture.to, brush: "green" },
    { orig: fixture.to, brush: "red" },
  ];
  await act(async () => {
    if (fixture.path.length) {
      tree.getState().makeMoves({ payload: ["e5", "Nf3"] });
      tree.getState().setStart([0]);
    }
    tree.getState().goToMove(fixture.path);
    tree.getState().setComment("Keep the saved answer annotations");
    for (const shape of shapes) tree.getState().setShapes([shape]);
    if (!dirty) tree.getState().save();
  });
  expect(atoms.get(deckAtom).positions).toHaveLength(1);
  expect(board().state.drawable.autoShapes).toEqual(shapes);
  expect(board().state.drawable.enabled).toBe(true);
  return shapes;
}

function savedState() {
  const { root, headers, dirty } = tree.getState();
  return { root, headers, dirty };
}

async function clearShapesHotkey() {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "l", ctrlKey: true, bubbles: true }),
    );
  });
}

async function clickBoard() {
  const element = container.querySelector<HTMLElement>("cg-board");
  expect(element).not.toBeNull();
  await act(async () => element!.click());
}

for (const fixture of shapeFixtures) {
  it.each([false, true])(
    `${fixture.name}: same-FEN Start hides native and saved shapes, protects dirty=%s, and Stop restores`,
    async (dirty) => {
      const shapes = await mountShapes(fixture, dirty);
      const before = structuredClone(savedState());
      const deckBefore = structuredClone(atoms.get(deckAtom));
      const persistedBefore = localStorage.getItem(storageKey);
      const fen = tree.getState().currentNode().fen;
      // Seed transient native marks too. Starting on the same FEN must remove them.
      board().setShapes(shapes.map((shape) => ({ ...shape })));
      expect(board().state.drawable.shapes).toEqual(shapes);
      await clickButton("Board.Practice.StartPractice");
      expect(tree.getState().practicePath).toEqual(fixture.path);
      expect(tree.getState().currentNode().fen).toBe(fen);
      expect(board().getFen()).toBe(fen.split(" ")[0]);
      expect.soft(board().state.drawable.autoShapes).toEqual([]);
      expect.soft(board().state.drawable.shapes).toEqual([]);
      expect.soft(board().state.drawable.enabled).toBe(false);
      expect.soft(savedState()).toEqual(before);

      // Even callbacks delivered despite disabled drawing must not toggle a saved
      // arrow/circle with the same endpoints, or clear the hidden originals.
      for (const change of [[shapes[0]], [shapes[1]], []]) {
        await act(async () => board().state.drawable.onChange!(change));
        expect.soft(savedState()).toEqual(before);
      }
      await clickBoard();
      expect.soft(savedState()).toEqual(before);
      // This dispatch exercises BoardAnalysis's real useHotkeys registration.
      await clearShapesHotkey();
      expect.soft(savedState()).toEqual(before);
      expect(atoms.get(deckAtom)).toEqual(deckBefore);
      expect(localStorage.getItem(storageKey)).toBe(persistedBefore);

      await clickButton("Common.Stop");
      expect(tree.getState().practicePath).toBeNull();
      expect(atoms.get(currentTabSelectedAtom)).toBe("practice");
      expect(atoms.get(currentPracticeTabAtom)).toBe("train");
      // Production still passes practicing=true after Stop, unlike the old harness.
      expect(board().state.drawable.enabled).toBe(true);
      expect(board().state.drawable.autoShapes).toEqual(shapes);
      expect(savedState()).toEqual(before);
      await clearShapesHotkey();
      expect(tree.getState().currentNode().shapes).toEqual([]);
      expect(tree.getState().dirty).toBe(true);
    },
  );

  it(`${fixture.name}: completion restores saved shapes and drawing`, async () => {
    const shapes = await mountShapes(fixture);
    const before = structuredClone(savedState());
    await clickButton("Board.Practice.StartPractice");
    expect.soft(board().state.drawable.autoShapes).toEqual([]);
    expect.soft(board().state.drawable.enabled).toBe(false);
    await play(fixture.from, fixture.to);
    expect(atoms.get(practiceStateAtom).phase).toBe("correct");
    // Rating is still part of the active drill, even at the answer node.
    expect.soft(board().state.drawable.enabled).toBe(false);
    await clickButton("Board.Practice.Good");
    expect(atoms.get(practiceStateAtom).phase).toBe("idle");
    expect(atoms.get(currentTabSelectedAtom)).toBe("practice");
    expect(atoms.get(currentPracticeTabAtom)).toBe("train");
    expect(tree.getState().practicePath).toBeNull();
    expect(board().state.drawable.enabled).toBe(true);
    // Completion advances to the answer. Revisit the unchanged annotated node.
    await act(async () => tree.getState().goToMove(fixture.path));
    expect(board().state.drawable.autoShapes).toEqual(shapes);
    expect(savedState()).toEqual(before);
    await act(async () => board().state.drawable.onChange!([shapes[0]]));
    expect(tree.getState().currentNode().shapes).toEqual([shapes[1]]);
    expect(tree.getState().dirty).toBe(true);
  });

  it.each(["build", "analysis"])(
    `${fixture.name}: %s restores saved shapes and drawing`,
    async (exit) => {
      const shapes = await mountShapes(fixture);
      const before = structuredClone(savedState());
      await clickButton("Board.Practice.StartPractice");
      expect.soft(board().state.drawable.autoShapes).toEqual([]);
      expect.soft(board().state.drawable.enabled).toBe(false);
      await clickButton(exit === "build" ? "Board.Practice.Build" : "Board.Tabs.Analysis");
      expect(tree.getState().practicePath).toBeNull();
      expect(board().state.drawable.enabled).toBe(true);
      await act(async () => tree.getState().goToMove(fixture.path));
      expect(board().state.drawable.autoShapes).toEqual(shapes);
      expect(savedState()).toEqual(before);
      await act(async () => board().state.drawable.onChange!([shapes[0]]));
      expect(tree.getState().currentNode().shapes).toEqual([shapes[1]]);
      expect(tree.getState().dirty).toBe(true);
    },
  );
}

it("ordinary analysis still adds/toggles shapes, accepts empty changes, and clears by click/hotkey", async () => {
  const shapes = await mountShapes(shapeFixtures[0]);
  await clickButton("Board.Tabs.Analysis");
  expect(board().state.drawable.enabled).toBe(true);
  await act(async () => board().state.drawable.onChange!([shapes[0]]));
  expect(tree.getState().currentNode().shapes).toEqual([shapes[1]]);
  await act(async () => board().state.drawable.onChange!([shapes[0]]));
  expect(tree.getState().currentNode().shapes).toEqual([shapes[1], shapes[0]]);
  await act(async () => board().state.drawable.onChange!([]));
  expect(tree.getState().currentNode().shapes).toEqual([]);
  await act(async () => board().state.drawable.onChange!([shapes[1]]));
  await clickBoard();
  expect(tree.getState().currentNode().shapes).toEqual([]);
  await act(async () => board().state.drawable.onChange!([shapes[0]]));
  await clearShapesHotkey();
  expect(tree.getState().currentNode().shapes).toEqual([]);
  expect(tree.getState().dirty).toBe(true);
});
