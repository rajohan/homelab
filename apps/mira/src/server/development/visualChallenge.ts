import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

const glyphs = [
    ["11111", "10001", "10011", "10101", "11001", "10001", "11111"],
    ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
    ["11111", "00001", "00001", "11111", "00001", "00001", "11111"],
    ["10001", "10001", "10001", "11111", "00001", "00001", "00001"],
    ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
    ["11111", "10000", "10000", "11111", "10001", "10001", "11111"],
    ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    ["11111", "10001", "10001", "11111", "10001", "10001", "11111"],
    ["11111", "10001", "10001", "11111", "00001", "00001", "11111"],
];

function chunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(Bun.hash.crc32(body));
    return Buffer.concat([size, body, checksum]);
}

/**
 * Draw a fresh six-digit visual challenge without including its answer in image metadata.
 * @returns A synthetic PNG and an expected answer retained only by the qualification host.
 */
export function createVisualChallenge(): { answer: string; data: string } {
    const answer = randomInt(100_000, 1_000_000).toString();
    const scale = 10;
    const width = 390;
    const height = 110;
    const rows = Buffer.alloc((width + 1) * height, 255);
    for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
    for (const [position, digit] of answer.split("").entries()) {
        const glyph = glyphs[Number(digit)]!;
        for (const [row, pixels] of glyph.entries())
            for (const [column, pixel] of pixels.split("").entries()) {
                if (pixel !== "1") continue;
                for (let dy = 0; dy < scale; dy++)
                    for (let dx = 0; dx < scale; dx++) {
                        const x = 20 + position * 60 + column * scale + dx;
                        const y = 20 + row * scale + dy;
                        rows[y * (width + 1) + 1 + x] = 0;
                    }
            }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // Eight-bit grayscale; the remaining PNG fields are zero.
    return {
        answer,
        data: Buffer.concat([
            Buffer.from("89504e470d0a1a0a", "hex"),
            chunk("IHDR", header),
            chunk("IDAT", deflateSync(rows)),
            chunk("IEND", Buffer.alloc(0)),
        ]).toString("base64"),
    };
}
