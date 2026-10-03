---
name: video-review
description: Build a review from an existing workflow recording and timed observations. Use for demonstrations, review evidence or bug recordings.
---

# Video review

Run `video-review build --help` for the input format. It needs Bun and FFmpeg on `PATH`.

## Write the review

- Use a few concrete, plain words for each chapter, at most 20 characters.
- Write one short sentence per result.
- State the observed outcome in past tense. Name the control or value you saw.
- Name an action only when a frame shows it, such as the highlighted control. Otherwise say what changed.
- Cut hype, filler and words such as "successfully". Use periods or commas, not em dashes.

Good: chapter "Site saved", text "The selected site appeared on the project page."
Bad: chapter "Seamless site update", text "The site was successfully updated—showcasing an enhanced experience."

## Mix media

A step's `source` can name another recording, or a card image you made, for example an HTML page you captured. Use a card for context the recording cannot show, such as what the diff changed: one title, at most three short points, each traceable to its source. The card states the facts; its caption says what to watch next. The recording proves the result, so never claim on a card what the recording does not show.

When a review mixes recordings, each caption names its take, for example "Before the fix, switching to Claude removed the image."

## With `--voiceover`

Each step's text is spoken as well as shown, so write it for someone watching, not reading a log.

- Say where to look and what they should see there, in one or two short sentences.
- Name things as people say them: "the image", "Claude", not file names, IDs or version strings.
- End on the result that matters, so the reviewer knows it passed.

Good: "Now the model switches to Claude. Watch the message box: the image should stay, and it does."
Bad: "Switching to claude-sonnet-4-6 kept the image and the text."

Without `GEMINI_API_KEY`, build captions-only and tell the user to set the key and build again with `--voiceover`.

## Share

In a pull request, embed `preview.gif` as an image that links to the hosted review page. GitHub doesn't play linked videos.
