export interface FieldDefinition {
    readonly name: string;
    readonly label: string;
    readonly type?: "email" | "password" | "text";
    readonly autoComplete?: string;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly initial?: string;
}
export type FormValues = Readonly<Record<string, string>>;
