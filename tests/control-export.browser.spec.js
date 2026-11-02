import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { createMannequin } from '../src/mannequin.js';

test.describe.configure({ timeout: 120_000 });

function unzip(buffer) {
  const files = {};
  for (let offset = 0; buffer.readUInt32LE(offset) === 0x04034b50;) {
    expect(buffer.readUInt16LE(offset + 8)).toBe(0);
    const size = buffer.readUInt32LE(offset + 18), length = buffer.readUInt16LE(offset + 26);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + length);
    const start = offset + 30 + length + buffer.readUInt16LE(offset + 28);
    files[name] = buffer.subarray(start, start + size); offset = start + size;
  }
  return files;
}

async function download(page, selector) {
  const pending = page.waitForEvent('download'); await page.locator(selector).click();
  return readFile(await (await pending).path());
}

async function openPrototype(page) {
  await page.locator('#export-references').click();
  await page.getByRole('button', { name: 'Control maps prototype', exact: true }).click();
  await expect(page.locator('#control-dialog')).toBeVisible();
}

async function validate(page) {
  await page.getByRole('button', { name: 'Validate PNGs', exact: true }).click();
  await expect(page.locator('#control-validation')).toContainText('PNG checks passed', { timeout: 30_000 });
  await expect(page.locator('#download-control-export')).toBeEnabled();
}

// Decode the actual downloaded PNGs, not application internals or regenerated maps.
async function inspectFiles(page, files, report, probes = []) {
  return page.evaluate(async ({ images, report, probes }) => {
    const output = {};
    for (const [name, base64] of Object.entries(images)) {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
      const context = c.getContext('2d'); context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, c.width, c.height).data;
      const pixel = (x, y) => [...data.slice((Math.floor(y) * c.width + Math.floor(x)) * 4, (Math.floor(y) * c.width + Math.floor(x)) * 4 + 4)];
      let opaque = true, gray = true, foreground = 0;
      for (let i = 0; i < data.length; i += 4) {
        opaque &&= data[i + 3] === 255; gray &&= data[i] === data[i + 1] && data[i] === data[i + 2];
        if (data[i] || data[i + 1] || data[i + 2]) foreground++;
      }
      output[name] = { width: c.width, height: c.height, opaque, gray, foreground, corner: pixel(0, 0),
        joints: report.body.map(p => p?.inFrame ? pixel(p.x, p.y) : null),
        surfaceSamples: report.checks.surfaceDepth.samples.map(p => pixel(p.x, p.y)[0]),
        probes: probes.map(p => pixel(p.x, p.y)) };
    }
    return output;
  }, { images: Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith('.png')).map(([name, data]) => [name, data.toString('base64')])), report, probes });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#status')).toHaveText('Ready · select a joint to begin');
});

test('downloads aligned opaque maps, decoded-pixel validation, and unchanged pose from the UI', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const before = JSON.parse(await download(page, '#export'));
  await openPrototype(page);
  await expect(page.locator('#download-control-export')).toBeDisabled();
  await page.locator('#control-hands').uncheck();
  await validate(page);
  const files = unzip(await download(page, '#download-control-export'));
  expect(Object.keys(files)).toEqual(['openpose.png', 'depth.png', 'reference.png', 'overlay.png', 'validation.json', 'pose.json', 'README.txt']);
  const report = JSON.parse(files['validation.json']);
  expect(report.cropped).toEqual([]); expect(report.surfaceClipped).toBe(false);
  expect(report.body).toHaveLength(18); expect(report.body.slice(14)).toEqual([null, null, null, null]);
  expect(report.hands).toEqual([]);
  expect(report.checks.surfaceDepth.count).toBeGreaterThan(20);
  expect(report.checks.surfaceDepth.maxError).toBeLessThanOrEqual(3);
  expect(JSON.parse(files['pose.json'])).toEqual(before);
  const decoded = await inspectFiles(page, files, report);
  for (const image of Object.values(decoded)) {
    expect(image.width).toBe(512); expect(image.height).toBe(768); expect(image.opaque).toBe(true);
    expect(image.foreground).toBeGreaterThan(100); expect(image.corner).toEqual([0, 0, 0, 255]);
  }
  expect(decoded['depth.png'].gray).toBe(true); expect(decoded['openpose.png'].gray).toBe(false);
  expect(decoded['openpose.png'].joints[2]).toEqual([255, 170, 0, 255]); // Anatomical right shoulder.
  expect(decoded['openpose.png'].joints[5]).toEqual([85, 255, 0, 255]); // Anatomical left shoulder.
  expect(decoded['openpose.png'].joints[5]).toEqual(decoded['overlay.png'].joints[5]);
  report.checks.surfaceDepth.samples.forEach((sample, i) => expect(decoded['depth.png'].surfaceSamples[i]).toBe(sample.actual));
  // Independent pinhole projection, no application projection helper / THREE.Vector3.project.
  const m = report.camera.worldMatrix, [cx, cy, cz] = report.camera.position;
  for (const point of report.body.filter(Boolean)) {
    const [x, y, z] = point.world.map((v, i) => v - [cx, cy, cz][i]);
    const vx = x * m[0] + y * m[1] + z * m[2];
    const vy = x * m[4] + y * m[5] + z * m[6];
    const vz = x * m[8] + y * m[9] + z * m[10];
    const scale = 1 / Math.tan(report.camera.fov * Math.PI / 360);
    expect(point.x).toBeCloseTo(256 * (1 + vx * scale / (-vz * report.camera.aspect)), 7);
    expect(point.y).toBeCloseTo(384 * (1 - vy * scale / -vz), 7);
  }
  await page.screenshot({ path: testInfo.outputPath('control-export.png') });
  await page.getByRole('button', { name: 'Close control maps', exact: true }).click();
  expect(JSON.parse(await download(page, '#export'))).toEqual(before);
  expect(errors).toEqual([]);
});

test('reaching arm has nearer depth, explicit fingertips, and correct perspective enlargement', async ({ page }) => {
  await page.getByLabel('Selected joint', { exact: true }).selectOption('leftShoulder');
  await page.locator('#angle-X').fill('-90'); await page.locator('#angle-X').press('Tab');
  await openPrototype(page); await validate(page);
  const files = unzip(await download(page, '#download-control-export')), report = JSON.parse(files['validation.json']);
  const wrist = report.body[7], shoulder = report.body[5];
  expect(wrist.distance).toBeLessThan(shoulder.distance - .3);
  expect(report.hands.map(hand => hand.length)).toEqual([21, 21]);
  expect(report.hands[0][4].name).toBe('leftThumbTip'); expect(report.hands[0][20].name).toBe('leftLittleTip');
  expect(report.hands[0][0].world).toEqual(wrist.world);
  const samples = report.checks.surfaceDepth.samples;
  const wristSamples = samples.filter(p => p.joint === 'leftWrist');
  const chestSamples = samples.filter(p => p.joint === 'chest');
  expect(wristSamples.length).toBeGreaterThan(0); expect(chestSamples.length).toBeGreaterThan(0);
  expect(Math.min(...wristSamples.map(p => p.actual))).toBeGreaterThan(Math.max(...chestSamples.map(p => p.actual)));
  // Equal world-space horizontal distances project larger at the nearer wrist depth.
  const scale = report.width / (2 * report.camera.aspect * Math.tan(report.camera.fov * Math.PI / 360));
  expect(scale / wrist.distance).toBeGreaterThan(scale / shoulder.distance);
  const decoded = await inspectFiles(page, files, report);
  samples.forEach((sample, i) => expect(Math.abs(decoded['depth.png'].surfaceSamples[i] - sample.expected)).toBeLessThanOrEqual(3));
});

test('camera controls invalidate validation, cropping is flagged, and empty framing blocks export', async ({ page }, testInfo) => {
  await openPrototype(page); await validate(page);
  const preview = page.locator('#control-overlay'), initial = await preview.evaluate(c => c.toDataURL());
  const box = await preview.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 15, { steps: 4 }); await page.mouse.up();
  await expect.poll(() => preview.evaluate(c => c.toDataURL())).not.toBe(initial);
  await expect(page.locator('#download-control-export')).toBeDisabled();
  const orbited = await preview.evaluate(c => c.toDataURL());
  await page.mouse.wheel(0, -100);
  await expect.poll(() => preview.evaluate(c => c.toDataURL())).not.toBe(orbited);
  await page.locator('#control-size').selectOption('768x512');
  await page.locator('#control-fov').fill('20');
  await expect(page.locator('#control-warnings')).toContainText('cropped');
  await page.locator('#control-frame').click();
  await expect(page.locator('#control-warnings')).not.toContainText('cropped');
  await validate(page);
  const files = unzip(await download(page, '#download-control-export')), report = JSON.parse(files['validation.json']);
  expect(report.camera.fov).toBe(20); expect(report.width).toBe(768); expect(report.height).toBe(512);
  expect(report.camera.position[0]).not.toBe(0);
  const current = await preview.boundingBox();
  await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(current.x + current.width / 2 + 900, current.y + current.height / 2, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('#control-warnings')).toContainText('Outside frame');
  await page.getByRole('button', { name: 'Validate PNGs', exact: true }).click();
  await expect(page.locator('#control-validation')).toContainText('Validation failed');
  await expect(page.locator('#download-control-export')).toBeDisabled();
  await page.locator('#control-frame').click(); await validate(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('#close-control-export')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('control-export-narrow.png') });
  await page.locator('#close-control-export').click();
  await openPrototype(page);
  await expect(page.locator('#download-control-export')).toBeDisabled();
});

test('crossed arms export the front limb depth where their projections overlap', async ({ page }) => {
  await page.locator('#limits').uncheck();
  for (const [joint, angles] of [
    ['leftShoulder', [0, 35, -90]], ['rightShoulder', [0, -15, 90]],
    ['leftElbow', [0, 0, 0]], ['rightElbow', [0, 0, 0]],
  ]) {
    await page.getByLabel('Selected joint', { exact: true }).selectOption(joint);
    for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
      await page.locator(`#angle-${axis}`).fill(String(angles[i])); await page.locator(`#angle-${axis}`).press('Tab');
    }
  }
  await openPrototype(page); await validate(page);
  const files = unzip(await download(page, '#download-control-export')), report = JSON.parse(files['validation.json']);
  // At world x=0 both upper arms share their shoulder height. Left has greater +Z
  // (.19*tan(35°) vs .19*tan(15°)), so it must be the foreground surface.
  const shoulder = report.body[5], scale = report.height / (2 * Math.tan(report.camera.fov * Math.PI / 360));
  const [cx, cy, cz] = report.camera.position;
  const x = report.width / 2 + (0 - cx) * scale / cz;
  const y = report.height / 2 - (shoulder.world[1] - cy) * scale / cz;
  // Check a deliberate crossing pixel independently of the validator's sampling
  // grid and boundary exclusions, using the pose actually downloaded through UI.
  const probe = { x: Math.floor(x), y: Math.floor(y) };
  const reference = createMannequin(new THREE.Scene()); reference.sync(JSON.parse(files['pose.json']));
  const camera = new THREE.PerspectiveCamera(report.camera.fov, report.camera.aspect, report.camera.near, report.camera.far);
  camera.position.fromArray(report.camera.position); camera.lookAt(...report.camera.target); camera.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(2 * (probe.x + .5) / report.width - 1, 1 - 2 * (probe.y + .5) / report.height), camera);
  const hit = ray.intersectObjects(reference.pickables, false)[0];
  expect(hit?.object.userData.jointId).toBe('leftShoulder');
  const distance = -hit.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
  const expected = Math.round(255 * (report.depth.far - distance) / (report.depth.far - report.depth.near));
  const decoded = await inspectFiles(page, files, report, [probe]);
  expect(Math.abs(decoded['depth.png'].probes[0][0] - expected)).toBeLessThanOrEqual(3);
});

test('validates and downloads a rotated view with antialiased depth boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openPrototype(page);
  for (let i = 0; i < 3; i++) {
    const box = await page.locator('#control-overlay').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 32, box.y + box.height / 2 + 7, { steps: 2 });
    await page.mouse.up();
  }
  await validate(page);
  const files = unzip(await download(page, '#download-control-export'));
  const report = JSON.parse(files['validation.json']);
  expect(report.cropped).toEqual([]);
  expect(report.surfaceClipped).toBe(false);
  expect(report.checks.surfaceDepth.count).toBeGreaterThan(20);
  expect(report.checks.surfaceDepth.tolerance).toBe(3);
  const decoded = await inspectFiles(page, files, report);
  expect(decoded['depth.png'].opaque).toBe(true);
  expect(decoded['depth.png'].gray).toBe(true);
  report.checks.surfaceDepth.samples.forEach((sample, i) => {
    expect(Math.abs(decoded['depth.png'].surfaceSamples[i] - sample.expected)).toBeLessThanOrEqual(3);
  });
});
