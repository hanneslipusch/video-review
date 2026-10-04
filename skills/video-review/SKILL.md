---
name: video-review
description: Build a captioned review video from recordings, screenshots and clips you make. Use for pull request evidence, demos and bug reports.
---

# Video review

A reviewer watches this one video instead of running your work. Done when every change and its result is on screen, the lines say what you decided and didn't check, and the frames the build prints for each step show what its line says.

## Show the change

Show each change in whatever way makes it obvious: the recording, before and after side by side, a zoom on the detail, the diff highlighted, a page of the exported file. A step's `source` takes any video or image, so compose what you need with ffmpeg, or with HyperFrames for HTML. Everything shown is real output from the work, and a line names the take when there are several.

Run `video-review build --help` for the input format.

## Fit each line to its footage

A step plays its footage once at recorded speed, with its line on screen, and spoken with `--voiceover`, the whole time. The footage sets the time, and the line fits it. When the build refuses a step, say it in fewer words or merge it with the next step. Hold and slow no frame: a reviewer reads a frozen screen as a hang. When you record for the review, time the lines first with `video-review lines`, then stay on each step that long.

## Write lines

The lines are all a reviewer takes in: heard with `--voiceover`, read as captions. Give each step one result. Its line says where to look and what happens there, in the present tense, naming the control or value. The chapter is a few plain words.

Good: chapter "Site saved", text "Save, and the site appears on the project page."
Bad: chapter "Seamless site update", text "The site was successfully updated, showcasing an enhanced experience."

Then say what watching can't show: a choice a reviewer would question and why, a trade-off you made, and what you didn't check. Put each over the footage it concerns, or over a still of the result at the end.

Good: "Totals round per row, like the invoice PDF, so the sum can differ by a cent."
Good: "Seeded with three sites; a list of 500 is unchecked."

With `--voiceover`, name things as people say them, and end on the result. Without `GEMINI_API_KEY`, build captions-only and tell the user to set the key and build again.

## Share

In a pull request, embed `preview.gif` as an image that links to the hosted review page. GitHub doesn't play linked videos.
