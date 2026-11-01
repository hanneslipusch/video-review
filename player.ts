// Define <video-player> before the UI elements, or they never find their player.
import './player-element';
import '@videojs/html/video/neutral-ui';
import { FPS, PLAYBACK_RATE, PLAYBACK_RATES } from './playback';

const video = document.querySelector('video')!;
// Loading a clip resets playbackRate to defaultPlaybackRate, so set both.
video.defaultPlaybackRate = video.playbackRate = PLAYBACK_RATE;
const chapters = [...video.textTracks].find(track => track.kind === 'chapters')!;
const shortcuts = document.querySelector('dialog')!;
document.querySelector('#shortcuts-button')!.addEventListener('click', () => shortcuts.showModal());

// YouTube's shortcuts that Video.js has no action for: https://support.google.com/youtube/answer/7631406
// Chapters take Option on a Mac, where Control+arrows switch desktops, and Control elsewhere, where Alt+arrows go back.
const chapterKey = /Mac/.test(navigator.userAgent) ? 'altKey' : 'ctrlKey';
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.metaKey) return;
  const forward = event.key === '>' || event.key === '.' || event.key === 'ArrowRight';
  if (event.key === '?') {
    if (shortcuts.open) shortcuts.close(); else shortcuts.showModal();
  } else if (event.key === '<' || event.key === '>') {
    video.playbackRate = Math.min(PLAYBACK_RATES.at(-1)!, Math.max(0.25, video.playbackRate + (forward ? 0.25 : -0.25)));
  } else if ((event.key === ',' || event.key === '.') && video.paused) {
    video.currentTime += (forward ? 1 : -1) / FPS;
  } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event[chapterKey]) {
    // Like YouTube, back goes to the previous chapter's start, however far into this one.
    const starts = [...chapters.cues ?? []].map(cue => cue.startTime);
    const current = starts.findLastIndex(start => start <= video.currentTime + 0.5 / FPS);
    const target = starts[forward ? current + 1 : Math.max(0, current - 1)];
    if (target === undefined) return;
    video.currentTime = target;
  } else return;
  event.preventDefault();
});

// Seeking a served file needs HTTP Range support, which servers such as Python's http.server lack;
// a downloaded copy seeks anywhere. Until it arrives, or if it fails, the served file plays.
fetch(video.currentSrc || video.src).then(response => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}).then(blob => {
  const { currentTime, paused, playbackRate } = video;
  video.src = URL.createObjectURL(blob);
  video.currentTime = currentTime;
  video.playbackRate = playbackRate;
  if (!paused) void video.play();
}, error => console.warn('video-review: download failed; seeking needs a server with Range support', error));
