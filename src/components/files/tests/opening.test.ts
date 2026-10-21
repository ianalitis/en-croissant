import { Chess } from "chessops";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { expect, it, vi } from "vitest";
import { buildFromTree, getStats, syncDeck } from "@/components/files/opening";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn<typeof import("@/utils/sound").playSound>() }));

function legalTree(fen: string, moves: string[]) {
    const position = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
    const tree = createTreeStore(undefined, defaultTree(fen));
    for (const san of moves) {
        const move = parseSan(position, san);
        expect(move).toBeDefined();
        expect(position.isLegal(move!)).toBe(true);
        expect(makeSan(position, move!)).toBe(san);
        position.play(move!);
        tree.getState().makeMove({ payload: san });
        expect(tree.getState().currentNode().fen).toBe(makeFen(position.toSetup()));
    }
    return structuredClone(tree.getState().root);
}

it.each([
    ["white", "8/6Pk/5K2/8/8/8/8/8 w - - 0 1", "g8=Q+", 0],
    ["black", "8/8/8/8/8/5k2/6pK/8 b - - 0 1", "g1=Q+", 1],
] as const)(
    "includes the eligible %s custom-FEN root of a legal one-ply tree",
    (color, fen, san, parity) => {
        const root = legalTree(fen, [san]);
        expect(root.halfMoves).toBe(parity);
        expect(root.children[0].children).toEqual([]);
        const positions = buildFromTree(root, color, []);
        expect(positions).toHaveLength(1);
        expect(positions[0]).toMatchObject({ fen, answer: san, card: { reps: 0, lapses: 0 } });
        expect(getStats(positions)).toMatchObject({ total: 1, unseen: 1, due: 0, practiced: 0 });
        expect(buildFromTree(root, color === "white" ? "black" : "white", [])).toEqual([]);
        expect(buildFromTree(root, color, [0])).toEqual([]);
        expect(buildFromTree(defaultTree(fen).root, color, [])).toEqual([]);
    },
);

it("keeps ordinary repertoire decisions, first-child SAN and explicit-start exclusions", () => {
    const root = legalTree(INITIAL_FEN, ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    const alternative = legalTree(INITIAL_FEN, ["d4", "d5", "c4"]);
    root.children.push(alternative.children[0]);
    expect(buildFromTree(root, "white", []).map(({ answer }) => answer)).toEqual([
        "e4",
        "Nf3",
        "Bb5",
        "c4",
    ]);
    expect(buildFromTree(root, "black", []).map(({ answer }) => answer)).toEqual([
        "e5",
        "Nc6",
        "d5",
    ]);
    // Nonempty starts exclude their ancestors and the selected node, not other branches.
    expect(buildFromTree(root, "white", [0, 0]).map(({ answer }) => answer)).toEqual(["Bb5", "c4"]);
    expect(buildFromTree(root, "white", []).map(({ answer }) => answer)[0]).toBe("e4");
});

it("deduplicates exact FENs but keeps different move counters distinct", () => {
    const root = legalTree(INITIAL_FEN, ["e4", "e5", "Nf3"]);
    root.children.push(structuredClone(root.children[0]));
    expect(buildFromTree(root, "white", []).map(({ fen }) => fen)).toEqual([
        INITIAL_FEN,
        getNodeAtPath(root, [0, 0]).fen,
    ]);
    const repeated = getNodeAtPath(root, [1, 0]);
    repeated.fen = repeated.fen.replace(" 0 2", " 0 3");
    expect(Chess.fromSetup(parseFen(repeated.fen).unwrap()).isOk).toBe(true);
    expect(buildFromTree(root, "white", [])).toHaveLength(3);
});

it("does not create a root card when the first child has no SAN", () => {
    const root = legalTree(INITIAL_FEN, ["e4"]);
    root.children[0].san = null;
    expect(buildFromTree(root, "white", [])).toEqual([]);
});

it("adds a missing root once while retaining surviving schedule objects and updating answers", () => {
    const root = legalTree(INITIAL_FEN, ["e4", "e5", "Nf3"]);
    const existing = buildFromTree(root, "white", [0]);
    expect(existing).toHaveLength(1);
    existing[0].card = {
        ...existing[0].card,
        reps: 7,
        stability: 10,
        difficulty: 4,
        due: new Date("2026-12-01T12:00:00Z"),
    };
    existing[0].answer = "Bc4";
    const synced = syncDeck(existing, root, "white", []);
    expect(synced).toMatchObject({ added: 1, removed: 0 });
    expect(synced.positions.map(({ answer }) => answer)).toEqual(["e4", "Nf3"]);
    expect(synced.positions[0].card.reps).toBe(0);
    expect(synced.positions[1].card).toBe(existing[0].card);
    expect(syncDeck(synced.positions, root, "white", [])).toEqual({
        positions: synced.positions,
        added: 0,
        removed: 0,
    });
});
