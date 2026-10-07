/**
 * Reads a barcode or QR code from a photo. Uses the browser's own BarcodeDetector where it exists
 * (Chrome on Android), and otherwise ZXing compiled to WebAssembly (iPhones, desktop). The WASM
 * file is bundled with the app and precached, so scanning works offline; it is never fetched from
 * a CDN.
 */

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new () => BarcodeDetectorLike;
  }
}

let zxingReady: Promise<typeof import('zxing-wasm/reader')> | null = null;

async function zxing() {
  zxingReady ??= (async () => {
    const [mod, wasm] = await Promise.all([
      import('zxing-wasm/reader'),
      import('zxing-wasm/reader/zxing_reader.wasm?url'),
    ]);
    mod.prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith('.wasm') ? wasm.default : prefix + path,
      },
    });
    return mod;
  })();
  return zxingReady;
}

export async function decodeBarcode(image: Blob): Promise<string | null> {
  if (window.BarcodeDetector) {
    try {
      const found = await new window.BarcodeDetector().detect(await createImageBitmap(image));
      if (found[0]?.rawValue) return found[0].rawValue;
    } catch {
      // Unsupported format or platform quirk: fall through to ZXing.
    }
  }
  const { readBarcodes } = await zxing();
  const results = await readBarcodes(image, { tryHarder: true, maxNumberOfSymbols: 1 });
  return results[0]?.text || null;
}
