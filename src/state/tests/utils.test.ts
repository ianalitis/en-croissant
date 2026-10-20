import type { AsyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAsyncZodStorage } from "../utils";

vi.mock("@tauri-apps/plugin-log", () => ({ warn: vi.fn() }));

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

for (const operation of ["setItem", "removeItem"] as const) {
    describe(`createAsyncZodStorage ${operation}`, () => {
        for (const outcome of ["success", "rejection"] as const) {
            it(`awaits the underlying ${operation} ${outcome} and preserves rejection identity`, async () => {
                const pending = deferred();
                // The source promise is handled even on the pre-fix red run, where the wrapper drops it.
                void pending.promise.catch(() => {});
                const source: AsyncStringStorage = {
                    getItem: vi.fn(async () => null),
                    setItem: vi.fn(() => pending.promise),
                    removeItem: vi.fn(() => pending.promise),
                };
                const storage = createAsyncZodStorage(z.array(z.string()), source);
                const settled = vi.fn();
                const result = Promise.resolve(
                    operation === "setItem"
                        ? storage.setItem("key", ["engine"])
                        : storage.removeItem("key"),
                ).then(
                    () => {
                        settled();
                        return { status: "ok", cause: undefined };
                    },
                    (cause: unknown) => {
                        settled();
                        return { status: "error", cause };
                    },
                );
                await Promise.resolve();
                await Promise.resolve();
                const settledBeforeStorage = settled.mock.calls.length;
                const original = new Error("storage failed");
                if (outcome === "success") pending.resolve();
                else pending.reject(original);
                const final = await result;
                expect(settledBeforeStorage).toBe(0);
                expect(settled).toHaveBeenCalledTimes(1);
                expect(final.status).toBe(outcome === "success" ? "ok" : "error");
                expect(final.cause).toBe(outcome === "success" ? undefined : original);
                expect(source[operation]).toHaveBeenCalledExactlyOnceWith(
                    ...(operation === "setItem"
                        ? ["key", JSON.stringify(["engine"], null, 4)]
                        : ["key"]),
                );
            });
        }
    });
}

it("rejects serialization failures before calling string storage", async () => {
    const original = new Error("serialization failed");
    const setItem = vi.fn(async () => {});
    const storage = createAsyncZodStorage(z.unknown(), {
        getItem: async () => null,
        setItem,
        removeItem: async () => {},
    });
    await expect(
        storage.setItem("key", {
            toJSON() {
                throw original;
            },
        }),
    ).rejects.toBe(original);
    expect(setItem).not.toHaveBeenCalled();
});
