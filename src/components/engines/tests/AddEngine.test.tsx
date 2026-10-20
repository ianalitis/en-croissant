// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig, ProgressItem, Result } from "@/bindings";
import ProgressButton from "@/components/common/ProgressButton";
import { useProgress } from "@/hooks/useProgress";
import type { Engine, LocalEngine } from "@/utils/engines";
import AddEngine from "../AddEngine";

const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn<(...args: unknown[]) => Promise<Result<null, string>>>(),
  setFileAsExecutable: vi.fn<(path: string) => Promise<Result<null, string>>>(),
  getEngineConfig: vi.fn<(path: string) => Promise<Result<EngineConfig, string>>>(),
  getProgress: vi.fn<(id: string) => Promise<ProgressItem | null>>(),
  clearProgress: vi.fn<(id: string) => Promise<void>>(),
  getEnginesDir: vi.fn<() => Promise<string>>(),
  resolve: vi.fn<(...paths: string[]) => Promise<string>>(),
  join: vi.fn<(...paths: string[]) => Promise<string>>(),
  setEngines: vi.fn<(update: (prev: Engine[]) => Promise<Engine[]>) => Promise<void>>(),
  notify: vi.fn(),
  log: vi.fn<(...args: unknown[]) => Promise<void>>(),
  registered: [] as Engine[],
  catalog: [] as LocalEngine[],
  listeners: new Set<(event: { payload: ProgressItem }) => void>(),
}));

vi.mock("@/bindings", () => ({
  commands: mocks,
  events: {
    progressEvent: {
      listen: vi.fn(async (listener: (event: { payload: ProgressItem }) => void) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
      }),
    },
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ resolve: mocks.resolve, join: mocks.join }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: mocks.log }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/utils/directories", () => ({ getEnginesDir: mocks.getEnginesDir }));
vi.mock("@/state/atoms", () => ({ enginesAtom: {} }));
vi.mock("jotai", () => ({ useAtom: () => [mocks.registered, mocks.setEngines] }));
vi.mock("@/utils/engines", () => ({
  requiredEngineSettings: ["MultiPV", "Threads", "Hash"],
  useDefaultEngines: () => ({ defaultEngines: mocks.catalog, isLoading: false }),
}));
vi.mock("@/utils/files", () => ({ usePlatform: () => ({ os: "macos" }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../EngineForm", () => ({ default: () => null }));

const ok = { status: "ok", data: null } as const;
const config = {
  name: "Test engine",
  options: [
    {
      type: "spin",
      value: { name: "Threads", default: BigInt(2), min: BigInt(1), max: BigInt(32) },
    },
    { type: "check", value: { name: "Ponder", default: false } },
  ],
} satisfies EngineConfig;

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
async function render(children: ReactNode) {
  await act(async () => {
    root.render(<MantineProvider env="test">{children}</MantineProvider>);
  });
}
async function renderEngine() {
  await render(<AddEngine opened setOpened={vi.fn()} />);
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
async function emit(progress: number, finished = false, id = "engine_0") {
  await act(async () => {
    for (const listener of mocks.listeners) listener({ payload: { id, progress, finished } });
  });
}
function expectRetryable(message: string) {
  expect(installButton().disabled).toBe(false);
  expect(installButton().textContent).toBe("Common.Install");
  expect(mocks.registered).toEqual([]);
  expect(mocks.setEngines).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));
  expect(mocks.log).toHaveBeenCalledExactlyOnceWith(message);
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
  mocks.listeners.clear();
  mocks.registered = [];
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
  mocks.downloadFile.mockResolvedValue(ok);
  mocks.setFileAsExecutable.mockResolvedValue(ok);
  mocks.getEngineConfig.mockResolvedValue({ status: "ok", data: config });
  mocks.getProgress.mockResolvedValue(null);
  mocks.clearProgress.mockResolvedValue(undefined);
  mocks.log.mockResolvedValue(undefined);
  mocks.getEnginesDir.mockResolvedValue("/engines/");
  mocks.resolve.mockImplementation(async (...paths) => paths.join("/"));
  mocks.join.mockImplementation(async (...paths) => paths.join("/"));
  mocks.setEngines.mockImplementation(async (update) => {
    mocks.registered = await update(mocks.registered);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("engine installation", () => {
  for (const failure of ["Result", "rejection"] as const) {
    for (const step of ["downloadFile", "setFileAsExecutable", "getEngineConfig"] as const) {
      it(`stops on ${step} ${failure}, reports once and allows retry`, async () => {
        const message = `${step} failed`;
        if (failure === "Result")
          mocks[step].mockResolvedValueOnce({ status: "error", error: message });
        else mocks[step].mockRejectedValueOnce(new Error(message));
        await renderEngine();
        await clickInstall();
        expectRetryable(message);
        expect(mocks.join).toHaveBeenCalledTimes(step === "downloadFile" ? 0 : 1);
        expect(mocks.setFileAsExecutable).toHaveBeenCalledTimes(step === "downloadFile" ? 0 : 1);
        expect(mocks.getEngineConfig).toHaveBeenCalledTimes(step === "getEngineConfig" ? 1 : 0);
        await clickInstall();
        expect(mocks.setEngines).toHaveBeenCalledTimes(1);
        expect(mocks.registered).toHaveLength(1);
        expect(installButton().textContent).toBe("Common.Installed");
        expect(mocks.notify).toHaveBeenCalledTimes(1);
      });
    }
  }
  for (const step of ["getEnginesDir", "resolve", "join"] as const) {
    it(`handles a rejected ${step} path operation`, async () => {
      mocks[step].mockRejectedValueOnce(new Error(`${step} failed`));
      await renderEngine();
      await clickInstall();
      expectRetryable(`${step} failed`);
      expect(mocks.setFileAsExecutable).not.toHaveBeenCalled();
      expect(mocks.getEngineConfig).not.toHaveBeenCalled();
      expect(mocks.downloadFile).toHaveBeenCalledTimes(step === "join" ? 1 : 0);
    });
  }
  it("clears partial progress after failure and installs on retry with preserved settings/path", async () => {
    const download = deferred<Result<null, string>>();
    mocks.downloadFile.mockReturnValueOnce(download.promise);
    await renderEngine();
    await clickInstall();
    await emit(42);
    expect(installButton().disabled).toBe(true);
    await act(async () => download.resolve({ status: "error", error: "partial download" }));
    expectRetryable("partial download");
    await clickInstall();
    expect(mocks.registered).toEqual([
      expect.objectContaining({
        name: "Test engine",
        version: "1",
        path: "/engines/test/engine",
        loaded: true,
        settings: [{ name: "Threads", value: BigInt(2) }],
      }),
    ]);
    expect(mocks.downloadFile).toHaveBeenLastCalledWith(
      "engine_0",
      "https://example.test/engine.zip",
      "/engines/",
      null,
      null,
      null,
    );
    expect(mocks.setEngines).toHaveBeenCalledTimes(1);
  });
  it("stays busy after download finished until chmod and configuration finish", async () => {
    const chmod = deferred<Result<null, string>>();
    const configuration = deferred<Result<EngineConfig, string>>();
    mocks.setFileAsExecutable.mockReturnValueOnce(chmod.promise);
    mocks.getEngineConfig.mockReturnValueOnce(configuration.promise);
    await renderEngine();
    await clickInstall();
    await emit(100, true);
    expect(installButton().disabled).toBe(true);
    expect(installButton().textContent).not.toBe("Common.Installed");
    expect(mocks.setEngines).not.toHaveBeenCalled();
    await act(async () => chmod.resolve(ok));
    expect(installButton().disabled).toBe(true);
    expect(installButton().textContent).not.toBe("Common.Installed");
    await act(async () => configuration.resolve({ status: "ok", data: config }));
    expect(installButton().textContent).toBe("Common.Installed");
    expect(mocks.setEngines).toHaveBeenCalledTimes(1);
  });
  it("awaits the registration setter before marking the action complete", async () => {
    const registration = deferred<void>();
    mocks.setEngines.mockReturnValueOnce(registration.promise);
    await renderEngine();
    await clickInstall();
    await emit(100, true);
    expect(installButton().textContent).not.toBe("Common.Installed");
    expect(installButton().disabled).toBe(true);
    await act(async () => registration.resolve());
    expect(installButton().textContent).toBe("Common.Installed");
  });
  it("contains a rejected registration setter", async () => {
    mocks.setEngines.mockRejectedValueOnce(new Error("registration failed"));
    await renderEngine();
    await clickInstall();
    expect(installButton().disabled).toBe(false);
    expect(installButton().textContent).toBe("Common.Install");
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "registration failed" }),
    );
  });
  it("blocks installation until start-clear resolves and rejects duplicate clicks", async () => {
    const clear = deferred<void>();
    mocks.clearProgress.mockReturnValueOnce(clear.promise);
    await renderEngine();
    await act(async () => {
      installButton().click();
      installButton().click();
    });
    expect(mocks.clearProgress).toHaveBeenCalledTimes(1);
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(installButton().disabled).toBe(true);
    await act(async () => clear.resolve());
    expect(mocks.downloadFile).toHaveBeenCalledTimes(1);
    expect(mocks.setEngines).toHaveBeenCalledTimes(1);
  });
  it("blocks installation when start-clear fails, then allows retry", async () => {
    mocks.clearProgress.mockRejectedValueOnce(new Error("start clear failed"));
    await renderEngine();
    await clickInstall();
    expectRetryable("start clear failed");
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    await clickInstall();
    expect(mocks.setEngines).toHaveBeenCalledTimes(1);
  });
  it("preserves the primary error when cleanup also fails and releases busy", async () => {
    mocks.downloadFile.mockResolvedValueOnce({ status: "error", error: "download failed" });
    mocks.clearProgress
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup failed"));
    await renderEngine();
    await clickInstall();
    expectRetryable("download failed");
    await clickInstall();
    expect(mocks.setEngines).toHaveBeenCalledTimes(1);
  });
  it("keeps successful registration installed when cleanup fails", async () => {
    mocks.clearProgress
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup failed"));
    await renderEngine();
    await clickInstall();
    expect(mocks.registered).toHaveLength(1);
    expect(installButton().textContent).toBe("Common.Installed");
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "cleanup failed" }),
    );
  });
  it("awaits cleanup before allowing a failed action to retry", async () => {
    const cleanup = deferred<void>();
    mocks.clearProgress.mockResolvedValueOnce(undefined).mockReturnValueOnce(cleanup.promise);
    mocks.downloadFile.mockResolvedValueOnce({ status: "error", error: "download failed" });
    await renderEngine();
    await clickInstall();
    expect(installButton().disabled).toBe(true);
    await act(async () => cleanup.resolve());
    expectRetryable("download failed");
  });
  for (const finished of [false, true]) {
    it(`ignores stale initial progress (finished=${finished}) for managed busy/completion`, async () => {
      mocks.getProgress.mockResolvedValueOnce({ id: "engine_0", progress: 80, finished });
      await renderEngine();
      expect(installButton().disabled).toBe(false);
      expect(installButton().textContent).toBe("Common.Install");
      await clickInstall();
      expect(mocks.setEngines).toHaveBeenCalledTimes(1);
    });
  }
  it("disables missing download URLs", async () => {
    mocks.catalog[0].downloadLink = undefined;
    await renderEngine();
    expect(installButton().disabled).toBe(true);
    await clickInstall();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });
  it("preserves already installed engines", async () => {
    mocks.registered = [mocks.catalog[0]];
    await renderEngine();
    expect(installButton().disabled).toBe(true);
    expect(installButton().textContent).toBe("Common.Installed");
  });
});

let progressState: ReturnType<typeof useProgress>;
function ProgressProbe({ id = "engine_0" }: { id?: string }) {
  progressState = useProgress(id);
  return <output>{JSON.stringify(progressState.item)}</output>;
}
describe("progress snapshot ordering", () => {
  it("does not restore a snapshot that resolves after clear", async () => {
    const snapshot = deferred<ProgressItem | null>();
    mocks.getProgress.mockReturnValueOnce(snapshot.promise);
    await render(<ProgressProbe />);
    await act(async () => {
      await progressState.clear();
    });
    await act(async () => snapshot.resolve({ id: "engine_0", progress: 70, finished: false }));
    expect(progressState.item).toBeNull();
  });
  it("does not overwrite a newer matching progress event with an old snapshot", async () => {
    const snapshot = deferred<ProgressItem | null>();
    mocks.getProgress.mockReturnValueOnce(snapshot.promise);
    await render(<ProgressProbe />);
    await emit(80);
    await act(async () => snapshot.resolve({ id: "engine_0", progress: 20, finished: false }));
    expect(progressState.progress).toBe(80);
  });
  it("ignores snapshots and callbacks belonging to the previous id", async () => {
    const snapshot = deferred<ProgressItem | null>();
    mocks.getProgress.mockReturnValueOnce(snapshot.promise);
    await render(<ProgressProbe />);
    const oldListener = [...mocks.listeners][0];
    await emit(40);
    await render(<ProgressProbe id="other" />);
    expect(progressState.item).toBeNull();
    await act(async () => {
      oldListener({ payload: { id: "engine_0", progress: 60, finished: false } });
      snapshot.resolve({ id: "engine_0", progress: 70, finished: true });
    });
    expect(progressState.item).toBeNull();
    await emit(30, false, "other");
    expect(progressState.progress).toBe(30);
  });
  it("clear resets immediately and finally, rejects native failures and is awaitable", async () => {
    const clear = deferred<void>();
    mocks.clearProgress.mockReturnValueOnce(clear.promise);
    await render(<ProgressProbe />);
    await emit(40);
    let clearing: Promise<unknown> | undefined;
    await act(async () => {
      clearing = Promise.resolve(progressState.clear()).catch((error: unknown) => error);
    });
    expect(progressState.item).toBeNull();
    await emit(60);
    const failure = new Error("clear failed");
    await act(async () => {
      clear.reject(failure);
      await clearing;
    });
    expect(await clearing).toBe(failure);
    expect(progressState.item).toBeNull();
  });
});

function LegacyButton({ onCancel }: { onCancel?: () => void }) {
  const [inProgress, setInProgress] = useState(false);
  return (
    <ProgressButton
      id="engine_0"
      initInstalled={false}
      onClick={() => setInProgress(true)}
      inProgress={inProgress}
      setInProgress={setInProgress}
      onCancel={onCancel}
      labels={{
        action: "Common.Install",
        completed: "Common.Installed",
        inProgress: "Common.Downloading",
      }}
    />
  );
}
describe("legacy progress buttons", () => {
  it("still completes from progress events without the managed opt-in", async () => {
    await render(<LegacyButton />);
    await clickInstall();
    await emit(100, true);
    expect(installButton().textContent).toBe("Common.Installed");
    expect(installButton().disabled).toBe(true);
    expect(mocks.clearProgress).not.toHaveBeenCalled();
  });
  it("contains cancellation clear failures and releases busy", async () => {
    mocks.clearProgress.mockRejectedValueOnce(new Error("cancel clear failed"));
    const cancel = vi.fn();
    await render(<LegacyButton onCancel={cancel} />);
    await clickInstall();
    await emit(40);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[title="Cancel"]')!.click(),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(installButton().disabled).toBe(false);
    expect(installButton().textContent).toBe("Common.Install");
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "cancel clear failed" }),
    );
  });
});
