---
type: llm
focus: { source: file, path: review/timeline.json }
---

Judge only the `text` field of each entry in `steps`. Each text is spoken aloud to a product manager watching the recording.

PASS if every text, in one or two short sentences, tells the viewer where to look and what they should see there, names things as people say them rather than as IDs or file names, and ends on the result of that step.
FAIL if any text reads like a log line, only restates an action without the visible result, or uses hype or filler. Name the failing step.
