// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

type Capability = {
    platforms?: string[];
    windows: string[];
    permissions: (string | { identifier: string })[];
};

const directory = new URL("./src-tauri/capabilities/", import.meta.url);
const capabilities: Capability[] = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(new URL(name, directory), "utf8")));
const desktopPermissions = ["cli:default", "updater:default", "window-state:default"];
const androidConfigPath = new URL("./src-tauri/tauri.android.conf.json", import.meta.url);
const androidConfig = existsSync(androidConfigPath)
    ? JSON.parse(readFileSync(androidConfigPath, "utf8"))
    : {};

it("resolves the Android Gradle callback from its configured working directory", () => {
    const androidDirectory = new URL("./src-tauri/gen/android/", import.meta.url);
    const gradle = readFileSync(new URL("app/build.gradle.kts", androidDirectory), "utf8");
    const task = readFileSync(
        new URL("buildSrc/src/main/java/org/encroissant/app/kotlin/BuildTask.kt", androidDirectory),
        "utf8",
    );
    const rootDirRel = gradle.match(/rootDirRel = "([^"]+)"/)?.[1];
    const argsList = task.match(/val args = listOf\(([^)]+)\)/)?.[1];
    expect(task).toContain('val executable = """node"""');
    expect(rootDirRel).toBeDefined();
    expect(argsList).toBeDefined();
    const args = [...(argsList ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(args.slice(1)).toEqual(["android", "android-studio-script"]);
    const result = spawnSync(process.execPath, [...args, "--help"], {
        cwd: new URL(rootDirRel ?? "", new URL("app/", androidDirectory)),
        encoding: "utf8",
        timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("android-studio-script");
});

it("removes unsupported native resources from the Android merge patch", () => {
    expect(androidConfig.bundle?.resources).toEqual({
        "../aixchess.duckdb_extension": null,
        "resources/vision/": null,
    });
    expect(androidConfig.build?.beforeBuildCommand).toContain("vite.js build");
    expect(androidConfig.build?.beforeBuildCommand).toContain("tsc --noEmit");
    expect(androidConfig.build?.beforeBuildCommand).not.toContain("prepare:aix");
    expect(androidConfig.build?.beforeDevCommand).toBe("node node_modules/vite/bin/vite.js");
});

function permissionsFor(platform: string) {
    return capabilities
        .filter((capability) => capability.windows.includes("main"))
        .filter((capability) => !capability.platforms || capability.platforms.includes(platform))
        .flatMap((capability) => capability.permissions)
        .map((permission) => (typeof permission === "string" ? permission : permission.identifier));
}

it.each(["android", "iOS"])("does not request desktop plugins on %s", (platform) => {
    const permissions = permissionsFor(platform);
    for (const permission of desktopPermissions) {
        expect(permissions).not.toContain(permission);
    }
    expect(permissions).toContain("fs:default");
    expect(permissions).toContain("dialog:default");
});

it.each(["macOS", "windows", "linux"])("preserves desktop plugin access on %s", (platform) => {
    const permissions = permissionsFor(platform);
    for (const permission of desktopPermissions) {
        expect(permissions).toContain(permission);
    }
});
