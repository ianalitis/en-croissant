import { makeSquare, parseSquare } from "chessops";
import { Chess } from "chessops/chess";
import { makeSan, parseSan } from "chessops/san";
import { expect, test } from "vitest";
import { ANNOTATION_INFO, type Annotation, NAG_INFO } from "../annotation";
import { getMoveDestination, hasMorePriority, headersToPGN } from "../chess";

for (const [color, halfMoves, rank] of [
    ["white", 1, "1"],
    ["black", 2, "8"],
] as const) {
    for (const [castle, rookFile, kingFile] of [
        ["O-O", "h", "g"],
        ["O-O-O", "a", "c"],
    ] as const) {
        test.each(["", "+", "#"])(`${color} ${castle}%s uses the king's destination`, (suffix) => {
            const destination = getMoveDestination({
                san: `${castle}${suffix}`,
                halfMoves,
                move: {
                    from: parseSquare(`e${rank}`)!,
                    to: parseSquare(`${rookFile}${rank}`)!,
                },
            });

            expect(destination).toBe(parseSquare(`${kingFile}${rank}`));
        });
    }
}

test("ordinary checking moves keep their destination", () => {
    expect(
        getMoveDestination({
            san: "Bb5+",
            halfMoves: 5,
            move: { from: parseSquare("f1")!, to: parseSquare("b5")! },
        }),
    ).toBe(parseSquare("b5"));
});

test("a root node has no move destination", () => {
    expect(getMoveDestination({ san: null, halfMoves: 0, move: null })).toBeUndefined();
});

test("issue 952 castling check uses c1 instead of the chessops rook square", () => {
    const position = Chess.default();
    const moves =
        "d4 c6 Nf3 b5 a3 f6 Nc3 h5 d5 Qa5 dxc6 dxc6 Bd2 Qb6 Be3 Qa5 b4 Qd8 Qxd8+ Kxd8".split(" ");
    for (const san of moves) {
        position.play(parseSan(position, san)!);
    }
    const move = parseSan(position, "O-O-O+")!;
    const san = makeSan(position, move);

    expect(san).toBe("O-O-O+");
    expect(makeSquare(move.to)).toBe("a1");
    expect(getMoveDestination({ san, halfMoves: moves.length + 1, move })).toBe(parseSquare("c1"));
});

test("NAGs are consistent", () => {
    for (const k of Object.keys(ANNOTATION_INFO)) {
        if (k === "") continue;
        const nag = ANNOTATION_INFO[k as Annotation].nag!;
        expect(NAG_INFO.get(`$${nag}`)).toBe(k);
    }
});

test("priority comparison", () => {
    expect(hasMorePriority([0, 0], [0])).toBe(false);
    expect(hasMorePriority([0], [0, 0])).toBe(true);
    expect(hasMorePriority([0], [1])).toBe(true);
    expect(hasMorePriority([1], [0])).toBe(false);
    expect(hasMorePriority([0, 0], [0, 1])).toBe(true);
    expect(hasMorePriority([0, 1], [0, 0])).toBe(false);
    expect(hasMorePriority([0, 1], [0, 2])).toBe(true);
    expect(hasMorePriority([0, 2], [0, 1])).toBe(false);
});

test("PGN headers preserve UTC time", () => {
    const pgn = headersToPGN({
        id: 1,
        fen: "",
        event: "Live Chess",
        site: "https://www.chess.com/game/live/1",
        date: "2026.09.19",
        time: "12:34:56",
        round: "-",
        white: "White",
        black: "Black",
        result: "1-0",
    });

    expect(pgn).toContain('[UTCTime "12:34:56"]');
});
