// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig, ProgressItem, Result } from "@/bindings";
import { enginesAtom } from "@/state/atoms";
import { type Engine, engineSchema, type LocalEngine } from "@/utils/engines";
import AddEngine from "../AddEngine";

const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn<(...args: unknown[]) => Promise<Result<null, string>>>(),
  setFileAsExecutable: vi.fn<(path: string) => Promise<Result<null, string>>>(),
  getEngineConfig: vi.fn<(path: string) => Promise<Result<EngineConfig, string>>>(),
  getProgress: vi.fn<(id: string) => Promise<ProgressItem | null>>(),
  clearProgress: vi.fn<(id: string) => Promise<void>>(),
  appDataDir: vi.fn<() => Promise<string>>(),
  resolve: vi.fn<(...paths: string[]) => Promise<string>>(),
  join: vi.fn<(...paths: string[]) => Promise<string>>(),
  exists: vi.fn<(path: string) => Promise<boolean>>(),
  mkdir: vi.fn<(...args: unknown[]) => Promise<void>>(),
  readTextFile: vi.fn<(path: string) => Promise<string>>(),
  writeTextFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  remove: vi.fn(),
  notify: vi.fn(),
  log: vi.fn<(...args: unknown[]) => Promise<void>>(),
  catalog: [] as LocalEngine[],
  listeners: new Set<(event: { payload: ProgressItem }) => void>(),
}));

vi.mock("@/bindings", () => ({
  commands: mocks,
  events: {
    progressEvent: {
      listen: async (listener: (event: { payload: ProgressItem }) => void) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
      },
    },
  },
}));
vi.mock("@tauri-apps/api/path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/path")>()),
  appDataDir: mocks.appDataDir,
  resolve: mocks.resolve,
  join: mocks.join,
}));
vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/plugin-fs")>()),
  exists: mocks.exists,
  mkdir: mocks.mkdir,
  readTextFile: mocks.readTextFile,
  writeTextFile: mocks.writeTextFile,
  remove: mocks.remove,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: mocks.log, warn: mocks.log }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/utils/engines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/engines")>()),
  useDefaultEngines: () => ({ defaultEngines: mocks.catalog, isLoading: false }),
}));

const i18n = createInstance();
beforeAll(async () => {
  // Use real translation hooks with key labels, not a mocked application component boundary.
  await i18n.init({ lng: "en", fallbackLng: false, resources: { en: { translation: {} } } });
});

const ok = { status: "ok", data: null } as const;
// Tauri JSON encodes these Rust integers as numbers, despite the generated bigint declaration.
const config = {
  name: "Test engine",
  options: [
    { type: "spin", value: { name: "Threads", default: 2, min: 1, max: 32 } },
    { type: "check", value: { name: "Ponder", default: false } },
  ],
} as unknown as EngineConfig;
const existing: Engine = {
  type: "local",
  id: "existing",
  name: "Existing engine",
  version: "1",
  path: "/existing",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let persisted: Engine[];
async function renderEngine() {
  await act(async () => {
    root.render(
      <Provider store={store}>
        <I18nextProvider i18n={i18n}>
          <MantineProvider env="test">
            <AddEngine opened setOpened={vi.fn()} />
          </MantineProvider>
        </I18nextProvider>
      </Provider>,
    );
  });
  expect(store.get(enginesAtom)).toEqual([existing]);
  // Hydration must not cause a schema repair write that could consume a failure intended for registration.
  expect(mocks.writeTextFile).not.toHaveBeenCalled();
}
function installButton() {
  const button = [...document.querySelectorAll("button")].find((element) =>
    /Common\.(Install|Installed|Downloading|Extracting)/.test(element.textContent ?? ""),
  );
  if (!button) throw new Error("Install button not found");
  return button;
}
async function clickInstall() {
  await act(async () => installButton().click());
}
function expectFailure(message: string, retained: Engine[] = [existing]) {
  expect(store.get(enginesAtom)).toEqual(retained);
  expect(installButton().disabled).toBe(false);
  expect(installButton().textContent).toBe("Common.Install");
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));
  expect(mocks.remove).not.toHaveBeenCalled();
}
function expectSuccess() {
  const registered = store.get(enginesAtom)!;
  expect(registered).toHaveLength(2);
  expect(registered[0]).toEqual(existing);
  expect(registered[1]).toEqual(
    expect.objectContaining({
      name: "Test engine",
      path: "/app/engines/test/engine",
      loaded: true,
      settings: [{ name: "Threads", value: 2 }],
    }),
  );
  expect(registered[1].id).not.toBe("catalog-engine");
  expect(engineSchema.parse(registered[1])).toEqual(registered[1]);
  expect(persisted).toEqual(registered);
  expect(installButton().textContent).toBe("Common.Installed");
  expect(installButton().disabled).toBe(true);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  localStorage.clear();
  sessionStorage.clear();
  mocks.listeners.clear();
  mocks.catalog = [
    {
      id: "catalog-engine",
      type: "local",
      name: "Test engine",
      version: "1",
      path: "test/engine",
      downloadLink: "https://example.test/engine.zip",
    },
  ];
  persisted = [existing];
  mocks.downloadFile.mockResolvedValue(ok);
  mocks.setFileAsExecutable.mockResolvedValue(ok);
  mocks.getEngineConfig.mockResolvedValue({ status: "ok", data: config });
  mocks.getProgress.mockResolvedValue(null);
  mocks.clearProgress.mockResolvedValue(undefined);
  mocks.appDataDir.mockResolvedValue("/app");
  mocks.resolve.mockImplementation(async (...paths) => paths.join("/"));
  mocks.join.mockImplementation(async (...paths) => paths.join("/"));
  mocks.exists.mockResolvedValue(true);
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.readTextFile.mockImplementation(async () => JSON.stringify(persisted));
  mocks.writeTextFile.mockImplementation(async (_path, contents) => {
    persisted = JSON.parse(contents);
  });
  mocks.log.mockResolvedValue(undefined);
  store = createStore();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("engine registration through real Jotai and file storage", () => {
  it("does not resurrect either failed attempt when two registration writes reject together", async () => {
    mocks.catalog.push({ ...mocks.catalog[0], id: "second-catalog", name: "Second engine" });
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    mocks.writeTextFile
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    await renderEngine();
    const buttons = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent === "Common.Install",
    );
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0].click());
    await act(async () => buttons[1].click());
    expect(store.get(enginesAtom)).toHaveLength(3);
    expect(mocks.writeTextFile).toHaveBeenCalledTimes(2);
    await act(async () => {
      firstWrite.reject(new Error("first registration failed"));
      secondWrite.reject(new Error("second registration failed"));
    });
    expect(store.get(enginesAtom)).toEqual([existing]);
    expect(persisted).toEqual([existing]);
    expect(mocks.writeTextFile).toHaveBeenCalledTimes(4);
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe("Common.Install");
    }
  });

  it("keeps the optimistic candidate busy and not Installed until the actual file write succeeds", async () => {
    const writing = deferred<void>();
    mocks.writeTextFile.mockImplementationOnce(async (_path, contents) => {
      await writing.promise;
      persisted = JSON.parse(contents);
    });
    await renderEngine();
    await clickInstall();
    expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeTextFile.mock.calls[0][0]).toBe("/app/engines/engines.json");
    expect(store.get(enginesAtom)).toHaveLength(2);
    expect(persisted).toEqual([existing]);
    expect(installButton().disabled).toBe(true);
    expect(installButton().textContent).not.toBe("Common.Installed");
    await clickInstall();
    expect(mocks.downloadFile).toHaveBeenCalledTimes(1);
    await act(async () => writing.resolve());
    expectSuccess();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("compensates only the attempted UUID after a write failure, then persists one candidate on retry", async () => {
    const writing = deferred<void>();
    mocks.writeTextFile.mockReturnValueOnce(writing.promise);
    await renderEngine();
    await clickInstall();
    const attempted = store.get(enginesAtom)!.find((engine) => engine.id !== existing.id)!;
    const failure = new Error("registration write failed");
    await act(async () => writing.reject(failure));
    expectFailure(failure.message);
    expect(mocks.log).toHaveBeenCalledExactlyOnceWith(failure.message);
    expect(persisted).toEqual([existing]);
    expect(mocks.writeTextFile).toHaveBeenCalledTimes(2);
    await clickInstall();
    expectSuccess();
    expect(store.get(enginesAtom)!.some((engine) => engine.id === attempted.id)).toBe(false);
    expect(mocks.writeTextFile).toHaveBeenCalledTimes(3);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("contains failed compensation, retains a concurrent same-name/path engine and releases busy", async () => {
    const writing = deferred<void>();
    const repairing = deferred<void>();
    mocks.writeTextFile.mockReturnValueOnce(writing.promise);
    await renderEngine();
    await clickInstall();
    const attempted = store.get(enginesAtom)!.find((engine) => engine.id !== existing.id)!;
    const unrelated: Engine = { ...attempted, id: "concurrent-engine" };
    // This write completes before compensation. A captured array, name or path rollback would lose it.
    await act(async () => {
      await store.set(enginesAtom, async (prev) => [...(await prev), unrelated]);
    });
    expect(persisted.map((engine) => engine.id)).toEqual([existing.id, attempted.id, unrelated.id]);
    mocks.writeTextFile.mockReturnValueOnce(repairing.promise);
    await act(async () => writing.reject(new Error("primary registration failure")));
    expect(store.get(enginesAtom)).toEqual([existing, unrelated]);
    expect(installButton().disabled).toBe(true);
    expect(installButton().textContent).not.toBe("Common.Installed");
    expect(mocks.notify).not.toHaveBeenCalled();
    await act(async () => repairing.reject(new Error("compensation write failure")));
    expect(store.get(enginesAtom)).toEqual([existing, unrelated]);
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "primary registration failure" }),
    );
    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining("compensation write failure"));
    expect(mocks.log).toHaveBeenCalledWith("primary registration failure");
    expect(mocks.log).toHaveBeenCalledTimes(2);
    // The retained same-name engine legitimately shows Installed, so remove only that test-owned
    // concurrent engine through the real setter to expose idle/retryability, not optimistic residue.
    await act(async () => {
      await store.set(enginesAtom, async (prev) =>
        (await prev).filter((engine) => engine.id !== unrelated.id),
      );
    });
    expectFailure("primary registration failure");
    await clickInstall();
    expectSuccess();
    expect(mocks.downloadFile).toHaveBeenCalledTimes(2);
  });

  for (const boundary of ["storage path", "storage mkdir", "write"] as const) {
    it(`propagates ${boundary} rejection through production file storage and allows retry`, async () => {
      await renderEngine();
      const failure = new Error(`${boundary} failed`);
      if (boundary === "storage path") {
        mocks.resolve.mockImplementation(async (...paths) => {
          if (paths.at(-1) === "engines.json") throw failure;
          return paths.join("/");
        });
      } else if (boundary === "storage mkdir") {
        // Installer directory exists, but storage must create its parent on this later check.
        mocks.exists
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);
        mocks.mkdir.mockRejectedValueOnce(failure);
      } else mocks.writeTextFile.mockRejectedValueOnce(failure);
      await clickInstall();
      expectFailure(failure.message);
      expect(mocks.mkdir.mock.calls).toEqual(
        boundary === "storage mkdir" ? [["/app/engines", { recursive: true }]] : [],
      );
      expect(mocks.writeTextFile).toHaveBeenCalledTimes(
        boundary === "storage path" ? 0 : boundary === "storage mkdir" ? 1 : 2,
      );
      if (boundary === "storage path") {
        mocks.resolve.mockImplementation(async (...paths) => paths.join("/"));
      }
      await clickInstall();
      expectSuccess();
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    });
  }

  for (const boundary of ["appDataDir", "mkdir"] as const) {
    it(`rejects installation directory ${boundary} failures before downloading`, async () => {
      await renderEngine();
      const failure = new Error(`${boundary} failed`);
      if (boundary === "appDataDir") mocks.appDataDir.mockRejectedValueOnce(failure);
      else {
        mocks.exists.mockResolvedValueOnce(false);
        mocks.mkdir.mockRejectedValueOnce(failure);
      }
      await clickInstall();
      expectFailure(failure.message);
      expect(mocks.downloadFile).not.toHaveBeenCalled();
      expect(mocks.writeTextFile).not.toHaveBeenCalled();
      await clickInstall();
      expectSuccess();
    });
  }

  it("compensates a JSON serialization failure without deleting the downloaded file", async () => {
    // BigInt is deliberately a failure fixture, never a JSON persistence success fixture.
    const invalid: EngineConfig = {
      name: "Test engine",
      options: [
        {
          type: "spin",
          value: { name: "Threads", default: BigInt(2), min: BigInt(1), max: BigInt(32) },
        },
      ],
    };
    mocks.getEngineConfig.mockResolvedValueOnce({ status: "ok", data: invalid });
    await renderEngine();
    await clickInstall();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const message: string = mocks.notify.mock.calls[0][0].message;
    expect(message).toMatch(/BigInt/i);
    expectFailure(message);
    expect(mocks.writeTextFile).toHaveBeenCalledExactlyOnceWith(
      "/app/engines/engines.json",
      JSON.stringify([existing], null, 4),
    );
    expect(persisted).toEqual([existing]);
    await clickInstall();
    expectSuccess();
  });
});
