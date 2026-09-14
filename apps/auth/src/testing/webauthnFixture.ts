import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import type {
    AuthenticationResponseJSON,
    RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

function clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}
export function softwareAuthenticator() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
    });
    const key = publicKey.export({ format: "jwk" });
    if (!key.x || !key.y) throw new Error("Fixture public key missing");
    const id = randomBytes(32),
        encodedId = id.toString("base64url");
    const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, new Uint8Array(Buffer.from(key.x, "base64url"))],
            [-3, new Uint8Array(Buffer.from(key.y, "base64url"))],
        ])
    );
    const rpHash = createHash("sha256").update("localhost").digest();
    function registration(challenge: string, origin: string): RegistrationResponseJSON {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(id.length);
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(1);
        const authData = Buffer.concat([
            rpHash,
            Buffer.from([0x45]),
            counter,
            Buffer.alloc(16),
            length,
            id,
            cose,
        ]);
        const attestation = isoCBOR.encode(
            new Map<string, string | Uint8Array | Map<string, string>>([
                ["fmt", "none"],
                ["attStmt", new Map()],
                ["authData", new Uint8Array(authData)],
            ])
        );
        return {
            id: encodedId,
            rawId: encodedId,
            type: "public-key",
            clientExtensionResults: {},
            response: {
                clientDataJSON: clientData("webauthn.create", challenge, origin).toString(
                    "base64url"
                ),
                attestationObject: Buffer.from(attestation).toString("base64url"),
                transports: ["usb", "nfc"],
            },
        };
    }
    function assertion(
        challenge: string,
        origin: string,
        count = 2,
        verified = true
    ): AuthenticationResponseJSON {
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(count);
        const authenticatorData = Buffer.concat([
            rpHash,
            Buffer.from([verified ? 0x05 : 0x01]),
            counter,
        ]);
        const data = clientData("webauthn.get", challenge, origin);
        const signed = Buffer.concat([
            authenticatorData,
            createHash("sha256").update(data).digest(),
        ]);
        return {
            id: encodedId,
            rawId: encodedId,
            type: "public-key",
            clientExtensionResults: {},
            response: {
                clientDataJSON: data.toString("base64url"),
                authenticatorData: authenticatorData.toString("base64url"),
                signature: sign("sha256", signed, privateKey).toString("base64url"),
            },
        };
    }
    return { registration, assertion };
}
