import { rules } from "eslint-plugin-jsdoc";

const requireJsdoc = rules?.["require-jsdoc"];
const requireDescription = rules?.["require-description"];
if (!requireJsdoc || !requireDescription)
    throw new Error(
        "The installed JSDoc plugin is missing the required documentation rules."
    );

// Register the upstream presence rule twice: exported functions and public methods
// need different publicOnly settings. Matching and validation stay upstream.
export default {
    meta: { name: "documentation" },
    rules: {
        exported: requireJsdoc,
        methods: requireJsdoc,
        description: requireDescription,
    },
};
