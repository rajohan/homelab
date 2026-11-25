import type { MiraChatSettings } from "@homelab/contracts/mira";
import { Fieldset, Switch } from "@homelab/ui";

/**
 * Share operator-controlled memory and history preferences across Chat and Automations.
 * @returns Settings for future turns; the server enforces ownership and restricted automation scopes.
 */
export function RecallSettings({
    settings,
    onChange,
    disabled = false,
    restricted = false,
    hideLegend = false,
}: {
    readonly settings: MiraChatSettings;
    readonly onChange: (settings: MiraChatSettings) => void;
    readonly disabled?: boolean;
    readonly restricted?: boolean;
    readonly hideLegend?: boolean;
}) {
    return (
        <Fieldset legend="Context" hideLegend={hideLegend}>
            {restricted ? (
                <p className="text-sm text-primary-400">
                    Dashboard improvement uses repository and task context. Private memory
                    and conversation history are unavailable.
                </p>
            ) : (
                <>
                    <Switch
                        label="Use saved memory"
                        description="Automatically remember useful preferences, decisions and ongoing work. Keep them current and remove obsolete notes. You can edit and delete entries in Memory."
                        checked={settings.useMemory !== false}
                        disabled={disabled}
                        onChange={(useMemory) => onChange({ ...settings, useMemory })}
                    />
                    <Switch
                        label="Use conversation history"
                        description="Find relevant earlier conversations and allow this conversation to be found by them. Archived, deleted and excluded conversations stay out of searches."
                        checked={settings.useHistory !== false}
                        disabled={disabled}
                        onChange={(useHistory) => onChange({ ...settings, useHistory })}
                    />
                </>
            )}
        </Fieldset>
    );
}
