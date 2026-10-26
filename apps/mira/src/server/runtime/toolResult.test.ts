import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

import { createVisualChallenge } from "../testing/visualChallenge";
import { runtimeContentItems } from "./toolResult";

const png = createVisualChallenge().data;
const image = (data = png, mediaType = "image/png") => ({
    type: "image",
    mediaType,
    data,
});
const oversizedDimensions = (width: number, height: number) => {
    const bytes = Buffer.from(png, "base64");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes.toString("base64");
};

describe("Mira visual tool result boundary", () => {
    test("preserves text, image order and exact inline bytes without interpreting JSON text", () => {
        const text = JSON.stringify({ content: [image()] });
        expect(runtimeContentItems(text)).toEqual([{ type: "inputText", text }]);
        expect(
            runtimeContentItems({
                content: [{ type: "text", text: "Screenshot" }, image()],
            })
        ).toEqual([
            { type: "inputText", text: "Screenshot" },
            { type: "inputImage", imageUrl: `data:image/png;base64,${png}` },
        ]);
    });
    test("accepts bounded JPEG dimensions and rejects a mismatched declaration", () => {
        // A minimal SOF marker exercises metadata inspection, not a full image decoder.
        const jpeg = Buffer.from(
            "ffd8ffe00002ffc0000b080010002001011100ffd9",
            "hex"
        ).toString("base64");
        expect(runtimeContentItems({ content: [image(jpeg, "image/jpeg")] })).toEqual([
            { type: "inputImage", imageUrl: `data:image/jpeg;base64,${jpeg}` },
        ]);
        expect(() => runtimeContentItems({ content: [image(jpeg)] })).toThrow();
    });
    test.each([
        undefined,
        {},
        { content: [] },
        { content: [image()], extra: "ignored" },
        { content: [{ type: "image", imageUrl: "https://example.test/private" }] },
        { content: [{ type: "image", path: "/private/screenshot.png" }] },
        { content: [image("https://example.test/private")] },
        { content: [image("file:///private/image.png")] },
        { content: [image("data:image/png;base64," + png)] },
        { content: [image(png + "\n")] },
        { content: [image("not an image")] },
        {
            content: [
                image(
                    Buffer.from('<svg width="10" height="10"></svg>').toString("base64")
                ),
            ],
        },
        { content: [image(Buffer.from("GIF89a").toString("base64"))] },
        { content: [image(png, "image/jpeg")] },
        { content: [image(png, "image/svg+xml")] },
        { content: [image(png, "image/gif")] },
        { content: [{ type: "inputAudio", audioUrl: "data:audio/wav;base64,AAAA" }] },
        { content: [image(oversizedDimensions(0, 100))] },
        { content: [image(oversizedDimensions(8193, 10))] },
        { content: [image(oversizedDimensions(10, 8193))] },
        { content: [image(oversizedDimensions(8192, 8192))] },
        { content: [image(Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"))] },
        { content: [image(), image(), image()] },
        { content: Array.from({ length: 9 }, () => ({ type: "text", text: "a" })) },
        "a".repeat(256 * 1024 + 1),
        "😀".repeat(70_000),
        {
            content: [
                { type: "text", text: "a".repeat(200_000) },
                { type: "text", text: "b".repeat(200_000) },
            ],
        },
    ])("rejects unsafe or oversized content case %#", (value) => {
        expect(() => runtimeContentItems(value)).toThrow();
    });
    test("bounds combined image bytes and escaped JSON size before transport", () => {
        const padded = Buffer.concat([
            Buffer.from(png, "base64"),
            Buffer.alloc(1_100_000),
        ]).toString("base64");
        expect(() =>
            runtimeContentItems({ content: [image(padded), image(padded)] })
        ).toThrow();
        const large = Buffer.concat([
            Buffer.from(png, "base64"),
            Buffer.alloc(2_000_000),
        ]).toString("base64");
        expect(() =>
            runtimeContentItems({
                content: [
                    image(large),
                    { type: "text", text: "\u0000".repeat(256 * 1024) },
                ],
            })
        ).toThrow(/transport budget/);
    });
    test("qualification challenge has fresh digits, valid PNG checksums and real pixel data", () => {
        const challenge = createVisualChallenge();
        expect(challenge.answer).toMatch(/^[1-9][0-9]{5}$/);
        const bytes = Buffer.from(challenge.data, "base64");
        const types: string[] = [];
        for (let offset = 8; offset < bytes.length;) {
            const length = bytes.readUInt32BE(offset);
            const body = bytes.subarray(offset + 4, offset + 8 + length);
            expect(bytes.readUInt32BE(offset + 8 + length)).toBe(Bun.hash.crc32(body));
            const type = body.subarray(0, 4).toString();
            types.push(type);
            if (type === "IDAT") {
                const pixels = inflateSync(body.subarray(4));
                expect(pixels.length).toBe(391 * 110);
                expect(pixels.filter((pixel) => pixel === 0).length).toBeGreaterThan(
                    1000
                );
                expect(pixels.filter((pixel) => pixel === 255).length).toBeGreaterThan(
                    1000
                );
            }
            offset += length + 12;
        }
        expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    });
});
