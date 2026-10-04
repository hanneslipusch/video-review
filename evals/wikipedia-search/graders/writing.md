---
type: llm
focus: { source: file, path: review/timeline.json }
---

Judge only the `chapter` and `text` field of each entry in `steps`.

PASS if every chapter is a few concrete, plain words, and every text is one short present-tense line that either says what to watch and what happens on screen, naming the control or value involved, or states a decision or something left unchecked.
FAIL if any chapter or text uses hype or filler, or is vague about what changed. Name the failing step.
