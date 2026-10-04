---
type: llm
focus: { source: file, path: review/timeline.json }
---

Reference, by second in the source recording: until 1.4 the todo list is empty. From 1.5 "Buy milk" is listed and the footer says "1 item left". From 3.5 "Write the report" is listed too and the footer says "2 items left". From 5.0 "Buy milk" is checked and struck through, and the footer says "1 item left". From 6.5 the "Active" filter is selected and only "Write the report" is listed, until the end at 8.6.

Each step shows its `start` to `end` interval of the recording, with its `text` on screen throughout.

A step without `start` and `end` shows a still image instead. Its text may state a decision or something left unchecked, and must agree with the reference.

PASS if everything each step's text says happens is shown inside that step's interval, within half a second.
FAIL if any text claims something its interval does not show, such as a result that appears only after its end or never.
