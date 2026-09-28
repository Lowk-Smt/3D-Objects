/* Browser entry used by the real upload flow and the browser regression test.
 * Keeping CDN-facing optimizer imports here (rather than in the large UI
 * module) makes the production dependency boundary directly testable. */

import {
  CANCEL_MESSAGE,
  optimizeGlbBytes,
  resolvePreset,
  shouldUseOptimized,
} from './optimizer-core.mjs';
import { createCanvasTextureStrategy } from './optimizer-browser-textures.mjs';

const canvasTextureStrategy = createCanvasTextureStrategy();

export { CANCEL_MESSAGE, resolvePreset, shouldUseOptimized };

/** Optimize the selected upload using the actual browser canvas path. */
export async function optimizeGLBBlob(blob, onProgress, presetKey = 'balanced', cancelToken = null, timeStage = null) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { glb } = await optimizeGlbBytes(bytes, {
    preset: presetKey,
    resizeTexture: (texture, limits) => canvasTextureStrategy.resize(texture, limits),
    timeStage: (label, run) => {
      if (!timeStage) return run();
      return timeStage(label, run);
    },
    onProgress,
    shouldCancel: () => Boolean(cancelToken && cancelToken.cancelled),
  });
  return new Blob([glb], { type: 'model/gltf-binary' });
}
