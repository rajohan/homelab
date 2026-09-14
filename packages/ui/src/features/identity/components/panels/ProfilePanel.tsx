import { Button, Card } from "../../../../index";
import type { AccountPanelProps } from "../../types";
export function ProfilePanel({ data, onAction }: AccountPanelProps) {
    return (
        <Card id="account-profile" className="space-y-5">
            <h2 className="text-xl font-semibold">Account</h2>
            <dl className="grid gap-4 text-base sm:grid-cols-2">
                <div>
                    <dt className="text-sm text-slate-600">Username</dt>
                    <dd className="mt-1 font-medium">{data.user.username}</dd>
                </div>
                <div>
                    <dt className="text-sm text-slate-600">Email</dt>
                    <dd className="mt-1 break-all">{data.user.email}</dd>
                    <dd className="mt-1 text-sm text-slate-600">
                        {data.user.emailVerified ? "Verified" : "Not verified"}
                    </dd>
                </div>
            </dl>
            <div className="flex flex-wrap gap-3">
                <Button onClick={() => onAction("email")}>
                    {data.user.emailVerified ? "Change email" : "Verify or change email"}
                </Button>
                <Button onClick={() => onAction("password")}>Change password</Button>
            </div>
        </Card>
    );
}
