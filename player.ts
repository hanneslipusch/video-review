// Define <video-player> before the UI elements, or they never find their player.
import { choose, chosenRate } from './player-element';
import '@videojs/html/video/neutral-ui';

const video = document.querySelector('video')!;
video.defaultPlaybackRate = 2.5;
choose(video, 2.5);

// Each step's clip plays during the step's hold. The hold plays slower than the chosen rate when the voice
// needs longer, so the progress bar never stops; extended audio description pauses instead:
// https://www.w3.org/WAI/WCAG22/Understanding/extended-audio-description-prerecorded
const track = document.querySelector<HTMLTrackElement>('track[label="voiceover"]');
if (track) {
  if (track.readyState === HTMLTrackElement.LOADED) voiceover(track.track.cues!);
  else track.addEventListener('load', () => voiceover(track.track.cues!), { once: true });
}

function voiceover(cues: TextTrackCueList) {
  const steps = Array.from(cues, cue => ({ start: cue.startTime, end: cue.endTime, src: new URL((cue as VTTCue).text, location.href).href }));
  // One element for every clip: Safari grants playback per element, and only from a user gesture.
  // https://webkit.org/blog/7734/auto-play-policy-changes-for-macos/
  const voice = new Audio();
  // 10 ms of silence: playing it from the first gesture unlocks the element without a sound.
  const SILENCE = 'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
  // Wait this many real seconds before a hold ends: frames and timers can arrive late on a busy machine.
  const GUARD = 0.25;
  let active: (typeof steps)[number] | undefined;
  let waiting = false, entries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blocked = (error: unknown) => console.warn('video-review: voiceover blocked', error);
  const speaking = () => !voice.paused && !voice.ended;
  // The hold plays no slower than this; a longer voice falls back to a pause at the hold's end.
  const SLOWEST = 0.25;
  let applied = NaN;
  const apply = (rate: number) => { if (Math.abs(video.playbackRate - rate) > 0.02) { applied = rate; video.playbackRate = rate; } };
  const stretch = () => {
    if (!active || !speaking() || video.paused) return apply(chosenRate(video));
    // Set once per start: per-frame correction chases the voice clock's coarse steps and output latency.
    // The 15% margin lets the voice end first, after which the rest of the hold plays at the chosen rate.
    const videoLeft = 0.85 * (deadline() - video.currentTime), voiceLeft = (voice.duration - voice.currentTime) / voice.playbackRate;
    apply(Math.min(chosenRate(video), Math.max(SLOWEST, videoLeft / voiceLeft)));
  };
  const deadline = () => active!.end - GUARD * video.playbackRate;
  const wait = () => {
    if (!active || waiting || !speaking() || video.paused || video.currentTime < deadline()) return;
    waiting = true;
    video.pause();
  };
  const schedule = () => {
    clearTimeout(timer);
    if (active && speaking() && !video.paused) timer = setTimeout(wait, Math.max(0, (deadline() - video.currentTime) / video.playbackRate * 1000));
  };
  const speak = () => { voice.play().then(schedule, blocked); };
  const enter = (step: typeof active) => {
    voice.pause();
    waiting = false;
    active = step;
    entries++;
    if (!step) return;
    voice.src = step.src;
    if (!video.paused) speak();
  };
  const unlock = () => {
    const entry = entries;
    if (!voice.src) voice.src = SILENCE;
    if (voice.paused) voice.play().then(() => { if (entries === entry && (!active || video.paused)) voice.pause(); }, blocked);
  };
  for (const type of ['pointerup', 'keyup']) video.closest('video-player')!.addEventListener(type, unlock, { capture: true, once: true });
  // The voice speeds up by the square root of the video rate, capped at 1.8×, about 270 words per minute
  // for this voice; comprehension of sped-up speech drops past about 275 (Foulke and Sticht, 1969).
  // Loading a clip resets playbackRate to defaultPlaybackRate, so set both.
  const pace = () => {
    // A rate set directly on the element, not by us or the rate button, becomes the chosen rate.
    if (video.playbackRate !== applied && video.playbackRate !== chosenRate(video)) video.dataset.rate = String(video.playbackRate);
    voice.defaultPlaybackRate = voice.playbackRate = Math.min(1.8, Math.sqrt(chosenRate(video)));
    if (video.playbackRate !== applied) stretch();
    schedule();
  };
  const follow = () => { voice.volume = video.volume; voice.muted = video.muted; };
  pace();
  follow();
  video.addEventListener('ratechange', pace);
  video.addEventListener('volumechange', follow);
  video.addEventListener('seeking', () => enter(undefined));
  // Reaching the end also pauses the video; let the last step finish speaking.
  video.addEventListener('pause', () => { clearTimeout(timer); if (!waiting && !video.ended) voice.pause(); });
  video.addEventListener('play', () => {
    // Play while the video waits for the voice skips the rest of the line.
    if (waiting) { waiting = false; voice.pause(); voice.currentTime = voice.duration; }
    else if (active && voice.paused && !voice.ended) speak();
  });
  // play() on an ended video restarts it, so only resume a wait that stopped short of the end.
  voice.addEventListener('playing', stretch);
  voice.addEventListener('pause', stretch);
  voice.addEventListener('ended', () => { if (waiting) { waiting = false; if (!video.ended) video.play().catch(blocked); } });
  // Hidden tabs stop frame callbacks and throttle timers, so pause both and resume on Play.
  document.addEventListener('visibilitychange', () => { if (document.hidden) { waiting = false; video.pause(); voice.pause(); } });
  const tick = () => {
    wait();
    const time = video.currentTime;
    if (!waiting && !(active && active.start <= time && time < active.end)) {
      const step = steps.find(s => s.start <= time && time < s.end);
      if (step !== active) enter(step);
    }
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
}
