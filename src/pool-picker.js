import { AVATAR_POOL_SCOPE } from "./context.js?v=2.3.0";
import { listAvatarPool, poolPortraitUrl } from "./avatar-pool.js?v=2.3.0";
import { compressImage, getCompressOptions } from "./image-utils.js?v=2.3.0";

export function bindPoolPicker(details, db, { selectFile, imageMeta, changed }) {
  const grid = details.querySelector('.bam-pool-grid');
  const group = details.querySelector('select');
  const files = details.querySelector('input[type=file]');
  const upload = details.querySelector('.bam-pool-upload');
  const status = details.querySelector('[role=status]');
  let items = [];
  let revision = 0;
  let selection = 0;
  let targetName = '';

  const report = error => { status.textContent = error.message || String(error); };

  async function render() {
    const version = ++revision;
    const catalog = await listAvatarPool(db);
    const visible = catalog.filter(item => !group.value || item.group === group.value);
    const buttons = await Promise.all(visible.map(async item => {
      const button = details.ownerDocument.createElement('button');
      button.type = 'button';
      button.dataset.id = item.id;
      button.title = item.label;
      const image = details.ownerDocument.createElement('img');
      image.alt = '';
      image.src = await poolPortraitUrl(db, item);
      const label = details.ownerDocument.createElement('span');
      label.textContent = item.label;
      button.append(image, label);
      return button;
    }));
    if (version !== revision || !details.isConnected) return;
    items = catalog;
    grid.replaceChildren(...buttons);
    status.textContent = buttons.length ? '' : '还没有上传到池中的头像';
  }

  details.addEventListener('toggle', () => {
    if (details.open) render().catch(report);
    else { selection++; targetName = ''; }
  });
  group.addEventListener('change', () => render().catch(report));
  grid.addEventListener('click', async event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const item = items.find(entry => entry.id === button.dataset.id);
    if (!item) return;
    const version = ++selection;
    try {
      const url = await poolPortraitUrl(db, item);
      const response = await fetch(url);
      if (!response.ok) throw new Error('读取头像失败（HTTP ' + response.status + '）');
      const bytes = await response.blob();
      const type = item.mimeType || (item.file.endsWith('.png') ? 'image/png' : 'image/webp');
      const file = new File([bytes], item.file || item.label, { type });
      const meta = await imageMeta(file);
      if (!meta.width) throw new Error('头像文件无法解码，请重新选择');
      if (version !== selection || !details.open || !details.isConnected) return;
      selectFile(file, targetName);
      details.open = false;
    } catch (error) { if (version === selection) report(error); }
  });

  upload.addEventListener('click', () => files.click());
  files.addEventListener('change', async () => {
    const selected = [...files.files];
    files.value = '';
    if (!selected.length) return;
    upload.disabled = true;
    let added = 0;
    try {
      const options = await getCompressOptions(db);
      for (const file of selected) {
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
          throw new Error(file.name + '：请选择 2 MB 以内的 PNG、JPG、GIF 或 WebP 图片');
        }
        const meta = await imageMeta(file);
        if (!meta.width) throw new Error(file.name + '：图片无法解码');
        const bytes = await compressImage(file, options);
        const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
        await db.add(AVATAR_POOL_SCOPE, key, bytes, meta);
        added++;
      }
      group.value = '我上传的';
      await render();
      status.textContent = '已加入头像池：' + added + ' 张';
    } catch (error) {
      await render().catch(report);
      status.textContent = (added ? '已加入 ' + added + ' 张。' : '') + (error.message || error);
    } finally {
      upload.disabled = false;
      if (added) changed();
    }
  });

  return name => {
    targetName = name;
    details.open = true;
    details.scrollIntoView({ block: 'nearest' });
  };
}
