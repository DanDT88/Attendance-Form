/**
 * Compresses a camera photo on the device before it is queued: long side at most `maxSide` px,
 * JPEG. A 4 MB phone photo becomes roughly 200-400 KB, which matters on prepaid data.
 */
export async function compressPhoto(file: Blob, maxSide = 1600, quality = 0.75): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  return out ?? file;
}

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
}

/**
 * One GPS reading, taken only when the supervisor presses Submit (POPIA: no background tracking).
 * Resolves to null rather than failing when permission is refused or there is no fix in time,
 * so a register is never blocked by GPS; the server records "location unknown" instead.
 */
export function readLocationOnce(timeoutMs = 10_000): Promise<Fix | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy ?? null,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

export function nowHHmm(d = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}
