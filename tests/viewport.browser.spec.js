import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Ready · select a joint to begin');
});

test('renders a WebGL scene and keeps the labeled axis guide aligned to the camera', async ({ page }) => {
  const canvas = page.locator('#viewport canvas');
  const guide = page.locator('.axis-guide');

  await expect(guide).toHaveAttribute('aria-label', /World orientation guide/);
  for (const axis of ['X', 'Y', 'Z']) {
    await expect(guide.locator(`text=${axis}`)).toBeVisible();
  }

  const webglVersion = await canvas.evaluate(element => {
    const gl = element.getContext('webgl2');
    return gl?.getParameter(gl.VERSION) ?? null;
  });
  expect(webglVersion).toMatch(/^WebGL 2/);

  const initialAxis = await page.locator('#guide-mark-x').getAttribute('transform');
  const initialImage = await canvas.screenshot();
  const viewport = await page.locator('#viewport').boundingBox();
  if (!viewport) throw new Error('Viewport has no layout box');

  // Drag in the empty right side of the viewport to orbit the camera.
  const startX = viewport.x + viewport.width * 0.88;
  const startY = viewport.y + viewport.height * 0.72;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 90, startY - 35, { steps: 5 });
  await page.mouse.up();

  await expect(page.locator('#guide-mark-x')).not.toHaveAttribute('transform', initialAxis);
  await expect.poll(async () => {
    const nextImage = await canvas.screenshot();
    return Buffer.compare(initialImage, nextImage);
  }).not.toBe(0);
});

test('edits a joint in 3D and restores the angle through undo and redo', async ({ page }) => {
  const canvas = page.locator('#viewport canvas');
  await page.locator('#joint-select').selectOption('leftShoulder');
  await expect(page.locator('#status')).toHaveText('Selected left shoulder');

  const initialImage = await canvas.screenshot();
  const angleX = page.locator('#angle-X');
  await angleX.fill('25');
  await angleX.press('Tab');
  await expect(angleX).toHaveValue('25');
  await expect(page.locator('#status')).toHaveText('Left shoulder updated');

  await expect.poll(async () => {
    const nextImage = await canvas.screenshot();
    return Buffer.compare(initialImage, nextImage);
  }).not.toBe(0);

  await page.locator('#undo').click();
  await expect(angleX).toHaveValue('0');
  await page.locator('#redo').click();
  await expect(angleX).toHaveValue('25');
});
