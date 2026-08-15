/** A local image attached to one prompt. The browser sends bytes, never a file path. */
export interface PromptImage {
  /** Browser-reported media type; the server allowlists image formats again. */
  mediaType: string;
  /** Base64 bytes without a `data:` URL prefix. */
  data: string;
  /** Display-only filename, intentionally not used to read anything on the server. */
  name: string;
}
