/* ============================================================
 * zip.js — 零依赖 ZIP 读写（STORE + deflate-raw）
 * 用于 .docx (OPC 包) 的生成与解析。
 * 压缩优先使用浏览器内置 CompressionStream / DecompressionStream，
 * 不支持时自动退化为 STORE（ZIP 规范允许，Word/WPS 均可正常打开）。
 * ============================================================ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const ENC = new TextEncoder();
const DEC = new TextDecoder('utf-8');

function utf8(str) { return ENC.encode(str); }
function fromUtf8(buf) { return DEC.decode(buf); }

/** 把 Bytes/ArrayBuffer/Uint8Array 统一成 Uint8Array */
function asBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('无法识别的二进制类型');
}

const HAS_COMPRESSION = (typeof CompressionStream === 'function');
const HAS_DECOMPRESSION = (typeof DecompressionStream === 'function');

/** 读完一个 ReadableStream，拼成 Uint8Array。
    自己读 reader，不依赖 Response —— 这样 ZIP 层不绑定任何环境全局对象。 */
async function collectStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const u = asBytes(value);
    chunks.push(u);
    total += u.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** raw deflate 压缩；失败返回 null（调用方退化为 STORE） */
async function deflateRaw(bytes) {
  if (!HAS_COMPRESSION) return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const out = await collectStream(stream);
    // 压不小就不用
    return out.length < bytes.length ? out : null;
  } catch (e) {
    return null;
  }
}

/** raw deflate 解压 */
async function inflateRaw(bytes) {
  if (!HAS_DECOMPRESSION) throw new Error('当前浏览器不支持解压（需 Chrome/Edge 103+）');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return collectStream(stream);
}

/* ---------------- 写 ---------------- */

class ByteWriter {
  constructor() { this.chunks = []; this.len = 0; }
  push(b) { const u = asBytes(b); this.chunks.push(u); this.len += u.length; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
  blob(type) { return new Blob(this.chunks, type ? { type } : undefined); }
  bytes() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

function dosDateTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * 打包为 ZIP。
 * @param {Array<{name:string, data:string|Uint8Array}>} files
 * @param {{compress?:boolean}} [opts]
 * @returns {Promise<Blob>}
 */
async function makeZip(files, opts = {}) {
  const compress = opts.compress !== false;
  const w = new ByteWriter();
  const { time, date } = dosDateTime(new Date());
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = utf8(f.name);
    const raw = typeof f.data === 'string' ? utf8(f.data) : asBytes(f.data);
    const crc = crc32(raw);
    let method = 0, payload = raw;
    if (compress) {
      const packed = await deflateRaw(raw);
      if (packed) { method = 8; payload = packed; }
    }
    const flags = 0x0800; // UTF-8 文件名

    const local = new ByteWriter();
    local.u32(0x04034b50);
    local.u16(20);            // version needed
    local.u16(flags);
    local.u16(method);
    local.u16(time);
    local.u16(date);
    local.u32(crc);
    local.u32(payload.length);
    local.u32(raw.length);
    local.u16(nameBytes.length);
    local.u16(0);             // extra len
    local.push(nameBytes);

    central.push({ nameBytes, method, time, date, crc, clen: payload.length, ulen: raw.length, offset, flags });
    w.push(local.bytes());
    w.push(payload);
    offset += local.len + payload.length;
  }

  const cdStart = offset;
  for (const c of central) {
    const h = new ByteWriter();
    h.u32(0x02014b50);
    h.u16(20);                // version made by
    h.u16(20);                // version needed
    h.u16(c.flags);
    h.u16(c.method);
    h.u16(c.time);
    h.u16(c.date);
    h.u32(c.crc);
    h.u32(c.clen);
    h.u32(c.ulen);
    h.u16(c.nameBytes.length);
    h.u16(0);                 // extra
    h.u16(0);                 // comment
    h.u16(0);                 // disk start
    h.u16(0);                 // internal attrs
    h.u32(0);                 // external attrs
    h.u32(c.offset);
    h.push(c.nameBytes);
    w.push(h.bytes());
  }
  const cdSize = w.len - cdStart;

  const eocd = new ByteWriter();
  eocd.u32(0x06054b50);
  eocd.u16(0);
  eocd.u16(0);
  eocd.u16(central.length);
  eocd.u16(central.length);
  eocd.u32(cdSize);
  eocd.u32(cdStart);
  eocd.u16(0);
  w.push(eocd.bytes());

  return new Blob([w.bytes()], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
}

/* ---------------- 读 ---------------- */

/**
 * 解析 ZIP，返回 {name: Uint8Array}
 * @param {ArrayBuffer|Uint8Array} buf
 */
async function readZip(buf) {
  const data = asBytes(buf);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // 找 EOCD
  let eocd = -1;
  const minStart = Math.max(0, data.length - 65558);
  for (let i = data.length - 22; i >= minStart; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到中央目录）');

  const total = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);

  const out = {};
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(cdOff, true) !== 0x02014b50) break;
    const method = dv.getUint16(cdOff + 10, true);
    const clen = dv.getUint32(cdOff + 20, true);
    const nameLen = dv.getUint16(cdOff + 28, true);
    const extraLen = dv.getUint16(cdOff + 30, true);
    const commentLen = dv.getUint16(cdOff + 32, true);
    const localOff = dv.getUint32(cdOff + 42, true);
    const name = fromUtf8(data.subarray(cdOff + 46, cdOff + 46 + nameLen));

    if (dv.getUint32(localOff, true) === 0x04034b50) {
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = data.subarray(start, start + clen);
      try {
        out[name] = method === 0 ? raw : await inflateRaw(raw);
      } catch (e) {
        out[name] = method === 0 ? raw : null;
      }
    }
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readZipText(buf, name) {
  const files = await readZip(buf);
  const f = files[name];
  return f ? fromUtf8(f) : null;
}

if (typeof window !== 'undefined') {
  window.WFPZip = { makeZip, readZip, readZipText, crc32, utf8, fromUtf8, deflateRaw, inflateRaw, HAS_COMPRESSION };
}
