import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    writeTextFile: vi.fn(),
    resolve: vi.fn(async (...parts: string[]) => parts.join("/")),
    emit: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: mocks.writeTextFile }));
vi.mock("@tauri-apps/api/path", () => ({ resolve: mocks.resolve }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("@/bindings", () => ({ events: { progressEvent: { emit: mocks.emit } } }));
vi.mock("@/utils/http", () => ({ apiHeaders: () => ({}) }));
vi.mock("../directories", () => ({ getDatabasesDir: async () => "/db" }));

import { downloadChessCom } from "../chess.com/api";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
const response = (data: unknown) => ({ ok: true, status: 200, url: "", json: async () => data });
async function flush() {
    for (let index = 0; index < 12; index++) await Promise.resolve();
}
const archives = { archives: ["https://chess.com/2024/01", "https://chess.com/2024/02"] };
const games = { games: [] };

beforeEach(() => vi.resetAllMocks());

describe("downloadChessCom writes", () => {
    it("waits for truncation and every append before proceeding or resolving", async () => {
        const truncate = deferred<void>();
        const firstAppend = deferred<void>();
        const secondAppend = deferred<void>();
        mocks.writeTextFile
            .mockReturnValueOnce(truncate.promise)
            .mockReturnValueOnce(firstAppend.promise)
            .mockReturnValueOnce(secondAppend.promise);
        mocks.fetch
            .mockResolvedValueOnce(response(archives))
            .mockResolvedValueOnce(response(games))
            .mockResolvedValueOnce(response(games));

        let settled = false;
        const download = downloadChessCom("player", null).then(() => {
            settled = true;
        });
        await flush();
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.writeTextFile).toHaveBeenNthCalledWith(1, "/db/player_chesscom.pgn", "", {
            append: false,
        });
        truncate.resolve();
        await flush();
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(mocks.writeTextFile).toHaveBeenCalledTimes(2);
        expect(mocks.writeTextFile).toHaveBeenNthCalledWith(2, "/db/player_chesscom.pgn", "", {
            append: true,
        });
        firstAppend.resolve();
        await flush();
        expect(mocks.fetch).toHaveBeenCalledTimes(3);
        expect(mocks.writeTextFile).toHaveBeenCalledTimes(3);
        expect(mocks.writeTextFile).toHaveBeenNthCalledWith(3, "/db/player_chesscom.pgn", "", {
            append: true,
        });
        expect(settled).toBe(false);
        secondAppend.resolve();
        await download;
        expect(settled).toBe(true);
    });

    it("propagates truncate and append write failures", async () => {
        mocks.fetch.mockResolvedValueOnce(response(archives));
        mocks.writeTextFile.mockRejectedValueOnce(new Error("truncate failed"));
        await expect(downloadChessCom("player", null)).rejects.toThrow("truncate failed");

        mocks.fetch.mockReset();
        mocks.writeTextFile.mockReset();
        mocks.fetch
            .mockResolvedValueOnce(response(archives))
            .mockResolvedValueOnce(response(games));
        mocks.writeTextFile
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("append failed"));
        await expect(downloadChessCom("player", null)).rejects.toThrow("append failed");
    });
});
