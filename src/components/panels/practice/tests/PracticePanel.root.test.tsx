import { Chessground as NativeChessground } from "@lichess-org/chessground";
import type { Key } from "@lichess-org/chessground/types";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Chess } from "chessops";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { createStore, Provider } from "jotai";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import Board from "@/components/boards/Board";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import PracticePanel from "@/components/panels/practice/PracticePanel";
import {
  activeTabAtom,
  autoPromoteAtom,
  currentEvalOpenAtom,
  currentInvisibleAtom,
  currentShowCommentsAtom,
  deckAtomFamily,
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
  function Harness() {
    const boardRef = useRef<HTMLDivElement>(null);
    const practicing = useStore(tree, (state) => state.practicePath !== null);
    return (
      <>
        <Board editingMode={false} boardRef={boardRef} practicing={practicing} />
        <PracticePanel />
      </>
    );
  }
  await act(async () => {
    renderer.render(
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
