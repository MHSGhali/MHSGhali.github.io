/* A minimal ZIP writer, so the STL export can hand over a folder.

   The desktop tool writes its printable parts into a DIRECTORY: one STL per
   part plus a MANIFEST.txt saying what each is. A browser cannot write a
   directory, and handing over a dozen separate downloads would be worse than
   useless -- so the same folder arrives as one archive with the same names
   inside it.

   Entries are STORED, not deflated. STL is mostly float noise and compresses
   poorly, the archive is a few hundred kilobytes either way, and stored
   entries need no compressor: the format is then small enough to be obviously
   correct rather than a dependency. */

/* CRC-32, table built once on first use. */
let TABLE = null;
function crcTable() {
  if (TABLE) return TABLE;
  TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  return TABLE;
}

function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* MS-DOS date and time, which is what the format stores. */
function dosStamp(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) |
               ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) |
               (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/* `entries` is [{ name, bytes }] where bytes is a Uint8Array or a string.
   Returns the archive as a Uint8Array. */
export function makeZip(entries, when = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosStamp(when);

  const items = entries.map((e) => {
    const bytes = typeof e.bytes === "string" ? enc.encode(e.bytes) : e.bytes;
    return { name: enc.encode(e.name), bytes, crc: crc32(bytes) };
  });

  let size = 0;
  for (const it of items) size += 30 + it.name.length + it.bytes.length;   /* local headers */
  for (const it of items) size += 46 + it.name.length;                     /* central dir  */
  size += 22;                                                              /* end record   */

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  const offsets = [];

  for (const it of items) {
    offsets.push(o);
    view.setUint32(o, 0x04034b50, true);        /* local file header */
    view.setUint16(o + 4, 20, true);            /* version needed */
    view.setUint16(o + 6, 0, true);             /* flags */
    view.setUint16(o + 8, 0, true);             /* method: stored */
    view.setUint16(o + 10, time, true);
    view.setUint16(o + 12, date, true);
    view.setUint32(o + 14, it.crc, true);
    view.setUint32(o + 18, it.bytes.length, true);
    view.setUint32(o + 22, it.bytes.length, true);
    view.setUint16(o + 26, it.name.length, true);
    view.setUint16(o + 28, 0, true);            /* extra field length */
    o += 30;
    out.set(it.name, o); o += it.name.length;
    out.set(it.bytes, o); o += it.bytes.length;
  }

  const centralStart = o;
  items.forEach((it, i) => {
    view.setUint32(o, 0x02014b50, true);        /* central directory header */
    view.setUint16(o + 4, 20, true);            /* version made by */
    view.setUint16(o + 6, 20, true);            /* version needed */
    view.setUint16(o + 8, 0, true);
    view.setUint16(o + 10, 0, true);
    view.setUint16(o + 12, time, true);
    view.setUint16(o + 14, date, true);
    view.setUint32(o + 16, it.crc, true);
    view.setUint32(o + 20, it.bytes.length, true);
    view.setUint32(o + 24, it.bytes.length, true);
    view.setUint16(o + 28, it.name.length, true);
    view.setUint16(o + 30, 0, true);            /* extra */
    view.setUint16(o + 32, 0, true);            /* comment */
    view.setUint16(o + 34, 0, true);            /* disk number */
    view.setUint16(o + 36, 0, true);            /* internal attrs */
    view.setUint32(o + 38, 0, true);            /* external attrs */
    view.setUint32(o + 42, offsets[i], true);
    o += 46;
    out.set(it.name, o); o += it.name.length;
  });

  view.setUint32(o, 0x06054b50, true);          /* end of central directory */
  view.setUint16(o + 4, 0, true);
  view.setUint16(o + 6, 0, true);
  view.setUint16(o + 8, items.length, true);
  view.setUint16(o + 10, items.length, true);
  view.setUint32(o + 12, o - centralStart, true);
  view.setUint32(o + 16, centralStart, true);
  view.setUint16(o + 20, 0, true);              /* comment length */
  return out;
}
