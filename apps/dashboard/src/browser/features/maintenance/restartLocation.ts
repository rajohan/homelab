import { idSchema } from "@homelab/contracts/operations";
import * as v from "valibot";

export const restartLocation = v.object({ restartBatch: v.optional(idSchema) });
