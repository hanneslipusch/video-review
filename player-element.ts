import { createPlayer, orientationLockFeature, playbackRateFeature, videoFeatures } from '@videojs/html';
import { registerIcons } from '@videojs/html/icons';
import { captionsOffIcon, captionsOnIcon, chevronIcon, fullscreenEnterIcon, fullscreenExitIcon, pauseIcon, playIcon, restartIcon, spinnerIcon } from '@videojs/html/icons/neutral';

// Markup follows the editable Neutral Video Skin: https://videojs.org/docs/framework/html/guides/customize-skins#style-skin-source
registerIcons('neutral', {
  'captions-off': captionsOffIcon, 'captions-on': captionsOnIcon, chevron: chevronIcon,
  'fullscreen-enter': fullscreenEnterIcon, 'fullscreen-exit': fullscreenExitIcon,
  pause: pauseIcon, play: playIcon, restart: restartIcon, spinner: spinnerIcon,
});

// Video.js 10.0 fixes rates at 0.2–2×; replace the list until https://github.com/videojs/v10/issues/1404 ships.
const rates = [1, 1.5, 2, 2.5, 3, 4];
const reviewRates: typeof playbackRateFeature = {
  ...playbackRateFeature,
  state: context => ({ ...playbackRateFeature.state(context), playbackRates: rates }),
};
const { PlayerElement } = createPlayer({ features: [...videoFeatures.map(feature => feature === playbackRateFeature ? reviewRates : feature), orientationLockFeature] });
customElements.define('video-player', class extends PlayerElement {});
