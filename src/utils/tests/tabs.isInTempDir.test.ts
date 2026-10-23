import { tempDir } from "@tauri-apps/api/path";
import { platform } from "@tauri-apps/plugin-os";
import { describe, expect, test, vi } from "vitest";
import { isInTempDir } from "@/utils/tabs";

vi.mock("@tauri-apps/api/path", () => ({ tempDir: vi.fn<typeof tempDir>() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn<typeof platform>() }));

describe("temporary game file classification", () => {
    test.each([
        ["linux", "/tmp/", "/tmp/game.pgn", true],
        ["linux", "/tmp/", "/TMP/game.pgn", false],
        ["linux", "/Tmp/", "/tmp/game.pgn", false],
        ["linux", "/tmp/", "/tmp\\game.pgn", false],
        ["linux", "/tmp", "/tmp/game.pgn", true],
        ["linux", "/tmp", "/tmp-extra/game.pgn", false],
        ["linux", "/tmp/", "/tmp-extra/game.pgn", false],
        ["linux", "/tmp//", "/tmp//game.pgn", true],
        ["linux", "/", "/games/game.pgn", true],
        ["windows", "C:\\Temp\\", "c:\\TEMP\\game.pgn", true],
        ["windows", "C:\\Temp\\", "C:/Temp/game.pgn", true],
        ["windows", "C:\\Temp", "C:\\Temp-extra\\game.pgn", false],
        ["windows", "C:\\Temp", "C:\\Temp\\game.pgn", true],
        ["windows", "C:\\Temp\\", "D:\\Temp\\game.pgn", false],
        ["windows", "C:\\", "C:/game.pgn", true],
        ["windows", "\\\\server\\share\\Temp\\", "//SERVER/share/temp/game.pgn", true],
        ["macos", "/var/Temp/", "/VAR/temp/game.pgn", true],
    ] as const)("%s temp %s classifies %s as %s", async (os, directory, file, expected) => {
        vi.mocked(platform).mockReturnValue(os);
        vi.mocked(tempDir).mockResolvedValue(directory);
        await expect(isInTempDir(file)).resolves.toBe(expected);
    });
});
