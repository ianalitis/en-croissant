// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { boardImageAtom, is3dAtom } from "@/state/atoms";
import english from "@/translation/en-US.json";
import BoardSelect from "../BoardSelect";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

const i18n = createInstance();
let root: Root;
let container: HTMLDivElement;
let atoms: ReturnType<typeof createStore>;

beforeAll(async () => {
  await i18n.init({ lng: "en", fallbackLng: false, resources: { en: english } });
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // Mantine measures the dropdown in browsers; these tests exercise selection, not layout.
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
  atoms = createStore();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <I18nextProvider i18n={i18n}>
            <BoardSelect />
          </I18nextProvider>
        </MantineProvider>
      </Provider>,
    );
  });
}

function trigger() {
  const button = container.querySelector<HTMLButtonElement>("button");
  expect(button).not.toBeNull();
  return button!;
}

function option(label: string) {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (item) => item.textContent === label,
  );
}

it("selects the optional 2D board through Mantine and retains it on rerender", async () => {
  await render();
  expect(trigger().textContent).toBe("gray");
  await act(async () => trigger().click());
  const workersClub = option("workers-club");
  expect(trigger().hasAttribute("data-expanded")).toBe(true);
  expect(workersClub).toBeDefined();
  const preview = workersClub!.querySelector<HTMLElement>('[style*="background-image"]');
  expect(preview?.style.backgroundImage).toBe('url("/board/workers-club.svg")');
  await act(async () => workersClub!.click());
  expect(atoms.get(boardImageAtom)).toBe("workers-club.svg");
  expect(trigger().textContent).toBe("workers-club");
  expect(trigger().hasAttribute("data-expanded")).toBe(false);

  await render();
  expect(atoms.get(boardImageAtom)).toBe("workers-club.svg");
  expect(trigger().textContent).toBe("workers-club");
  expect(localStorage.getItem("board-image")).toBe('"workers-club.svg"');
});

it.each([undefined, "gray.svg", "wood.jpg"])(
  "does not overwrite the default or existing 2D selection %s",
  async (selection) => {
    if (selection) localStorage.setItem("board-image", JSON.stringify(selection));
    const stored = localStorage.getItem("board-image");
    await render();
    await act(async () => trigger().click());
    await render();
    expect(atoms.get(boardImageAtom)).toBe(selection ?? "gray.svg");
    expect(trigger().textContent).toBe((selection ?? "gray.svg").split(".")[0]);
    expect(localStorage.getItem("board-image")).toBe(stored);
  },
);

it("excludes workers-club from 3D and keeps the existing mode-switch fallbacks", async () => {
  atoms.set(boardImageAtom, "workers-club.svg");
  await render();
  expect(trigger().textContent).toBe("workers-club");

  await act(async () => atoms.set(is3dAtom, true));
  expect(atoms.get(boardImageAtom)).toBe("Black-White-Aluminium.png");
  expect(trigger().textContent).toBe("Black-White-Aluminium");
  await act(async () => trigger().click());
  expect(option("workers-club")).toBeUndefined();
  expect(option("Black-White-Aluminium")).toBeDefined();

  await act(async () => atoms.set(is3dAtom, false));
  expect(atoms.get(boardImageAtom)).toBe("blue.png");
  expect(trigger().textContent).toBe("blue");
  expect(option("blue")).toBeDefined();
  expect(option("workers-club")).toBeDefined();
});

it("preserves a stored 3D selection without offering the 2D board", async () => {
  localStorage.setItem("board-image", '"Jade.png"');
  localStorage.setItem("is-3d", "true");
  await render();
  await act(async () => trigger().click());
  expect(atoms.get(boardImageAtom)).toBe("Jade.png");
  expect(trigger().textContent).toBe("Jade");
  expect(option("workers-club")).toBeUndefined();
  expect(localStorage.getItem("board-image")).toBe('"Jade.png"');
});
