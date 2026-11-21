import { AuthFrame } from "../../../../../packages/ui/src/components/AuthFrame/AuthFrame";
import { ActionGroup } from "../../../../../packages/ui/src/components/Button/ActionGroup";
import { Button } from "../../../../../packages/ui/src/components/Button/Button";
import { buttonStyles } from "../../../../../packages/ui/src/components/Button/buttonStyles";
import { LoadingState } from "../../../../../packages/ui/src/components/Loading/LoadingState";

export type LogoutStep = "confirm" | "finishing" | "complete";

/**
 * Present each sign-out step in the same account frame as sign-in and recovery.
 * @param props - The step selected by the Identity provider.
 * @returns Native navigation and form controls, or the shared pending indicator.
 */
export function LogoutView({
    step,
    title,
    description,
}: {
    readonly step: LogoutStep;
    readonly title: string;
    readonly description: string;
}) {
    const actions = (
        <ActionGroup>
            {step === "confirm" && (
                <a href="/account" className={buttonStyles({ variant: "secondary" })}>
                    Cancel
                </a>
            )}
            {step === "complete" ? (
                <a href="/sign-in" className={buttonStyles()}>
                    Sign in again
                </a>
            ) : (
                <Button
                    id="confirm-logout"
                    type="submit"
                    form="op.logoutForm"
                    name="logout"
                    value="yes"
                >
                    Sign out
                </Button>
            )}
        </ActionGroup>
    );
    return (
        <AuthFrame title={title} description={description}>
            {step === "finishing" ? (
                <div>
                    <div id="logout-controls">{actions}</div>
                    <div id="logout-progress" hidden>
                        <LoadingState size="sm" label="Ending session…" />
                    </div>
                </div>
            ) : (
                actions
            )}
        </AuthFrame>
    );
}
