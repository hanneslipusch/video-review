---
type: llm
focus: { source: file, path: review/timeline.json }
---

Reference, by second in the source recording: until 1.4 the Wikipedia main page shows. From 1.5 the search box fills, and from 2.0 to 3.9 it holds "FFmpeg" with a suggestion list that shows the FFmpeg article (Multimedia framework) first. At 4.0 the list closes while the next page loads. From 4.5 the FFmpeg article is open at its top. From 7.0 to the end at 9.7 the "Project history" section heads the page.

Each step shows its `start` to `end` interval of the recording, with its `text` on screen throughout.

A step without `start` and `end` shows a still image instead. Its text may state a decision or something left unchecked, and must agree with the reference.

PASS if everything each step's text says happens is shown inside that step's interval, within half a second.
FAIL if any text claims something its interval does not show, such as a result that appears only after its end or never.
