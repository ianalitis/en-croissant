import { Chessground as NativeChessground } from "@lichess-org/chessground";
import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { MantineProvider } from "@mantine/core";
import { Chess, makeUci, parseUci } from "chessops";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  activeTabAtom,
  currentPuzzleAtom,
  jumpToNextPuzzleAtom,
  selectedPuzzleDbAtom,
  tabsAtom,
  trackPuzzleTimeAtom,
} from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import type { Puzzle } from "@/utils/puzzles";
import { defaultTree, treeIteratorMainLine } from "@/utils/treeReducer";
import Puzzles from "../Puzzles";

// Keep the parent, controls, session storage, board and tree real. Only native
// I/O and browser layout are stubbed; the Chessground spy delegates to native.
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
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/puzzles", () => ({
  getPuzzleDatabases: vi
    .fn<typeof import("@/utils/puzzles").getPuzzleDatabases>()
    .mockResolvedValue([]),
}));
vi.mock("@/utils/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/db")>()),
  getDefaultPuzzleDatabases: vi
    .fn<typeof import("@/utils/db").getDefaultPuzzleDatabases>()
    .mockResolvedValue([]),
}));
vi.mock("@/utils/chess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/chess")>()),
  getOpening: vi.fn<typeof import("@/utils/chess").getOpening>().mockResolvedValue(""),
}));

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
const earlyMatePuzzle: Puzzle = {
  ...matePuzzle,
  moves: ["h7h8", "g5g4", "h8h7", "g4g7"],
};
const native = vi.mocked(NativeChessground);
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
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
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn<HTMLElement["scrollTo"]>(),
  });
  vi.spyOn(commands, "getPuzzleThemes").mockResolvedValue({ status: "ok", data: [] });
  vi.spyOn(commands, "getThemesForPuzzle").mockResolvedValue({ status: "ok", data: [] });
  localStorage.clear();
  sessionStorage.clear();
  atoms = createStore();
  atoms.set(tabsAtom, [
    {
      name: "Synthetic puzzles",
      value: "puzzle-parent-test",
      type: "puzzles",
      gameOrigin: { kind: "none" },
    },
  ]);
  atoms.set(activeTabAtom, "puzzle-parent-test");
  atoms.set(currentPuzzleAtom, 0);
  atoms.set(jumpToNextPuzzleAtom, false);
  atoms.set(trackPuzzleTimeAtom, false);
  atoms.set(selectedPuzzleDbAtom, "synthetic-puzzles.db3");
  tree = createTreeStore(undefined, defaultTree());
  container = document.createElement("div");
  container.innerHTML =
    '<div id="left"></div><div id="topRight"></div><div id="bottomRight"></div><div id="test-root"></div>';
  document.body.append(container);
  root = createRoot(container.querySelector("#test-root")!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollTo) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

async function mount(puzzle = matePuzzle) {
  sessionStorage.setItem("puzzle-parent-test-puzzles", JSON.stringify([puzzle]));
  const position = Chess.fromSetup(parseFen(puzzle.fen).unwrap()).unwrap();
  const initialMove = parseUci(puzzle.moves[0])!;
  expect(position.isLegal(initialMove)).toBe(true);
  tree.getState().setFen(puzzle.fen);
  tree.getState().makeMove({ payload: initialMove });
  await act(async () => {
    root.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <TreeStateContext.Provider value={tree}>
            <Puzzles id="puzzle-parent-test" />
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

function hint() {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Puzzle.GetAHint",
  );
  expect(button).toBeDefined();
  return button!;
}

function savedPuzzle(): Puzzle {
  return JSON.parse(sessionStorage.getItem("puzzle-parent-test-puzzles")!)[0];
}

it.each([false, true])(
  "cycles hints circle > arrow > clear > circle with unrelated drawings: %s",
  async (withDrawings) => {
    await mount();
    const unrelated: DrawShape[] = withDrawings
      ? [
          { orig: "a1", brush: "red" },
          { orig: "g5", dest: "g4", brush: "blue" },
        ]
      : [];
    for (const shape of unrelated) {
      await act(async () => board().state.drawable.onChange!([shape]));
    }
    expect(tree.getState().currentNode().shapes).toEqual(unrelated);
    expect(board().state.drawable.autoShapes).toEqual(unrelated);
    const fen = tree.getState().currentNode().fen;
    const path = [...tree.getState().position];
    expect(savedPuzzle().completion).toBe("incomplete");
    const hints: DrawShape[][] = [
      [{ orig: "g5", brush: "green" }],
      [{ orig: "g5", dest: "g7", brush: "green" }],
      [],
      [{ orig: "g5", brush: "green" }],
    ];
    for (const [index, shapes] of hints.entries()) {
      await act(async () => hint().click());
      expect
        .soft(tree.getState().currentNode().shapes, `store click ${index + 1}`)
        .toEqual([...unrelated, ...shapes]);
      expect
        .soft(board().state.drawable.autoShapes, `native click ${index + 1}`)
        .toEqual([...unrelated, ...shapes]);
      expect(tree.getState().currentNode().fen).toBe(fen);
      expect(board().getFen()).toBe(fen.split(" ")[0]);
      expect(tree.getState().position).toEqual(path);
      expect(savedPuzzle().completion).toBe("incorrect");
      expect(hint().disabled).toBe(false);
    }
  },
);

it.each(["circle", "arrow", "both"] as const)(
  "matches an existing %s hint by endpoints regardless of brush",
  async (kind) => {
    await mount({ ...matePuzzle, completion: "incorrect" });
    const unrelated: DrawShape[] = [
      { orig: "a1", brush: "red" },
      { orig: "g5", dest: "g4", brush: "blue" },
    ];
    const matching: DrawShape[] = [];
    if (kind !== "arrow") matching.push({ orig: "g5", brush: "yellow" });
    if (kind !== "circle") matching.push({ orig: "g5", dest: "g7", brush: "red" });
    for (const shape of [...unrelated, ...matching]) {
      await act(async () => board().state.drawable.onChange!([shape]));
    }
    expect(tree.getState().currentNode().shapes).toEqual([...unrelated, ...matching]);
    expect(board().state.drawable.autoShapes).toEqual([...unrelated, ...matching]);
    const fen = tree.getState().currentNode().fen;
    const path = [...tree.getState().position];
    await act(async () => hint().click());
    const expected: DrawShape[] =
      kind === "circle" ? [...unrelated, { orig: "g5", dest: "g7", brush: "green" }] : unrelated;
    expect.soft(tree.getState().currentNode().shapes).toEqual(expected);
    expect.soft(board().state.drawable.autoShapes).toEqual(expected);
    expect(tree.getState().currentNode().fen).toBe(fen);
    expect(board().getFen()).toBe(fen.split(" ")[0]);
    expect(tree.getState().position).toEqual(path);
    expect(savedPuzzle().completion).toBe("incorrect");
  },
);

it.each([
  ["canonical", "g7", "g5g7", false, matePuzzle],
  ["alternative", "h6", "g5h6", false, matePuzzle],
  ["canonical after a wrong attempt", "g7", "g5g7", true, matePuzzle],
  ["alternative after a wrong attempt", "h6", "g5h6", true, matePuzzle],
  ["early", "h6", "g5h6", false, earlyMatePuzzle],
  ["early after a wrong attempt", "h6", "g5h6", true, earlyMatePuzzle],
] as const)(
  "disables the real hint control at %s mate, not at the previous position",
  async (_, to, uci, wrongAttempt, puzzle) => {
    await mount(puzzle);
    const beforeMate = tree.getState().currentNode().fen;
    expect(hint().disabled).toBe(false);
    if (wrongAttempt) {
      await play("g5", "g3");
    }
    expect(savedPuzzle().completion).toBe(wrongAttempt ? "incorrect" : "incomplete");
    expect(tree.getState().currentNode().fen).toBe(beforeMate);
    await play("g5", to);
    const expected = Chess.fromSetup(parseFen(matePuzzle.fen).unwrap()).unwrap();
    for (const move of ["h7h8", uci]) {
      expect(expected.isLegal(parseUci(move)!)).toBe(true);
      expected.play(parseUci(move)!);
    }
    expect(expected.isCheckmate()).toBe(true);
    expect(tree.getState().currentNode().fen).toBe(makeFen(expected.toSetup()));
    expect(tree.getState().position).toEqual([0, 0]);
    expect(
      [...treeIteratorMainLine(tree.getState().root)]
        .slice(1)
        .map(({ node }) => makeUci(node.move!)),
    ).toEqual(["h7h8", uci]);
    expect(board().getFen()).toBe(makeFen(expected.toSetup()).split(" ")[0]);
    expect(savedPuzzle().completion).toBe(wrongAttempt ? "incorrect" : "correct");
    expect.soft(hint().disabled).toBe(true);
    await act(async () => hint().click());
    expect(tree.getState().currentNode().shapes).toEqual([]);
    expect(board().state.drawable.autoShapes).toEqual([]);

    // Navigate using the real MoveControls, not a copied parent predicate.
    const previous = container
      .querySelector("#bottomRight .tabler-icon-chevron-left")
      ?.closest("button");
    expect(previous).toBeDefined();
    await act(async () => previous!.click());
    expect(tree.getState().position).toEqual([0]);
    expect(tree.getState().currentNode().fen).toBe(beforeMate);
    expect(hint().disabled).toBe(false);
    await act(async () => hint().click());
    expect(tree.getState().currentNode().shapes).toEqual([{ orig: "g5", brush: "green" }]);
    expect(savedPuzzle().completion).toBe(wrongAttempt ? "incorrect" : "correct");
    const next = container
      .querySelector("#bottomRight .tabler-icon-chevron-right")
      ?.closest("button");
    expect(next).toBeDefined();
    await act(async () => next!.click());
    expect(tree.getState().currentNode().fen).toBe(makeFen(expected.toSetup()));
    expect(hint().disabled).toBe(true);
    expect(tree.getState().currentNode().shapes).toEqual([]);
  },
);

it("keeps hints available on an ordinary active puzzle and its next player turn", async () => {
  await mount({ ...matePuzzle, fen: INITIAL_FEN, moves: ["e2e4", "e7e5", "g1f3", "b8c6"] });
  const fen = tree.getState().currentNode().fen;
  expect(savedPuzzle().completion).toBe("incomplete");
  expect(hint().disabled).toBe(false);
  await act(async () => hint().click());
  expect(tree.getState().currentNode().shapes).toEqual([{ orig: "e7", brush: "green" }]);
  expect(savedPuzzle().completion).toBe("incorrect");
  expect(tree.getState().currentNode().fen).toBe(fen);
  expect(tree.getState().position).toEqual([0]);
  expect(hint().disabled).toBe(false);
  await play("e7", "e5");
  expect(tree.getState().position).toEqual([0, 0, 0]);
  expect(makeUci(tree.getState().currentNode().move!)).toBe("g1f3");
  expect(hint().disabled).toBe(false);
  await act(async () => hint().click());
  expect(tree.getState().currentNode().shapes).toEqual([{ orig: "b8", brush: "green" }]);
  expect(savedPuzzle().completion).toBe("incorrect");
});
