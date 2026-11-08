import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawControlNetSkeleton } from '../src/control-export.js';

function recordingContext(width, height) {
  const ellipses = [], dots = [], rectangles = [];
  const context = {
    canvas: { width, height },
    fillRect() {}, save() {}, beginPath() {}, clip() {}, fill() {}, restore() {},
    rect: (...args) => rectangles.push(args),
    ellipse: (...args) => ellipses.push(args),
    arc: (...args) => dots.push(args),
  };
  return { context, ellipses, dots, rectangles };
}

test('COCO_18 draws exactly the expected edges and skips missing or clipped endpoints', () => {
  const body = Array.from({ length: 18 }, (_, i) => ({ x: 10 + i * 20, y: 5 + i * i, inFrame: true }));
  const edges = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10],
    [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
  for (const omit of [false, true]) {
    const points = [...body];
    if (omit) {
      points[3] = null;
      points[7] = { ...body[7], inFrame: false };
    }
    const { context, ellipses, dots } = recordingContext(512, 512);
    drawControlNetSkeleton(context, points, 512, 512);
    const drawn = point => point?.inFrame;
    const centers = edges.filter(([a, b]) => drawn(points[a]) && drawn(points[b])).map(([a, b]) =>
      [Math.trunc((body[a].x + body[b].x) / 2), Math.trunc((body[a].y + body[b].y) / 2)]);
    assert.deepEqual(ellipses.map(args => args.slice(0, 2)), centers);
    assert.deepEqual(dots.map(args => args.slice(0, 2)), points.filter(drawn).map(({ x, y }) => [x, y]));
  }
});

test('compatibility renderer preserves a landscape viewport and uses target-size thickness', () => {
  const { context, rectangles } = recordingContext(1024, 1024);
  const scale = 1024 / 768, offsetY = (1024 - 512 * scale) / 2;
  assert.deepEqual(drawControlNetSkeleton(context, [], 768, 512), {
    fit: { scale, offsetX: 0, offsetY }, limbHalfWidthPx: 12, jointRadiusPx: 12,
  });
  assert.deepEqual(rectangles, [[0, offsetY, 1024, 512 * scale]]);
  for (const [size, radius] of [[499, 4], [500, 8], [999, 8], [1000, 12], [2000, 16], [5000, 28]]) {
    const { context } = recordingContext(size, size);
    const result = drawControlNetSkeleton(context, [], size, size);
    assert.equal(result.limbHalfWidthPx, radius);
    assert.equal(result.jointRadiusPx, radius);
  }
});
