import { test, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { reconstructPose } from '../src/reconstruct-pose.js';

test.describe.configure({ timeout: 90_000 });

async function downloadJSON(page, button) {
  const pending = page.waitForEvent('download');
  await page.locator(button).click();
  const download = await pending;
  return { download, data: JSON.parse(await readFile(await download.path(), 'utf8')) };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready · select a joint to begin');
});

test('downloads complete default pose with exact procedural source and independently matching geometry', async ({ page }, testInfo) => {
  const { data, download } = await downloadJSON(page, '#export-complete');
  expect(download.suggestedFilename()).toBe('pose-export.json');
  expect(Object.keys(data)).toEqual(['formatVersion', 'rig', 'coordinateSystem', 'restPose', 'pose', 'camera', 'geometry', 'validation']);
  expect(data.validation.jointCount).toBe(54);
  expect(data.validation.missingOrUnsupportedData).toEqual([]);
  expect(data.geometry.requiredCompanionAssets).toEqual([]);
  for (const file of data.geometry.proceduralSource.files) {
    expect(file.source).toBe(await readFile(new URL(`../src/${file.name}`, import.meta.url), 'utf8'));
  }
  const rebuilt = reconstructPose(data);
  for (const joint of data.rig.joints) {
    const saved = data.pose.transforms[joint.node];
    rebuilt.nodes.get(joint.node).matrixWorld.elements.forEach((value, index) => expect(value).toBeCloseTo(saved.world.matrix[index], 10));
  }
  const comparison = await page.evaluate(async data => {
    const THREE = await import('/vendor/build/three.module.js');
    const { reconstructPose } = await import('/src/reconstruct-pose.js');
    const { createMannequin } = await import('/src/mannequin.js');
    const reconstructed = reconstructPose(data);
    const originalScene = new THREE.Scene(), rebuiltScene = new THREE.Scene();
    const original = createMannequin(originalScene); original.sync(data.pose); original.setMarkersVisible(false);
    rebuiltScene.add(reconstructed.root);
    for (const scene of [originalScene, rebuiltScene]) {
      scene.background = new THREE.Color(0xe9eee8);
      scene.add(new THREE.HemisphereLight(0xffffff, 0xa5b9a2, 2.3));
      const key = new THREE.DirectionalLight(0xfff5df, 3.2); key.position.set(-2.7, 5, 3.8); scene.add(key);
    }
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    const { width, height } = data.camera.front.renderResolution;
    renderer.setSize(width, height); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
    const draw = scene => {
      renderer.render(scene, reconstructed.camera);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); context.drawImage(renderer.domElement, 0, 0);
      return { png: canvas.toDataURL(), pixels: context.getImageData(0, 0, width, height).data };
    };
    const originalImage = draw(originalScene), rebuiltImage = draw(rebuiltScene);
    let differentChannels = 0, maxDifference = 0;
    for (let index = 0; index < originalImage.pixels.length; index++) {
      const difference = Math.abs(originalImage.pixels[index] - rebuiltImage.pixels[index]);
      if (difference) differentChannels++;
      maxDifference = Math.max(maxDifference, difference);
    }
    renderer.dispose();
    return { original: originalImage.png, reconstructed: rebuiltImage.png, differentChannels, maxDifference };
  }, data);
  expect(comparison.differentChannels).toBe(0);
  for (const name of ['original', 'reconstructed']) {
    const image = Buffer.from(comparison[name].split(',')[1], 'base64');
    await writeFile(testInfo.outputPath(`${name}-front.png`), image);
    await testInfo.attach(`${name}-front`, { body: image, contentType: 'image/png' });
  }
  await mkdir('work/complete-pose', { recursive: true });
  await writeFile('work/complete-pose/pose-export.json', JSON.stringify(data, null, 2) + '\n');
  await page.screenshot({ path: testInfo.outputPath('editor.png') });
});

test('export preserves edited pose, history, panned Front camera and a different active view', async ({ page }) => {
  await page.locator('#joint-select').selectOption('leftShoulder');
  await page.locator('#angle-X').fill('-53.5'); await page.locator('#angle-X').press('Tab');
  await page.locator('#angle-Z').fill('61'); await page.locator('#angle-Z').press('Tab');
  await page.locator('#joint-select').selectOption('rightKnee');
  await page.locator('#angle-X').fill('72'); await page.locator('#angle-X').press('Tab');
  const baseline = (await downloadJSON(page, '#export-complete')).data;
  const front = await page.locator('.view-pane[data-view="0"]').boundingBox();
  await page.mouse.move(front.x + front.width * .75, front.y + front.height * .7);
  await page.mouse.wheel(0, -160);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(front.x + front.width * .75 + 22, front.y + front.height * .7 + 14, { steps: 3 });
  await page.mouse.up({ button: 'right' });
  await page.locator('.view-pane[data-view="3"] [data-maximize]').click();
  await expect(page.locator('#viewport-grid')).toHaveAttribute('data-maximized', '3');
  const legacyBefore = (await downloadJSON(page, '#export')).data;
  await page.locator('#export-complete').hover();
  const imageBefore = await page.locator('#viewport').screenshot();
  const { data } = await downloadJSON(page, '#export-complete');
  expect(data.pose.rotations).toEqual(legacyBefore.rotations);
  expect(data.pose.rotations.leftShoulder).toEqual([-53.5, 0, 61]);
  expect(data.camera.active.name).toBe('Right');
  expect(data.camera.front.viewport.visible).toBe(false);
  expect(data.camera.front.renderResolution.width).toBeGreaterThan(0);
  expect(data.camera.front.zoom).toBeGreaterThan(baseline.camera.front.zoom);
  expect(data.camera.front.orbitControlsTarget).not.toEqual(baseline.camera.front.orbitControlsTarget);
  expect(data.restPose).toEqual(baseline.restPose);
  const imageAfter = await page.locator('#viewport').screenshot();
  expect(imageAfter.equals(imageBefore)).toBe(true);
  const repeated = (await downloadJSON(page, '#export-complete')).data;
  expect(repeated).toEqual(data);
  const legacyAfter = (await downloadJSON(page, '#export')).data;
  expect(legacyAfter).toEqual(legacyBefore);
  await page.locator('#undo').click();
  await expect(page.locator('#angle-X')).toHaveValue('0');
  await page.locator('#redo').click();
  await expect(page.locator('#angle-X')).toHaveValue('72');
  await page.locator('#pose-file').setInputFiles({ name: 'pose.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacyBefore)) });
  await expect(page.locator('#status')).toHaveText('Pose opened · Undo restores the previous pose');
});

test('exports matching Front projection and resolution after reframing a hidden view', async ({ page }) => {
  const initial = (await downloadJSON(page, '#export-complete')).data;
  const maximizeRight = page.locator('.view-pane[data-view="3"] [data-maximize]');
  await maximizeRight.click();
  await page.setViewportSize({ width: 800, height: 900 });
  const right = page.locator('.view-pane[data-view="3"]');
  await expect.poll(async () => (await right.boundingBox()).width).toBe(530);
  await page.locator('#fit').click();
  const hidden = (await downloadJSON(page, '#export-complete')).data;
  const front = hidden.camera.front;
  expect(front.viewport.visible).toBe(false);
  expect(front.lastVisibleViewport).toEqual(initial.camera.front.lastVisibleViewport);
  expect(front.renderResolution).not.toEqual(initial.camera.front.renderResolution);
  expect(front.renderResolution.width / front.renderResolution.height).toBeCloseTo(front.aspect, 10);
  expect(hidden.pose).toEqual(initial.pose);
  const repeated = (await downloadJSON(page, '#export-complete')).data;
  expect(repeated.camera).toEqual(hidden.camera);

  await maximizeRight.click();
  await expect(page.locator('.view-pane[data-view="0"]')).toBeVisible();
  const shown = (await downloadJSON(page, '#export-complete')).data;
  expect(shown.camera.front.renderResolution).toEqual(front.renderResolution);
  expect(shown.camera.front.projectionMatrix).toEqual(front.projectionMatrix);
  expect(shown.camera.front.worldMatrix).toEqual(front.worldMatrix);
});

test('keeps all file actions onscreen and usable on narrow screens', async ({ page }, testInfo) => {
  for (const width of [320, 390, 430, 640, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    for (const button of await page.locator('.file-actions button').all()) {
      await expect(button).toBeInViewport({ ratio: 1 });
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
  }
  await page.setViewportSize({ width: 390, height: 800 });
  const complete = await downloadJSON(page, '#export-complete');
  expect(complete.download.suggestedFilename()).toBe('pose-export.json');
  const legacy = await downloadJSON(page, '#export');
  expect(complete.data.pose.rotations).toEqual(legacy.data.rotations);
  await page.locator('#export-references').click();
  await expect(page.locator('#reference-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('narrow-toolbar.png') });
});
