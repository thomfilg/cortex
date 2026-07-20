'use strict';

/**
 * No-op stand-in for sharp (see package.json for why).
 *
 * @xenova/transformers does `import sharp from 'sharp'` at module load and
 * throws "Unable to load image processing library." if the default export is
 * falsy — so this must export a truthy function. It only throws if something
 * actually tries to process an image, which cortex never does.
 */
function sharp() {
  throw new Error(
    'sharp is stubbed out in cortex: image processing is not supported ' +
    '(cortex only uses text embeddings).'
  );
}

module.exports = sharp;
module.exports.default = sharp;
