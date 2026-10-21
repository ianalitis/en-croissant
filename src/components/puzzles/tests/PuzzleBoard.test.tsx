import { Chessground as NativeChessground } from "@lichess-org/chessground";
import type { Key } from "@lichess-org/chessground/types";
import { MantineProvider } from "@mantine/core";
import { Chess, makeUci, parseUci } from "chessops";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { createStore, Provider } from "jotai";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { jumpToNextPuzzleAtom } from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import type { Completion, Puzzle } from "@/utils/puzzles";
import { defaultTree, treeIteratorMainLine } from "@/utils/treeReducer";
import PuzzleBoard from "../PuzzleBoard";

// Observe, but do not replace, native selection and move dispatch. Chessops,
// PuzzleBoard, PromotionModal and the tree store all execute their real logic.
vi.mock("@lichess-org/chessground", async (importOriginal) => {
  const native = await importOriginal<typeof import("@lichess-org/chessground")>();
  return { ...native, Chessground: vi.fn<typeof NativeChessground>(native.Chessground) };
});
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn<typeof import("@tauri-apps/plugin-log").error>().mockResolvedValue(undefined),
  warn: vi.fn<typeof import("@tauri-apps/plugin-log").warn>().mockResolvedValue(undefined),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn<typeof import("@/utils/sound").playSound>() }));

const matePuzzle: Puzzle = {
  id: 1,
  fen: "8/5K1k/8/6Q1/8/8/8/8 b - - 0 1",
  moves: ["h7h8", "g5g7"],
  rating: 1000,
  rating_deviation: 0,
  popularity: 0,
  nb_plays: 0,
  completion: "incomplete",
};
const nextPuzzle: Puzzle = {
  ...matePuzzle,
  id: 2,
  fen: INITIAL_FEN,
  moves: ["e2e4", "e7e5"],
};
const native = vi.mocked(NativeChessground);
const changeCompletion = vi.fn<(completion: Completion) => void>();
const generatePuzzle = vi.fn<(db: string) => void>();
let root: Root;
let container: HTMLDivElement;
let atoms: ReturnType<typeof createStore>;
let tree: ReturnType<typeof createTreeStore>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
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
  atoms.set(jumpToNextPuzzleAtom, false);
  tree = createTreeStore(undefined, defaultTree());
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

function seedPuzzle(puzzle: Puzzle) {
  // Match Puzzles.setPuzzle: the first move belongs to the opponent.
  tree.getState().setFen(puzzle.fen);
  tree.getState().makeMove({ payload: parseUci(puzzle.moves[0])! });
}

async function mount(puzzle = matePuzzle, db: string | null = "synthetic-puzzles.db3") {
  seedPuzzle(puzzle);
  function Harness() {
    const [puzzles, setPuzzles] = useState([puzzle]);
    const [currentPuzzle, setCurrentPuzzle] = useState(0);
    return (
      <>
        <output>{puzzles.map((p) => p.completion).join(",")}</output>
        <PuzzleBoard
          key={currentPuzzle}
          puzzles={puzzles}
          currentPuzzle={currentPuzzle}
          db={db}
          changeCompletion={async (completion) => {
            changeCompletion(completion);
            setPuzzles((previous) =>
              previous.map((p, index) => (index === currentPuzzle ? { ...p, completion } : p)),
            );
          }}
          generatePuzzle={async (database) => {
            generatePuzzle(database);
            // The real parent replaces the board, it does not retain the old solution.
            setPuzzles((previous) => [...previous, nextPuzzle]);
            setCurrentPuzzle(puzzles.length);
            seedPuzzle(nextPuzzle);
          }}
        />
      </>
    );
  }
  await act(async () => {
    root.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <TreeStateContext.Provider value={tree}>
            <Harness />
          </TreeStateContext.Provider>
        </MantineProvider>
      </Provider>,
    );
  });
}

function board() {
  expect(native).toHaveBeenCalled();
  return native.mock.results.at(-1)!.value;
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

function expectLine(fen: string, moves: string[]) {
  const state = tree.getState();
  const line = [...treeIteratorMainLine(state.root)].slice(1);
  expect(line.map(({ node }) => makeUci(node.move!))).toEqual(moves);
  expect(state.position).toEqual(moves.map(() => 0));
  const expected = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  for (const uci of moves) {
    const move = parseUci(uci)!;
    expect(expected.isLegal(move)).toBe(true);
    expected.play(move);
  }
  expect(state.currentNode().fen).toBe(makeFen(expected.toSetup()));
  expect(board().getFen()).toBe(state.currentNode().fen.split(" ")[0]);
  expect(state.headers.result).toBe("*");
  return expected;
}

it.each([
  ["canonical", "g7", "g5g7", "7k/5KQ1/8/8/8/8/8/8 b - - 2 2"],
  ["alternative", "h6", "g5h6", "7k/5K2/7Q/8/8/8/8/8 b - - 2 2"],
] as const)(
  "retains the actual %s final mate in the mainline and current FEN",
  async (_, to, uci, fen) => {
    await mount();
    await play("g5", to);
    expect(changeCompletion).toHaveBeenCalledExactlyOnceWith("correct");
    expect(container.querySelector("output")?.textContent).toBe("correct");
    expect(tree.getState().currentNode().fen).toBe(fen);
    expect(expectLine(matePuzzle.fen, ["h7h8", uci]).isCheckmate()).toBe(true);
    expect(generatePuzzle).not.toHaveBeenCalled();
    expect(matePuzzle.moves).toEqual(["h7h8", "g5g7"]);
  },
);

it("continues a canonical player move with the opponent reply before completing the final move", async () => {
  const puzzle = { ...nextPuzzle, moves: ["e2e4", "e7e5", "g1f3", "b8c6"] };
  await mount(puzzle);
  await play("e7", "e5");
  expectLine(INITIAL_FEN, puzzle.moves.slice(0, 3));
  expect(changeCompletion).not.toHaveBeenCalled();
  expect(container.querySelector("output")?.textContent).toBe("incomplete");
  await play("b8", "c6");
  expectLine(INITIAL_FEN, puzzle.moves);
  expect(changeCompletion).toHaveBeenCalledExactlyOnceWith("correct");
});

it.each([
  ["queen", "f7f8q"],
  ["rook", "f7f8r"],
] as const)(
  "retains the selected %s promotion mate through the real promotion modal",
  async (role, uci) => {
    const puzzle = {
      ...matePuzzle,
      fen: "6k1/5P2/6K1/8/8/8/8/8 b - - 0 1",
      moves: ["g8h8", "f7f8q"],
    };
    await mount(puzzle);
    const before = tree.getState().currentNode().fen;
    await play("f7", "f8");
    expect(changeCompletion).not.toHaveBeenCalled();
    expect(tree.getState().currentNode().fen).toBe(before);
    const button = container.querySelector(`.white.${role}`)?.closest("button");
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(changeCompletion).toHaveBeenCalledExactlyOnceWith("correct");
    expect(expectLine(puzzle.fen, ["g8h8", uci]).isCheckmate()).toBe(true);
    expect(tree.getState().currentNode().move).toMatchObject({ promotion: role });
    expect(container.querySelectorAll("button")).toHaveLength(0);
  },
);

it("retains an alternative final mate without changing prior incorrect completion or losing the wrong attempt", async () => {
  await mount();
  const before = tree.getState().currentNode().fen;
  await play("g5", "g4");
  expect(changeCompletion).toHaveBeenCalledExactlyOnceWith("incorrect");
  expect(tree.getState().currentNode().fen).toBe(before);
  expect(tree.getState().position).toEqual([0]);
  const wrongAttempt = tree.getState().currentNode().children[0];
  expect(makeUci(wrongAttempt.move!)).toBe("g5g4");
  await play("g5", "h6");
  expect(changeCompletion).toHaveBeenCalledExactlyOnceWith("incorrect");
  expect(container.querySelector("output")?.textContent).toBe("incorrect");
  expect(expectLine(matePuzzle.fen, ["h7h8", "g5h6"]).isCheckmate()).toBe(true);
  expect(tree.getState().root.children[0].children[1]).toEqual(wrongAttempt);
  expect(generatePuzzle).not.toHaveBeenCalled();
});

it.each(["g7", "h6"] as const)(
  "lets auto-next replace the board after final mate on %s",
  async (to) => {
    atoms.set(jumpToNextPuzzleAtom, true);
    await mount();
    const oldBoard = board();
    const destroyOldBoard = vi.spyOn(oldBoard, "destroy");
    await play("g5", to);
    expect(native).toHaveBeenCalledTimes(2);
    expect(board()).not.toBe(oldBoard);
    expect(destroyOldBoard).toHaveBeenCalledExactlyOnceWith();
    expect(oldBoard.state.dom.destroyed).toBe(true);
    expect(board().state.dom.destroyed).not.toBe(true);
    expect(changeCompletion).toHaveBeenCalledExactlyOnceWith("correct");
    expect(generatePuzzle).toHaveBeenCalledExactlyOnceWith("synthetic-puzzles.db3");
    expect(container.querySelector("output")?.textContent).toBe("correct,incomplete");
    expect(tree.getState().root.fen).toBe(INITIAL_FEN);
    expectLine(INITIAL_FEN, ["e2e4"]);
    const nextBoard = board();
    const destroyNextBoard = vi.spyOn(nextBoard, "destroy");
    await play("e7", "e5");
    expect(native).toHaveBeenCalledTimes(3);
    expect(board()).not.toBe(nextBoard);
    expect(destroyOldBoard).toHaveBeenCalledTimes(1);
    expect(destroyNextBoard).toHaveBeenCalledExactlyOnceWith();
    expect(nextBoard.state.dom.destroyed).toBe(true);
    expect(board().state.dom.destroyed).not.toBe(true);
    expect(changeCompletion).toHaveBeenCalledTimes(2);
    expect(generatePuzzle).toHaveBeenCalledTimes(2);
  },
);

it("retains an alternative mate with auto-next enabled but no database", async () => {
  atoms.set(jumpToNextPuzzleAtom, true);
  await mount(matePuzzle, null);
  await play("g5", "h6");
  expect(expectLine(matePuzzle.fen, ["h7h8", "g5h6"]).isCheckmate()).toBe(true);
  expect(changeCompletion).toHaveBeenCalledExactlyOnceWith("correct");
  expect(generatePuzzle).not.toHaveBeenCalled();
});

it("does not change the existing earlier-than-final mate continuation policy", async () => {
  const puzzle = { ...matePuzzle, moves: ["h7h8", "g5g4", "h8h7", "g4g7"] };
  await mount(puzzle);
  await play("g5", "h6");
  // This existing behavior is deliberately outside the final-move fix's scope.
  expectLine(puzzle.fen, puzzle.moves.slice(0, 3));
  expect(changeCompletion).not.toHaveBeenCalled();
  expect(generatePuzzle).not.toHaveBeenCalled();
  expect(container.querySelector("output")?.textContent).toBe("incomplete");
});
