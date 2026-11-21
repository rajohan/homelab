import { idSchema } from "@homelab/contracts/operations";
import * as v from "valibot";

export const incidentLocation = v.object({
    notice: v.optional(idSchema),
    incident: v.optional(idSchema),
    view: v.optional(v.picklist(["current", "resolved"])),
});
