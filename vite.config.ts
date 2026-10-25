/// <reference types="vitest/config" />
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import * as os from "node:os";

const isDebug = !!process.env.TAURI_ENV_DEBUG;
const host = process.env.TAURI_DEV_HOST;

// Cross-compilation must follow the target, not the machine running Vite.
const PLATFORM_ALIASES: Record<string, string> = {
    windows: "win32",
    macos: "darwin",
};
const platform = process.env.TAURI_ENV_PLATFORM || os.platform();

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        tanstackRouter({
            target: "react",
        }),
        react({ compiler: true }),
    ],
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                  protocol: "ws",
                  host,
                  port: 1421,
              }
            : undefined,
        watch: {
            ignored: ["**/src-tauri/**"],
        },
    },
    build: {
        minify: isDebug ? false : "esbuild",
        sourcemap: isDebug ? "inline" : false,
        target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13",
    },
    resolve: {
        alias: {
            "@": resolve(import.meta.dirname, "./src"),
        },
    },
    test: {
        environment: "jsdom",
    },
    define: {
        "import.meta.env.VITE_PLATFORM": JSON.stringify(PLATFORM_ALIASES[platform] ?? platform),
    },
});
