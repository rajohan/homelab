import {
    ActionGroup,
    Button,
    buttonStyles,
    CopyTextButton,
    ErrorNotice,
    Modal,
} from "@homelab/ui";
import { ExternalLink, KeyRound, LoaderCircle } from "lucide-react";

import type { ChatgptConnectionState } from "./useChatgptConnection";

/** Present the operator's current device-code request and its explicit actions.
 * @returns The sign-in dialog, including preparation, verification and recovery states.
 */
export function ChatgptConnection({
    auth,
    onClose,
    onStart,
}: {
    readonly auth: ChatgptConnectionState;
    readonly onClose: () => void;
    readonly onStart: () => void;
}) {
    const { login, start, cancel } = auth;
    const code =
        auth.active && login?.userCode && login.verificationUrl ? login : undefined;
    const preparing = !code && (auth.active || start.isPending);
    let message = auth.description;
    if (preparing) message = "Requesting a one-time code from OpenAI…";
    else if (login?.state === "cancelled")
        message = "Sign-in cancelled. You can request another code.";
    return (
        <Modal
            title="ChatGPT sign-in"
            icon={KeyRound}
            onClose={onClose}
            footer={
                <ActionGroup>
                    {auth.active && login && auth.data?.canManage && (
                        <Button
                            variant="secondary"
                            busy={cancel.isPending}
                            onClick={() => cancel.mutate(login.requestId)}
                        >
                            Cancel sign-in
                        </Button>
                    )}
                    {code?.verificationUrl && (
                        <a
                            href={code.verificationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={buttonStyles()}
                        >
                            Open sign-in page{" "}
                            <ExternalLink size={15} aria-hidden="true" />
                        </a>
                    )}
                    {!auth.active && auth.canStart && (
                        <Button busy={start.isPending} onClick={onStart}>
                            {auth.action}
                        </Button>
                    )}
                    {!auth.active && !auth.canStart && !start.isPending && (
                        <Button onClick={onClose}>Close</Button>
                    )}
                </ActionGroup>
            }
        >
            {code?.userCode ? (
                <div className="space-y-3">
                    <p className="text-sm leading-relaxed text-primary-200">
                        Open the OpenAI sign-in page and enter this code.
                    </p>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary-700 bg-surface-card px-4 py-3">
                        <div className="min-w-0">
                            <p className="text-xs font-medium text-primary-300">
                                One-time code
                            </p>
                            <p className="mt-1 font-mono text-2xl font-semibold tracking-wider wrap-anywhere text-primary-50 select-all">
                                {code.userCode}
                            </p>
                        </div>
                        <CopyTextButton text={code.userCode} label="Copy one-time code" />
                    </div>
                    <output className="flex items-center gap-2 text-xs text-primary-300">
                        <LoaderCircle
                            size={14}
                            aria-hidden="true"
                            className="motion-safe:animate-spin"
                        />{" "}
                        Waiting for OpenAI
                    </output>
                </div>
            ) : (
                <output className="flex items-start gap-2 text-sm leading-relaxed text-primary-200">
                    {preparing && (
                        <LoaderCircle
                            size={17}
                            aria-hidden="true"
                            className="mt-0.5 shrink-0 text-accent-300 motion-safe:animate-spin"
                        />
                    )}
                    {message}
                </output>
            )}
            {(start.error || cancel.error) && (
                <div className="mt-3">
                    <ErrorNotice error={start.error ?? cancel.error} />
                </div>
            )}
        </Modal>
    );
}
