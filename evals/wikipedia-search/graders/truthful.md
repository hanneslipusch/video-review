---
type: llm
focus: { source: file, path: review/timeline.json }
---

Reference, by second in the source recording: until 1.4 the Wikipedia main page shows. From 1.5 the search box fills, and from 2.0 to 3.9 it holds "FFmpeg" with a suggestion list that shows the FFmpeg article (Multimedia framework) first. At 4.0 the list closes while the next page loads. From 4.5 the FFmpeg article is open at its top. From 7.0 to the end at 9.7 the "Project history" section heads the page.

Each step's `end` is the source second whose frame its `text` describes.

PASS if every step's text matches what the reference shows at that step's end, within half a second.
FAIL if any text claims something the recording does not show at that moment, such as a result that appears only later or never.
