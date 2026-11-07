const _zipCrc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

function zipCrc32(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) crc = _zipCrc32Table[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 将文件列表打包为 ZIP Blob（store 模式，无压缩）
 * @param {Array<{name: string, data: Uint8Array}>} files - 文件列表
 * @returns {Blob} ZIP 文件 Blob
 */
function zipCreate(files) {
  const encoder = new TextEncoder();
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = zipCrc32(file.data);
    const size = file.data.length;

    // Local file header (30 + nameLen + data)
    const local = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034B50, true);   // 签名
    lv.setUint16(4, 20, true);            // 版本
    lv.setUint16(6, 0, true);             // 标志
    lv.setUint16(8, 0, true);             // 压缩方法: store
    lv.setUint16(10, 0, true);            // 修改时间
    lv.setUint16(12, 0, true);            // 修改日期
    lv.setUint32(14, crc, true);          // CRC-32
    lv.setUint32(18, size, true);         // 压缩大小
    lv.setUint32(22, size, true);         // 原始大小
    lv.setUint16(26, nameBytes.length, true); // 文件名长度
    lv.setUint16(28, 0, true);            // 额外字段长度
    new Uint8Array(local, 30).set(nameBytes);
    localHeaders.push(new Uint8Array(local));

    // Central directory header (46 + nameLen)
    const central = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(central);
    cv.setUint32(0, 0x02014B50, true);    // 签名
    cv.setUint16(4, 20, true);            // 创建版本
    cv.setUint16(6, 20, true);            // 解压版本
    cv.setUint16(8, 0, true);             // 标志
    cv.setUint16(10, 0, true);            // 压缩方法: store
    cv.setUint16(12, 0, true);            // 修改时间
    cv.setUint16(14, 0, true);            // 修改日期
    cv.setUint32(16, crc, true);          // CRC-32
    cv.setUint32(20, size, true);         // 压缩大小
    cv.setUint32(24, size, true);         // 原始大小
    cv.setUint16(28, nameBytes.length, true); // 文件名长度
    cv.setUint16(30, 0, true);            // 额外字段长度
    cv.setUint16(32, 0, true);            // 文件注释长度
    cv.setUint16(34, 0, true);            // 磁盘编号
    cv.setUint16(36, 0, true);            // 内部属性
    cv.setUint32(38, 0, true);            // 外部属性
    cv.setUint32(42, offset, true);       // 本地头偏移
    new Uint8Array(central, 46).set(nameBytes);
    centralHeaders.push(new Uint8Array(central));

    offset += 30 + nameBytes.length + size;
  }

  // End of central directory (22 bytes)
  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) centralDirSize += ch.length;

  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054B50, true);      // 签名
  ev.setUint16(4, 0, true);               // 磁盘编号
  ev.setUint16(6, 0, true);               // 中央目录磁盘
  ev.setUint16(8, files.length, true);     // 本磁盘条目数
  ev.setUint16(10, files.length, true);    // 总条目数
  ev.setUint32(12, centralDirSize, true);  // 中央目录大小
  ev.setUint32(16, centralDirOffset, true);// 中央目录偏移
  ev.setUint16(20, 0, true);              // 注释长度

  // 组装最终 Blob
  const parts = [];
  for (let i = 0; i < files.length; i++) {
    parts.push(localHeaders[i]);
    parts.push(files[i].data);
  }
  for (const ch of centralHeaders) parts.push(ch);
  parts.push(new Uint8Array(eocd));

  return new Blob(parts, { type: 'application/zip' });
}

/**
 * 从 ZIP Blob 中逐文件提取（store 模式）
 * @param {ArrayBuffer} buffer - ZIP 文件的 ArrayBuffer
 * @returns {Map<string, Uint8Array>} 文件名 -> 文件数据的 Map
 */
function zipExtract(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const decoder = new TextDecoder();
  const files = new Map();

  // 从末尾查找 EOCD 签名
  let eocdOffset = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('无效的 ZIP 文件：找不到 EOCD 签名');

  const entryCount = dv.getUint16(eocdOffset + 10, true);
  let cdOffset = dv.getUint32(eocdOffset + 16, true);

  for (let i = 0; i < entryCount; i++) {
    if (dv.getUint32(cdOffset, true) !== 0x02014B50) throw new Error('ZIP 中央目录损坏');
    const method = dv.getUint16(cdOffset + 10, true);
    const crc = dv.getUint32(cdOffset + 16, true);
    const compSize = dv.getUint32(cdOffset + 20, true);
    const nameLen = dv.getUint16(cdOffset + 28, true);
    const extraLen = dv.getUint16(cdOffset + 30, true);
    const commentLen = dv.getUint16(cdOffset + 32, true);
    const localOffset = dv.getUint32(cdOffset + 42, true);
    const name = decoder.decode(u8.subarray(cdOffset + 46, cdOffset + 46 + nameLen));

    if (method !== 0) throw new Error(`ZIP 条目 "${name}" 使用了不支持的压缩方法 ${method}，仅支持 store 模式`);

    // 从 local header 中读取实际数据偏移
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    const data = u8.slice(dataOffset, dataOffset + compSize);

    // CRC32 校验
    const actualCrc = zipCrc32(data);
    if (actualCrc !== crc) throw new Error(`ZIP 条目 "${name}" CRC32 校验失败（期望 ${crc}，实际 ${actualCrc}）`);

    files.set(name, data);
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}

/** mimeType 转文件扩展名 */
function mimeToExt(mime) {
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp', 'image/avif': '.avif' };
  return map[mime] || '.bin';
}

/** 文件扩展名转 mimeType */
function extToMime(ext) {
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
  return map[ext.toLowerCase()] || 'image/webp';
}

/** 安全化文件名（去除路径分隔符和特殊字符） */
function safeFileName(name) {
  return (name || 'unnamed').replace(/[\/\\:*?"<>|]/g, '_').substring(0, 100);
}

export { zipCreate, zipExtract, mimeToExt, extToMime, safeFileName };
