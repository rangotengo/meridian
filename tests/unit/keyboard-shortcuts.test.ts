import { describe, it, expect } from "vitest";
import { isEditableTarget, resolvePaletteShortcut } from "@/lib/keyboard-shortcuts";

function event(overrides: Record<string, unknown> = {}) {
  return {
    key: "n",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    ...overrides
  };
}

describe("isEditableTarget", () => {
  it("treats inputs, textareas, selects and contenteditable as editable", () => {
    // Plain stand-ins for DOM elements: the helper reads tagName /
    // isContentEditable structurally and must not need a DOM.
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    const textarea = { tagName: "TEXTAREA" } as unknown as EventTarget;
    const select = { tagName: "SELECT" } as unknown as EventTarget;
    const editable = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
    const button = { tagName: "BUTTON" } as unknown as EventTarget;
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(button)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("resolvePaletteShortcut", () => {
  it("opens the palette on Cmd/Ctrl+K from anywhere, even inputs", () => {
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    expect(resolvePaletteShortcut(event({ key: "k", metaKey: true, target: input }))).toBe(
      "toggle-palette"
    );
    expect(resolvePaletteShortcut(event({ key: "K", ctrlKey: true }))).toBe("toggle-palette");
  });

  it("opens the palette on / when not typing", () => {
    expect(resolvePaletteShortcut(event({ key: "/" }))).toBe("toggle-palette");
  });

  it("maps n to new transaction and q to quick add", () => {
    expect(resolvePaletteShortcut(event({ key: "n" }))).toBe("new-transaction");
    expect(resolvePaletteShortcut(event({ key: "N" }))).toBe("new-transaction");
    expect(resolvePaletteShortcut(event({ key: "q" }))).toBe("quick-add");
    expect(resolvePaletteShortcut(event({ key: "Q" }))).toBe("quick-add");
  });

  it("does not fire single-key shortcuts while typing", () => {
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    const textarea = { tagName: "TEXTAREA" } as unknown as EventTarget;
    expect(resolvePaletteShortcut(event({ key: "n", target: input }))).toBeNull();
    expect(resolvePaletteShortcut(event({ key: "q", target: textarea }))).toBeNull();
    expect(resolvePaletteShortcut(event({ key: "/", target: input }))).toBeNull();
  });

  it("ignores other keys and modified shortcuts", () => {
    expect(resolvePaletteShortcut(event({ key: "x" }))).toBeNull();
    expect(resolvePaletteShortcut(event({ key: "n", metaKey: true }))).toBeNull();
    expect(resolvePaletteShortcut(event({ key: "n", altKey: true }))).toBeNull();
    expect(resolvePaletteShortcut(event({ key: "n", shiftKey: true }))).toBeNull();
    expect(resolvePaletteShortcut(event({ key: "k" }))).toBeNull();
  });
});
