# video-review

Turn an agent's screen recording into a narrated review video that someone can check in under a minute.

![A review page plays LibreChat issue #16636 at 1.5×: before and after the fix side by side, the result up close, and what wasn't checked. Hovering the progress bar previews a step.](docs/demo.gif)

This review shows a LibreChat bug before and after the fix. One command built it from two 6-second recordings and a `steps.json`.

## Install

You need [Bun](https://bun.sh) and [FFmpeg](https://ffmpeg.org/download.html) with `ffprobe`, `libx264` and `libass` on `PATH`.

In Claude Code, the plugin adds the skill and the `video-review` command:

```sh
claude plugin marketplace add hanneslipusch/agents
claude plugin install video-review@hanneslipusch
```

For other agents, install the skill and the command:

```sh
bunx skills add hanneslipusch/video-review
bun add -g github:hanneslipusch/video-review
```

## Build a review

The skill gives your agent these steps. By hand, first find the times. `video-review frames recording.webm --out frames` writes one image every 0.5 s, named by its second.

Then write `steps.json`. Times are seconds in the recording. Each step plays exactly its interval, with `text` as its caption throughout, so the interval must last as long as the caption takes to read: the build names any step that is too short. `chapter` labels the progress bar in at most 20 characters.

```json
{
  "title": "Search Wikipedia for FFmpeg",
  "steps": [
    { "start": 0, "end": 5, "chapter": "Search suggested", "text": "Typing FFmpeg suggests the article." },
    { "start": 5, "end": 8, "chapter": "Article opened", "text": "Enter opens it." },
    { "start": 8, "end": 13.5, "chapter": "History shown", "text": "The page scrolls to its history." }
  ]
}
```

To show another recording or a card, give the step a `source` path relative to `steps.json`. Another recording uses its own clock. A PNG or JPG card takes no `start` or `end` and shows for as long as its caption needs:

```json
{ "source": "what-changed.png", "chapter": "What changed", "text": "Watch the attachment when the model switches." }
```

When you record for the review, time it first: `video-review lines steps.json` prints the seconds each line needs to be read or spoken, so the recording can stay on each step that long.

Build the review:

```sh
video-review build recording.webm steps.json --out review
```

Serve the `review` folder from any static server; browsers block its player script on `file://`. A new build replaces the review in its `--out` folder and refuses any other existing folder. `video-review build --help` lists every input and output.

## What the reviewer gets

The page plays at 1.5×, and the rate button steps from 1× to 4×. Each line stays on screen at least as long as a subtitle reader needs at 1.5×: 17 characters per second of watching time, or the spoken line plus half a second. Each step plays at recorded speed in a 16:9 frame, with no frozen frames. Hover a segment of the progress bar to see its chapter and a frame. With `notes`, the frame widens by a panel on the right that shows each step's note, also in fullscreen, `video.mp4` and `preview.gif`.

The folder also holds `video.mp4` for chat, `frames/` with each step's first, middle and last frame and its caption, and `timeline.json` with source hashes, step times and notes. `preview.gif` plays the review at 2.5× with the captions, for pages that can't play video, such as a pull request. Link the page first; GitHub shows a GIF over 5 MiB as a broken image. The [Video.js 10](https://videojs.org/) player is bundled, with no CDN.

## Voiceover

With `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey) set, the build speaks each line; without it, the review is captions-only. Pass `--captions-only` for a silent review. Only the caption text goes to the [Gemini TTS API](https://ai.google.dev/gemini-api/docs/speech-generation). Each line's speech is cached in `~/.cache/video-review/speech`, or under `$XDG_CACHE_HOME`, so a rebuild requests only the lines that changed. The voice is part of `video.mp4`.

## Develop

```sh
bun run check
bun run test
claude plugin eval . --allow-tools Bash Write --judge-model sonnet --no-publish
claude --plugin-dir .   # try the plugin from this checkout
```

Commit the generated `bin/video-review` with the source. The default Haiku judge fails timelines that match their reference, so the evals judge with Sonnet. They run each case with and without the skill and bill your Claude account. Their sandbox hides your home directory, so put `bun`, `ffmpeg`, `ffprobe`, and this repo's `bin/` on a `PATH` outside it. Keep private cases in `evals-private/`, which git ignores, and run them with `--eval-dir evals-private`.

### Reviewability eval

`evals/reviewability/` asks whether a review is easier to judge as before then after (A), side by side (B), or side by side with a per-chapter backend receipt as its `notes` in a panel of the video (C). The receipt shows each request's query count before → after, and diffs repeated queries and log lines; status and time appear only when they change. Each scenario records one change twice with the same steps. Its `scenario.json` fixes the questions and the true answers, plus whether the change should block a merge. The public scenarios plant an N+1 query, a swallowed webhook error, and a wrong footer count, and include a real speed-up and a sort change as controls.

Opus and Sol each review every version from its frames and captions; C's frames show the receipt. They answer the questions, approve or request changes, and pick the better version of each pair, shown in both orders. Code scores the answers. `claude plugin eval` doesn't fit here: it has no code graders, and it tests an agent using the plugin, not a finished review.

```sh
uv sync --directory evals/reviewability/app         # the instrumented FastAPI app; spans stay in a local file
bun evals/reviewability/record.ts                    # needs agent-browser; rewrites before/after.webm and recording.json
bun evals/reviewability/build.ts                     # versions A, B, C and each judge's packet, in evals/results/reviewability/
bun evals/reviewability/judge.ts --repeats 3         # claude -p (claude-opus-5-5) and codex exec (gpt-6.1-sol); bills both accounts
bun evals/reviewability/score.ts                     # bug-catch, false alarms, accuracy, preference, judge agreement, as JSON
```

The recordings are committed, so `build.ts` onward runs without recording. Judging resumes where it stopped. Private scenarios in `evals-private/reviewability/` follow the same `scenario.json` format, with clips and a hand-written `receipt` per step.

`patches/` fixes the type declarations in `@videojs/html` 10.0.0 until [videojs/v10#2369](https://github.com/videojs/v10/issues/2369) ships.
