import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { MeroShareSyncWarnings } from "@/app/(app)/settings/meroshare/manager";
describe("MeroShare sync warnings", () => {
  it("shows skipped-history warnings even when cost basis is available", () => {
    const html = renderToStaticMarkup(
      createElement(MeroShareSyncWarnings, {
        result: {
          accounts: 1,
          costBasisAvailable: true,
          warnings: ["One history row was skipped."]
        }
      })
    );
    expect(html).toContain("One history row was skipped.");
  });
  it("shows every warning when cost basis is unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(MeroShareSyncWarnings, {
        result: {
          accounts: 1,
          costBasisAvailable: false,
          warnings: ["Purchase cost is unavailable.", "One history row was skipped."]
        }
      })
    );
    expect(html).toContain("Purchase cost is unavailable.");
    expect(html).toContain("One history row was skipped.");
  });
  it("renders nothing on a complete success", () => {
    expect(
      renderToStaticMarkup(
        createElement(MeroShareSyncWarnings, {
          result: { accounts: 1, costBasisAvailable: true, warnings: [] }
        })
      )
    ).toBe("");
  });
});
