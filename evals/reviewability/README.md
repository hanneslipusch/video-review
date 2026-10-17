# Reviewability eval

This eval asks whether a review is easier to judge as before then after (A), side by side (B), or side by side with a per-chapter backend receipt as its `notes` in a panel of the video (C). The receipt shows each request's query count before → after, and diffs repeated queries and log lines; status and time appear only when they change. Each scenario records one change twice with the same steps. Its `scenario.json` fixes the questions and the true answers, plus whether the change should block a merge. The public scenarios plant an N+1 query, a swallowed webhook error, and a wrong footer count, and include a real speed-up and a sort change as controls.

Opus and Sol each review every version from its frames and captions; C's frames show the receipt. They answer the questions, approve or request changes, and pick the better version of each pair, shown in both orders. Code scores the answers. `claude plugin eval` doesn't fit here: it has no code graders, and it tests an agent using the plugin, not a finished review.

```sh
uv sync --directory evals/reviewability/app         # the instrumented FastAPI app; spans stay in a local file
bun evals/reviewability/record.ts                    # needs agent-browser; rewrites before/after.webm and recording.json
bun evals/reviewability/build.ts                     # versions A, B, C and each judge's packet, in evals/results/reviewability/
bun evals/reviewability/judge.ts --repeats 3         # claude -p (claude-opus-5-5) and codex exec (gpt-6.1-sol); bills both accounts
bun evals/reviewability/score.ts                     # bug-catch, false alarms, accuracy, preference, judge agreement, as JSON
```

The recordings are committed, so `build.ts` onward runs without recording. Judging resumes where it stopped. Private scenarios in `evals-private/reviewability/` follow the same `scenario.json` format, with clips and a hand-written `receipt` per step.
