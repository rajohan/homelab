import { TOTP } from "otpauth";

// Public synthetic fixture, just like the development password. Never use for a real account.
export const developmentTotpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/**
 * Generate the disposable developer account's standard authenticator proof.
 * @returns The current six-digit preview code, without reading any environment or real credentials.
 */
export function developmentTotpCode(): string {
    return new TOTP({ secret: developmentTotpSecret }).generate();
}
