import { type MiraProposal, miraQuestionRequestSchema } from "@homelab/contracts/mira";
import { Button, ErrorNotice, Textarea } from "@homelab/ui";
import { useRef, useState } from "react";
import * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Collect one answer at a time while preserving drafts during navigation.
 * @returns Immediate choice actions and a right-aligned send action for free text.
 */
export function QuestionReview({ proposal }: { readonly proposal: MiraProposal }) {
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const submitting = useRef(false);
    const answer = useOperation((values: Record<string, string>) =>
        api.mira.proposals.answer.mutate({
            id: proposal.id,
            inputHash: proposal.inputHash,
            answers: values,
        })
    );
    const request = v.safeParse(miraQuestionRequestSchema, proposal.input);
    if (!request.success)
        return (
            <ErrorNotice
                error={
                    new Error(
                        "This question could not be loaded. Refresh the conversation."
                    )
                }
            />
        );
    const questions = request.output.questions;
    const question = questions[index]!;
    const value = answers[question.id] ?? "";
    const advance = async (value: string) => {
        if (!value.trim() || submitting.current) return;
        const next = { ...answers, [question.id]: value };
        setAnswers(next);
        const missing = questions.findIndex((entry) => !next[entry.id]?.trim());
        if (missing !== -1) {
            setIndex(missing);
            return;
        }
        submitting.current = true;
        try {
            await answer.mutateAsync(next);
        } catch {
            // Keep the exact answers available for an explicit retry.
        } finally {
            submitting.current = false;
        }
    };
    return (
        <section aria-label="Answer Mira">
            {questions.length > 1 && (
                <p className="mb-1 text-xs text-primary-400" aria-live="polite">
                    Question {index + 1} of {questions.length}
                </p>
            )}
            <fieldset disabled={answer.isPending} className="space-y-2">
                <legend className="mb-2 text-sm font-medium wrap-anywhere text-primary-100">
                    {question.title}
                </legend>
                {question.options.length > 0 && (
                    <div className="flex flex-col gap-1">
                        {question.options.map((option, optionIndex) => (
                            <Button
                                key={optionIndex}
                                size="sm"
                                variant="secondary"
                                className="h-auto min-h-9 justify-start text-left wrap-anywhere whitespace-normal"
                                onClick={() => void advance(option)}
                            >
                                {option}
                            </Button>
                        ))}
                    </div>
                )}
                <label
                    htmlFor={`answer-${proposal.id}-${question.id}`}
                    className="block text-sm text-primary-300"
                >
                    <span className="sr-only">Your answer</span>
                    <Textarea
                        id={`answer-${proposal.id}-${question.id}`}
                        value={value}
                        maxLength={4000}
                        rows={1}
                        className="min-h-9"
                        placeholder="Type your own answer"
                        onKeyDown={(event) => {
                            if (
                                event.key === "Enter" &&
                                !event.shiftKey &&
                                !event.altKey &&
                                !event.nativeEvent.isComposing &&
                                globalThis.matchMedia("(pointer: fine)").matches
                            ) {
                                event.preventDefault();
                                void advance(value);
                            }
                        }}
                        onChange={(event) =>
                            setAnswers((current) => ({
                                ...current,
                                [question.id]: event.target.value,
                            }))
                        }
                    />
                </label>
            </fieldset>
            {answer.error && <ErrorNotice error={answer.error} />}
            <div className="mt-2 flex items-center justify-end gap-2">
                {questions.length > 1 && index > 0 && (
                    <Button
                        size="sm"
                        variant="secondary"
                        className="mr-auto"
                        disabled={answer.isPending}
                        onClick={() => setIndex(index - 1)}
                    >
                        Previous question
                    </Button>
                )}
                <Button
                    size="sm"
                    busy={answer.isPending}
                    disabled={!value.trim()}
                    onClick={() => void advance(value)}
                >
                    {questions.some(
                        (entry) => entry.id !== question.id && !answers[entry.id]?.trim()
                    )
                        ? "Next"
                        : "Send"}
                </Button>
            </div>
        </section>
    );
}
