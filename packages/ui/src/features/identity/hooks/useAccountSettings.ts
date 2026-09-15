import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { IdentityClient } from "../api/IdentityClient";
import type { AccountAction, AccountNotice } from "../types";
import { actionSection } from "../validation/actionSection";
export function useAccountSettings(client: IdentityClient) {
    const queryClient = useQueryClient();
    const account = useQuery({
        queryKey: ["identity", "account"],
        queryFn: () => client.snapshot(),
        retry: false,
        staleTime: 0,
    });
    const [action, setAction] = useState<AccountAction>();
    const [notice, setNotice] = useState<AccountNotice>();
    const [recovery, setRecovery] = useState<readonly string[]>();
    const refresh = async (message: string): Promise<void> => {
        setAction(undefined);
        setNotice(
            action === undefined ? undefined : { section: actionSection(action), message }
        );
        await queryClient.invalidateQueries({ queryKey: ["identity"] });
    };
    const closeAction = () => {
        client.cancelActions();
        setAction(undefined);
    };
    return {
        account,
        action,
        setAction: (next: AccountAction) => {
            setNotice(undefined);
            setAction(next);
        },
        notice,
        recovery,
        setRecovery,
        refresh,
        closeAction,
    };
}
