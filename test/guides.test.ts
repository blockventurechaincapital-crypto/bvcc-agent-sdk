import { describe, it, expect } from "vitest";
import { GUIDES, listGuides, getGuide } from "../src/guides.js";
import { CATALOG, getCapability, CAPABILITY_MODULES, filterByModules } from "../src/catalog.js";

/**
 * Anti-drift: a guide that names a tool which doesn't exist (or misses a tool that
 * does) is worse than no guide. These tests keep the guides honest against the
 * catalog, and lock the "meta is always exposed" contract.
 */
describe("guides", () => {
  it("every tool a guide names exists in the catalog", () => {
    for (const g of GUIDES) {
      for (const id of g.tools) {
        expect(getCapability(id), `guide "${g.area}" names unknown tool "${id}"`).toBeTruthy();
      }
    }
  });

  it("every feature module has at least one guide", () => {
    for (const m of CAPABILITY_MODULES) {
      expect(
        GUIDES.some((g) => g.module === m),
        `no guide covers module "${m}"`,
      ).toBe(true);
    }
  });

  it("every non-meta capability is covered by some guide", () => {
    const covered = new Set(GUIDES.flatMap((g) => g.tools));
    const uncovered = CATALOG.filter((c) => (c.module ?? "core") !== "meta" && !covered.has(c.id)).map(
      (c) => c.id,
    );
    expect(uncovered, `capabilities missing from every guide: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("listGuides returns one summary per guide", () => {
    const list = listGuides();
    expect(list.length).toBe(GUIDES.length);
    expect(new Set(list.map((g) => g.area)).size).toBe(GUIDES.length); // areas unique
  });

  it("getGuide renders every area and names its tools", () => {
    for (const g of GUIDES) {
      const text = getGuide(g.area);
      expect(text).toContain(g.title);
      for (const id of g.tools) expect(text).toContain(id);
    }
  });

  it("getGuide rejects an unknown area", () => {
    expect(() => getGuide("nope")).toThrow(/No guide/);
  });

  it("the guide tools are exposed even when a single feature module is selected", () => {
    // A lending-only wrapper must still surface listGuides/getGuide (module "meta").
    const exposed = filterByModules(CATALOG, ["aave"]);
    const ids = new Set(exposed.map((c) => c.id));
    expect(ids.has("listGuides")).toBe(true);
    expect(ids.has("getGuide")).toBe(true);
    // ...but not a different feature module's tools.
    expect(ids.has("addLiquidityV3")).toBe(false);
  });
});
