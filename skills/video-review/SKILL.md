---
name: video-review
description: Build a narrated review video from recordings, screenshots and clips you make. Use for pull request evidence, demos and bug reports.
---

# Video review

A reviewer watches this one video instead of running your work. Done when every change and its result is on screen, the lines say what you decided and didn't check, and the frames the build prints for each step show what its line says.

## Show the change

Show each change the way that makes it obvious. When it has a before, show before and after side by side, before on the left, both recorded with the same steps from the same start, each at a 960 px wide viewport, half the 1920 px frame, so its text stays full size. Otherwise use the recording, a zoom on the detail, the highlighted diff, or a page of the exported file. A step's `source` takes any video or image, so compose with ffmpeg, or with HyperFrames for HTML. Show only real output, and name the take when there are several. `video-review build --help` gives the input format.

## Fit each line to its footage

Each step plays its footage once, with its line on screen and spoken throughout. The footage sets the length, and the line fits it: when the build refuses a step, cut words or merge it with the next. Keep every frame at recorded speed, since a reviewer reads a frozen screen as a hang. When you record for the review, time the lines first with `video-review lines`, then stay on each step that long.

## Write lines

The lines are all a reviewer takes in. Give each step one result: where to look and what happens there, in the present tense, naming the control or value. The chapter is a few plain words.

Good: chapter "Site saved", text "Save, and the site appears on the project page."
Bad: chapter "Seamless site update", text "The site was successfully updated, showcasing an enhanced experience."

Then say what watching can't show: a choice a reviewer would question and why, a trade-off you made, and what you didn't check. Put each over the footage it concerns, or over a still of the result at the end.

Good: "Totals round per row, like the invoice PDF, so the sum can differ by a cent."
Good: "Seeded with three sites; a list of 500 is unchecked."

Name things as people say them, and end on the result. When Gemini fails, as on quota, build with `--captions-only`, deliver it, and tell the user what to fix for a voiceover.

## Share

Share the link to the hosted review page. Where video can't play, as in a pull request, put the link first and add `preview.gif` linking to it only under 5 MiB; GitHub's [image proxy](https://github.com/atmos/camo#configuration) breaks larger images.
