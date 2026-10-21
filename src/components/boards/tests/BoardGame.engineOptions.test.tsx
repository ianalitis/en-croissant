// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { commands, GoMode } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  activeTabAtom,
  currentGameStateAtom,
  enginesAtom,
  gameInputColorAtom,
  gameOpeningBookEnabledAtom,
  gamePlayer1SettingsAtom,
  gamePlayer2SettingsAtom,
  tabsAtom,
} from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import english from "@/translation/en-US.json";
import type { EngineSettings, LocalEngine } from "@/utils/engines";
import BoardGame from "../BoardGame";

const mocks = vi.hoisted(() => ({
  startGame: vi.fn<typeof commands.startGame>(),
  readTextFile: vi.fn<() => Promise<string>>(),
}));
// Native commands and engine-catalog storage never reach Tauri or disk.
vi.mock("@/bindings", () => ({ commands: { startGame: mocks.startGame }, events: {} }));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/test-app",
  resolve: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 0 },
  exists: async () => true,
  mkdir: vi.fn(),
  readTextFile: mocks.readTextFile,
  writeTextFile: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-log", () => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
// Keep BoardGame, OpponentForm, EnginesSelect, Jotai and the tree real.
// Rendering the board and querying an engine's UCI capabilities are outside this boundary.
vi.mock("@/components/boards/Board", () => ({ default: () => null }));
vi.mock("@/components/boards/BoardControls", () => ({ default: () => null }));
vi.mock("@/components/boards/EditingCard", () => ({ default: () => null }));
vi.mock("@/components/common/EngineLogsView", () => ({ default: () => null }));
vi.mock("@/components/common/GameInfo", () => ({ default: () => null }));
vi.mock("@/components/common/GameNotation", () => ({ default: () => null }));
vi.mock("@/components/common/MoveControls", () => ({ default: () => null }));
vi.mock("@/components/panels/analysis/EngineSettingsForm", () => ({ default: () => null }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", fallbackLng: false, resources: { en: english } });
});

const catalogEngine: LocalEngine = {
  type: "local",
  id: "test-engine",
  name: "Test engine",
  version: "1",
  path: "/test-engines/engine",
  settings: [
    { name: "Threads", value: 1 },
    { name: "Hash", value: 16 },
    { name: "UCI_LimitStrength", value: false },
    { name: "UCI_Elo", value: 2500 },
    { name: "Skill Level", value: 20 },
    { name: "MultiPV", value: 3 },
  ],
};
const configuredOptions: EngineSettings = [
  { name: "Threads", value: 4 },
  { name: "Hash", value: 128 },
  { name: "UCI_LimitStrength", value: true },
  { name: "UCI_Elo", value: 1100 },
  { name: "Skill Level", value: 0 },
  { name: "MultiPV", value: 5 },
];
const expectedOptions = [
  { name: "Threads", value: "4" },
  { name: "Hash", value: "128" },
  { name: "UCI_LimitStrength", value: "true" },
  { name: "UCI_Elo", value: "1100" },
  { name: "Skill Level", value: "0" },
];
const nativeStop = new Error("Test stops at the native startGame boundary");
let root: Root;
let container: HTMLDivElement;
let atoms: ReturnType<typeof createStore>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  sessionStorage.clear();
  mocks.readTextFile.mockResolvedValue(JSON.stringify([catalogEngine]));
  mocks.startGame.mockRejectedValue(nativeStop);
  vi.spyOn(console, "error").mockImplementation(() => {});
  atoms = createStore();
  container = document.createElement("div");
  document.body.append(container);
  for (const id of ["left", "topRight", "bottomRight"]) {
    const target = document.createElement("div");
    target.id = id;
    container.append(target);
  }
  root = createRoot(container.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderGame(inputColor: "white" | "black", engine = catalogEngine) {
  mocks.readTextFile.mockResolvedValue(JSON.stringify([engine]));
  atoms.set(tabsAtom, [
    { value: "options-test", name: "Options test", type: "play", gameOrigin: { kind: "none" } },
  ]);
  atoms.set(activeTabAtom, "options-test");
  atoms.set(currentGameStateAtom, "settingUp");
  atoms.set(gameInputColorAtom, inputColor);
  atoms.set(gameOpeningBookEnabledAtom, false);
  atoms.set(gamePlayer1SettingsAtom, { type: "human", name: "Human" });
  atoms.set(gamePlayer2SettingsAtom, {
    type: "engine",
    engine: null,
    go: { t: "Depth", c: 12 },
  });
  await act(async () => {
    root.render(
      <Provider store={atoms}>
        <I18nextProvider i18n={i18n}>
          <MantineProvider env="test">
            <TreeStateContext.Provider value={createTreeStore()}>
              <BoardGame />
            </TreeStateContext.Provider>
          </MantineProvider>
        </I18nextProvider>
      </Provider>,
    );
  });
  expect(atoms.get(gamePlayer2SettingsAtom)).toMatchObject({
    engine: JSON.parse(JSON.stringify(engine)),
    engineSettings: engine.settings,
  });
}

async function clickStartGame() {
  const button = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === i18n.t("Board.Opponent.StartGame"),
  );
  expect(button).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
  expect(mocks.startGame).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledExactlyOnceWith("Failed to start game:", nativeStop);
}

it.each([
  { inputColor: "white", engineColor: "black", limitStrength: true },
  { inputColor: "black", engineColor: "white", limitStrength: true },
  { inputColor: "white", engineColor: "black", limitStrength: false },
  { inputColor: "black", engineColor: "white", limitStrength: false },
] as const)(
  "forwards per-game options to $engineColor with UCI_LimitStrength=$limitStrength",
  async ({ inputColor, engineColor, limitStrength }) => {
    await renderGame(inputColor);
    // Model already-configured per-game settings, not the mocked settings editor's UI.
    await act(async () => {
      atoms.set(gamePlayer2SettingsAtom, (prev) => ({
        ...prev,
        engineSettings: configuredOptions.map((option) =>
          option.name === "UCI_LimitStrength" ? { ...option, value: limitStrength } : option,
        ),
      }));
    });
    await clickStartGame();
    const [gameId, config] = mocks.startGame.mock.calls[0];
    expect(gameId).toBe("options-test-game");
    expect(config[engineColor]).toEqual({
      type: "engine",
      name: catalogEngine.name,
      path: catalogEngine.path,
      options: [
        expectedOptions[0],
        expectedOptions[1],
        { name: "UCI_LimitStrength", value: limitStrength ? "true" : "false" },
        expectedOptions[3],
        expectedOptions[4],
      ],
      go: { t: "Depth", c: 12 },
    });
    expect(config[inputColor]).toEqual({ type: "human", name: "Human" });
  },
);

it.each([
  { t: "Nodes", c: 1 },
  { t: "Depth", c: 28 },
  { t: "Time", c: 5000 },
] satisfies GoMode[])("uses the selected engine's $t default in untimed play", async (go) => {
  await renderGame("white", { ...catalogEngine, go });
  await clickStartGame();
  expect(mocks.startGame.mock.calls[0][1].black).toMatchObject({ go });
});

for (const settings of [
  [
    { name: "Elo", value: 1800 },
    { name: "SelfElo", value: 1200 },
    { name: "OppoElo", value: 1300 },
  ],
  [{ name: "Elo", value: 1500 }],
  [
    { name: "SelfElo", value: 1200 },
    { name: "Elo", value: 1800 },
  ],
  [
    { name: "Elo", value: 1800 },
    { name: "OppoElo", value: 1300 },
  ],
] satisfies EngineSettings[]) {
  it.each([
    { inputColor: "white", engineColor: "black" },
    { inputColor: "black", engineColor: "white" },
  ] as const)(
    `forwards persisted default-valued overrides ${JSON.stringify(settings)} to $engineColor`,
    async ({ inputColor, engineColor }) => {
      const persistedEngine = {
        ...catalogEngine,
        settings: [...settings, { name: "MultiPV", value: 3 }],
      };
      // renderGame hydrates a fresh Jotai store from JSON via the real catalog schema.
      await renderGame(inputColor, persistedEngine);
      expect(mocks.readTextFile).toHaveBeenCalled();
      expect(atoms.get(enginesAtom)).toEqual([persistedEngine]);
      await clickStartGame();
      expect(mocks.startGame.mock.calls[0][1][engineColor]).toEqual({
        type: "engine",
        name: persistedEngine.name,
        path: persistedEngine.path,
        options: settings.map(({ name, value }) => ({ name, value: String(value) })),
        go: { t: "Depth", c: 12 },
      });
      expect(mocks.startGame.mock.calls[0][1][inputColor]).toEqual({
        type: "human",
        name: "Human",
      });
    },
  );
}

it.each([{ t: "Infinite" }, null, undefined] satisfies (GoMode | null | undefined)[])(
  "retains the finite game limit when the engine default is %j",
  async (go) => {
    await renderGame("white", { ...catalogEngine, go });
    await clickStartGame();
    expect(mocks.startGame.mock.calls[0][1].black).toMatchObject({ go: { t: "Depth", c: 12 } });
  },
);

it("preserves a per-game limit when the same engine's catalog defaults change", async () => {
  await renderGame("white");
  await act(async () => {
    atoms.set(gamePlayer2SettingsAtom, (prev) => ({ ...prev, go: { t: "Nodes", c: 7 } }));
    await atoms.set(enginesAtom, [{ ...catalogEngine, go: { t: "Depth", c: 30 } }]);
  });
  await clickStartGame();
  expect(mocks.startGame.mock.calls[0][1].black).toMatchObject({ go: { t: "Nodes", c: 7 } });
});

it("keeps clock-driven play when selecting an engine with a nodes-one default", async () => {
  await renderGame("white", { ...catalogEngine, go: { t: "Nodes", c: 1 } });
  await act(async () => {
    atoms.set(gamePlayer2SettingsAtom, (prev) => ({
      ...prev,
      timeControl: { seconds: 180000, increment: 2000 },
    }));
  });
  await clickStartGame();
  expect(mocks.startGame.mock.calls[0][1].black).toMatchObject({ go: null });
});

it.each([
  { inputColor: "white", engineColor: "black" },
  { inputColor: "black", engineColor: "white" },
] as const)(
  "refreshes stale same-ID catalog settings before starting the $engineColor engine",
  async ({ inputColor, engineColor }) => {
    await renderGame(inputColor);
    const refreshedEngine: LocalEngine = { ...catalogEngine, settings: configuredOptions };
    await act(async () => {
      await atoms.set(enginesAtom, [refreshedEngine]);
    });
    expect(atoms.get(gamePlayer2SettingsAtom)).toMatchObject({
      engine: refreshedEngine,
      engineSettings: configuredOptions,
    });
    await clickStartGame();
    expect(mocks.startGame.mock.calls[0][1][engineColor]).toEqual({
      type: "engine",
      name: refreshedEngine.name,
      path: refreshedEngine.path,
      options: expectedOptions,
      go: { t: "Depth", c: 12 },
    });
  },
);
