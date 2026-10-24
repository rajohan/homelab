import { type MiraTask } from "@homelab/contracts/mira";
import { Button, Card, PageHeader, SearchInput, Select } from "@homelab/ui";
import { Plus } from "lucide-react";
import { useState } from "react";

import { TaskBoard } from "../features/mira/TaskBoard";
import { TaskDetail } from "../features/mira/TaskDetail";
import { TaskEditor } from "../features/mira/TaskEditor";

/**
 * Restore Mira's task board with independent state columns and shared responsive controls.
 * @returns Tasks, ownership filters, requirements and attributed progress.
 */
export function Tasks() {
    const [search, setSearch] = useState("");
    const [assignee, setAssignee] = useState<MiraTask["assignee"] | "all">("all");
    const [selected, setSelected] = useState<MiraTask>();
    const [editing, setEditing] = useState(false);
    return (
        <div className="space-y-4">
            <PageHeader
                actions={
                    <Button
                        onClick={() => {
                            setSelected(undefined);
                            setEditing(true);
                        }}
                    >
                        <Plus size={16} aria-hidden="true" />
                        New task
                    </Button>
                }
                title="Tasks"
                description="Plan work, agree on completion criteria and follow progress."
            />
            <Card className="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
                <SearchInput
                    label="Search tasks"
                    placeholder="Search tasks and labels…"
                    value={search}
                    onChange={setSearch}
                    maxLength={160}
                />
                <Select
                    label="Filter by assignee"
                    value={assignee}
                    onChange={setAssignee}
                    options={[
                        { value: "all", label: "All assignees" },
                        { value: "mira", label: "Mira" },
                        { value: "operator", label: "You" },
                    ]}
                />
            </Card>
            <TaskBoard search={search} assignee={assignee} onSelect={setSelected} />
            {editing ? (
                <TaskEditor
                    task={selected}
                    onClose={() => {
                        setEditing(false);
                        setSelected(undefined);
                    }}
                />
            ) : (
                selected && (
                    <TaskDetail
                        task={selected}
                        onClose={() => setSelected(undefined)}
                        onEdit={() => setEditing(true)}
                    />
                )
            )}
        </div>
    );
}
