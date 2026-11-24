import type { MiraDaytonaContent } from "@homelab/contracts/miraDaytona";

import { localCodeRequest } from "../../sandbox/localProtocol";
import { daytonaCheckProfile } from "../../sandbox/profile";

declare global {
    interface ImportMeta {
        readonly homelabDaytonaProgram?: string;
    }
}
const bootstrap = import.meta.homelabDaytonaProgram?.replace(
    '"__HOMELAB_RELEASE_PROFILE__"',
    JSON.stringify(Buffer.from(JSON.stringify(daytonaCheckProfile)).toString("base64"))
);
const maxBytes = 256 * 1024;
export const daytonaPlatformUser = "nobody";

/** Access the program shared by the dashboard and executor.
 * @returns The bounded nonsecret bootstrap built into this release.
 */
export function platformProgram() {
    if (!bootstrap || Buffer.byteLength(bootstrap) > maxBytes)
        throw new Error("The built Daytona platform harness is missing or too large.");
    return bootstrap;
}

/** Fingerprint the exact release bootstrap, profile, pinned Bun and toolchain policy.
 * @returns Lowercase SHA-256 of the release artifact.
 */
export function platformProgramHash(): string {
    return new Bun.CryptoHasher("sha256").update(platformProgram()).digest("hex");
}

const verifier = [
    "import hashlib, os, stat, sys",
    "name, digest = sys.argv[1:3]",
    "del sys.argv[1:3]",
    'if os.geteuid() == 0 or name != "/tmp/homelab-mira/" + sys.argv[1] + "/platform.py" or os.path.realpath(name) != name: raise ValueError("Unexpected platform path or user")',
    "with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as f:",
    " s = os.fstat(f.fileno())",
    ` if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or not 0 < s.st_size <= ${maxBytes}: raise ValueError("Unexpected platform file")`,
    ` data = f.read(${maxBytes + 1})`,
    'if hashlib.sha256(data).hexdigest() != digest: raise ValueError("Platform bootstrap integrity mismatch")',
    'exec(compile(data, name, "exec"))',
].join("\n");

function quote(value: string) {
    return "'" + value.replaceAll("'", String.raw`'\''`) + "'";
}

/**
 * Bind a reviewed command to the non-root platform policy. Only complete fixed proposals
 * receive the released harness; general shell commands require no bootstrap or Bun.
 * @param id - Durable reviewed job UUID.
 * @param content - Approval-bound command and selected files.
 * @param digest - Exact public bootstrap previously bound to operator consent.
 * @returns The command whose provider receipt and subsequent logs must match.
 */
export function platformExecution(
    id: string,
    content: MiraDaytonaContent,
    digest: string
) {
    const prefix = `bun --no-env-file ${daytonaCheckProfile.executable} `;
    let command = "/bin/sh -c " + quote(content.command);
    const fixed = content.command.startsWith(prefix);
    if (fixed) {
        localCodeRequest(id, content);
        if (digest !== platformProgramHash())
            throw new Error("Daytona platform toolchain changed.");
        command =
            "/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin python3 -I -c " +
            quote(verifier) +
            ` /tmp/homelab-mira/${id}/platform.py ${digest} ` +
            content.command.slice(prefix.length);
    }
    return {
        fixed,
        command:
            'test "$(/usr/bin/id -u)" -ne 0 && exec /usr/bin/setpriv --no-new-privs -- ' +
            command,
    };
}
