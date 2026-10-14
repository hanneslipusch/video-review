// Define <video-player> before the UI elements, or they never find their player.
import './player-element';
import '@videojs/html/video/neutral-ui';
import { PLAYBACK_RATE } from './rate';

const video = document.querySelector('video')!;
// Loading a clip resets playbackRate to defaultPlaybackRate, so set both.
video.defaultPlaybackRate = video.playbackRate = PLAYBACK_RATE;

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

const notes = document.querySelector('.notes');
if (notes) {
  const articles = [...notes.querySelectorAll('article')];
  // timeupdate fires as playback moves and after every seek.
  video.addEventListener('timeupdate', () => {
    const current = articles.findLast(article => Number(article.dataset['at']) <= video.currentTime);
    if (!current?.hidden) return;
    for (const article of articles) article.hidden = article !== current;
    notes.scrollTop = 0;
  });
}
