import { idSchema } from "@homelab/contracts/operations";
import * as v from "valibot";

export const calendarLocation = v.object({ event: v.optional(idSchema) });
