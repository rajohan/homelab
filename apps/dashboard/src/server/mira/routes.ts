import {
    miraProposalDecisionSchema,
    miraRunReadSchema,
    miraAutomationInputSchema,
    miraChatSettingsUpdateSchema,
    miraAutomationUpdateSchema,
    miraConversationInputSchema,
    miraConversationReadSchema,
    miraEnableSchema,
    miraMemoryInputSchema,
    miraMemoryUpdateSchema,
    miraMessageInputSchema,
    miraPageSchema,
    miraConversationPageSchema,
    miraProgressInputSchema,
    miraReportInputSchema,
    miraReportFilterSchema,
    miraStateChangeSchema,
    miraTaskFilterSchema,
    miraTaskRunInputSchema,
    miraTaskReviewInputSchema,
    miraTaskInputSchema,
    miraTaskUpdateSchema,
} from "@homelab/contracts/mira";
import {
    miraCodeSaveSchema,
    miraCodeApproveSchema,
    miraCodeFilterSchema,
} from "@homelab/contracts/miraCode";
import {
    miraDaytonaSaveSchema,
    miraDaytonaApproveSchema,
    miraDaytonaFilterSchema,
    miraDaytonaResolveSchema,
} from "@homelab/contracts/miraDaytona";
import {
    miraMailApproveSchema,
    miraMailFilterSchema,
    miraMailSaveSchema,
} from "@homelab/contracts/miraMail";
import {
    miraPublicationSaveSchema,
    miraPublicationApproveSchema,
    miraPublicationFilterSchema,
} from "@homelab/contracts/miraPublication";
import {
    miraSocialSaveSchema,
    miraSocialApproveSchema,
    miraSocialVerifySchema,
    miraSocialFilterSchema,
} from "@homelab/contracts/miraSocial";
import { idSchema, versionedIdSchema } from "@homelab/contracts/operations";
import {
    deleteMiraAutomation,
    installMiraPresets,
    runMiraAutomationNow,
} from "@homelab/mira/data/automationActions";
import {
    listMiraAutomations,
    listMiraSwitches,
    saveMiraAutomation,
    setMiraEnabled,
} from "@homelab/mira/data/automations";
import { listMiraModels, saveMiraChatSettings } from "@homelab/mira/data/chatSettings";
import {
    saveMiraCode,
    approveMiraCode,
    cancelMiraCode,
    inspectMiraCode,
    listMiraCode,
    readMiraCode,
} from "@homelab/mira/data/code";
import { readCodeSource } from "@homelab/mira/data/codeSource";
import { MiraFailure, type MiraContext } from "@homelab/mira/data/context";
import {
    cancelRun,
    changeConversation,
    createConversation,
    enqueueTurn,
    listConversations,
    readConversation,
    renameConversation,
} from "@homelab/mira/data/conversations";
import {
    listMiraDaytona,
    readMiraDaytona,
    saveMiraDaytona,
    approveMiraDaytona,
    cancelMiraDaytona,
    daytonaInputDescriptor,
} from "@homelab/mira/data/daytona";
import {
    readMiraDaytonaRecovery,
    resolveMiraDaytonaCleanup,
} from "@homelab/mira/data/daytonaRecovery";
import {
    changeReport,
    createReport,
    deleteMemory,
    listMemory,
    listReports,
    readReport,
    saveMemory,
} from "@homelab/mira/data/documents";
import { listMiraFiles, miraFileMetadata } from "@homelab/mira/data/files";
import { listMiraIntegrations } from "@homelab/mira/data/integrations";
import {
    approveMiraMail,
    cancelMiraMail,
    listMiraMail,
    saveMiraMail,
} from "@homelab/mira/data/mail";
import { listMiraProposals, decideMiraProposal } from "@homelab/mira/data/proposals";
import {
    saveMiraPublication,
    approveMiraPublication,
    cancelMiraPublication,
    listMiraPublications,
} from "@homelab/mira/data/publications";
import { listMiraRuns } from "@homelab/mira/data/queue";
import { readMiraRun } from "@homelab/mira/data/runHistory";
import {
    saveMiraSocial,
    approveMiraSocial,
    verifyMiraSocial,
    listMiraSocial,
    cancelMiraSocial,
} from "@homelab/mira/data/social";
import { readTaskExecution, runMiraTask } from "@homelab/mira/data/taskExecution";
import { reviewTaskRun } from "@homelab/mira/data/taskRecovery";
import {
    addTaskProgress,
    deleteTask,
    listTasks,
    saveTask,
    taskProgress,
} from "@homelab/mira/data/tasks";
import { agentMailBindingHash } from "@homelab/mira/integrations/agentmail/configuration";
import { daytonaBindingHash } from "@homelab/mira/integrations/daytona/configuration";
import { githubBindingHash } from "@homelab/mira/integrations/github/configuration";
import { hereNowBindingHash } from "@homelab/mira/integrations/herenow/configuration";
import { moltbookBindingHash } from "@homelab/mira/integrations/moltbook/configuration";
import * as v from "valibot";

import { runOperation, trpc } from "../api/trpc";
import { authorizedOperations } from "../operations/authorization";
import type { OperationsContext } from "../operations/context";
import { OperationFailure } from "../operations/errors";

function execute<T>(
    context: OperationsContext,
    operation: (mira: MiraContext) => Promise<T>
): Promise<T> {
    return runOperation(async () => {
        const { operations, principal } = authorizedOperations(context, "jobs:read");
        if (principal.kind !== "human")
            throw new OperationFailure(
                "FORBIDDEN",
                "Mira requires a signed-in operator."
            );
        try {
            return await operation({
                client: operations.client,
                owner: principal.id,
                actor: `human:${principal.id}`,
            });
        } catch (error) {
            if (error instanceof MiraFailure)
                throw new OperationFailure(error.code, error.message);
            throw error;
        }
    });
}

const record = v.strictObject({ id: idSchema });
export const miraRouter = trpc.router({
    daytona: trpc.router({
        recovery: trpc.procedure
            .input(record)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => readMiraDaytonaRecovery(mira, input.id))
            ),
        resolveCleanup: trpc.procedure
            .input(miraDaytonaResolveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => resolveMiraDaytonaCleanup(mira, input))
            ),
        list: trpc.procedure
            .input(miraDaytonaFilterSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => listMiraDaytona(mira, input))
            ),
        read: trpc.procedure
            .input(record)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => readMiraDaytona(mira.client, mira.owner, input.id))
            ),
        input: trpc.procedure
            .input(record)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => daytonaInputDescriptor(mira, input.id))
            ),
        save: trpc.procedure
            .input(miraDaytonaSaveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    saveMiraDaytona(mira, input, ctx.operations?.daytonaBinding)
                )
            ),
        approve: trpc.procedure
            .input(miraDaytonaApproveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    approveMiraDaytona(mira, input, ctx.operations?.daytonaBinding)
                )
            ),
        cancel: trpc.procedure
            .input(versionedIdSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => cancelMiraDaytona(mira, input))
            ),
    }),
    social: trpc.router({
        list: trpc.procedure
            .input(miraSocialFilterSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => listMiraSocial(mira, input))
            ),
        save: trpc.procedure
            .input(miraSocialSaveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    saveMiraSocial(mira, input, ctx.operations?.moltbookBinding)
                )
            ),
        approve: trpc.procedure
            .input(miraSocialApproveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    approveMiraSocial(mira, input, ctx.operations?.moltbookBinding)
                )
            ),
        verify: trpc.procedure
            .input(miraSocialVerifySchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    verifyMiraSocial(mira, input, ctx.operations?.moltbookBinding)
                )
            ),
        cancel: trpc.procedure
            .input(versionedIdSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => cancelMiraSocial(mira, input))
            ),
    }),
    code: trpc.router({
        read: trpc.procedure
            .input(record)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => readMiraCode(mira.client, mira.owner, input.id))
            ),
        list: trpc.procedure
            .input(miraCodeFilterSchema)
            .query(({ ctx, input }) => execute(ctx, (mira) => listMiraCode(mira, input))),
        save: trpc.procedure
            .input(miraCodeSaveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    saveMiraCode(mira, input, ctx.operations?.githubBinding)
                )
            ),
        approve: trpc.procedure
            .input(miraCodeApproveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    approveMiraCode(
                        mira,
                        input,
                        ctx.operations?.githubBinding,
                        ctx.operations?.miraFilesDirectory
                    )
                )
            ),
        cancel: trpc.procedure
            .input(versionedIdSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => cancelMiraCode(mira, input))
            ),
        inspect: trpc.procedure
            .input(versionedIdSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => inspectMiraCode(mira, input))
            ),
        source: trpc.procedure.input(record).query(({ ctx, input }) =>
            execute(ctx, async (mira) => {
                const draft = await readMiraCode(mira.client, mira.owner, input.id);
                const source = await readCodeSource(
                    mira,
                    draft.content,
                    draft.conversationId,
                    ctx.operations?.miraFilesDirectory
                );
                return { contentHash: draft.contentHash, plan: source.plan };
            })
        ),
    }),
    publications: trpc.router({
        list: trpc.procedure
            .input(miraPublicationFilterSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => listMiraPublications(mira, input))
            ),
        save: trpc.procedure
            .input(miraPublicationSaveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    saveMiraPublication(mira, input, ctx.operations?.hereNowBinding)
                )
            ),
        approve: trpc.procedure
            .input(miraPublicationApproveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    approveMiraPublication(
                        mira,
                        input,
                        ctx.operations?.hereNowBinding,
                        ctx.operations?.miraFilesDirectory
                    )
                )
            ),
        cancel: trpc.procedure
            .input(versionedIdSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => cancelMiraPublication(mira, input))
            ),
    }),
    mail: trpc.router({
        list: trpc.procedure
            .input(miraMailFilterSchema)
            .query(({ ctx, input }) => execute(ctx, (mira) => listMiraMail(mira, input))),
        save: trpc.procedure
            .input(miraMailSaveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    saveMiraMail(mira, input, ctx.operations?.agentMailHook)
                )
            ),
        approve: trpc.procedure
            .input(miraMailApproveSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    approveMiraMail(
                        mira,
                        input,
                        ctx.operations?.agentMailHook,
                        ctx.operations?.miraFilesDirectory
                    )
                )
            ),
        cancel: trpc.procedure
            .input(versionedIdSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => cancelMiraMail(mira, input))
            ),
    }),
    proposals: trpc.router({
        list: trpc.procedure
            .input(record)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => listMiraProposals(mira, input.id))
            ),
        decide: trpc.procedure
            .input(miraProposalDecisionSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => decideMiraProposal(mira, input))
            ),
    }),
    files: trpc.router({
        list: trpc.procedure
            .input(miraPageSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => listMiraFiles(mira, input.before))
            ),
        metadata: trpc.procedure
            .input(v.pipe(v.array(idSchema), v.maxLength(8)))
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => miraFileMetadata(mira, input))
            ),
    }),
    status: trpc.procedure.query(({ ctx }) =>
        execute(ctx, async ({ client }) => {
            const [runtime] = await client<
                {
                    ready: boolean;
                    model: string | null;
                    version: string;
                    message: string | null;
                    fresh: boolean;
                }[]
            >`SELECT ready, model, version, message, heartbeat_at > now() - interval '30 seconds' AS fresh FROM mira_runtime_status WHERE id = 1`;
            return {
                ready: runtime?.ready === true && runtime.fresh,
                model: runtime?.model ?? null,
                version: runtime?.version ?? null,
                message: runtime?.fresh
                    ? runtime.message
                    : "Mira is not connected. Messages remain queued until the executor is ready.",
            };
        })
    ),
    models: trpc.procedure.query(({ ctx }) => execute(ctx, listMiraModels)),
    conversations: trpc.router({
        settings: trpc.procedure
            .input(miraChatSettingsUpdateSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => saveMiraChatSettings(mira, input))
            ),
        list: trpc.procedure
            .input(miraConversationPageSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => listConversations(mira, input))
            ),
        create: trpc.procedure
            .input(miraConversationInputSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => createConversation(mira, input.title))
            ),
        read: trpc.procedure
            .input(miraConversationReadSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => readConversation(mira, input.id, input.before))
            ),
        rename: trpc.procedure
            .input(
                v.strictObject({
                    ...versionedIdSchema.entries,
                    ...miraConversationInputSchema.entries,
                })
            )
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => renameConversation(mira, input))
            ),
        change: trpc.procedure
            .input(miraStateChangeSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => changeConversation(mira, input))
            ),
        send: trpc.procedure
            .input(miraMessageInputSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    mira.client.begin((query) => enqueueTurn(query, mira, input))
                )
            ),
    }),
    runs: trpc.router({
        read: trpc.procedure
            .input(miraRunReadSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => readMiraRun(mira, input.id, input.before))
            ),
        list: trpc.procedure
            .input(miraPageSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => listMiraRuns(mira, input.before))
            ),
        cancel: trpc.procedure
            .input(record)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => cancelRun(mira, input.id))
            ),
    }),
    tasks: trpc.router({
        execution: trpc.procedure
            .input(miraConversationReadSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => readTaskExecution(mira, input.id, input.before))
            ),
        reviewRun: trpc.procedure
            .input(miraTaskReviewInputSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => reviewTaskRun(mira, input))
            ),
        run: trpc.procedure
            .input(miraTaskRunInputSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => runMiraTask(mira, input))
            ),
        list: trpc.procedure
            .input(miraTaskFilterSchema)
            .query(({ ctx, input }) => execute(ctx, (mira) => listTasks(mira, input))),
        create: trpc.procedure
            .input(miraTaskInputSchema)
            .mutation(({ ctx, input }) => execute(ctx, (mira) => saveTask(mira, input))),
        update: trpc.procedure
            .input(miraTaskUpdateSchema)
            .mutation(({ ctx, input }) => execute(ctx, (mira) => saveTask(mira, input))),
        delete: trpc.procedure
            .input(versionedIdSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => deleteTask(mira, input.id, input.version))
            ),
        progress: trpc.procedure
            .input(miraConversationReadSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => taskProgress(mira, input.id, input.before))
            ),
        addProgress: trpc.procedure
            .input(miraProgressInputSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => addTaskProgress(mira, input.taskId, input.text))
            ),
    }),
    reports: trpc.router({
        list: trpc.procedure
            .input(miraReportFilterSchema)
            .query(({ ctx, input }) => execute(ctx, (mira) => listReports(mira, input))),
        read: trpc.procedure
            .input(record)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => readReport(mira, input.id))
            ),
        create: trpc.procedure
            .input(miraReportInputSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => createReport(mira, input))
            ),
        change: trpc.procedure
            .input(miraStateChangeSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => changeReport(mira, input))
            ),
    }),
    memory: trpc.router({
        list: trpc.procedure
            .input(miraPageSchema)
            .query(({ ctx, input }) => execute(ctx, (mira) => listMemory(mira, input))),
        create: trpc.procedure
            .input(miraMemoryInputSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => saveMemory(mira, input))
            ),
        update: trpc.procedure
            .input(miraMemoryUpdateSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => saveMemory(mira, input))
            ),
        delete: trpc.procedure
            .input(versionedIdSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => deleteMemory(mira, input.id, input.version))
            ),
    }),
    automations: trpc.router({
        presets: trpc.procedure.mutation(({ ctx }) => execute(ctx, installMiraPresets)),
        run: trpc.procedure
            .input(v.strictObject({ id: idSchema, requestId: idSchema }))
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    runMiraAutomationNow(mira, input.id, input.requestId)
                )
            ),
        delete: trpc.procedure
            .input(versionedIdSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) =>
                    deleteMiraAutomation(mira, input.id, input.version)
                )
            ),
        list: trpc.procedure
            .input(miraPageSchema)
            .query(({ ctx, input }) =>
                execute(ctx, (mira) => listMiraAutomations(mira, input.before))
            ),
        create: trpc.procedure
            .input(miraAutomationInputSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => saveMiraAutomation(mira, input))
            ),
        update: trpc.procedure
            .input(miraAutomationUpdateSchema)
            .mutation(({ ctx, input }) =>
                execute(ctx, (mira) => saveMiraAutomation(mira, input))
            ),
    }),
    integrations: trpc.procedure.query(({ ctx }) =>
        execute(ctx, (mira) =>
            listMiraIntegrations(
                mira,
                ctx.operations?.agentMailHook,
                ctx.operations?.moltbookBinding,
                ctx.operations?.hereNowBinding,
                ctx.operations?.daytonaBinding,
                ctx.operations?.githubBinding
            )
        )
    ),
    controls: trpc.router({
        list: trpc.procedure.query(({ ctx }) => execute(ctx, listMiraSwitches)),
        setEnabled: trpc.procedure.input(miraEnableSchema).mutation(({ ctx, input }) =>
            execute(ctx, async (mira) => {
                const binding = ctx.operations?.agentMailHook;
                const moltbook = ctx.operations?.moltbookBinding;
                const hereNow = ctx.operations?.hereNowBinding;
                const daytona = ctx.operations?.daytonaBinding;
                const github = ctx.operations?.githubBinding;
                if (
                    [
                        "integration:agentmail",
                        "integration:moltbook",
                        "integration:moltbook-publish",
                        "integration:here-now",
                        "integration:daytona",
                        "integration:github",
                    ].includes(input.key) &&
                    input.enabled
                ) {
                    const statuses = await listMiraIntegrations(
                        mira,
                        binding,
                        moltbook,
                        hereNow,
                        daytona,
                        github
                    );
                    const status = statuses.find((item) => item.key === input.key);
                    if (!status?.ready)
                        throw new MiraFailure(
                            "PRECONDITION_FAILED",
                            status?.message ??
                                "The integration must be configured and connected before enabling it."
                        );
                }
                let hash: string | undefined;
                if (
                    ["integration:moltbook", "integration:moltbook-publish"].includes(
                        input.key
                    ) &&
                    moltbook?.owner === mira.owner
                )
                    hash = moltbookBindingHash(moltbook);
                else if (
                    input.key === "integration:agentmail" &&
                    binding?.owner === mira.owner
                )
                    hash = agentMailBindingHash(binding);
                else if (
                    input.key === "integration:here-now" &&
                    hereNow?.owner === mira.owner
                )
                    hash = hereNowBindingHash(hereNow);
                if (input.key === "integration:daytona" && daytona?.owner === mira.owner)
                    hash = daytonaBindingHash(daytona);
                if (input.key === "integration:github" && github?.owner === mira.owner)
                    hash = githubBindingHash(github);
                return setMiraEnabled(mira, input, hash);
            })
        ),
    }),
});
