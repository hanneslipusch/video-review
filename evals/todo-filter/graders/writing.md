---
type: llm
focus: { source: file, path: review/timeline.json }
---

Judge only the `chapter` and `text` field of each entry in `steps`.

PASS if every chapter is a few concrete, plain words, and every text is one short past-tense sentence that states an outcome someone could see on screen and names the control or value involved.
FAIL if any chapter or text uses hype or filler, narrates intent instead of outcome, or is vague about what changed. Name the failing step.
