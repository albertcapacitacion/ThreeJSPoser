import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { createMannequin } from '../src/mannequin.js';
import { createHash } from 'node:crypto';
import { reconstructPose } from '../src/reconstruct-pose.js';
import { decodeDepth16 } from '../src/depth-codec.js';

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

async function verifyPackage(page, files) {
  const manifest = JSON.parse(files['manifest.json']), report = JSON.parse(files['validation.json']);
  const landmarks = JSON.parse(files['landmarks.json']), complete = JSON.parse(files['pose-export.json']);
  expect(manifest.camera.type).toBe('perspective');
  expect(complete.camera.front.type).toBe('orthographic'); // Intentionally separate editor camera.
  expect(manifest.camera.worldMatrix).toEqual(report.camera.worldMatrix);
  expect(manifest.camera.projectionMatrix).toEqual(report.camera.projectionMatrix);
  expect(landmarks.snapshotHash).toBe(manifest.snapshotHash.value);
  expect(landmarks.packageId).toBe(manifest.packageId);
  for (const file of manifest.files) {
    expect(file.role).toBeTruthy();
    expect(createHash('sha256').update(files[file.name]).digest('hex')).toBe(file.sha256);
  }
  expect(manifest.files.map(file => file.name).sort()).toEqual(Object.keys(files).filter(name => name !== 'manifest.json').sort());
  expect(files['mannequin.png'].equals(files['reference.png'])).toBe(true);
  const rebuilt = reconstructPose(complete);
  for (const point of landmarks.landmarks) {
    const joint = complete.rig.joints.find(joint => joint.name === point.rigJoint);
    expect(point.rigNode).toBe(joint.node);
    const world = new THREE.Vector3(...point.localOffset).applyMatrix4(rebuilt.nodes.get(point.rigNode).matrixWorld);
    world.toArray().forEach((value, i) => expect(point.world[i]).toBeCloseTo(value, 10));
    expect(point.normalized[0]).toBeCloseTo(point.pixel[0] / report.width, 10);
    expect(point.normalized[1]).toBeCloseTo(point.pixel[1] / report.height, 10);
    expect(['visible', 'occluded', 'unknown', 'out-of-frame']).toContain(point.visibility.status);
    if (!point.inFrame) expect(point.visibility.occluded).toBe(null);
  }
  const result = await page.evaluate(async ({ images, manifest, samples, decoder }) => {
    const decoded = {};
    for (const [name, base64] of Object.entries(images)) {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
      const context = c.getContext('2d'); context.drawImage(image, 0, 0);
      decoded[name] = context.getImageData(0, 0, c.width, c.height).data;
      if (c.width !== manifest.resolution.width || c.height !== manifest.resolution.height) throw new Error('Image size mismatch');
    }
    const silhouette = decoded['silhouette.png'], segments = decoded['segmentation.png'], precise = decoded['depth16.png'];
    const palette = new Set(manifest.segmentation.palette.map(entry => entry.rgb.join(',')));
    let foreground = 0;
    for (let i = 0; i < silhouette.length; i += 4) {
      const mask = silhouette[i];
      if (![0, 255].includes(mask) || silhouette[i + 1] !== mask || silhouette[i + 2] !== mask || silhouette[i + 3] !== 255) throw new Error('Nonbinary mask');
      if (!palette.has([...segments.slice(i, i + 3)].join(','))) throw new Error('Nonpalette color');
      const q = precise[i] * 256 + precise[i + 1];
      if (Boolean(q) !== Boolean(mask) || Boolean(segments[i] || segments[i + 1] || segments[i + 2]) !== Boolean(mask)) throw new Error('Boundary mismatch');
      if (precise[i + 2] !== 0 || precise[i + 3] !== 255 || segments[i + 3] !== 255) throw new Error('Corrupted data channels');
      foreground += Boolean(mask);
    }
    const url = URL.createObjectURL(new Blob([decoder], { type: 'text/javascript' }));
    const { decodeDepth16 } = await import(url); URL.revokeObjectURL(url);
    const depths = samples.map(sample => {
      const i = (sample.y * manifest.resolution.width + sample.x) * 4;
      return { q: precise[i] * 256 + precise[i + 1], metres: decodeDepth16(precise[i], precise[i + 1], manifest.depth) };
    });
    return { foreground, depths };
  }, { images: Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith('.png')).map(([name, data]) => [name, data.toString('base64')])),
    manifest, samples: report.checks.surfaceDepth.samples, decoder: files['decode-depth.js'].toString() });
  expect(result.foreground).toBeGreaterThan(100);
  result.depths.forEach((value, index) => {
    const sample = report.checks.surfaceDepth.samples[index];
    expect(Math.abs(value.metres - sample.distance)).toBeLessThanOrEqual(manifest.depth.depth16.cpuGeometryComparisonToleranceMetres);
    expect(value.metres).toBe(decodeDepth16(value.q >> 8, value.q & 255, manifest.depth));
  });
  return { manifest, landmarks, report };
}

// Independent pinhole projection of the coordinates in the downloaded report.
function checkProjection(report) {
  const m = report.camera.worldMatrix, position = report.camera.position;
  const scale = 1 / Math.tan(report.camera.fov * Math.PI / 360);
  for (const point of report.body.filter(Boolean)) {
    const [x, y, z] = point.world.map((v, i) => v - position[i]);
    const vx = x * m[0] + y * m[1] + z * m[2];
    const vy = x * m[4] + y * m[5] + z * m[6];
    const vz = x * m[8] + y * m[9] + z * m[10];
    expect(point.x).toBeCloseTo(report.width / 2 * (1 + vx * scale / (-vz * report.camera.aspect)), 7);
    expect(point.y).toBeCloseTo(report.height / 2 * (1 - vy * scale / -vz), 7);
  }
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
  await verifyPackage(page, files);
  expect(Object.keys(files)).toEqual(['openpose.png', 'depth.png', 'reference.png', 'overlay.png',
    'mannequin.png', 'silhouette.png', 'segmentation.png', 'depth16.png',
    'validation.json', 'pose.json', 'README.txt', 'pose-export.json', 'decode-depth.js', 'landmarks.json', 'manifest.json']);
  const report = JSON.parse(files['validation.json']);
  expect(report.cropped).toEqual([]); expect(report.surfaceClipped).toBe(false);
  expect(report.body).toHaveLength(18);
  expect(report.body.slice(14).map(p => p.name)).toEqual(['rightEye', 'leftEye', 'rightEar', 'leftEar']);
  expect(report.warnings).toContain('Nose, eyes and ears are approximate head-surface anchors; facial expression landmarks are omitted.');
  expect(files['README.txt'].toString()).toContain('anchors that follow head rotation');
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
  const faceColors = [[255, 0, 0, 255], [170, 0, 255, 255], [255, 0, 255, 255], [255, 0, 170, 255], [255, 0, 85, 255]];
  [0, 14, 15, 16, 17].forEach((index, i) => {
    expect(decoded['openpose.png'].joints[index]).toEqual(faceColors[i]);
    expect(decoded['overlay.png'].joints[index]).toEqual(faceColors[i]);
  });
  report.checks.surfaceDepth.samples.forEach((sample, i) => expect(decoded['depth.png'].surfaceSamples[i]).toBe(sample.actual));
  checkProjection(report);
  await page.screenshot({ path: testInfo.outputPath('control-export.png') });
  await page.getByRole('button', { name: 'Close control maps', exact: true }).click();
  expect(JSON.parse(await download(page, '#export'))).toEqual(before);
  expect(errors).toEqual([]);
});

for (const [name, head, neck = [0, 0, 0]] of [
  ['turn left', [0, 35, 0]], ['turn right', [0, -35, 0]],
  ['nod down', [25, 0, 0]], ['nod up', [-20, 0, 0]],
  ['tilt', [0, 0, 20]], ['profile', [0, 90, 0]], ['rear', [0, 180, 0]],
  ['combined head and neck', [15, -30, -15], [-10, 25, 10]],
]) {
  test(`head anchors follow ${name} in downloaded maps`, async ({ page }, testInfo) => {
    // Profile/rear deliberately exercise the existing unrestricted posing mode.
    if (name === 'profile' || name === 'rear') await page.locator('#limits').uncheck();
    for (const [joint, angles] of [['neck', neck], ['head', head]]) {
      await page.locator('#joint-select').selectOption(joint);
      for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
        await page.locator(`#angle-${axis}`).fill(String(angles[i]));
        await page.locator(`#angle-${axis}`).press('Tab');
      }
    }
    const complete = JSON.parse(await download(page, '#export-complete'));
    expect(complete.pose.rotations.head).toEqual(head);
    expect(complete.pose.rotations.neck).toEqual(neck);
    const headNode = complete.rig.joints.find(joint => joint.name === 'head').node;
    const m = complete.pose.transforms[headNode].world.matrix;
    await openPrototype(page); await page.locator('#control-hands').uncheck(); await validate(page);
    const files = unzip(await download(page, '#download-control-export'));
    const report = JSON.parse(files['validation.json']);
    const anchors = [report.body[0], ...report.body.slice(14)];
    // Fixed anatomical reference values, independent of the production anchor table.
    const offsets = [[0, .044, .111], [-.034, .084, .087], [.034, .084, .087], [-.09, .064, 0], [.09, .064, 0]];
    for (const [i, point] of anchors.entries()) {
      const [x, y, z] = offsets[i];
      for (let axis = 0; axis < 3; axis++) {
        expect(point.world[axis]).toBeCloseTo(m[axis] * x + m[4 + axis] * y + m[8 + axis] * z + m[12 + axis], 10);
      }
      expect(point.inFrame).toBe(true);
    }
    checkProjection(report);
    const [nose, rightEye, leftEye, rightEar, leftEar] = anchors;
    if (name === 'turn left' || name === 'turn right') {
      const sign = name === 'turn left' ? 1 : -1;
      expect(sign * (nose.world[0] - m[12])).toBeGreaterThan(0);
      expect(sign * (leftEye.distance - rightEye.distance)).toBeGreaterThan(0);
      expect(rightEar.x).toBeLessThan(leftEar.x);
    }
    if (name === 'profile') {
      expect(Math.abs(rightEye.x - leftEye.x)).toBeLessThan(1);
      expect(nose.x).toBeGreaterThan(rightEye.x);
      expect(leftEye.distance).toBeGreaterThan(rightEye.distance);
    }
    if (name === 'rear') {
      expect(rightEar.x).toBeGreaterThan(leftEar.x);
      expect(nose.distance).toBeGreaterThan(leftEar.distance);
    }
    if (name === 'tilt') expect(leftEye.y).toBeLessThan(rightEye.y);
    expect(report.cropped).toEqual([]); expect(report.surfaceClipped).toBe(false);
    expect(JSON.parse(files['pose.json'])).toEqual({
      version: complete.pose.version, rig: complete.pose.rig, limits: complete.pose.limits, rotations: complete.pose.rotations,
    });
    const decoded = await inspectFiles(page, files, report);
    // Last body landmark remains visible even when other face dots overlap at profile/rear.
    expect(decoded['openpose.png'].joints[17]).toEqual([255, 0, 85, 255]);
    expect(decoded['overlay.png'].joints[17]).toEqual([255, 0, 85, 255]);
    await testInfo.attach(`${name}-overlay`, { body: files['overlay.png'], contentType: 'image/png' });
    await testInfo.attach(`${name}-openpose`, { body: files['openpose.png'], contentType: 'image/png' });
    await page.locator('#close-control-export').click();
    expect(JSON.parse(await download(page, '#export'))).toEqual(JSON.parse(files['pose.json']));
  });
}

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
  await verifyPackage(page, files);
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
  expect(decoded['segmentation.png'].probes[0]).toEqual([255, 0, 0, 255]); // Anatomical left upper arm wins the crossing.
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

test('unchanged package repeats exactly and size changes produce a new snapshot identifier', async ({ page }) => {
  await openPrototype(page); await validate(page);
  const first = await download(page, '#download-control-export');
  const initial = await verifyPackage(page, unzip(first));
  await validate(page);
  expect((await download(page, '#download-control-export')).equals(first)).toBe(true);
  await page.locator('#control-size').selectOption('512x512');
  await expect(page.locator('#download-control-export')).toBeDisabled();
  await validate(page);
  const changed = await verifyPackage(page, unzip(await download(page, '#download-control-export')));
  expect(changed.manifest.snapshotHash.value).not.toBe(initial.manifest.snapshotHash.value);
  expect(changed.manifest.resolution).toEqual({ width: 512, height: 512 });
});

for (const [name, rotations] of [
  ['raised left arm', [['leftShoulder', [-110, 0, 100]]]],
  ['raised right arm', [['rightShoulder', [-110, 0, -100]]]],
  ['bent knee', [['leftKnee', [95, 0, 0]]]],
  ['rotated torso', [['chest', [0, 35, 15]]]],
  ['crossed legs', [['leftHip', [0, 15, -30]], ['rightHip', [0, -15, 30]]]],
  ['wrist occluded by torso', [['leftShoulder', [70, 0, -20]]]],
]) test(`complete package retains exact transforms and aligned masks for ${name}`, async ({ page }) => {
  await page.locator('#limits').uncheck();
  for (const [joint, angles] of rotations) {
    await page.getByLabel('Selected joint', { exact: true }).selectOption(joint);
    for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
      await page.locator(`#angle-${axis}`).fill(String(angles[i])); await page.locator(`#angle-${axis}`).press('Tab');
    }
  }
  const poseBefore = JSON.parse(await download(page, '#export'));
  await openPrototype(page); await validate(page);
  const files = unzip(await download(page, '#download-control-export'));
  const { landmarks } = await verifyPackage(page, files);
  expect(JSON.parse(files['pose.json'])).toEqual(poseBefore);
  if (name.includes('occluded')) {
    const wrist = landmarks.landmarks.find(point => point.id === 'leftWrist');
    expect(wrist.visibility.status).toBe('occluded');
    expect(wrist.visibility.occluderSegmentId).toBe(2); // Torso; independently arranged behind the spine.
  }
  await page.locator('#close-control-export').click();
  expect(JSON.parse(await download(page, '#export'))).toEqual(poseBefore);
});
