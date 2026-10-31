import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Ready · select a joint to begin');
});

test('renders four standard views and maximizes and restores a viewport', async ({ page }) => {
  const canvas = page.locator('#viewport canvas');
  const panes = page.locator('.view-pane');
  await expect(panes).toHaveCount(4);
  for (const [index, label] of ['Front', 'Top', 'Left', 'Right'].entries()) {
    await expect(page.locator(`.view-pane[data-view="${index}"] .pane-title`)).toHaveText(label);
  }

  const webglVersion = await canvas.evaluate(element => {
    const gl = element.getContext('webgl2');
    return gl?.getParameter(gl.VERSION) ?? null;
  });
  expect(webglVersion).toMatch(/^WebGL 2/);

  const viewport = await page.locator('#viewport').boundingBox();
  if (!viewport) throw new Error('Viewport has no layout box');
  const front = page.locator('.view-pane[data-view="0"]');
  await front.locator('[data-maximize]').click();
  await expect(page.locator('#viewport-grid')).toHaveAttribute('data-maximized', '0');
  await expect(front).toBeVisible();
  for (const index of [1, 2, 3]) await expect(page.locator(`.view-pane[data-view="${index}"]`)).toBeHidden();
  await expect.poll(async () => (await front.boundingBox())?.width).toBeCloseTo(viewport.width, 0);

  await front.locator('[data-maximize]').click();
  await expect(page.locator('#viewport-grid')).toHaveAttribute('data-maximized', '');
  for (const index of [0, 1, 2, 3]) await expect(page.locator(`.view-pane[data-view="${index}"]`)).toBeVisible();
});

test('selects a mannequin joint from each orthographic view', async ({ page }) => {
  const selected = page.locator('#joint-select');
  await selected.selectOption('head');

  for (const index of [0, 1, 2, 3]) {
    const pane = page.locator(`.view-pane[data-view="${index}"]`);
    const bounds = await pane.boundingBox();
    if (!bounds) throw new Error(`View ${index} has no layout box`);
    const x = bounds.x + bounds.width * (index === 1 ? .62 : .5);
    const y = bounds.y + bounds.height * .5;
    await page.mouse.click(x, y);
    await expect(selected).not.toHaveValue('head');
    await selected.selectOption('head');
  }
});

test('drags the rotation gizmo in every orthographic view', async ({ page }) => {
  test.setTimeout(60_000);
  await page.locator('#joint-select').selectOption('leftShoulder');

  for (const index of [0, 1, 2, 3]) {
    const pane = page.locator(`.view-pane[data-view="${index}"]`);
    await pane.locator('[data-maximize]').click();
    await page.locator('#focus').click();
    const bounds = await pane.boundingBox();
    if (!bounds) throw new Error(`View ${index} has no layout box`);

    const angles = ['X', 'Y', 'Z'].map(name => page.locator(`#angle-${name}`));
    const initialAngles = await Promise.all(angles.map(angle => angle.inputValue()));
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const ringRadius = 52;
    await page.mouse.move(centerX + ringRadius, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX, centerY - ringRadius, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => Promise.all(angles.map(angle => angle.inputValue()))).not.toEqual(initialAngles);

    await page.locator('#reset-joint').click();
    await pane.locator('[data-maximize]').click();
  }
});

test('edits a joint in 3D and restores the angle through undo and redo', async ({ page }) => {
  await page.locator('#joint-select').selectOption('leftShoulder');
  await expect(page.locator('#status')).toHaveText('Selected left shoulder');

  const angleX = page.locator('#angle-X');
  await angleX.fill('25');
  await angleX.press('Tab');
  await expect(angleX).toHaveValue('25');
  await expect(page.locator('#status')).toHaveText('Left shoulder updated');
  await expect(page.locator('#undo')).toBeEnabled();

  await page.locator('#undo').click();
  await expect(angleX).toHaveValue('0');
  await page.locator('#redo').click();
  await expect(angleX).toHaveValue('25');
});
