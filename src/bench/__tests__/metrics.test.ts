import { describe, expect, it } from "vitest";
import { combine } from "../combine";
import { computeMetrics, isBlocker, isClear, percent, type Judged } from "../metrics";

describe("combining atomic conditions", () => {
  it("needs every part of an inclusion criterion, and one failing part is enough to fail it", () => {
    expect(combine("inclusion", ["met", "met"])).toBe("met");
    expect(combine("inclusion", ["met", "not_met", "unknown"])).toBe("not_met");
    expect(combine("inclusion", ["met", "unknown"])).toBe("unknown");
  });

  it("treats the parts of an exclusion criterion as alternatives", () => {
    expect(combine("exclusion", ["not_met", "met"])).toBe("met");
    expect(combine("exclusion", ["not_met", "not_met"])).toBe("not_met");
    expect(combine("exclusion", ["not_met", "unknown"])).toBe("unknown");
  });

  it("stays unknown when there is nothing to combine", () => {
    expect(combine("inclusion", [])).toBe("unknown");
  });
});

describe("bench metrics", () => {
  it("knows what rules a trial out and what clears a criterion", () => {
    expect(isBlocker("inclusion", "not_met")).toBe(true);
    expect(isBlocker("exclusion", "met")).toBe(true);
    expect(isBlocker("inclusion", "met")).toBe(false);
    expect(isBlocker("exclusion", "unknown")).toBe(false);
    expect(isClear("inclusion", "met")).toBe(true);
    expect(isClear("exclusion", "not_met")).toBe(true);
    expect(isClear("exclusion", "unknown")).toBe(false);
  });

  it("counts exact matches, decisive answers and abstentions", () => {
    const items: Judged[] = [
      { kind: "inclusion", expert: "met", ours: "met", ms: 1000 },
      { kind: "inclusion", expert: "met", ours: "unknown", ms: 3000, unsupported: true },
      { kind: "inclusion", expert: "unknown", ours: "met" },
      { kind: "exclusion", expert: "not_met", ours: "not_met" },
    ];
    const m = computeMetrics(items);
    expect(m.n).toBe(4);
    expect(m.exact).toBe(2);
    expect(m.decisive).toBe(3);
    expect(m.decisiveCorrect).toBe(2);
    expect(m.abstained).toBe(1);
    expect(m.unsupported).toBe(1);
    expect(m.avgMs).toBe(2000);
    expect(m.confusion.met.unknown).toBe(1);
    expect(m.confusion.unknown.met).toBe(1);
  });

  it("separates the two harmful errors: false blockers and false clearances", () => {
    const items: Judged[] = [
      // Physicians: blocker. App: blocker. Found.
      { kind: "inclusion", expert: "not_met", ours: "not_met" },
      // Physicians: blocker. App: shows it as satisfied. Wrongly reassuring.
      { kind: "exclusion", expert: "met", ours: "not_met" },
      // Physicians: blocker. App: unknown. Missed, but not reassuring.
      { kind: "exclusion", expert: "met", ours: "unknown" },
      // Physicians: fine. App: blocker. Wrongly rules the trial out.
      { kind: "inclusion", expert: "met", ours: "not_met" },
      // Physicians: unknown. App: blocker. Also a false blocker.
      { kind: "exclusion", expert: "unknown", ours: "met" },
      { kind: "exclusion", expert: "not_met", ours: "unknown" },
    ];
    const m = computeMetrics(items);
    expect(m.expertBlockers).toBe(3);
    expect(m.blockersFound).toBe(1);
    expect(m.falseClearances).toBe(1);
    expect(m.expertNonBlockers).toBe(3);
    expect(m.falseBlockers).toBe(2);
  });

  it("handles an empty run", () => {
    const m = computeMetrics([]);
    expect(m.n).toBe(0);
    expect(m.avgMs).toBeNull();
    expect(percent(0, 0)).toBe("n/a");
    expect(percent(1, 4)).toBe("25.0%");
  });
});
