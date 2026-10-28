import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { watchComputerParent } from "./companionParent";

test("supervised runs stop once on parent EOF, errors, closure or unexpected input", async () => {
    for (const event of ["end", "close", "error", "data", "already-closed"]) {
        const input = new PassThrough();
        let stopped = 0;
        if (event === "already-closed") input.destroy();
        const detach = watchComputerParent(input, () => stopped++);
        if (event === "end") input.end();
        if (event === "close") input.destroy();
        if (event === "error") input.emit("error", new Error("synthetic parent loss"));
        if (event === "data") input.write("this is not a command channel");
        await Bun.sleep(1);
        expect(stopped).toBe(1);
        input.emit("close");
        expect(stopped).toBe(1);
        detach();
        detach();
        for (const name of ["end", "close", "error", "data"])
            expect(input.listenerCount(name)).toBe(0);
        input.destroy();
    }
});

test("finishing a supervised run removes its parent listeners without stopping another lifetime", () => {
    const input = new PassThrough();
    let stopped = 0;
    const detach = watchComputerParent(input, () => stopped++);
    detach();
    input.emit("end");
    input.emit("close");
    input.write("unused");
    expect(stopped).toBe(0);
    input.destroy();
});
