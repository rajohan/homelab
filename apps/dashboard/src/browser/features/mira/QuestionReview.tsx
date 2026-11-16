import { type MiraProposal, miraQuestionRequestSchema } from "@homelab/contracts/mira";
import { ActionGroup, Button, ErrorNotice, Textarea } from "@homelab/ui";
import { useState } from "react";
import * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Present one question at a time, preserving choices and free text while browsing.
 * @returns A shared question card; only an explicit submission sends all answers.
 */
export function QuestionReview({ proposal }: { readonly proposal: MiraProposal }) {
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const answer = useOperation(() =>
        api.mira.proposals.answer.mutate({
            id: proposal.id,
            inputHash: proposal.inputHash,
            answers,
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
    const complete = questions.every((entry) => answers[entry.id]?.trim());
    return (
        <section aria-label="Answer Mira">
            <p className="mb-2 text-xs text-primary-400" aria-live="polite">
                Question {index + 1} of {questions.length}
            </p>
            <fieldset disabled={answer.isPending} className="space-y-3">
                <legend className="mb-3 text-sm font-medium text-primary-100">
                    {question.title}
                </legend>
                {question.options.map((option, optionIndex) => (
                    <label
                        key={optionIndex}
                        className="flex cursor-pointer items-start gap-3 rounded-lg border border-primary-700 p-3 text-sm text-primary-100"
                    >
                        <input
                            type="radio"
                            name={`question-${proposal.id}-${question.id}`}
                            checked={value === option}
                            onChange={() =>
                                setAnswers((current) => ({
                                    ...current,
                                    [question.id]: option,
                                }))
                            }
                        />
                        <span>{option}</span>
                    </label>
                ))}
                <label
                    htmlFor={`answer-${proposal.id}-${question.id}`}
                    className="block space-y-2 text-sm text-primary-300"
                >
                    <span>Your answer</span>
                    <Textarea
                        id={`answer-${proposal.id}-${question.id}`}
                        value={value}
                        maxLength={4000}
                        rows={2}
                        placeholder="Choose an option or type your own answer"
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
            <ActionGroup className="mt-3">
                <Button
                    variant="secondary"
                    disabled={index === 0 || answer.isPending}
                    onClick={() => setIndex(index - 1)}
                >
                    Previous question
                </Button>
                {index < questions.length - 1 ? (
                    <Button
                        disabled={answer.isPending}
                        onClick={() => setIndex(index + 1)}
                    >
                        Next question
                    </Button>
                ) : (
                    <Button
                        busy={answer.isPending}
                        disabled={!complete}
                        onClick={() => void answer.mutateAsync(undefined).catch(() => {})}
                    >
                        Send answers
                    </Button>
                )}
            </ActionGroup>
        </section>
    );
}
