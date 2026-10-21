import { INITIAL_FEN } from "chessops/fen";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands, type Token } from "@/bindings";
import { buildFromTree } from "@/components/files/opening";
import { createTreeStore } from "@/state/store/tree";
import { getMoveText, getPGN, parsePGN } from "@/utils/chess";
import { defaultTree } from "@/utils/treeReducer";

vi.mock("@/utils/sound", () => ({ playSound: vi.fn<typeof import("@/utils/sound").playSound>() }));

const fen = "8/5k2/7p/3p4/3P4/7P/4K3/8 b - - 7 23";
const pgn = `[SetUp "1"]
[FEN "${fen}"]

{Find king activity [%cal Gf7g6]} 23... Kg6 $1 {Centralize.}
(23... Ke6 {Alternative.} 24. Kf3) 24. Kf3 *`;
const tokens: Token[] = [
    { type: "Header", value: { tag: "SetUp", value: "1" } },
    { type: "Header", value: { tag: "FEN", value: fen } },
    { type: "Comment", value: "Find king activity [%cal Gf7g6]" },
    { type: "San", value: "Kg6" },
    { type: "Nag", value: "$1" },
    { type: "Comment", value: "Centralize." },
    { type: "ParenOpen" },
    { type: "San", value: "Ke6" },
    { type: "Comment", value: "Alternative." },
    { type: "San", value: "Kf3" },
    { type: "ParenClose" },
    { type: "San", value: "Kf3" },
    { type: "Outcome", value: "*" },
];
const exportOptions = { glyphs: true, comments: true, extraMarkups: true, variations: true };

beforeEach(() => {
    // lexPgn is native Tauri. These explicit tokens test the frontend boundary only.
    vi.spyOn(commands, "lexPgn").mockResolvedValue({ status: "ok", data: [] });
});

afterEach(() => vi.restoreAllMocks());

test.each([
    ["default", undefined, 0],
    ["initial", INITIAL_FEN, 0],
    ["white move 1", "8/5k2/7p/3p4/3P4/7P/4K3/8 w - - 7 1", 0],
    ["black move 1", "8/5k2/7p/3p4/3P4/7P/4K3/8 b - - 7 1", 1],
    ["white move 23", "8/5k2/7p/3p4/3P4/7P/4K3/8 w - - 7 23", 44],
    ["black move 23", fen, 45],
    ["black move 23 with zero halfmove clock", "8/5k2/7p/3p4/3P4/7P/4K3/8 b - - 0 23", 45],
] as const)(
    "%s initializes absolute ply for construction and empty PGN import",
    async (_, initialFen, ply) => {
        const tree = defaultTree(initialFen);
        expect.soft(tree.root.halfMoves).toBe(ply);
        expect(tree.root.fen).toBe(initialFen ?? INITIAL_FEN);
        const headers: Token[] = initialFen
            ? [{ type: "Header", value: { tag: "FEN", value: initialFen } }]
            : [];
        vi.mocked(commands.lexPgn).mockResolvedValueOnce({ status: "ok", data: headers });
        const parsed = await parsePGN(initialFen ? `[FEN "${initialFen}"]` : "");
        expect.soft(parsed.root.halfMoves).toBe(ply);
        expect(parsed.root.fen).toBe(initialFen ?? INITIAL_FEN);
        expect(parsed.root.children).toEqual([]);
    },
);

test("preserves original FEN clocks, mainline, annotations and variation numbering", async () => {
    vi.mocked(commands.lexPgn).mockResolvedValueOnce({ status: "ok", data: tokens });
    const tree = await parsePGN(pgn);
    expect(commands.lexPgn).toHaveBeenCalledExactlyOnceWith(pgn);
    expect.soft(tree.root.halfMoves).toBe(45);
    expect(tree.root.fen).toBe(fen);
    expect(tree.headers).toMatchObject({ fen, other: { SetUp: "1" } });
    expect(tree.root.comment).toBe("Find king activity");
    expect(tree.root.shapes).toEqual([{ orig: "f7", dest: "g6", brush: "green" }]);
    expect(tree.root.children.map(({ san }) => san)).toEqual(["Kg6", "Ke6"]);
    const [main, alternative] = tree.root.children;
    expect.soft(main.halfMoves).toBe(46);
    expect(main.fen).toBe("8/8/6kp/3p4/3P4/7P/4K3/8 w - - 8 24");
    expect(main.annotations).toEqual(["!"]);
    expect(main.comment).toBe("Centralize.");
    expect(alternative.comment).toBe("Alternative.");
    expect.soft(alternative.halfMoves).toBe(46);
    expect(alternative.fen).toBe("8/8/4k2p/3p4/3P4/7P/4K3/8 w - - 8 24");
    for (const branch of [main, alternative]) {
        expect(branch.children).toHaveLength(1);
        expect.soft(branch.children[0].halfMoves).toBe(47);
        expect(branch.children[0].san).toBe("Kf3");
        expect(branch.children[0].fen).toContain("/5K1P/8/8 b - - 9 24");
    }
    expect
        .soft(getMoveText(main, { ...exportOptions, isFirst: true }))
        .toBe("23... Kg6! {Centralize.} ");
    expect.soft(getMoveText(main.children[0], exportOptions)).toBe("24. Kf3 ");
    const exported = getPGN(tree.root, { ...exportOptions, headers: tree.headers });
    expect(exported.match(/^\[SetUp /gm)).toHaveLength(1);
    expect(exported.match(/^\[FEN /gm)).toHaveLength(1);
    expect(exported).toContain('[SetUp "1"]');
    expect(exported).toContain(`[FEN "${fen}"]`);
    expect(exported).toContain("[%cal Gf7g6]Find king activity");
    expect.soft(exported).toContain("23... Kg6! {Centralize.}");
    expect.soft(exported).toMatch(/\(23\.\.\. Ke6 \{Alternative\.\}\s+24\. Kf3\)/);
    expect.soft(exported).toMatch(/\)\s+24\. Kf3 \*$/);
});

test.each([
    ["standard root", INITIAL_FEN],
    ["custom root", fen],
])("%s owns setup tags without mutating imported metadata", (_, rootFen) => {
    const tree = defaultTree(rootFen);
    tree.headers.other = { SetUp: "0", FEN: "stale imported FEN", Study: "Original study" };
    const originalHeaders = structuredClone(tree.headers);
    const exported = getPGN(tree.root, { ...exportOptions, headers: tree.headers });

    const setupTags = exported.match(/^\[(?:SetUp|FEN) .*$/gm) ?? [];
    expect(setupTags).toEqual(rootFen === INITIAL_FEN ? [] : ['[SetUp "1"]', `[FEN "${rootFen}"]`]);
    expect(exported).toContain('[Study "Original study"]');
    expect(tree.headers).toEqual(originalHeaders);
});

test("nested variations retain their parent absolute ply and first-child order", async () => {
    vi.mocked(commands.lexPgn).mockResolvedValueOnce({
        status: "ok",
        data: [
            { type: "San", value: "Kg6" },
            { type: "ParenOpen" },
            { type: "San", value: "Ke6" },
            { type: "San", value: "Kf3" },
            { type: "ParenOpen" },
            { type: "San", value: "Kd3" },
            { type: "ParenClose" },
            { type: "ParenClose" },
            { type: "San", value: "Kf3" },
        ],
    });
    const tree = await parsePGN("23... Kg6 (23... Ke6 24. Kf3 (24. Kd3)) 24. Kf3", fen);
    expect(tree.root.children.map(({ san, halfMoves }) => [san, halfMoves])).toEqual([
        ["Kg6", 46],
        ["Ke6", 46],
    ]);
    expect(tree.root.children[1].children.map(({ san, halfMoves }) => [san, halfMoves])).toEqual([
        ["Kf3", 47],
        ["Kd3", 47],
    ]);
    expect(getPGN(tree.root, { ...exportOptions, headers: null })).toMatch(
        /\(23\.\.\. Ke6\s+24\. Kf3\s+\(24\. Kd3\s*\)\)/,
    );
});

test("explicit initial FEN wins over header FEN without normalizing headers", async () => {
    const override = "8/5k2/7p/3p4/3P4/7P/4K3/8 w - - 7 12";
    vi.mocked(commands.lexPgn).mockResolvedValueOnce({
        status: "ok",
        data: [
            { type: "Header", value: { tag: "FEN", value: fen } },
            { type: "San", value: "Kf3" },
            { type: "San", value: "Kg6" },
        ],
    });
    const tree = await parsePGN(`[FEN "${fen}"] 12. Kf3 Kg6`, ` ${override} `);
    expect(tree.root.fen).toBe(override);
    expect(tree.headers.fen).toBe(fen);
    expect(tree.root.halfMoves).toBe(22);
    expect(tree.root.children[0].halfMoves).toBe(23);
    expect(tree.root.children[0].children[0].halfMoves).toBe(24);
    expect(getMoveText(tree.root.children[0], exportOptions)).toBe("12. Kf3 ");
    expect(getPGN(tree.root, { ...exportOptions, headers: null })).toContain("12. Kf3");
});

test("blank explicit FEN falls back to the header", async () => {
    vi.mocked(commands.lexPgn).mockResolvedValueOnce({ status: "ok", data: tokens });
    const tree = await parsePGN(pgn, "  ");
    expect(tree.root.fen).toBe(fen);
    expect(tree.root.halfMoves).toBe(45);
});

test.each(["w", "b"])(
    "invalid %s position keeps the existing constructor and parser fallbacks",
    async (turn) => {
        const invalidFen = `8/8/8/8/8/8/8/8 ${turn} - - 7 23`;
        expect(defaultTree(invalidFen).root).toMatchObject({ fen: invalidFen, halfMoves: 0 });
        vi.mocked(commands.lexPgn).mockResolvedValueOnce({
            status: "ok",
            data: [{ type: "San", value: "Kg6" }],
        });
        const tree = await parsePGN("23... Kg6", invalidFen);
        expect(tree.root).toMatchObject({
            fen: invalidFen,
            halfMoves: turn === "b" ? 1 : 0,
            children: [],
        });
    },
);

test("malformed FEN still falls back in construction and rejects during parsing", async () => {
    expect(defaultTree("invalid").root.halfMoves).toBe(0);
    await expect(parsePGN("", "invalid")).rejects.toThrow("ERR_BOARD");
});

test.each([
    ["white", "8/5k2/7p/3p4/3P4/7P/4K3/8 w - - 7 23", "Kf3", 44],
    ["black", fen, "Kg6", 45],
] as const)(
    "high-fullmove %s root keeps practice eligibility and first-child answer",
    (color, initialFen, san, ply) => {
        const store = createTreeStore(undefined, defaultTree(initialFen));
        store.getState().makeMove({ payload: san });
        const root = store.getState().root;
        expect(root.halfMoves).toBe(ply);
        expect(buildFromTree(root, color, [])).toMatchObject([{ fen: initialFen, answer: san }]);
        expect(buildFromTree(root, color === "white" ? "black" : "white", [])).toEqual([]);
        expect(buildFromTree(root, color, [0])).toEqual([]);
    },
);
