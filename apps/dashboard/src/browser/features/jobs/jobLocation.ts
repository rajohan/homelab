import { idSchema } from "@homelab/contracts/operations";
import * as v from "valibot";

export const jobLocation = v.object({ run: v.optional(idSchema) });
