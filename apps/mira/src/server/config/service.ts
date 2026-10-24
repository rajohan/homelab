import { validatePilot } from "../runtime/validatePilot";
import { miraEnvironment } from "./environment";

/**
 * Load operator-owned runtime settings and validate the isolated executable and state.
 * @returns Validated service settings without exposing credentials to the model process.
 */
export async function miraServiceConfiguration() {
    const { file, ...environment } = miraEnvironment();
    const config = await validatePilot(await Bun.file(file).json());
    return { ...environment, config };
}
