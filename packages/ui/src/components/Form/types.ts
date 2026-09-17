export interface FieldDefinition {
    readonly name: string;
    readonly label: string;
    readonly placeholder?: string;
    readonly type?: "email" | "password" | "text" | "time";
    readonly autoComplete?: string;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly initial?: string;
    readonly validate?: (value: string) => string | undefined;
}
export type FormValues = Readonly<Record<string, string>>;

export type FormErrors = Readonly<Record<string, string | undefined>>;
