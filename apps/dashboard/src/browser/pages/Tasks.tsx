import { type MiraTask } from "@homelab/contracts/mira";
import { Button, FilterBar, PageHeader, SearchInput, Select } from "@homelab/ui";
import { ListTodo, Plus, Users } from "lucide-react";
import { useState } from "react";

import { TaskBoard } from "../features/mira/TaskBoard";
import { TaskDetail } from "../features/mira/TaskDetail";
import { TaskEditor } from "../features/mira/TaskEditor";
import { useTaskColumn } from "../features/mira/useTaskColumn";

/**
 * Restore Mira's task board with independent state columns and shared responsive controls.
 * @returns Tasks, ownership filters, requirements and attributed progress.
 */
export function Tasks() {
    const [search, setSearch] = useState("");
    const [assignee, setAssignee] = useState<MiraTask["assignee"] | "all">("all");
    const columns = {
        todo: useTaskColumn("todo", search, assignee),
        in_progress: useTaskColumn("in_progress", search, assignee),
        blocked: useTaskColumn("blocked", search, assignee),
        done: useTaskColumn("done", search, assignee),
    };
    const [selected, setSelected] = useState<MiraTask>();
    const [editing, setEditing] = useState(false);
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
            <PageHeader
                icon={ListTodo}
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
            <FilterBar
                search={
                    <SearchInput
                        label="Search tasks"
                        placeholder="Search by #number, text or label…"
                        value={search}
                        onChange={setSearch}
                        maxLength={160}
                    />
                }
            >
                <Select
                    label="Filter by assignee"
                    icon={Users}
                    value={assignee}
                    onChange={setAssignee}
                    options={[
                        { value: "all", label: "All assignees" },
                        { value: "mira", label: "Mira" },
                        { value: "operator", label: "You" },
                    ]}
                />
            </FilterBar>
            <TaskBoard
                columns={columns}
                search={search}
                assignee={assignee}
                onSelect={setSelected}
            />
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
                        onEdit={(task) => {
                            setSelected(task);
                            setEditing(true);
                        }}
                    />
                )
            )}
        </div>
    );
}
