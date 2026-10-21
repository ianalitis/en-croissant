import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    writeTextFile: vi.fn(),
    resolve: vi.fn(async (...parts: string[]) => parts.join("/")),
    emit: vi.fn(),
    error: vi.fn(),
    notify: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: mocks.writeTextFile }));
vi.mock("@tauri-apps/api/path", () => ({ resolve: mocks.resolve }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: mocks.error, info: vi.fn() }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
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

describe.each([0, 1])("downloadChessCom malformed archive at index %i", (failedIndex) => {
    it.each([
        { status: 429, data: { code: 429, message: "Too many requests" } },
        { status: 200, data: { games: [{ pgn: "incomplete game" }] } },
    ])(
        "rejects HTTP $status data, stops downloading, and permits a clean retry",
        async ({ status, data }) => {
            const monthlyArchives = [...archives.archives, "https://chess.com/2024/03"];
            const failedArchive = monthlyArchives[failedIndex];
            const pgn = "1. e4 e5 *";
            const validGames = {
                games: [
                    {
                        url: "https://www.chess.com/game/live/1",
                        pgn,
                        time_control: "300",
                        end_time: 1704067200,
                        rated: true,
                        initial_setup: "startpos",
                        fen: "startpos",
                        rules: "chess",
                        white: { rating: 1500, result: "draw", username: "player" },
                        black: { rating: 1500, result: "draw", username: "opponent" },
                    },
                ],
            };
            let stagedPgn = "previous download";
            mocks.writeTextFile.mockImplementation(async (_file, content, options) => {
                stagedPgn = options.append ? stagedPgn + content : content;
            });
            mocks.fetch.mockResolvedValueOnce(response({ archives: monthlyArchives }));
            for (let index = 0; index < failedIndex; index++) {
                mocks.fetch.mockResolvedValueOnce(response(validGames));
            }
            mocks.fetch.mockResolvedValueOnce({
                ...response(data),
                ok: status === 200,
                status,
                url: failedArchive,
            });

            await expect(downloadChessCom("player", null)).rejects.toThrow(
                `Invalid Chess.com games response for ${failedArchive}`,
            );
            expect(mocks.fetch).toHaveBeenCalledTimes(failedIndex + 2);
            expect(mocks.fetch).toHaveBeenLastCalledWith(failedArchive, {
                headers: {},
                method: "GET",
            });
            expect(mocks.writeTextFile).toHaveBeenCalledTimes(failedIndex + 1);
            expect(stagedPgn).toBe(pgn.repeat(failedIndex));
            expect(mocks.emit).toHaveBeenCalledTimes(failedIndex);
            expect(mocks.emit).not.toHaveBeenCalledWith(expect.objectContaining({ progress: 100 }));
            expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
                `Failed to fetch Chess.com games: ${status} ${failedArchive}`,
            );
            expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    title: "Failed to fetch Chess.com games",
                    message: `Could not find games for "player" on chess.com for ${failedArchive}`,
                    color: "red",
                }),
            );

            mocks.fetch.mockResolvedValueOnce(response({ archives: monthlyArchives }));
            for (const _archive of monthlyArchives) {
                mocks.fetch.mockResolvedValueOnce(response(validGames));
            }
            await expect(downloadChessCom("player", null)).resolves.toBeUndefined();
            expect(mocks.writeTextFile).toHaveBeenNthCalledWith(
                failedIndex + 2,
                "/db/player_chesscom.pgn",
                "",
                { append: false },
            );
            expect(mocks.fetch).toHaveBeenCalledTimes(failedIndex + 6);
            expect(mocks.writeTextFile).toHaveBeenCalledTimes(failedIndex + 5);
            expect(stagedPgn).toBe(pgn.repeat(monthlyArchives.length));
            expect(mocks.emit).toHaveBeenLastCalledWith({
                finished: false,
                id: "chesscom_player",
                progress: 100,
            });
            expect(mocks.notify).toHaveBeenCalledTimes(1);
        },
    );
});
