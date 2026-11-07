import { STYLE_DEFAULTS } from "./config.js?v=2.0.1";

async function compressImage(blob, options = {}) {
  const {
    quality = STYLE_DEFAULTS.style_imageCompressQuality,
    skipBelowKB = 50,
    enabled = true
  } = options;
  if (!enabled) return blob;
  if (blob.size < skipBelowKB * 1024) return blob;
  if (blob.type === 'image/gif') return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const compressed = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (compressed.size >= blob.size) return blob;
    return compressed;
  } catch (e) {
    console.warn('[compressImage] 压缩失败，使用原图:', e);
    return blob;
  }
}

async function getCompressOptions(db) {
  try {
    const enabled = await db.getConfig('style_imageCompressEnabled', STYLE_DEFAULTS.style_imageCompressEnabled);
    const quality = await db.getConfig('style_imageCompressQuality', STYLE_DEFAULTS.style_imageCompressQuality);
    return { enabled: enabled !== false && enabled !== 'false', quality: Number(quality) || 0.82 };
  } catch (_) {
    return { enabled: true, quality: 0.82 };
  }
}

export { compressImage, getCompressOptions };
