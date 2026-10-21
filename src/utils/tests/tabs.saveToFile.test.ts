import { notifications } from "@mantine/notifications";
import { save } from "@tauri-apps/plugin-dialog";
import * as fs from "@tauri-apps/plugin-fs";
import { error } from "@tauri-apps/plugin-log";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { commands } from "@/bindings";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { getPGN, parsePGN } from "@/utils/chess";
import { saveToFile, type Tab } from "@/utils/tabs";
import * as unwrapModule from "@/utils/unwrap";

vi.mock("@mantine/notifications", () => ({
    notifications: { show: vi.fn<typeof notifications.show>() },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn<typeof save>() }));
vi.mock("@tauri-apps/api/path", () => ({ resolve: async (...parts: string[]) => parts.join("/") }));
vi.mock("@tauri-apps/plugin-fs", { spy: true });
vi.mock("@tauri-apps/plugin-log", () => ({
    error: vi.fn<typeof error>().mockResolvedValue(undefined),
}));

let store: TreeStore;

beforeEach(() => {
    store = createTreeStore();
    store.getState().setHeaders({ ...store.getState().headers, white: "White", black: "Black" });
    store.getState().setComment("Unsaved analysis");
    vi.spyOn(commands, "writeGame");
    vi.spyOn(commands, "writeDbGame");
});

describe("save confirmation and publication", () => {
    const tab: Tab = {
        name: "New",
        value: "source",
        type: "analysis",
        gameOrigin: { kind: "none" },
    };
    const database: Tab = {
        ...tab,
        gameOrigin: { kind: "database", database: "/games/test.db3", gameId: 7 },
    };

    test("distinguishes picker cancellation and leaves the source dirty", async () => {
        vi.mocked(save).mockResolvedValueOnce(null);
        const setCurrentTab = vi.fn();
        await expect(saveToFile({ dir: "/games", tab, setCurrentTab, store })).resolves.toBe(
            "cancelled",
        );
        expect(store.getState().dirty).toBe(true);
        expect(setCurrentTab).not.toHaveBeenCalled();
        expect(commands.writeGame).not.toHaveBeenCalled();
    });

    test.each(["native", "transport"])(
        "database %s failure retains edits and permits retry",
        async (failure) => {
            const setCurrentTab = vi.fn();
            if (failure === "native")
                vi.mocked(commands.writeDbGame).mockResolvedValueOnce({
                    status: "error",
                    error: "Database locked",
                });
            else
                vi.mocked(commands.writeDbGame).mockRejectedValueOnce(new Error("Database locked"));
            await expect(
                saveToFile({ dir: "/games", tab: database, setCurrentTab, store }),
            ).rejects.toThrow("Database locked");
            expect(store.getState().dirty).toBe(true);
            vi.mocked(commands.writeDbGame).mockResolvedValueOnce({ status: "ok", data: null });
            await expect(
                saveToFile({ dir: "/games", tab: database, setCurrentTab, store }),
            ).resolves.toBe("saved");
            expect(store.getState().dirty).toBe(false);
            expect(setCurrentTab).not.toHaveBeenCalled();
        },
    );

    test("publishes a picked origin only after a successful write", async () => {
        vi.mocked(save).mockResolvedValue("/games/new");
        const write = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
        vi.mocked(commands.writeGame).mockReturnValueOnce(write.promise);
        const setCurrentTab = vi.fn();
        const pending = saveToFile({ dir: "/games", tab, setCurrentTab, store });
        await vi.waitFor(() => expect(commands.writeGame).toHaveBeenCalled());
        expect(setCurrentTab).not.toHaveBeenCalled();
        write.resolve({ status: "error", error: "Disk full" });
        await expect(pending).rejects.toThrow("Disk full");
        expect(setCurrentTab).not.toHaveBeenCalled();
        expect(store.getState().dirty).toBe(true);
        vi.mocked(commands.writeGame).mockResolvedValueOnce({ status: "ok", data: null });
        await expect(saveToFile({ dir: "/games", tab, setCurrentTab, store })).resolves.toBe(
            "saved",
        );
        expect(setCurrentTab).toHaveBeenCalledTimes(1);
        expect(setCurrentTab.mock.calls[0][0](tab).gameOrigin.file.path).toBe("/games/new.pgn");
    });

    test("does not clean the tree when publishing the new origin fails", async () => {
        vi.mocked(save).mockResolvedValueOnce("/games/new.pgn");
        vi.mocked(commands.writeGame).mockResolvedValueOnce({ status: "ok", data: null });
        await expect(
            saveToFile({
                dir: "/games",
                tab,
                store,
                setCurrentTab: () => {
                    throw new Error("Metadata failed");
                },
            }),
        ).rejects.toThrow("Metadata failed");
        expect(store.getState().dirty).toBe(true);
    });

    test.each(["root", "headers"])(
        "keeps %s changes made after the serialized snapshot dirty",
        async (change) => {
            const write = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeDbGame>>>();
            vi.mocked(commands.writeDbGame).mockReturnValueOnce(write.promise);
            const pending = saveToFile({
                dir: "/games",
                tab: database,
                store,
                setCurrentTab: vi.fn(),
            });
            if (change === "root") store.getState().setComment("Newer edit");
            else store.getState().setHeaders({ ...store.getState().headers, white: "Newer edit" });
            write.resolve({ status: "ok", data: null });
            await expect(pending).resolves.toBe("changed");
            expect(store.getState().dirty).toBe(true);
            expect(commands.writeDbGame).toHaveBeenCalledWith(
                "/games/test.db3",
                7,
                expect.not.stringContaining("Newer edit"),
            );
        },
    );
});

afterEach(() => {
    // No persistence ID, subscriptions or timers are attached to this store.
    store.getState().reset();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

test.each(["file", "database"] as const)(
    "%s save sends literal FEN move numbers and annotations to the native boundary",
    async (kind) => {
        const fen = "8/5k2/7p/3p4/3P4/7P/4K3/8 b - - 7 23";
        // Explicit native lexer output, not a native lexer or filesystem roundtrip.
        vi.spyOn(commands, "lexPgn").mockResolvedValueOnce({
            status: "ok",
            data: [
                { type: "Header", value: { tag: "SetUp", value: "1" } },
                { type: "Header", value: { tag: "FEN", value: fen } },
                { type: "Header", value: { tag: "White", value: "White" } },
                { type: "Header", value: { tag: "Black", value: "Black" } },
                { type: "Comment", value: "Find king activity [%cal Gf7g6]" },
                { type: "San", value: "Kg6" },
                { type: "Nag", value: "$1" },
                { type: "Comment", value: "Centralize." },
                { type: "ParenOpen" },
                { type: "San", value: "Ke6" },
                { type: "Comment", value: "Alternative." },
                { type: "San", value: "Kf3" },
                { type: "ParenClose" },
                { type: "San", value: "Kf3" },
                { type: "Outcome", value: "*" },
            ],
        });
        store.getState().setState(
            await parsePGN(`[SetUp "1"]\n[FEN "${fen}"]
[White "White"]\n[Black "Black"]
{Find king activity [%cal Gf7g6]} 23... Kg6 $1 {Centralize.}
(23... Ke6 {Alternative.} 24. Kf3) 24. Kf3 *`),
        );
        store.setState({ dirty: true });
        const tab: Tab = {
            name: "FEN analysis",
            value: "fen-numbering",
            type: "analysis",
            gameOrigin:
                kind === "database"
                    ? { kind, database: "/games/fen.db3", gameId: 7 }
                    : {
                          kind,
                          gameNumber: 2,
                          file: {
                              type: "file",
                              name: "fen.pgn",
                              path: "/games/fen.pgn",
                              numGames: 3,
                              metadata: { tags: [], type: "game" },
                              lastModified: 0,
                          },
                      },
        };
        const write = kind === "database" ? commands.writeDbGame : commands.writeGame;
        vi.mocked(write).mockResolvedValueOnce({ status: "ok", data: null });
        const setCurrentTab = vi.fn<Parameters<typeof saveToFile>[0]["setCurrentTab"]>();
        await expect(saveToFile({ dir: "/games", tab, store, setCurrentTab })).resolves.toBe(
            "saved",
        );
        expect(write).toHaveBeenCalledExactlyOnceWith(
            kind === "database" ? "/games/fen.db3" : "/games/fen.pgn",
            kind === "database" ? 7 : 2,
            expect.any(String),
        );
        const payload = vi.mocked(write).mock.calls[0][2];
        expect(payload).toContain('[SetUp "1"]');
        expect(payload).toContain(`[FEN "${fen}"]`);
        expect(payload).toContain('[White "White"]');
        expect(payload).toContain('[Black "Black"]');
        expect(payload).toContain("[%cal Gf7g6]Find king activity");
        expect.soft(payload).toContain("23... Kg6! {Centralize.}");
        expect.soft(payload).toMatch(/\(23\.\.\. Ke6 \{Alternative\.\}\s+24\. Kf3\)/);
        expect.soft(payload).toMatch(/\)\s+24\. Kf3 \*\s*$/);
        expect(store.getState().root.fen).toBe(fen);
        expect(store.getState().dirty).toBe(false);
        expect(setCurrentTab).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    },
);

describe.each(["file", "temp_file"] as const)("saveToFile with %s origin", (kind) => {
    const tab: Tab = {
        name: "Analysis",
        value: "save-test",
        type: "analysis",
        gameOrigin: {
            kind,
            gameNumber: 2,
            file: {
                type: "file",
                name: "analysis.pgn",
                path: "/games/analysis.pgn",
                numGames: 3,
                metadata: { tags: [], type: "game" },
                lastModified: 0,
            },
        },
    };

    function saveGame() {
        const setCurrentTab = vi.fn<Parameters<typeof saveToFile>[0]["setCurrentTab"]>();
        const promise = saveToFile({ dir: "/games", tab, setCurrentTab, store });
        return { promise, setCurrentTab };
    }

    function expectWrite() {
        const { root, headers } = store.getState();
        const pgn = `${getPGN(root, {
            headers,
            comments: true,
            extraMarkups: true,
            glyphs: true,
            variations: true,
        })}\n\n`;
        expect(pgn).toContain("Unsaved analysis");
        expect(pgn).toContain('[White "White"]');
        expect(commands.writeGame).toHaveBeenCalledWith("/games/analysis.pgn", 2, pgn);
        expect(save).not.toHaveBeenCalled();
        expect(fs.copyFile).not.toHaveBeenCalled();
        expect(commands.writeDbGame).not.toHaveBeenCalled();
    }

    test("reports a native error, rejects and retains the dirty tree", async () => {
        const write = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
        vi.mocked(commands.writeGame).mockReturnValueOnce(write.promise);
        const before = store.getState();
        const { promise, setCurrentTab } = saveGame();
        expect(store.getState().dirty).toBe(true);
        expectWrite();

        write.resolve({ status: "error", error: "Permission denied" });
        await expect.soft(promise).rejects.toThrow("Permission denied");
        expect.soft(store.getState()).toEqual(before);
        expect.soft(store.getState().dirty).toBe(true);
        expect(setCurrentTab).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledExactlyOnceWith("Permission denied");
        expect(notifications.show).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ title: "Error", message: "Permission denied", color: "red" }),
        );
    });

    test("clears dirty only after a confirmed native write", async () => {
        const write = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
        vi.mocked(commands.writeGame).mockReturnValueOnce(write.promise);
        const { root, headers } = store.getState();
        const { promise, setCurrentTab } = saveGame();
        await Promise.resolve();
        expect(store.getState().dirty).toBe(true);
        expectWrite();

        write.resolve({ status: "ok", data: null });
        await expect(promise).resolves.toBe("saved");
        expect(store.getState().dirty).toBe(false);
        expect(store.getState().root).toBe(root);
        expect(store.getState().headers).toBe(headers);
        expect(setCurrentTab).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(notifications.show).not.toHaveBeenCalled();
    });

    test("can retry the retained dirty tree after a native error", async () => {
        vi.mocked(commands.writeGame)
            .mockResolvedValueOnce({ status: "error", error: "Disk full" })
            .mockResolvedValueOnce({ status: "ok", data: null });
        await expect(saveGame().promise).rejects.toThrow("Disk full");
        expect(store.getState().dirty).toBe(true);
        const firstWrite = vi.mocked(commands.writeGame).mock.calls[0];

        await expect(saveGame().promise).resolves.toBe("saved");
        expect(commands.writeGame).toHaveBeenCalledTimes(2);
        expect(vi.mocked(commands.writeGame).mock.calls[1]).toEqual(firstWrite);
        expectWrite();
        expect(store.getState().dirty).toBe(false);
        expect(error).toHaveBeenCalledExactlyOnceWith("Disk full");
        expect(notifications.show).toHaveBeenCalledTimes(1);
    });

    test("preserves transport rejection identity and dirty state", async () => {
        const transportError = new Error("Native transport unavailable");
        vi.mocked(commands.writeGame).mockRejectedValueOnce(transportError);
        const before = store.getState();
        const { promise, setCurrentTab } = saveGame();

        await expect(promise).rejects.toBe(transportError);
        expect(store.getState()).toEqual(before);
        expect(store.getState().dirty).toBe(true);
        expectWrite();
        expect(setCurrentTab).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(notifications.show).not.toHaveBeenCalled();
    });
});

describe("destination save ordering", () => {
    function fileTab(
        path = "/games/ordered.pgn",
        kind: "file" | "temp_file" = "file",
        gameNumber = 0,
    ): Tab {
        return {
            name: "Ordered",
            value: "ordered",
            type: "analysis",
            gameOrigin: {
                kind,
                gameNumber,
                file: {
                    type: "file",
                    name: path,
                    path,
                    numGames: 3,
                    metadata: { tags: [], type: "game" },
                    lastModified: 0,
                },
            },
        };
    }

    // Drain the bounded promise chain without timing native completion using a timer.
    async function flushSaves() {
        for (let i = 0; i < 12; i++) await Promise.resolve();
    }

    test.each(["file", "temp_file"] as const)(
        "%s persists overlapping old/new snapshots in order instead of leaving stale disk content clean",
        async (kind) => {
            const firstWrite = Promise.withResolvers<void>();
            let disk = "";
            vi.mocked(commands.writeGame).mockImplementation(async (_path, _game, pgn) => {
                if (pgn.includes("Unsaved analysis")) await firstWrite.promise;
                disk = pgn;
                return { status: "ok", data: null };
            });
            const options = {
                dir: "/games",
                tab: fileTab(undefined, kind),
                store,
                setCurrentTab: vi.fn(),
            };
            const older = saveToFile(options);
            expect(commands.writeGame).toHaveBeenCalledTimes(1);
            store.getState().setComment("Newer edit");
            const newer = saveToFile(options);
            await flushSaves();
            expect.soft(commands.writeGame).toHaveBeenCalledTimes(1);
            expect.soft(store.getState().dirty).toBe(true);
            firstWrite.resolve();
            await expect(older).resolves.toBe("changed");
            await expect(newer).resolves.toBe("saved");
            expect(disk).toContain("Newer edit");
            expect(store.getState().dirty).toBe(false);
        },
    );

    test("shares a destination queue across stores and game numbers", async () => {
        const firstWrite = Promise.withResolvers<void>();
        let disk: Record<number, string> = {};
        vi.mocked(commands.writeGame).mockImplementation(async (_path, game, pgn) => {
            const before = disk;
            if (game === 0) await firstWrite.promise;
            disk = { ...before, [game]: pgn };
            return { status: "ok", data: null };
        });
        const secondStore = createTreeStore();
        secondStore.getState().setComment("Second game");
        const first = saveToFile({ dir: "/games", tab: fileTab(), store, setCurrentTab: vi.fn() });
        const second = saveToFile({
            dir: "/games",
            tab: fileTab(undefined, "temp_file", 1),
            store: secondStore,
            setCurrentTab: vi.fn(),
        });
        await flushSaves();
        expect.soft(commands.writeGame).toHaveBeenCalledTimes(1);
        firstWrite.resolve();
        await Promise.all([first, second]);
        expect(disk[0]).toContain("Unsaved analysis");
        expect(disk[1]).toContain("Second game");
    });

    test("file saves and their queue work when Promise.withResolvers is unavailable", async () => {
        const firstWrite = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
        vi.mocked(commands.writeGame)
            .mockReturnValueOnce(firstWrite.promise)
            .mockResolvedValueOnce({ status: "ok", data: null });
        const options = { dir: "/games", tab: fileTab(), store, setCurrentTab: vi.fn() };
        const descriptor = Object.getOwnPropertyDescriptor(Promise, "withResolvers")!;
        const saves: Promise<unknown>[] = [];
        Object.defineProperty(Promise, "withResolvers", { ...descriptor, value: undefined });
        try {
            saves.push(saveToFile(options).catch((error: unknown) => error));
            saves.push(saveToFile(options).catch((error: unknown) => error));
        } finally {
            Object.defineProperty(Promise, "withResolvers", descriptor);
        }
        expect.soft(commands.writeGame).toHaveBeenCalledTimes(1);
        firstWrite.resolve({ status: "ok", data: null });
        await expect(Promise.all(saves)).resolves.toEqual(["saved", "saved"]);
        expect(commands.writeGame).toHaveBeenCalledTimes(2);
        expect(store.getState().dirty).toBe(false);
    });

    test("unrelated destinations run independently", async () => {
        const firstWrite = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
        vi.mocked(commands.writeGame)
            .mockReturnValueOnce(firstWrite.promise)
            .mockResolvedValueOnce({ status: "ok", data: null });
        const first = saveToFile({ dir: "/games", tab: fileTab(), store, setCurrentTab: vi.fn() });
        const second = saveToFile({
            dir: "/games",
            tab: fileTab("/games/independent.pgn"),
            store,
            setCurrentTab: vi.fn(),
        });
        expect(commands.writeGame).toHaveBeenCalledTimes(2);
        await expect(second).resolves.toBe("saved");
        firstWrite.resolve({ status: "ok", data: null });
        await first;
    });

    test("finishing an earlier save retains the current tail and draining restores an immediate write", async () => {
        const firstWrite = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
        const secondWrite = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
        vi.mocked(commands.writeGame)
            .mockReturnValueOnce(firstWrite.promise)
            .mockReturnValueOnce(secondWrite.promise)
            .mockResolvedValue({ status: "ok", data: null });
        const options = { dir: "/games", tab: fileTab(), store, setCurrentTab: vi.fn() };
        const first = saveToFile(options);
        const second = saveToFile(options);
        firstWrite.resolve({ status: "ok", data: null });
        await first;
        expect.soft(commands.writeGame).toHaveBeenCalledTimes(2);
        const third = saveToFile(options);
        expect.soft(commands.writeGame).toHaveBeenCalledTimes(2);
        secondWrite.resolve({ status: "ok", data: null });
        await Promise.all([second, third]);
        const afterDrain = saveToFile(options);
        expect(commands.writeGame).toHaveBeenCalledTimes(4);
        await expect(afterDrain).resolves.toBe("saved");
    });

    test.each(["native", "transport"])(
        "%s failure releases a queued retry without changing the error identity",
        async (failure) => {
            const firstWrite =
                Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
            let expectedError = new Error("Transport unavailable");
            if (failure === "native") {
                const unwrap = unwrapModule.unwrap;
                vi.spyOn(unwrapModule, "unwrap").mockImplementation((result) => {
                    try {
                        return unwrap(result);
                    } catch (error) {
                        expectedError = error as Error;
                        throw error;
                    }
                });
            }
            vi.mocked(commands.writeGame)
                .mockReturnValueOnce(firstWrite.promise)
                .mockResolvedValueOnce({ status: "ok", data: null });
            const options = { dir: "/games", tab: fileTab(), store, setCurrentTab: vi.fn() };
            const failed = saveToFile(options).catch((error: unknown) => error);
            const retry = saveToFile(options);
            await flushSaves();
            expect.soft(commands.writeGame).toHaveBeenCalledTimes(1);
            if (failure === "native") firstWrite.resolve({ status: "error", error: "Disk full" });
            else firstWrite.reject(expectedError);
            expect(await failed).toBe(expectedError);
            await expect(retry).resolves.toBe("saved");
            expect(commands.writeGame).toHaveBeenCalledTimes(2);
            expect(store.getState().dirty).toBe(false);
            expect(notifications.show).toHaveBeenCalledTimes(failure === "native" ? 1 : 0);
        },
    );

    test("a queued save retains its call-start snapshot and never cleans a later edit", async () => {
        const firstWrite = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
        vi.mocked(commands.writeGame)
            .mockReturnValueOnce(firstWrite.promise)
            .mockResolvedValueOnce({ status: "ok", data: null });
        const options = { dir: "/games", tab: fileTab(), store, setCurrentTab: vi.fn() };
        const first = saveToFile(options);
        store.getState().setComment("Queued snapshot");
        const queued = saveToFile(options);
        store.getState().setComment("Later edit");
        firstWrite.resolve({ status: "ok", data: null });
        await expect(first).resolves.toBe("changed");
        await expect(queued).resolves.toBe("changed");
        expect(vi.mocked(commands.writeGame).mock.calls[1][2]).toContain("Queued snapshot");
        expect(vi.mocked(commands.writeGame).mock.calls[1][2]).not.toContain("Later edit");
        expect(store.getState().dirty).toBe(true);
    });

    test.each([false, true])(
        "queued owner invalidation skips write, copy and publication (Save As: %s)",
        async (isUserSave) => {
            const firstWrite =
                Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
            vi.mocked(commands.writeGame)
                .mockReturnValueOnce(firstWrite.promise)
                .mockResolvedValue({ status: "ok", data: null });
            vi.mocked(fs.copyFile).mockResolvedValue(undefined);
            vi.mocked(save).mockResolvedValue("/games/ordered.pgn");
            const blocker = saveToFile({
                dir: "/games",
                tab: fileTab(),
                store: createTreeStore(),
                setCurrentTab: vi.fn(),
            });
            let current = true;
            const setCurrentTab = vi.fn();
            const queued = saveToFile({
                dir: "/games",
                tab: fileTab(isUserSave ? "/temp/source.pgn" : undefined, "temp_file"),
                store,
                setCurrentTab,
                isUserSave,
                isCurrent: () => current,
            });
            await flushSaves();
            expect.soft(commands.writeGame).toHaveBeenCalledTimes(1);
            expect.soft(fs.copyFile).not.toHaveBeenCalled();
            current = false;
            firstWrite.resolve({ status: "ok", data: null });
            await blocker;
            await expect(queued).resolves.toBe("changed");
            expect(commands.writeGame).toHaveBeenCalledTimes(1);
            expect(fs.copyFile).not.toHaveBeenCalled();
            expect(setCurrentTab).not.toHaveBeenCalled();
            expect(store.getState().dirty).toBe(true);
        },
    );

    test("temp Save As copy and write hold the same target gate until publication", async () => {
        const copy = Promise.withResolvers<void>();
        const firstWrite = Promise.withResolvers<Awaited<ReturnType<typeof commands.writeGame>>>();
        vi.mocked(save).mockResolvedValue("/games/ordered.pgn");
        vi.mocked(fs.copyFile).mockReturnValueOnce(copy.promise);
        vi.mocked(commands.writeGame)
            .mockReturnValueOnce(firstWrite.promise)
            .mockResolvedValueOnce({ status: "ok", data: null });
        const setCurrentTab = vi.fn();
        const first = saveToFile({
            dir: "/games",
            tab: fileTab("/temp/source.pgn", "temp_file"),
            store,
            setCurrentTab,
            isUserSave: true,
        });
        await flushSaves();
        expect(fs.copyFile).toHaveBeenCalledExactlyOnceWith(
            "/temp/source.pgn",
            "/games/ordered.pgn",
        );
        const second = saveToFile({
            dir: "/games",
            tab: fileTab(),
            store: createTreeStore(),
            setCurrentTab: vi.fn(),
        });
        await flushSaves();
        expect.soft(commands.writeGame).not.toHaveBeenCalled();
        expect.soft(setCurrentTab).not.toHaveBeenCalled();
        copy.resolve();
        await flushSaves();
        expect.soft(commands.writeGame).toHaveBeenCalledTimes(1);
        expect.soft(setCurrentTab).not.toHaveBeenCalled();
        firstWrite.resolve({ status: "ok", data: null });
        await expect(first).resolves.toBe("saved");
        await expect(second).resolves.toBe("saved");
        expect(setCurrentTab).toHaveBeenCalledTimes(1);
    });

    test("copy failure releases a queued retry and preserves rejection identity", async () => {
        const copy = Promise.withResolvers<void>();
        const copyError = new Error("Copy denied");
        vi.mocked(save).mockResolvedValue("/games/ordered.pgn");
        vi.mocked(fs.copyFile).mockReturnValueOnce(copy.promise);
        vi.mocked(commands.writeGame).mockResolvedValue({ status: "ok", data: null });
        const setCurrentTab = vi.fn();
        const first = saveToFile({
            dir: "/games",
            tab: fileTab("/temp/source.pgn", "temp_file"),
            store,
            setCurrentTab,
            isUserSave: true,
        }).catch((error: unknown) => error);
        await flushSaves();
        const retry = saveToFile({ dir: "/games", tab: fileTab(), store, setCurrentTab: vi.fn() });
        await flushSaves();
        expect.soft(commands.writeGame).not.toHaveBeenCalled();
        copy.reject(copyError);
        expect(await first).toBe(copyError);
        await expect(retry).resolves.toBe("saved");
        expect(setCurrentTab).not.toHaveBeenCalled();
        expect(commands.writeGame).toHaveBeenCalledTimes(1);
    });

    test("a late Save As picker cannot overwrite a newer clean snapshot at the same destination", async () => {
        const picker = Promise.withResolvers<string | null>();
        vi.mocked(save)
            .mockReturnValueOnce(picker.promise)
            .mockResolvedValueOnce("/games/ordered.pgn");
        vi.mocked(fs.copyFile).mockResolvedValue(undefined);
        let disk = "";
        vi.mocked(commands.writeGame).mockImplementation(async (_path, _game, pgn) => {
            disk = pgn;
            return { status: "ok", data: null };
        });
        const options = {
            dir: "/games",
            tab: fileTab("/temp/source.pgn", "temp_file"),
            store,
            setCurrentTab: vi.fn(),
            isUserSave: true,
        };
        const older = saveToFile(options);
        await flushSaves();
        store.getState().setComment("Newer edit");
        await expect(saveToFile(options)).resolves.toBe("saved");
        picker.resolve("/games/ordered.pgn");
        await expect(older).resolves.toBe("changed");
        expect(disk).toContain("Newer edit");
        expect(commands.writeGame).toHaveBeenCalledTimes(1);
        expect(fs.copyFile).toHaveBeenCalledTimes(1);
        expect(options.setCurrentTab).toHaveBeenCalledTimes(1);
        expect(store.getState().dirty).toBe(false);
    });
});
