import agents from "./AGENTS.md" with { type: "text" };
import identity from "./IDENTITY.md" with { type: "text" };
import soul from "./SOUL.md" with { type: "text" };
import user from "./USER.md" with { type: "text" };

// Static imports embed the reviewed files in the server release; never read a
// mutable working directory or fetch remote instructions during a conversation.
export const miraInstructions = [identity, soul, user, agents].join("\n\n");
export const miraInstructionsHash = new Bun.CryptoHasher("sha256")
    .update(miraInstructions)
    .digest("hex");
