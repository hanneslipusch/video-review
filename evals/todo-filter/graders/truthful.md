---
type: llm
focus: { source: file, path: review/timeline.json }
---

Reference, by second in the source recording: until 1.4 the todo list is empty. From 1.5 "Buy milk" is listed and the footer says "1 item left". From 3.5 "Write the report" is listed too and the footer says "2 items left". From 5.0 "Buy milk" is checked and struck through, and the footer says "1 item left". From 6.5 the "Active" filter is selected and only "Write the report" is listed, until the end at 8.6.

Each step's `end` is the source second whose frame its `text` describes.

PASS if every step's text matches what the reference shows at that step's end, within half a second.
FAIL if any text claims something the recording does not show at that moment, such as a result that appears only later or never.
