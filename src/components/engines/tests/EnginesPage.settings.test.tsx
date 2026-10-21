// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { SWRConfig } from "swr";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig, Result } from "@/bindings";
import { enginesAtom } from "@/state/atoms";
import { type Engine, type EngineSettings, engineSchema, type LocalEngine } from "@/utils/engines";
import EnginesPage from "../EnginesPage";

const mocks = vi.hoisted(() => ({
  getEngineConfig: vi.fn<(path: string) => Promise<Result<EngineConfig, string>>>(),
  readTextFile: vi.fn<(path: string) => Promise<string>>(),
  writeTextFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  navigate: vi.fn<() => void>(),
}));
// Only native and route boundaries are mocked. Controls, SWR, Jotai and schemas stay real.
vi.mock("@/bindings", () => ({ commands: { getEngineConfig: mocks.getEngineConfig }, events: {} }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/routes/engines", () => ({ Route: { useSearch: () => ({ selected: 0 }) } }));
vi.mock("@tauri-apps/api/path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/path")>()),
  appDataDir: async () => "/app",
  resolve: async (...parts: string[]) => parts.join("/"),
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/plugin-fs")>()),
  exists: async () => true,
  mkdir: vi.fn<typeof import("@tauri-apps/plugin-fs").mkdir>(),
  readTextFile: mocks.readTextFile,
  writeTextFile: mocks.writeTextFile,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn<typeof import("@tauri-apps/plugin-dialog").open>(),
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn<typeof import("@tauri-apps/plugin-log").error>(),
  warn: vi.fn<typeof import("@tauri-apps/plugin-log").warn>(),
}));

const i18n = createInstance();
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeAll(async () => {
  // jsdom has no scrolling layout, but Mantine's real combobox calls this browser API.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn<HTMLElement["scrollIntoView"]>(),
  });
  await i18n.init({ lng: "en", fallbackLng: false, resources: { en: { translation: {} } } });
});
afterAll(() => {
  if (scrollIntoView)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

// Real Tauri JSON uses numbers for these Rust integers, not the generated bigint type.
const config = {
  name: "Test engine",
  options: [
    { type: "spin", value: { name: "MultiPV", default: 1, min: 1, max: 10 } },
    { type: "spin", value: { name: "Threads", default: 2, min: 1, max: 32 } },
    { type: "spin", value: { name: "Hash", default: 16, min: 1, max: 1024 } },
    { type: "spin", value: { name: "Elo", default: 1500, min: 0, max: 3000 } },
    { type: "spin", value: { name: "SelfElo", default: 1200, min: 0, max: 3000 } },
    { type: "spin", value: { name: "OppoElo", default: 1300, min: 0, max: 3000 } },
    { type: "spin", value: { name: "Skill Level", default: 0, min: 0, max: 20 } },
    { type: "check", value: { name: "Ponder", default: false } },
    { type: "combo", value: { name: "Style", default: "Normal", var: ["Normal", "Aggressive"] } },
    { type: "string", value: { name: "Note", default: "" } },
    { type: "spin", value: { name: "UntouchedSpin", default: 0, min: 0, max: 10 } },
    { type: "check", value: { name: "UntouchedCheck", default: false } },
    { type: "combo", value: { name: "UntouchedCombo", default: "A", var: ["A", "B"] } },
    { type: "string", value: { name: "UntouchedString", default: "" } },
    { type: "check", value: { name: "UCI_Chess960", default: false } },
    { type: "button", value: { name: "Clear Hash" } },
  ],
} as unknown as EngineConfig;
const required: EngineSettings = [
  { name: "MultiPV", value: 1 },
  { name: "Threads", value: 2 },
  { name: "Hash", value: 16 },
];
const initialSettings: EngineSettings = [...required, { name: "Unrelated", value: "keep" }];
const engine: LocalEngine = {
  type: "local",
  id: "settings-engine",
  name: "Test engine",
  version: "1",
  path: "/engines/test",
  settings: initialSettings,
};
const otherEngine: LocalEngine = { ...engine, id: "other-engine", name: "Other engine" };
let root: Root;
let container: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let persistedJSON: string;

async function renderPage() {
  const cache = new Map();
  await act(async () => {
    root.render(
      <Provider store={store}>
        <SWRConfig value={{ provider: () => cache }}>
          <I18nextProvider i18n={i18n}>
            <MantineProvider env="test">
              <EnginesPage />
            </MantineProvider>
          </I18nextProvider>
        </SWRConfig>
      </Provider>,
    );
  });
  expect(input("SelfElo").value).not.toBe("");
}
function input(name: string): HTMLInputElement {
  const label = [...document.querySelectorAll("label")].find((label) => label.textContent === name);
  const element = label && document.getElementById(label.htmlFor);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Input not found: ${name}`);
  return element;
}
async function change(name: string, value: string) {
  await act(async () => {
    const element = input(name);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input(name).value).toBe(value);
}
async function select(name: string, value: string) {
  await act(async () => input(name).click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent === value,
  );
  expect(option).toBeDefined();
  await act(async () => option!.click());
  expect(input(name).value).toBe(value);
}
function expectSettings(expected: EngineSettings) {
  const stored: Engine[] = JSON.parse(persistedJSON);
  expect(stored).toEqual([{ ...engine, settings: expected }, otherEngine]);
  expect(store.get(enginesAtom)).toEqual(stored);
  expect(engineSchema.parse(stored[0])).toEqual(stored[0]);
  expect(new Set(stored[0].settings!.map((setting) => setting.name)).size).toBe(expected.length);
  for (const [path, contents] of mocks.writeTextFile.mock.calls) {
    expect(path).toBe("/app/engines/engines.json");
    expect(JSON.parse(contents)[1]).toEqual(otherEngine);
  }
}
async function reopen(expected: EngineSettings) {
  const capturedJSON = persistedJSON;
  const reads = mocks.readTextFile.mock.calls.length;
  const configs = mocks.getEngineConfig.mock.calls.length;
  const writes = mocks.writeTextFile.mock.calls.length;
  await act(async () => root.unmount());
  store = createStore();
  root = createRoot(container);
  await renderPage();
  expect(mocks.readTextFile.mock.calls.length).toBeGreaterThan(reads);
  expect(mocks.getEngineConfig.mock.calls.length).toBe(configs + 1);
  expect(mocks.writeTextFile).toHaveBeenCalledTimes(writes);
  expect(persistedJSON).toBe(capturedJSON);
  expectSettings(expected);
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
      addEventListener: vi.fn<MediaQueryList["addEventListener"]>(),
      removeEventListener: vi.fn<MediaQueryList["removeEventListener"]>(),
    })),
  );
  localStorage.clear();
  sessionStorage.clear();
  persistedJSON = JSON.stringify([engine, otherEngine]);
  mocks.getEngineConfig.mockResolvedValue({ status: "ok", data: config });
  mocks.readTextFile.mockImplementation(async () => persistedJSON);
  mocks.writeTextFile.mockImplementation(async (_path, contents) => {
    persistedJSON = contents;
  });
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

describe("explicit engine settings through real controls and in-memory native file boundaries", () => {
  it("does not write untouched optional defaults, render buttons, or enable UCI_Chess960", async () => {
    await renderPage();
    expectSettings(initialSettings);
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(input("Elo").value).toBe("1500");
    expect(input("SelfElo").value).toBe("1200");
    expect(input("OppoElo").value).toBe("1300");
    expect(input("UCI_Chess960").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Clear Hash");
    await reopen(initialSettings);
  });

  it("materializes only missing required advertised defaults", async () => {
    persistedJSON = JSON.stringify([{ ...engine, settings: [] }, otherEngine]);
    await renderPage();
    expectSettings(required);
    expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);
    await reopen(required);
  });

  it.each([
    ["Elo", "SelfElo", "OppoElo"],
    ["OppoElo", "SelfElo", "Elo"],
    ["SelfElo", "Elo"],
    ["Elo", "OppoElo"],
  ])("retains independent overrides in edit order %j", async (...names: string[]) => {
    await renderPage();
    const defaults: Record<string, number> = { SelfElo: 1200, OppoElo: 1300 };
    for (const name of names) {
      await change(name, "1800");
      if (name !== "Elo") await change(name, String(defaults[name]));
    }
    const expected = [
      ...initialSettings,
      ...names.map((name) => ({ name, value: name === "Elo" ? 1800 : defaults[name] })),
    ];
    expectSettings(expected);
    await reopen(expected);
    for (const name of names)
      expect(input(name).value).toBe(name === "Elo" ? "1800" : String(defaults[name]));
  });

  it("keeps an alias changed back to 1500 explicit while both channels remain absent", async () => {
    await renderPage();
    await change("Elo", "1800");
    await change("Elo", "1500");
    const expected = [...initialSettings, { name: "Elo", value: 1500 }];
    expectSettings(expected);
    await reopen(expected);
    expect(input("Elo").value).toBe("1500");
  });

  it("never mutates an older settings array or setting object on insertion or replacement", async () => {
    await renderPage();
    const beforeInsert = store.get(enginesAtom)!;
    const insertSnapshot = structuredClone(beforeInsert);
    await change("Elo", "1800");
    expect(beforeInsert).toEqual(insertSnapshot);
    const beforeReplace = store.get(enginesAtom)!;
    const replaceSnapshot = structuredClone(beforeReplace);
    await change("Elo", "1900");
    expect(beforeReplace).toEqual(replaceSnapshot);
    expect(store.get(enginesAtom)![0].settings).not.toBe(beforeReplace[0].settings);
    expectSettings([...initialSettings, { name: "Elo", value: 1900 }]);
  });

  it("persists spin, check, combo and string defaults including 0, false and empty string", async () => {
    await renderPage();
    await change("Skill Level", "5");
    await change("Skill Level", "0");
    await act(async () => input("Ponder").click());
    expect(input("Ponder").checked).toBe(true);
    await act(async () => input("Ponder").click());
    expect(input("Ponder").checked).toBe(false);
    await select("Style", "Aggressive");
    await select("Style", "Normal");
    await change("Note", "explicit");
    await change("Note", "");
    const expected = [
      ...initialSettings,
      { name: "Skill Level", value: 0 },
      { name: "Ponder", value: false },
      { name: "Style", value: "Normal" },
      { name: "Note", value: "" },
    ];
    expectSettings(expected);
    await reopen(expected);
    expect(input("Skill Level").value).toBe("0");
    expect(input("Ponder").checked).toBe(false);
    expect(input("Style").value).toBe("Normal");
    expect(input("Note").value).toBe("");
  });

  it("resets explicit overrides to required advertised defaults only, including after reopen", async () => {
    await renderPage();
    await change("Elo", "1800");
    await change("SelfElo", "1800");
    await change("SelfElo", "1200");
    await change("OppoElo", "1800");
    await change("OppoElo", "1300");
    await change("Threads", "4");
    const expected = [
      required[0],
      { name: "Threads", value: 4 },
      required[2],
      initialSettings[3],
      { name: "Elo", value: 1800 },
      { name: "SelfElo", value: 1200 },
      { name: "OppoElo", value: 1300 },
    ];
    expectSettings(expected);
    await reopen(expected);
    const reset = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Engines.Settings.Reset",
    );
    expect(reset).toBeDefined();
    await act(async () => reset!.click());
    expectSettings(required);
    await reopen(required);
    expect(input("Elo").value).toBe("1500");
    expect(input("SelfElo").value).toBe("1200");
    expect(input("OppoElo").value).toBe("1300");
  });
});
