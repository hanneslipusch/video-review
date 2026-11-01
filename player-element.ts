import { createPlayer, orientationLockFeature, playbackRateFeature, videoFeatures } from '@videojs/html';
import { registerIcons } from '@videojs/html/icons';
import { captionsOffIcon, captionsOnIcon, chevronIcon, fullscreenEnterIcon, fullscreenExitIcon, pauseIcon, playIcon, restartIcon, spinnerIcon, volumeHighIcon, volumeLowIcon, volumeOffIcon } from '@videojs/html/icons/neutral';
import { PLAYBACK_RATES } from './playback';

// Markup follows the editable Neutral Video Skin: https://videojs.org/docs/framework/html/guides/customize-skins#style-skin-source
registerIcons('neutral', {
  'captions-off': captionsOffIcon, 'captions-on': captionsOnIcon, chevron: chevronIcon,
  'fullscreen-enter': fullscreenEnterIcon, 'fullscreen-exit': fullscreenExitIcon,
  pause: pauseIcon, play: playIcon, restart: restartIcon, spinner: spinnerIcon,
  'volume-high': volumeHighIcon, 'volume-low': volumeLowIcon, 'volume-off': volumeOffIcon,
});

// Video.js 10.2 fixes rates at 0.2–2×; replace the list until https://github.com/videojs/video.js/issues/9273 ships.
const reviewRates: typeof playbackRateFeature = {
  ...playbackRateFeature,
  state: context => ({ ...playbackRateFeature.state(context), playbackRates: PLAYBACK_RATES }),
};
const { PlayerElement } = createPlayer({ features: [...videoFeatures.map(feature => feature === playbackRateFeature ? reviewRates : feature), orientationLockFeature] });
customElements.define('video-player', class extends PlayerElement {});
