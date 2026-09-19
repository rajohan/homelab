import { expect, test } from "bun:test";

import { TOTP } from "otpauth";

import { developmentTotpCode, developmentTotpSecret } from "./developmentTotp";

test("the public disposable account fixture uses normal six-digit TOTP verification", () => {
    const code = developmentTotpCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(
        new TOTP({ secret: developmentTotpSecret }).validate({ token: code, window: 1 })
    ).not.toBeNull();
});
