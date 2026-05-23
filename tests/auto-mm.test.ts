/**
 * Unit tests for autoMM — tag-intersection selection, top-K, dedup, and
 * end-to-end orchestration via the AutoMMClient interface.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  type AutoMMClient,
  type AutoMMEntry,
  buildAutoMMMessage,
  formatMMContent,
  injectAutoMM,
  type MentalModelMeta,
  selectMentalModels,
} from "../src/auto-mm";
import { collectInjectedMMIds } from "../src/index";

const mm = (id: string, tags: string[], name?: string): MentalModelMeta => ({
  id,
  name: name ?? id,
  tags,
});

const item = (tags: string[], id?: string): { id: string; text: string; tags: string[] } => ({
  id: id ?? `${Math.random()}`,
  text: "irrelevant",
  tags,
});

const defaultConfig = {
  autoMMEnabled: true,
  autoMMTopK: 2,
  autoMMMinMatchCount: 10,
  autoMMMinMatchRatio: 0.2,
  autoMMDisplay: true,
};

describe("selectMentalModels", () => {
  it("returns empty when no recall results", () => {
    const { selected } = selectMentalModels([], [mm("a", ["x"])], defaultConfig);
    expect(selected).toEqual([]);
  });

  it("returns empty when no mental models", () => {
    const { selected } = selectMentalModels([item(["x"])], [], defaultConfig);
    expect(selected).toEqual([]);
  });

  it("returns empty when topK is 0", () => {
    const { selected } = selectMentalModels([item(["x"])], [mm("a", ["x"])], {
      ...defaultConfig,
      autoMMTopK: 0,
    });
    expect(selected).toEqual([]);
  });

  it("counts items where ALL of an MM's tags appear (AND semantics)", () => {
    const results = [
      item(["customer:110-hany", "kind:infra-fact"]),
      item(["customer:110-hany", "kind:procedure"]),
      item(["customer:401-iamsick", "kind:procedure"]),
    ];
    const mms = [
      mm("hany", ["customer:110-hany"]),
      mm("iamsick", ["customer:401-iamsick"]),
      mm("hany-proc", ["customer:110-hany", "kind:procedure"]),
    ];
    const { considered } = selectMentalModels(results, mms, {
      ...defaultConfig,
      autoMMMinMatchCount: 1,
      autoMMMinMatchRatio: 0,
    });
    const byId = new Map(considered.map((c) => [c.meta.id, c.matchCount]));
    expect(byId.get("hany")).toBe(2);
    expect(byId.get("iamsick")).toBe(1);
    expect(byId.get("hany-proc")).toBe(1);
  });

  it("skips MMs with no tags (would match every item)", () => {
    const results = [item(["x"])];
    const { selected, considered } = selectMentalModels(results, [mm("notag", [])], {
      ...defaultConfig,
      autoMMMinMatchCount: 0,
      autoMMMinMatchRatio: 0,
    });
    expect(selected).toEqual([]);
    expect(considered[0]?.passedThreshold).toBe(false);
  });

  it("ranks by match count descending, ties broken alphabetically", () => {
    const results = [item(["x"]), item(["x"]), item(["x"]), item(["y"]), item(["y"])];
    const mms = [
      mm("c-y", ["y"], "Y handbook"),
      mm("a-x", ["x"], "X handbook"),
      mm("b-x", ["x"], "X-alt handbook"),
    ];
    const { selected } = selectMentalModels(results, mms, {
      ...defaultConfig,
      autoMMTopK: 2,
      autoMMMinMatchCount: 1,
      autoMMMinMatchRatio: 0,
    });
    expect(selected.length).toBe(2);
    // Both 'x' MMs have count 3, beating 'y' (count 2).
    expect(selected.map((s) => s.meta.id).sort()).toEqual(["a-x", "b-x"]);
  });

  it("enforces topK", () => {
    const results = Array.from({ length: 5 }, () => item(["k"]));
    const mms = [
      mm("a", ["k"], "A"),
      mm("b", ["k"], "B"),
      mm("c", ["k"], "C"),
      mm("d", ["k"], "D"),
    ];
    const { selected } = selectMentalModels(results, mms, {
      ...defaultConfig,
      autoMMTopK: 2,
      autoMMMinMatchCount: 1,
      autoMMMinMatchRatio: 0,
    });
    expect(selected.length).toBe(2);
  });

  it("threshold uses OR of count and ratio", () => {
    // 5 items; count threshold 10 (will fail), ratio threshold 0.2 (1 of 5 = 0.2 passes)
    const results = [item(["k"]), item([]), item([]), item([]), item([])];
    const { selected } = selectMentalModels(results, [mm("a", ["k"], "A")], {
      ...defaultConfig,
      autoMMTopK: 2,
      autoMMMinMatchCount: 10,
      autoMMMinMatchRatio: 0.2,
    });
    expect(selected.length).toBe(1);
  });

  it("matches handoff Appendix-A data (hany vs iamsick on multi-host comparison)", () => {
    // Synthesize a workload like cc02 (multi-host comparison):
    // 78 items, hany=21, iamsick=16, others trace amounts
    const results: Array<{ id: string; text: string; tags: string[] }> = [];
    for (let i = 0; i < 21; i++) results.push(item(["customer:110-hany"]));
    for (let i = 0; i < 16; i++) results.push(item(["customer:401-iamsick"]));
    for (let i = 0; i < 1; i++) results.push(item(["customer:109-avro-strategies"]));
    for (let i = 0; i < 3; i++) results.push(item(["customer:400-splitlify"]));
    // Pad with untagged items
    while (results.length < 78) results.push(item([]));

    const mms = [
      mm("avro", ["customer:109-avro-strategies"]),
      mm("hany", ["customer:110-hany"]),
      mm("splitlify", ["customer:400-splitlify"]),
      mm("iamsick", ["customer:401-iamsick"]),
    ];

    const { selected } = selectMentalModels(results, mms, {
      ...defaultConfig,
      autoMMTopK: 2,
      autoMMMinMatchCount: 10,
      autoMMMinMatchRatio: 0.2,
    });

    expect(selected.length).toBe(2);
    expect(selected.map((s) => s.meta.id)).toEqual(["hany", "iamsick"]);
  });
});

describe("formatMMContent / buildAutoMMMessage", () => {
  it("wraps blocks in <hindsight_handbooks> fence", () => {
    const out = formatMMContent([
      { meta: mm("a", ["x"], "Alpha"), matchCount: 5, matchRatio: 0.5, content: "alpha body" },
      { meta: mm("b", ["y"], "Beta"), matchCount: 3, matchRatio: 0.3, content: "beta body" },
    ]);
    expect(out).toContain("<hindsight_handbooks>");
    expect(out).toContain("</hindsight_handbooks>");
    expect(out).toContain("## Alpha");
    expect(out).toContain("## Beta");
    expect(out).toContain("alpha body");
    expect(out).toContain("---"); // separator between blocks
  });

  it("buildAutoMMMessage returns null on empty blocks", () => {
    expect(buildAutoMMMessage([], true)).toBeNull();
  });

  it("buildAutoMMMessage exposes per-MM detail for renderer", () => {
    const msg = buildAutoMMMessage(
      [{ meta: mm("a", ["x"], "Alpha"), matchCount: 5, matchRatio: 0.5, content: "alpha body" }],
      true
    );
    expect(msg).not.toBeNull();
    expect(msg?.customType).toBe("hindsight-mm");
    expect(msg?.details.selected[0]?.id).toBe("a");
    expect(msg?.details.selected[0]?.matchCount).toBe(5);
    expect(msg?.details.selected[0]?.contentLength).toBe("alpha body".length);
  });
});

describe("injectAutoMM", () => {
  const makeClient = (
    listItems: MentalModelMeta[],
    mmContents: Record<string, string>
  ): AutoMMClient =>
    ({
      listMentalModels: mock(async () => ({ success: true, items: listItems })),
      getMentalModel: mock(async (id: string) => ({
        success: true,
        id,
        name: listItems.find((m) => m.id === id)?.name ?? id,
        content: mmContents[id] ?? null,
        tags: listItems.find((m) => m.id === id)?.tags ?? [],
      })),
    }) as unknown as AutoMMClient;

  it("returns null when disabled", async () => {
    const client = makeClient([mm("a", ["x"])], { a: "hello" });
    const result = await injectAutoMM({
      client,
      recallResults: [item(["x"])],
      config: { ...defaultConfig, autoMMEnabled: false },
    });
    expect(result.message).toBeNull();
  });

  it("returns null when no recall results", async () => {
    const client = makeClient([mm("a", ["x"])], { a: "hello" });
    const result = await injectAutoMM({
      client,
      recallResults: [],
      config: defaultConfig,
    });
    expect(result.message).toBeNull();
  });

  it("fetches and injects content for selected MMs", async () => {
    const results = [
      item(["customer:110-hany"]),
      item(["customer:110-hany"]),
      item(["customer:110-hany"]),
    ];
    const client = makeClient(
      [mm("hany", ["customer:110-hany"], "Hany Handbook")],
      { hany: "## hany content body" }
    );
    const audits: AutoMMEntry[] = [];
    const result = await injectAutoMM({
      client,
      recallResults: results,
      config: { ...defaultConfig, autoMMMinMatchCount: 1, autoMMMinMatchRatio: 0 },
      onAudit: (e) => audits.push(e),
    });
    expect(result.message).not.toBeNull();
    expect(result.message?.content).toContain("hany content body");
    expect(result.message?.details.selected[0]?.id).toBe("hany");
    expect(audits.length).toBe(1);
    expect(audits[0]?.selected.length).toBe(1);
  });

  it("uses mmListCache when provided (no listMentalModels call)", async () => {
    const client = makeClient([], { hany: "hany" });
    const listSpy = mock(client.listMentalModels);
    client.listMentalModels = listSpy;
    await injectAutoMM({
      client,
      recallResults: [item(["customer:110-hany"])],
      config: { ...defaultConfig, autoMMMinMatchCount: 1, autoMMMinMatchRatio: 0 },
      mmListCache: [mm("hany", ["customer:110-hany"], "Hany")],
    });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("returns null when listMentalModels fails", async () => {
    const client = {
      listMentalModels: mock(async () => ({ success: false, error: "boom" })),
      getMentalModel: mock(async () => ({ success: true })),
    } as unknown as AutoMMClient;
    const result = await injectAutoMM({
      client,
      recallResults: [item(["x"])],
      config: defaultConfig,
    });
    expect(result.message).toBeNull();
  });

  it("audit always fires, even when no selection met threshold", async () => {
    const client = makeClient([mm("a", ["x"])], {});
    const audits: AutoMMEntry[] = [];
    await injectAutoMM({
      client,
      // Only 1 of 10 items has the tag; ratio 0.1, count 1. Both thresholds fail.
      recallResults: [
        item(["x"]),
        ...Array.from({ length: 9 }, () => item([])),
      ],
      config: {
        ...defaultConfig,
        autoMMMinMatchCount: 5,
        autoMMMinMatchRatio: 0.5,
      },
      onAudit: (e) => audits.push(e),
    });
    expect(audits.length).toBe(1);
    expect(audits[0]?.selected.length).toBe(0);
  });
});

describe("collectInjectedMMIds", () => {
  it("returns empty set on empty entries", () => {
    expect(collectInjectedMMIds([])).toEqual(new Set());
  });

  it("extracts MM IDs from prior hindsight-mm messages", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "custom",
          customType: "hindsight-mm",
          details: {
            selected: [
              { id: "customer-110-hany-handbook", name: "Hany", matchCount: 5, contentLength: 1000 },
              { id: "customer-401-iamsick-handbook", name: "iamsick", matchCount: 3, contentLength: 800 },
            ],
            body: "fenced body",
          },
        },
      },
      {
        type: "message",
        message: { role: "user", content: "irrelevant" },
      },
      {
        type: "message",
        message: {
          role: "custom",
          customType: "hindsight-recall",
          details: { count: 5 },
        },
      },
    ];
    const ids = collectInjectedMMIds(entries);
    expect(ids).toEqual(new Set(["customer-110-hany-handbook", "customer-401-iamsick-handbook"]));
  });

  it("deduplicates across multiple hindsight-mm entries", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "custom",
          customType: "hindsight-mm",
          details: {
            selected: [{ id: "a", name: "A", matchCount: 1, contentLength: 1 }],
            body: "",
          },
        },
      },
      {
        type: "message",
        message: {
          role: "custom",
          customType: "hindsight-mm",
          details: {
            selected: [
              { id: "a", name: "A", matchCount: 2, contentLength: 1 },
              { id: "b", name: "B", matchCount: 1, contentLength: 1 },
            ],
            body: "",
          },
        },
      },
    ];
    expect(collectInjectedMMIds(entries)).toEqual(new Set(["a", "b"]));
  });
});
