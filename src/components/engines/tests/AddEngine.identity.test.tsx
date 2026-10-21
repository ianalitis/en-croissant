import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import { enginesAtom } from "@/state/atoms";
import type { Engine } from "@/utils/engines";
import AddEngine from "../AddEngine";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  getEngineConfig: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/bindings", () => ({ commands: mocks }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-log", () => ({ warn: mocks.warn, error: mocks.warn }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tauri-apps/api/path", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/path")>()),
  resolve: async (...paths: string[]) => paths.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", async (original) => ({
  ...(await original<typeof import("@tauri-apps/plugin-fs")>()),
  readTextFile: mocks.readTextFile,
  writeTextFile: mocks.writeTextFile,
  exists: async () => true,
}));
vi.mock("@/utils/directories", async (original) => ({
  ...(await original<typeof import("@/utils/directories")>()),
  getEnginesDir: async () => "/engines",
}));
vi.mock("@/utils/engines", async (original) => ({
  ...(await original<typeof import("@/utils/engines")>()),
  useDefaultEngines: () => ({ defaultEngines: [], isLoading: false }),
}));

const first: Engine = {
  type: "local",
  id: "shared-engine-id",
  name: "First engine",
  version: "1",
  path: "/first",
  settings: [{ name: "Threads", value: 2 }],
};
const second: Engine = {
  ...first,
  name: "Second engine",
  path: "/second",
  settings: [{ name: "Threads", value: 4 }],
};

let root: Root;
let container: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let persisted: Engine[];

async function render(children: ReactNode) {
  await act(async () => {
    root.render(
      <Provider store={store}>
        <MantineProvider env="test">{children}</MantineProvider>
      </Provider>,
    );
  });
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
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  localStorage.clear();
  sessionStorage.clear();
  persisted = [];
  mocks.readTextFile.mockImplementation(async () => JSON.stringify(persisted));
  mocks.writeTextFile.mockImplementation(async (_path, contents) => {
    persisted = JSON.parse(contents);
  });
  mocks.warn.mockResolvedValue(undefined);
  store = createStore();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("assigns a fresh ID to each manual submission while the Add Engine form stays mounted", async () => {
  await render(<AddEngine opened setOpened={vi.fn()} />);
  const localTab = [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
    (button) => button.textContent === "Common.Local",
  )!;
  await act(async () => localTab.click());

  for (const [name, path] of [
    ["First manual engine", "/manual/first"],
    ["Second manual engine", "/manual/second"],
  ]) {
    mocks.open.mockResolvedValueOnce(path);
    mocks.getEngineConfig.mockResolvedValueOnce({ status: "ok", data: { name, options: [] } });
    const form = document.querySelector("form")!;
    await act(async () => form.querySelector<HTMLButtonElement>("button[type=button]")!.click());
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  const engines = store.get(enginesAtom)!;
  expect(engines.map((engine) => engine.name)).toEqual([
    "First manual engine",
    "Second manual engine",
  ]);
  expect(new Set(engines.map((engine) => engine.id)).size).toBe(2);
  expect(persisted).toEqual(engines);
  await render(<EnginesSelect engine={null} setEngine={vi.fn()} />);
  expect(document.querySelector("input")).not.toBeNull();
});

it("repairs persisted ID collisions without dropping records and persists stable replacement IDs", async () => {
  persisted = [first, second];
  const setEngine = vi.fn();
  await render(<EnginesSelect engine={null} setEngine={setEngine} />);
  const engines = store.get(enginesAtom)!;
  expect(engines).toHaveLength(2);
  expect(engines[0]).toEqual(first);
  expect(engines[1]).toEqual({ ...second, id: expect.any(String) });
  expect(engines[1].id).not.toBe(first.id);
  expect(persisted).toEqual(engines);
  expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);

  setEngine.mockClear();
  await act(async () => document.querySelector<HTMLInputElement>("input")!.click());
  const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find(
    (element) => element.textContent === second.name,
  )!;
  await act(async () => option.click());
  expect(setEngine).toHaveBeenLastCalledWith(engines[1]);

  store = createStore();
  await render(<EnginesSelect engine={null} setEngine={vi.fn()} />);
  expect(store.get(enginesAtom)).toEqual(engines);
  expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);
});

it("does not rewrite engine collections whose IDs are already unique", async () => {
  persisted = [first, { ...second, id: "second-engine-id" }];
  await render(<EnginesSelect engine={null} setEngine={vi.fn()} />);
  expect(store.get(enginesAtom)).toEqual(persisted);
  expect(mocks.writeTextFile).not.toHaveBeenCalled();
});

it.each([false, true])(
  "retains valid repaired engines when writeback fails (logging also fails: %s)",
  async (loggingFails) => {
    const original = [first, second];
    const logFailure = new Error("logging failed");
    const consoleError = loggingFails
      ? vi.spyOn(console, "error").mockImplementation(() => {})
      : undefined;
    if (loggingFails) mocks.warn.mockRejectedValueOnce(logFailure);
    persisted = original;
    mocks.writeTextFile.mockRejectedValueOnce(new Error("repair write failed"));
    await render(<EnginesSelect engine={null} setEngine={vi.fn()} />);
    const engines = store.get(enginesAtom)!;
    expect(engines).toHaveLength(2);
    expect(engines[0]).toEqual(first);
    expect(engines[1]).toEqual({ ...second, id: expect.any(String) });
    expect(engines[1].id).not.toBe(first.id);
    expect(persisted).toEqual(original);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("repair write failed"));
    if (consoleError) expect(consoleError).toHaveBeenCalledExactlyOnceWith(logFailure);
  },
);

it("preserves later unique IDs and remote records even when a generated replacement collides", async () => {
  const reserved = "00000000-0000-4000-8000-000000000001";
  const replacement = "00000000-0000-4000-8000-000000000002";
  const remoteReplacement = "00000000-0000-4000-8000-000000000003";
  const later: Engine = { ...first, id: reserved, name: "Later engine", path: "/later" };
  const remote: Engine = {
    type: "chessdb",
    id: first.id,
    name: "Remote engine",
    url: "https://example.test",
  };
  persisted = [first, second, later, remote];
  vi.spyOn(crypto, "randomUUID")
    .mockReturnValueOnce(reserved)
    .mockReturnValueOnce(replacement)
    .mockReturnValueOnce(remoteReplacement);
  await render(<EnginesSelect engine={null} setEngine={vi.fn()} />);
  expect(store.get(enginesAtom)).toEqual([
    first,
    { ...second, id: replacement },
    later,
    { ...remote, id: remoteReplacement },
  ]);
  expect(persisted).toEqual(store.get(enginesAtom));
});

it("still rejects ordinary engine writes when persistence fails", async () => {
  persisted = [first];
  await render(<EnginesSelect engine={null} setEngine={vi.fn()} />);
  mocks.writeTextFile.mockRejectedValueOnce(new Error("ordinary write failed"));
  await act(async () => {
    await expect(store.set(enginesAtom, [first, { ...second, id: "new-engine" }])).rejects.toThrow(
      "ordinary write failed",
    );
  });
  expect(persisted).toEqual([first]);
  expect(mocks.warn).not.toHaveBeenCalled();
});
