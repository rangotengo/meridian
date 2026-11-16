import { describe, expect, it } from "vitest";
import {
  chooseThemePreference,
  isThemePreference,
  parseThemePreference,
  resolveTheme,
  themeBootstrapScript,
  THEME_COOKIE_NAME
} from "@/lib/theme";

describe("theme contract: parsing", () => {
  it("accepts exactly light, dark, and system", () => {
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("auto")).toBe(false);
    expect(isThemePreference("")).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(42)).toBe(false);
  });

  it("parses raw cookie values, rejecting missing or invalid ones", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference(undefined)).toBeNull();
    expect(parseThemePreference(null)).toBeNull();
    expect(parseThemePreference("sepia")).toBeNull();
    expect(parseThemePreference(" dark")).toBeNull();
  });
});

describe("theme contract: precedence", () => {
  it("a valid browser preference wins over the saved preference", () => {
    expect(chooseThemePreference("light", "dark")).toBe("light");
    expect(chooseThemePreference("dark", "light")).toBe("dark");
    // An explicit "system" browser choice also wins — it is a real
    // preference, not the absence of one.
    expect(chooseThemePreference("system", "dark")).toBe("system");
  });

  it("the saved preference initializes a missing browser preference", () => {
    expect(chooseThemePreference(null, "dark")).toBe("dark");
    expect(chooseThemePreference(null, "light")).toBe("light");
    expect(chooseThemePreference(null, "system")).toBe("system");
  });

  it("system is the fallback when neither exists", () => {
    expect(chooseThemePreference(null, null)).toBe("system");
  });
});

describe("theme contract: resolution", () => {
  it("explicit preferences ignore the OS setting", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("system follows the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("theme contract: bootstrap script", () => {
  it("embeds the preference and never writes the cookie", () => {
    // Rendering must not persist anything: only explicit user choices
    // may write the theme cookie.
    for (const pref of ["light", "dark", "system"] as const) {
      const script = themeBootstrapScript(pref);
      expect(script).toContain(JSON.stringify(pref));
      expect(script).not.toContain("document.cookie");
      expect(script).not.toContain(THEME_COOKIE_NAME + "=");
    }
  });

  it("resolves system through matchMedia and explicit values directly", () => {
    const script = themeBootstrapScript("system");
    expect(script).toContain("prefers-color-scheme: dark");
    expect(script).toContain('classList.toggle("dark"');
  });
});
