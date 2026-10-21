// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  download: vi.fn(),
  resolve: vi.fn(async (...parts: string[]) => parts.join("/")),
  convert: vi.fn(),
  deleteEmptyGames: vi.fn(),
  eventsListen: vi.fn(async () => () => {}),
}));
vi.mock("@/utils/db", () => ({ query_games: mocks.query, getDatabases: vi.fn() }));
vi.mock("@/utils/chess.com/api", () => ({ downloadChessCom: mocks.download }));
vi.mock("@tauri-apps/api/path", () => ({
  resolve: mocks.resolve,
  basename: async () => "games.pgn",
}));
vi.mock("@/bindings", () => ({
  commands: { convertPgn: mocks.convert, deleteEmptyGames: mocks.deleteEmptyGames },
  events: { progressEvent: { listen: mocks.eventsListen, emit: vi.fn() } },
}));
vi.mock("@tauri-apps/plugin-log", () => ({ info: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/unwrap", () => ({ unwrap: (value: unknown) => value }));

import { databaseConversionStateAtom, storedDatabasesDirAtom } from "@/state/atoms";
import { AccountCard } from "../AccountCard";

let root: Root;
let container: HTMLDivElement;
const store = createStore();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mocks.query.mockResolvedValue({ count: 0, data: [] });
  store.set(storedDatabasesDirAtom, "/db");
  store.set(databaseConversionStateAtom, {
    inProgress: false,
    totalGames: 0,
    elapsedSeconds: 0,
    targetDatabasePath: null,
    targetDatabaseTitle: null,
    sourceFileName: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each(["download", "cursor", "resolve", "conversion resolve", "conversion"] as const)(
  "cleans up only owned conversion state and permits retry after %s rejection",
  async (failure) => {
    const database = { type: "success", file: "/db/current.db3", game_count: 2 } as never;
    const failureError = new Error(`${failure} failed`);
    const initialState = store.get(databaseConversionStateAtom);
    const unrelatedState = {
      inProgress: true,
      totalGames: 42,
      elapsedSeconds: 7,
      targetDatabasePath: "/db/unrelated.db3",
      targetDatabaseTitle: "Unrelated import",
      sourceFileName: "unrelated.pgn",
    };
    if (failure !== "conversion") store.set(databaseConversionStateAtom, unrelatedState);
    if (failure === "download") mocks.download.mockRejectedValueOnce(failureError);
    else if (failure === "cursor") mocks.query.mockRejectedValueOnce(failureError);
    else if (failure === "resolve") mocks.resolve.mockRejectedValueOnce(failureError);
    else if (failure === "conversion resolve") {
      mocks.resolve
        .mockResolvedValueOnce("/db/player_chesscom.pgn")
        .mockRejectedValueOnce(failureError);
    } else {
      mocks.convert.mockImplementationOnce(async () => {
        expect(store.get(databaseConversionStateAtom)).toMatchObject({
          inProgress: true,
          targetDatabasePath: "/db/player_chesscom.db3",
          targetDatabaseTitle: "player Chess.com",
        });
        throw failureError;
      });
    }
    const originalError = console.error;
    console.error = vi.fn();
    try {
      await act(async () =>
        root.render(
          <Provider store={store}>
            <MantineProvider env="test">
              <AccountCard
                type="chesscom"
                database={database}
                title="player"
                updatedAt={0}
                total={2}
                stats={[]}
                logout={vi.fn()}
                reload={vi.fn()}
                setDatabases={vi.fn()}
              />
            </MantineProvider>
          </Provider>,
        ),
      );
      const button = container.querySelectorAll("button")[1];
      await act(async () => button.click());
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("data-loading")).not.toBe("true");
      expect(mocks.query).toHaveBeenCalledTimes(1);
      if (failure === "cursor") {
        expect(mocks.download).not.toHaveBeenCalled();
      } else {
        expect(mocks.download).toHaveBeenCalledExactlyOnceWith("player", null);
      }
      expect(console.error).toHaveBeenCalledExactlyOnceWith(failureError);
      expect(mocks.convert).toHaveBeenCalledTimes(failure === "conversion" ? 1 : 0);
      expect(mocks.deleteEmptyGames).not.toHaveBeenCalled();
      expect(store.get(databaseConversionStateAtom)).toEqual(
        failure === "conversion" ? initialState : unrelatedState,
      );
      // The unrelated operation completes before this account retries.
      if (failure !== "conversion") {
        await act(async () => store.set(databaseConversionStateAtom, initialState));
      }
      // The same mounted button must perform a real retry, not merely look enabled.
      await act(async () => button.click());
      expect(mocks.convert).toHaveBeenCalledTimes(failure === "conversion" ? 2 : 1);
      expect(mocks.deleteEmptyGames).toHaveBeenCalledExactlyOnceWith("/db/player_chesscom.db3");
      expect(console.error).toHaveBeenCalledExactlyOnceWith(failureError);
      expect(store.get(databaseConversionStateAtom)).toEqual(initialState);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("data-loading")).not.toBe("true");
    } finally {
      console.error = originalError;
    }
  },
);
