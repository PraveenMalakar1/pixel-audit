import sharp from 'sharp';
import pixelmatch from 'pixelmatch';

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

export interface Aligned {
  width: number;
  height: number;
  /** Live width / design image width (before resizing). */
  imageScale: number;
  designHeight: number;
  liveHeight: number;
  /** Raw RGBA buffers of identical size. */
  design: Buffer;
  live: Buffer;
}

/**
 * Makes design and live images the same size so they can be compared:
 * the design is scaled to the live width, then both are padded with white
 * at the bottom up to the taller height.
 */
export async function alignImages(designPng: Buffer, livePng: Buffer): Promise<Aligned> {
  const lm = await sharp(livePng).metadata();
  const dm = await sharp(designPng).metadata();
  if (!lm.width || !lm.height || !dm.width || !dm.height) throw new Error('Could not read image sizes.');
  const width = lm.width;

  const resized = await sharp(designPng)
    .resize({ width, kernel: 'lanczos3' })
    .flatten({ background: WHITE })
    .png()
    .toBuffer({ resolveWithObject: true });
  const designHeight = resized.info.height;
  const liveHeight = lm.height;
  const height = Math.max(designHeight, liveHeight);

  const toRaw = (buf: Buffer, h: number) =>
    sharp(buf)
      .flatten({ background: WHITE })
      .extend({ bottom: height - h, background: WHITE })
      .ensureAlpha()
      .raw()
      .toBuffer();

  const [design, live] = await Promise.all([toRaw(resized.data, designHeight), toRaw(livePng, liveHeight)]);
  return { width, height, imageScale: width / dm.width, designHeight, liveHeight, design, live };
}

export interface PixelDiff {
  mismatched: number;
  ratio: number;
  /** RGBA heat-map: faded live image with differing pixels in red. */
  heatmap: Buffer;
  /** One byte per pixel, 1 = different. */
  mask: Uint8Array;
}

export function pixelDiff(design: Uint8Array, live: Uint8Array, w: number, h: number, threshold = 0.1): PixelDiff {
  const heatmap = Buffer.alloc(w * h * 4);
  const mismatched = pixelmatch(design, live, heatmap, w, h, { threshold, alpha: 0.15 });

  const maskOut = Buffer.alloc(w * h * 4);
  pixelmatch(design, live, maskOut, w, h, { threshold, diffMask: true });
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    // Real differences are drawn pure red; anti-aliasing pixels are yellow.
    if (maskOut[p + 3] > 0 && maskOut[p] === 255 && maskOut[p + 1] === 0) mask[i] = 1;
  }
  return { mismatched, ratio: mismatched / (w * h), heatmap, mask };
}

export function rawToPng(raw: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
