import { deflateSync } from "node:zlib";

function chunk(name: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xff_ff_ff_ff;
    for (const byte of body) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xed_b8_83_20 : 0);
    }
    const length = Buffer.alloc(4),
        checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xff_ff_ff_ff) >>> 0);
    return Buffer.concat([length, body, checksum]);
}

/**
 * Build the image fixture shared by the host and container qualifications.
 * @returns A deterministic 64 by 64 red PNG without private content.
 */
export function syntheticRedImage(): Uint8Array {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(64);
    header.writeUInt32BE(64, 4);
    header[8] = 8;
    header[9] = 2;
    const pixels = Buffer.alloc(64 * (64 * 3 + 1));
    for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
