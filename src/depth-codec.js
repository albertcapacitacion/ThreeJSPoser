// PNG RGB bytes are data, not display colors. Zero is background.
export function decodeDepth16(red, green, { near, far }) {
  const value = red * 256 + green;
  return value === 0 ? null : far - value / 65535 * (far - near);
}

export function encodeDepth16(distance, { near, far }) {
  const value = distance === null ? 0 : Math.round(65535 * Math.max(1 / 65535, Math.min(1, (far - distance) / (far - near))));
  return [value >> 8, value & 255, 0, 255];
}
