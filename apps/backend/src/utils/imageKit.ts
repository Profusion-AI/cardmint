const IMAGEKIT_HOST_TOKEN = "imagekit.io";

export const FRONT_IMAGE_TRANSFORM_SEGMENT = "tr:e-usm-2-2.4-1.8-0.015,e-retouch";

export function applyImageKitTransform(url: string, transformSegment?: string): string;
export function applyImageKitTransform(url: null, transformSegment?: string): null;
export function applyImageKitTransform(url: undefined, transformSegment?: string): undefined;
export function applyImageKitTransform(
  url: string | null | undefined,
  transformSegment = FRONT_IMAGE_TRANSFORM_SEGMENT
): string | null | undefined {
  if (!url) {
    return url;
  }

  if (!url.includes(IMAGEKIT_HOST_TOKEN)) {
    return url;
  }

  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/");
    const firstSegmentIndex = segments.findIndex((segment) => segment.length > 0);

    if (firstSegmentIndex === -1) {
      return url;
    }

    const normalizedSegment = transformSegment.startsWith("tr:")
      ? transformSegment
      : `tr:${transformSegment}`;
    const insertIndex = firstSegmentIndex + 1;
    const existing = segments[insertIndex];

    if (existing === normalizedSegment) {
      return parsed.toString();
    }

    if (existing?.startsWith("tr:")) {
      segments[insertIndex] = normalizedSegment;
    } else {
      segments.splice(insertIndex, 0, normalizedSegment);
    }

    parsed.pathname = segments.join("/");
    return parsed.toString();
  } catch {
    return url;
  }
}
