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

The skill gives your agent these steps. By hand:

```sh
video-review frames recording.webm --out frames            # one image every 0.5 s, to find each step's times
video-review build recording.webm steps.json --out review
```

In `steps.json`, each step plays its interval of the recording, in seconds, with `text` captioned and spoken throughout. `chapter` labels the progress bar in at most 20 characters.

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

An interval must last as long as its line takes to read or hear, and the build names any step that is too short. When you record for the review, run `video-review lines steps.json` first: it prints the seconds each line needs. A step can also show another recording or a PNG card, or a panel of Markdown notes. `video-review build --help` lists every input and output.

Serve the `review` folder from any static server, because browsers block its player script on `file://`.

## What the reviewer gets

`index.html` plays the review at 1.5×, each step at recorded speed in a 16:9 frame, with its caption on screen at least as long as a reader needs. Hovering the progress bar previews a step. The [Video.js 10](https://videojs.org/) player is bundled, with no CDN.

The folder also holds `video.mp4` for chat, `frames/` with each step's first, middle and last frame, and `preview.gif` at 2.5× for pages that can't play video, such as a pull request. There, link the page first: GitHub shows a GIF over 5 MiB as a broken image.

## Voiceover

The build speaks every line with the first provider whose variables are set:

| Provider | Variables | Voice |
|---|---|---|
| [Gemini](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` | Kore |
| [Azure AI Speech](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech) | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` such as `westeurope` | `en-US-AvaMultilingualNeural` |
| [ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | your voice, with `eleven_v4` |

If that provider fails, as on Gemini's daily quota, the next one speaks every line, so a review keeps one voice. Only the caption text is sent. Speech is cached per line in `~/.cache/video-review/speech`, or under `$XDG_CACHE_HOME`, and a rebuild stays with the provider that already spoke most lines. With no key set, or with `--captions-only`, the review has captions only.

## Develop

```sh
bun run check
bun run test
claude plugin eval . --allow-tools Bash Write --judge-model sonnet --no-publish
claude --plugin-dir .   # try the plugin from this checkout
```

Commit the generated `bin/video-review` with the source. The evals run each case with and without the skill and bill your Claude account. They judge with Sonnet, because the default Haiku judge fails timelines that match their reference. Their sandbox hides your home directory, so put `bun`, `ffmpeg`, `ffprobe`, and this repo's `bin/` on a `PATH` outside it. Keep private cases in `evals-private/`, which git ignores, and run them with `--eval-dir evals-private`.

[The reviewability eval](evals/reviewability/README.md) measures which review layout helps a reviewer catch a bug.
