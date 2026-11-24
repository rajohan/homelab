import { daytonaQualificationEnvironment } from "../../config/environment";
import { daytonaBindingHash } from "./configuration";

// Run in the same release as the executor after qualification. This command does not
// consume the API key, access Daytona, change consent or write any setting.
if (import.meta.main) {
    const binding = daytonaQualificationEnvironment();
    if (!binding?.projectId) throw new Error("No Daytona v2 mapping is configured.");
    process.stdout.write(daytonaBindingHash(binding) + "\n");
}
