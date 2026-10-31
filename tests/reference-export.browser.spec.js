import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function zipEntryNames(zip) {
  const names = [];
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error('ZIP end record is missing');
  const end = zip.readUInt32LE(endOffset + 16);
  for (let offset = end; zip.readUInt32LE(offset) === 0x02014b50;) {
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function zipEntry(zip, wantedName) {
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = zip.readUInt32LE(endOffset + 16);
  while (zip.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wantedName) {
      const local = zip.readUInt32LE(offset + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      return zip.subarray(start, start + zip.readUInt32LE(local + 18));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry ${wantedName} is missing`);
}

test('exports full-body views and an independently framed close-up in a reference ZIP', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready · select a joint to begin');
  await page.locator('#export-references').click();

  const dialog = page.locator('#reference-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.reference-card')).toHaveCount(4);
  await expect(page.locator('#reference-count')).toHaveText('4 full-body images · 0 close-ups');

  const front = page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Front' }) });
  await front.getByLabel('Add close-up').check();
  const preview = front.locator('canvas');
  const initial = await preview.evaluate(canvas => canvas.toDataURL());
  const bounds = await preview.boundingBox();
  if (!bounds) throw new Error('Front preview has no layout box');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -240);
  await expect.poll(() => preview.evaluate(canvas => canvas.toDataURL())).not.toBe(initial);
  const zoomed = await preview.evaluate(canvas => canvas.toDataURL());
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(bounds.x + bounds.width / 2 + 25, bounds.y + bounds.height / 2 + 15, { steps: 3 });
  await page.mouse.up({ button: 'right' });
  await expect.poll(() => preview.evaluate(canvas => canvas.toDataURL())).not.toBe(zoomed);
  await expect(page.locator('#reference-count')).toHaveText('4 full-body images · 1 close-ups');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-references').click();
  const download = await downloadPromise;
  const zip = await readFile(await download.path());
  const names = zipEntryNames(zip);
  expect(names).toEqual(expect.arrayContaining([
    'front.png', 'front-closeup.png', 'top.png', 'left.png', 'right.png',
    'overview.png', 'pose.json', 'reference.md',
  ]));
  expect(zipEntry(zip, 'front.png').equals(zipEntry(zip, 'front-closeup.png'))).toBe(false);
  const overview = zipEntry(zip, 'overview.png').toString('base64');
  const frontCellBounds = await page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(20, 48, 760, 470).data;
    let left = 760, right = -1, top = 470, bottom = -1;
    for (let y = 0; y < 470; y++) for (let x = 0; x < 760; x++) {
      const i = (y * 760 + x) * 4;
      if (pixels[i] < 244 || pixels[i + 1] < 247 || pixels[i + 2] < 244) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    return { width: right - left + 1, height: bottom - top + 1 };
  }, overview);
  expect(frontCellBounds.width / frontCellBounds.height).toBeCloseTo(1200 / 1600, 1);
  await expect(dialog).toBeHidden();
});
