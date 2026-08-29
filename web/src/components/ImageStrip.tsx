import type { PromptImage } from '@claudia/shared';

/** An attachment plus the local-only fields the strip needs to render it. */
export type PendingImage = PromptImage & { id: string; preview: string };

/** How many images one prompt may carry, and how large each may be. */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Reads dropped, pasted or chosen files into base64 attachments.
 *
 * Filters to the media types the model accepts and drops anything over the
 * per-image limit. Note the server enforces a further TOTAL budget across the
 * prompt, so a set that passes here can still be trimmed on the way out — which
 * is why the transcript labels what was actually sent rather than what was
 * offered.
 */
export async function readImageFiles(files: FileList | File[], alreadyAttached: number): Promise<PendingImage[]> {
  const remaining = MAX_IMAGES - alreadyAttached;
  if (remaining <= 0) return [];
  const eligible = Array.from(files)
    .filter((file) => /^image\/(jpeg|png|gif|webp)$/.test(file.type) && file.size > 0 && file.size <= MAX_IMAGE_BYTES)
    .slice(0, remaining);

  return Promise.all(
    eligible.map(async (file) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      return {
        id: crypto.randomUUID(),
        name: file.name,
        mediaType: file.type,
        // Strip the "data:<type>;base64," prefix; the wire carries raw base64.
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        preview: dataUrl,
      };
    }),
  );
}

interface Props {
  images: PendingImage[];
  onRemove: (id: string) => void;
}

/** Thumbnails for the images queued on the next prompt, each removable. */
export function ImageStrip({ images, onRemove }: Props) {
  if (images.length === 0) return null;
  return (
    <div
      aria-label={`${images.length} image attachment${images.length === 1 ? '' : 's'}`}
      style={{ display: 'flex', gap: 5, paddingBottom: 4, overflowX: 'auto' }}
    >
      {images.map((image) => (
        <span key={image.id} style={{ position: 'relative', flex: 'none' }}>
          <img
            src={image.preview}
            alt={image.name}
            style={{ display: 'block', width: 38, height: 38, objectFit: 'cover', borderRadius: 4, border: '1px solid #4a4e65' }}
          />
          <button
            type="button"
            aria-label={`Remove ${image.name}`}
            title={`Remove ${image.name}`}
            onClick={() => onRemove(image.id)}
            style={{
              position: 'absolute',
              top: -5,
              right: -5,
              border: '1px solid #5c3b3b',
              borderRadius: 9,
              width: 18,
              height: 18,
              padding: 0,
              cursor: 'pointer',
              background: '#2e2226',
              color: '#f1b3b3',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
