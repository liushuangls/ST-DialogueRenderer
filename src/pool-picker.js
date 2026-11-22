import { AVATAR_POOL_SCOPE } from "./context.js?v=2.6.1";
import { groupedAvatarPool, poolPortraitUrl, portraitNameFromFile } from "./avatar-pool.js?v=2.6.1";
import { groupEdits, poolGroups, UNGROUPED } from "./pool-groups.js?v=2.6.1";
import { compressImage, getCompressOptions } from "./image-utils.js?v=2.6.1";

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
}

function elements(doc) {
  function node(tag, text, className) {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(text, className) {
    const el = node('button', text, className);
    el.type = 'button';
    return el;
  }
  return {node, button};
}

// Both views share the grouped gallery, but each supplies its own actions.
function bindCatalog(root, db, { activate, decorateTile, groupButton }) {
  const sections = root.querySelector('.bam-pool-sections');
  const {node, button} = elements(root.ownerDocument);
  const expanded = new Set();
  let revision = 0;
  let firstView = true;
  async function render() {
    const version = ++revision;
    const catalog = await groupedAvatarPool(db);
    if (version !== revision || !root.isConnected) return;
    if (firstView) { expanded.add(catalog[0].id); firstView = false; }
    const rows = await Promise.all(catalog.map(async g => {
      const section = node('details', undefined, 'bam-pool-group');
      section.dataset.group = g.id;
      section.open = expanded.has(g.id);
      const heading = node('summary');
      heading.append(node('span', g.name), node('small', String(g.items.length)));
      section.append(heading);
      if (groupButton) section.append(groupButton(g));
      const grid = node('div', undefined, 'bam-pool-grid');
      const tiles = await Promise.all(g.items.map(async item => {
        const tile = button();
        tile.dataset.id = item.id;
        tile.title = item.label;
        const image = node('img');
        image.alt = ''; image.loading = 'lazy';
        image.src = await poolPortraitUrl(db, item);
        tile.append(image, node('span', item.label));
        tile.addEventListener('click', () => activate(item, tile));
        return decorateTile ? decorateTile(item, tile) : tile;
      }));
      const buckets = new Map();
      for (const [index, item] of g.items.entries()) {
        const key = item.series || '';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(tiles[index]);
      }
      for (const [series, portraits] of buckets) {
        if (series || buckets.size > 1) grid.append(node('h4', series || '其他头像'));
        grid.append(...portraits);
      }
      section.append(grid);
      section.addEventListener('toggle', () => {
        if (!sections.contains(section)) return;
        if (section.open) expanded.add(g.id); else expanded.delete(g.id);
      });
      return section;
    }));
    if (version !== revision || !root.isConnected) return;
    sections.replaceChildren(...rows);
    return catalog;
  }
  return {render, expanded};
}

export function bindPoolPicker(details, db, { selectFile, imageMeta }) {
  const status = details.querySelector('[role=status]');
  let selection = 0;
  let targetName;
  const catalog = bindCatalog(details, db, { activate: async item => {
    const version = ++selection;
    try {
      const url = await poolPortraitUrl(db, item);
      const response = await fetch(url);
      if (!response.ok) throw new Error('读取头像失败（HTTP ' + response.status + '）');
      const bytes = await response.blob();
      const type = item.mimeType || bytes.type || (item.file?.endsWith('.png') ? 'image/png' : 'image/webp');
      const file = new File([bytes], item.file || item.label, { type });
      const meta = await imageMeta(file);
      if (!meta.width) throw new Error('头像文件无法解码，请重新选择');
      if (version !== selection || !details.open || !details.isConnected) return;
      selectFile(file, targetName, item);
      details.open = false;
    } catch (error) { if (version === selection) status.textContent = error.message || String(error); }
  } });
  function refresh() {
    if (details.open) catalog.render().catch(error => { status.textContent = error.message || String(error); });
  }
  details.addEventListener('toggle', event => {
    if (event.target !== details) return;
    if (details.open) { status.textContent = ''; refresh(); }
    else { selection++; targetName = undefined; }
  });
  return {
    refresh,
    open(speakerName) {
      selection++;
      targetName = speakerName;
      if (details.open) refresh(); else details.open = true;
      details.scrollIntoView({ block:'nearest' });
    },
  };
}

export function bindPoolManager(details, db, { preview, imageMeta, changed }) {
  const doc = details.ownerDocument;
  const sections = details.querySelector('.bam-pool-sections');
  const editor = details.querySelector('.bam-group-editor');
  const target = editor.querySelector('select');
  const name = editor.querySelector('input');
  const manage = details.querySelector('.bam-manage-toggle');
  const files = details.querySelector('input[type=file]');
  const status = details.querySelector('[role=status]');
  const move = editor.querySelector('[data-edit=move]');
  const selected = new Set();
  const {node, button} = elements(doc);
  let groups = [];
  let uploadGroup;
  let uploading = false;

  const report = error => { status.textContent = error.message || String(error); };
  function updateEditor() {
    const editable = groups.filter(g => g.id !== UNGROUPED);
    const index = editable.findIndex(g => g.id === target.value);
    editor.querySelector('[data-edit=rename]').disabled = index < 0;
    editor.querySelector('[data-edit=delete]').disabled = index < 0;
    editor.querySelector('[data-edit=up]').disabled = index <= 0;
    editor.querySelector('[data-edit=down]').disabled = index < 0 || index === editable.length - 1;
    move.disabled = !target.value || !selected.size;
    move.textContent = selected.size ? '移入所选分组（' + selected.size + '）' : '勾选头像后可移动';
  }

  function editUpload(item, trigger) {
    const previous = sections.querySelector('.bam-upload-editor');
    if (previous) previous.remove();
    const form = node('form', undefined, 'bam-upload-editor');
    const label = node('label', '头像名称');
    const input = node('input');
    input.type = 'text';
    input.value = item.label;
    input.required = true;
    label.append(input);
    const actions = node('div', undefined, 'bam-group-actions');
    const save = button('保存名字');
    save.type = 'submit';
    const remove = button('删除头像', 'bam-upload-delete');
    const cancel = button('取消');
    actions.append(save, remove, cancel);
    form.append(label, actions);
    trigger.parentElement.after(form);
    input.focus();
    input.select();

    cancel.addEventListener('click', () => { form.remove(); trigger.focus(); });
    async function commit(deleting) {
      if (save.disabled) return;
      if (deleting && !doc.defaultView.confirm('从头像池删除「' + item.label + '」？所有使用这张源图的角色头像和情绪差分也会一起删除。')) return;
      save.disabled = remove.disabled = cancel.disabled = true;
      try {
        if (deleting) {
          await db.delete(AVATAR_POOL_SCOPE, item.uploadKey);
          selected.delete(item.id);
        } else {
          await db.renamePoolUpload(item.uploadKey, input.value);
        }
        changed();
        status.textContent = deleting ? '已从头像池删除' : '头像名称已保存';
        await render();
      } catch (error) {
        report(error);
      } finally {
        save.disabled = remove.disabled = cancel.disabled = false;
      }
    }
    form.addEventListener('submit', event => { event.preventDefault(); commit(false); });
    remove.addEventListener('click', () => commit(true));
  }

  const {render: renderCatalog, expanded} = bindCatalog(details, db, {
    groupButton(group) {
      const upload = button('上传到本组', 'bam-pool-upload');
      upload.setAttribute('aria-label', '上传到' + group.name);
      upload.disabled = uploading;
      upload.addEventListener('click', () => { uploadGroup = group.id; files.click(); });
      return upload;
    },
    decorateTile(item, tile) {
      if (!editor.hidden) {
        tile.setAttribute('aria-pressed', String(selected.has(item.id)));
        return tile;
      }
      if (!item.uploadKey) return tile;
      const entry = node('div', undefined, 'bam-upload-tile');
      const edit = button('编辑');
      edit.setAttribute('aria-label', '编辑「' + item.label + '」');
      edit.addEventListener('click', () => editUpload(item, edit));
      entry.append(tile, edit);
      return entry;
    },
    activate(item, tile) {
      if (editor.hidden) { preview(tile.querySelector('img').src, item.label); return; }
      if (selected.has(item.id)) selected.delete(item.id); else selected.add(item.id);
      tile.setAttribute('aria-pressed', String(selected.has(item.id)));
      updateEditor();
    },
  });

  async function render(preferred) {
    const catalog = await renderCatalog();
    if (!catalog) return;
    groups = catalog;
    const active = preferred || target.value;
    const options = groups.filter(g => g.id !== UNGROUPED).map(g => {
      const option = node('option', g.name); option.value = g.id; return option;
    });
    target.replaceChildren(...options);
    if (options.some(o => o.value === active)) target.value = active;
    updateEditor();
  }

  manage.addEventListener('click', () => {
    editor.hidden = !editor.hidden;
    selected.clear();
    manage.setAttribute('aria-expanded', String(!editor.hidden));
    manage.textContent = editor.hidden ? '管理分组' : '完成管理';
    name.value = ''; status.textContent = '';
    render().catch(report);
  });
  target.addEventListener('change', () => { name.value = ''; updateEditor(); });
  editor.addEventListener('click', async event => {
    const action = event.target.closest('button[data-edit]')?.dataset.edit;
    if (!action) return;
    const id = action === 'create' ? 'custom-' + newId() : target.value;
    const groupName = target.selectedOptions[0]?.textContent || '';
    if (action === 'delete' && !confirm('删除「' + groupName + '」分组？组内头像将保留在「未分组」。')) return;
    try {
      const selectionIds = [...selected];
      const label = name.value;
      await db.editPoolLayout(settings => {
        if (action !== 'move') return groupEdits(settings, action, id, label);
        if (!poolGroups(settings).some(g => g.id === id)) throw new Error('目标分组已变更');
        return Object.fromEntries(selectionIds.map(key => ['item:' + key, id]));
      });
      if (action === 'move' || action === 'delete') changed();
      if (action === 'move' || action === 'create') expanded.add(id);
      selected.clear(); name.value = ''; status.textContent = '';
      await render(id);
    } catch (error) { report(error); }
  });

  files.addEventListener('change', async () => {
    const batch = [...files.files];
    const destination = uploadGroup;
    files.value = '';
    if (!batch.length || !destination || uploading) return;
    uploading = true;
    for (const item of sections.querySelectorAll('.bam-pool-upload')) item.disabled = true;
    let added = 0;
    let message;
    try {
      const options = await getCompressOptions(db);
      for (const file of batch) {
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
          throw new Error(file.name + '：请选择 2 MB 以内的 PNG、JPG、GIF 或 WebP 图片');
        }
        const meta = await imageMeta(file);
        if (!meta.width) throw new Error(file.name + '：图片无法解码');
        const bytes = await compressImage(file, options);
        await db.add(AVATAR_POOL_SCOPE, newId(), bytes, { ...meta, fileName: portraitNameFromFile(file.name), poolGroup: destination });
        added++;
      }
      expanded.add(destination);
      message = '已上传 ' + added + ' 张头像';
    } catch (error) {
      message = (added ? '已加入 ' + added + ' 张。' : '') + (error.message || error);
    } finally {
      uploading = false;
      status.textContent = message;
      await render().catch(report);
      if (added) changed();
    }
  });

  return render;
}
