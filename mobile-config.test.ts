// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
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
