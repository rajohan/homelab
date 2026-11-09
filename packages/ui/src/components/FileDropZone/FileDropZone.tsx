import { Upload } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "../../lib/classNames";

/**
 * Accept local file drops around ordinary controls without intercepting text drags.
 * @returns A bounded drop surface with a visible target while files are dragged over it.
 */
export function FileDropZone({
    children,
    disabled = false,
    onFiles,
    className,
}: {
    readonly children: ReactNode;
    readonly disabled?: boolean;
    readonly onFiles: (files: File[]) => void;
    readonly className?: string;
}) {
    const depth = useRef(0);
    const [dragging, setDragging] = useState(false);
    return (
        <div
            className={cn("relative min-w-0", className)}
            onDragEnter={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.stopPropagation();
                depth.current++;
                if (!disabled) setDragging(true);
            }}
            onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = disabled ? "none" : "copy";
            }}
            onDragLeave={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.stopPropagation();
                depth.current = Math.max(0, depth.current - 1);
                if (depth.current === 0) setDragging(false);
            }}
            onDrop={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.stopPropagation();
                depth.current = 0;
                setDragging(false);
                const files = [...event.dataTransfer.files];
                if (!disabled && files.length > 0) onFiles(files);
            }}
        >
            {children}
            {dragging && !disabled && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent-400 bg-primary-950/95 p-4 text-sm font-medium text-primary-100">
                    <Upload size={20} aria-hidden="true" />
                    Drop files to attach
                </div>
            )}
        </div>
    );
}
