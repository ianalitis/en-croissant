// @vitest-environment jsdom
import { Chessground as NativeChessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import { MantineProvider } from "@mantine/core";
import { INITIAL_FEN } from "chessops/fen";
import { createStore, Provider } from "jotai";
import { act, type ComponentProps, createRef, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardImageAtom, is3dAtom, moveMethodAtom } from "@/state/atoms";
import { Chessground, type ChessgroundRef } from "../Chessground";

// Observe the real native boundary, including config merging, moves and destruction.
// No fake geometry, pointer events or ResizeObserver behavior is needed for these API tests.
vi.mock("@lichess-org/chessground", async (importOriginal) => {
  const native = await importOriginal<typeof import("@lichess-org/chessground")>();
  return {
    ...native,
    Chessground: vi.fn<typeof NativeChessground>((element, config) => {
      const api = native.Chessground(element, config);
      vi.spyOn(api, "set");
      vi.spyOn(api, "destroy");
      vi.spyOn(api, "playPremove");
      vi.spyOn(api, "cancelPremove");
      return api;
    }),
  };
});
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

const native = vi.mocked(NativeChessground);
const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR";
let root: Root | null;
let container: HTMLDivElement;
let atoms: ReturnType<typeof createStore>;

function instances(): Api[] {
  return native.mock.results.map((result) => result.value);
}

async function render(props: ComponentProps<typeof Chessground> = {}, strict = false) {
  const board = (
    <Provider store={atoms}>
      <MantineProvider env="test">
        <Chessground fen={INITIAL_FEN} animation={{ enabled: false }} {...props} />
      </MantineProvider>
    </Provider>
  );
  await act(async () => root!.render(strict ? <StrictMode>{board}</StrictMode> : board));
}

async function unmount() {
  await act(async () => root?.unmount());
  root = null;
}

beforeEach(() => {
  native.mockClear();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn<MediaQueryList["addEventListener"]>(),
      removeEventListener: vi.fn<MediaQueryList["removeEventListener"]>(),
    })),
  );
  localStorage.clear();
  sessionStorage.clear();
  atoms = createStore();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await unmount();
  // Isolate even the failing pre-fix baseline. Lifecycle assertions happen before this fallback.
  for (const api of instances()) {
    if (!api.state.dom.destroyed) api.destroy();
  }
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Chessground native lifecycle", () => {
  it("initializes once with the complete config and no redundant set", async () => {
    await render({ orientation: "black", viewOnly: true, drawable: { visible: false } });
    expect(native).toHaveBeenCalledTimes(1);
    const [api] = instances();
    expect(api.set).not.toHaveBeenCalled();
    expect(api.getFen()).toBe(INITIAL_FEN.split(" ")[0]);
    expect(api.state.orientation).toBe("black");
    expect(api.state.viewOnly).toBe(true);
    expect(api.state.dom.elements.shapes).toBeUndefined();
    expect(native.mock.calls[0][1]?.addDimensionsCssVarsTo).toBe(native.mock.calls[0][0]);
    expect(container.querySelectorAll("cg-board")).toHaveLength(1);
  });

  it("uses one set per ordinary rerender without recreating or destroying the instance", async () => {
    await render({ check: "white", lastMove: ["e2", "e4"] });
    const [api] = instances();
    vi.mocked(api.set).mockClear();

    await render({ fen: afterE4, orientation: "black", check: false, lastMove: undefined });
    expect(native).toHaveBeenCalledTimes(1);
    expect(api.destroy).not.toHaveBeenCalled();
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(api.getFen()).toBe(afterE4);
    expect(api.state.orientation).toBe("black");
    expect(api.state.check).toBeUndefined();
    expect(api.state.lastMove).toBeUndefined();

    vi.mocked(api.set).mockClear();
    await render({ fen: afterE4, orientation: "black", coordinates: false });
    expect(native).toHaveBeenCalledTimes(1);
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(api.state.coordinates).toBe(false);
  });

  it("destroys and unbinds its exact instance once on unmount, not on prop updates", async () => {
    await render();
    const [api] = instances();
    const unbind = vi.spyOn(api.state.dom, "unbind");
    await render({ orientation: "black" });
    expect(api.destroy).not.toHaveBeenCalled();
    await unmount();
    expect(api.destroy).toHaveBeenCalledTimes(1);
    expect(unbind).toHaveBeenCalledTimes(1);
    expect(api.state.dom.destroyed).toBe(true);
  });

  it("destroys every StrictMode instance exactly once and exposes only the live one", async () => {
    const ref = createRef<ChessgroundRef>();
    await render({ ref }, true);
    expect(native).toHaveBeenCalledTimes(2);
    const [retired, live] = instances();
    expect(retired.destroy).toHaveBeenCalledTimes(1);
    expect(retired.state.dom.destroyed).toBe(true);
    expect(live.destroy).not.toHaveBeenCalled();

    vi.mocked(live.set).mockClear();
    await render({ ref, orientation: "black" }, true);
    expect(native).toHaveBeenCalledTimes(2);
    expect(live.set).toHaveBeenCalledTimes(1);
    expect(retired.set).not.toHaveBeenCalled();
    expect(ref.current?.playPremove()).toBe(false);
    ref.current?.cancelPremove();
    expect(live.playPremove).toHaveBeenCalledTimes(1);
    expect(live.cancelPremove).toHaveBeenCalledTimes(1);
    expect(retired.playPremove).not.toHaveBeenCalled();
    expect(retired.cancelPremove).not.toHaveBeenCalled();

    await unmount();
    expect(ref.current).toBeNull();
    for (const api of instances()) {
      expect(api.destroy).toHaveBeenCalledTimes(1);
      expect(api.state.dom.destroyed).toBe(true);
    }
  });
});

it("uses the latest callbacks and piece-only edit FEN while retaining the change override", async () => {
  const oldFen = vi.fn<(fen: string) => void>();
  const oldSelect = vi.fn<NonNullable<Api["state"]["events"]["select"]>>();
  const oldMove = vi.fn<NonNullable<Api["state"]["events"]["move"]>>();
  const oldAfter = vi.fn<NonNullable<Api["state"]["movable"]["events"]["after"]>>();
  const suppliedChange = vi.fn<() => void>();
  await render({
    setBoardFen: oldFen,
    events: { select: oldSelect, move: oldMove, change: suppliedChange },
    movable: { free: true, color: "both", events: { after: oldAfter } },
    draggable: { deleteOnDropOff: true },
  });
  const [api] = instances();
  const latestFen = vi.fn<(fen: string) => void>();
  const latestSelect = vi.fn<NonNullable<Api["state"]["events"]["select"]>>();
  const latestMove = vi.fn<NonNullable<Api["state"]["events"]["move"]>>();
  const latestAfter = vi.fn<NonNullable<Api["state"]["movable"]["events"]["after"]>>();
  await render({
    setBoardFen: latestFen,
    events: { select: latestSelect, move: latestMove, change: suppliedChange },
    movable: { free: true, color: "both", events: { after: latestAfter } },
    draggable: { deleteOnDropOff: true },
  });
  await act(async () => {
    api.selectSquare("e2");
    api.selectSquare("e4");
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(latestSelect.mock.calls).toEqual([["e2"], ["e4"]]);
  expect(latestMove).toHaveBeenCalledWith("e2", "e4", undefined);
  expect(latestAfter).toHaveBeenCalledWith("e2", "e4", expect.objectContaining({ premove: false }));
  expect(latestFen).toHaveBeenCalledExactlyOnceWith(afterE4);
  expect(api.state.draggable.deleteOnDropOff).toBe(true);
  for (const callback of [oldFen, oldSelect, oldMove, oldAfter, suppliedChange]) {
    expect(callback).not.toHaveBeenCalled();
  }

  // The wrapper has always owned events.change, even without an edit callback.
  await render({ fen: afterE4, events: { change: suppliedChange } });
  await act(async () => {
    api.move("e7", "e5");
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(latestFen).toHaveBeenCalledTimes(1);
  expect(suppliedChange).not.toHaveBeenCalled();
});

it.each([
  ["drag", false, true, false],
  ["select", true, false, true],
  ["both", false, true, true],
] as const)(
  "preserves %s settings and 3D flags on creation and updates",
  async (method, is3d, drag, select) => {
    atoms.set(moveMethodAtom, method);
    atoms.set(is3dAtom, is3d);
    atoms.set(boardImageAtom, "blue.svg");
    await render({
      draggable: { enabled: false, deleteOnDropOff: true },
      selectable: { enabled: false },
    });
    const [api] = instances();
    const board = native.mock.calls[0][0];
    expect(api.state.draggable.enabled).toBe(drag);
    expect(api.state.selectable.enabled).toBe(select);
    expect(api.state.draggable.deleteOnDropOff).toBe(true);
    expect(api.state.addPieceZIndex).toBe(is3d);
    expect(board.classList.contains("is3d")).toBe(is3d);
    expect(board.style.getPropertyValue("--board-image")).toBe(
      `url('/${is3d ? "board-3d" : "board"}/blue.svg')`,
    );
    expect(board.style.getPropertyValue("--board-coord-color-white")).toBe("#dee3e6");
    expect(board.style.paddingBottom).toBe(is3d ? "91%" : "");

    vi.mocked(api.set).mockClear();
    await act(async () => atoms.set(is3dAtom, !is3d));
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(api.state.addPieceZIndex).toBe(!is3d);
    expect(board.classList.contains("is3d")).toBe(!is3d);
    expect(board.style.paddingBottom).toBe(is3d ? "" : "91%");

    vi.mocked(api.set).mockClear();
    const nextMethod = method === "drag" ? "select" : "drag";
    await act(async () => atoms.set(moveMethodAtom, nextMethod));
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(api.state.draggable.enabled).toBe(nextMethod !== "select");
    expect(api.state.selectable.enabled).toBe(nextMethod !== "drag");
    expect(api.state.draggable.deleteOnDropOff).toBe(true);
    expect(native).toHaveBeenCalledTimes(1);
    expect(api.destroy).not.toHaveBeenCalled();
  },
);

it("cancels and plays real premoves through the imperative handle after a turn update", async () => {
  const ref = createRef<ChessgroundRef>();
  const after = vi.fn<NonNullable<Api["state"]["movable"]["events"]["after"]>>();
  const movable = {
    free: false,
    color: "white" as const,
    dests: new Map([["e2" as const, ["e4" as const]]]),
    events: { after },
  };
  await render({ ref, turnColor: "black", movable, premovable: { enabled: true } });
  const [api] = instances();
  expect(ref.current?.playPremove()).toBe(false);
  api.selectSquare("e2");
  api.selectSquare("e4");
  expect(api.state.premovable.current).toEqual(["e2", "e4"]);
  ref.current?.cancelPremove();
  expect(api.state.premovable.current).toBeUndefined();
  expect(ref.current?.playPremove()).toBe(false);

  api.selectSquare("e2");
  api.selectSquare("e4");
  await render({ ref, turnColor: "white", movable, premovable: { enabled: true } });
  await act(async () => {
    expect(ref.current?.playPremove()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(after).toHaveBeenCalledExactlyOnceWith("e2", "e4", { premove: true });
  expect(api.getFen()).toBe(afterE4);
  expect(api.state.premovable.current).toBeUndefined();
  expect(ref.current?.playPremove()).toBe(false);
  expect(native).toHaveBeenCalledTimes(1);
});
