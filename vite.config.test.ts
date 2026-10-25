// @vitest-environment node
import { platform } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

it.each([
    ["android", "android"],
    ["ios", "ios"],
    ["windows", "win32"],
    ["macos", "darwin"],
    ["linux", "linux"],
    [undefined, platform()],
    ["", platform()],
])("uses target %s rather than the build host", async (target, expected) => {
    vi.stubEnv("TAURI_ENV_PLATFORM", target);
    vi.resetModules();
    const { default: config } = await import("./vite.config");
    expect(config.define?.["import.meta.env.VITE_PLATFORM"]).toBe(JSON.stringify(expected));
});
