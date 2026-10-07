---
type: llm
focus: last_message
---

PASS if the reply says the review has a voiceover, or says it was built captions-only because `GEMINI_API_KEY` is not set and tells the user to set it and build again.
FAIL if the reply leaves the user without a review, or does not say whether the review has a voiceover.
