import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * Read a .tgz in-process and list what it actually contains.
 *
 * Shelling out to `tar` was the first implementation and it was wrong in a way CI could never catch:
 * GNU tar on Windows parses `C:\path` as a remote `host:path`, so the release gate passed on Linux
 * runners and failed on the machine that cuts releases.
 *
 * Three header forms matter beyond the plain ustar case, and getting them wrong makes the assertions
 * built on this function silently weaker rather than loud:
 *   - pax ('x') and GNU ('L') headers carry the real name for the FOLLOWING entry. Ignore them and a
 *     path component over 100 characters is truncated at the ustar name field, losing the extension,
 *     so suffix-anchored checks like /\.log$/ stop matching a file that is genuinely in the tarball.
 *   - links ('1'/'2') carry no data but do carry a path. A symlink named `.env` is invisible to every
 *     content check unless it is listed like anything else.
 */
export function parseTar(buf) {
  const out = [];
  let pendingName = null;

  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    if (header.every(b => b === 0)) break;

    const str = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
    const typeflag = str(156, 1) || '0';
    const sizeField = str(124, 12);
    // base-256 encoding (high bit set) is used for sizes that do not fit in 11 octal digits
    const size = (header[124] & 0x80)
      ? Number(header.subarray(124, 136).reduce((acc, b, i) => (i === 0 ? BigInt(b & 0x7f) : (acc << 8n) | BigInt(b)), 0n))
      : (parseInt(sizeField || '0', 8) || 0);

    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    const next = () => { off = dataStart + Math.ceil(size / 512) * 512; };

    if (typeflag === 'x' || typeflag === 'g') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec('\n' + data.toString('utf8'));
      if (m && typeflag === 'x') pendingName = m[1];
      next();
      continue;
    }
    if (typeflag === 'L') {
      pendingName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
      next();
      continue;
    }

    const prefix = str(345, 155);
    const raw = str(0, 100);
    const name = pendingName ?? (prefix ? `${prefix}/${raw}` : raw);
    pendingName = null;

    if (typeflag === '0' || typeflag === '') {
      out.push({ name, size, kind: 'file', read: () => buf.subarray(dataStart, dataStart + size) });
    } else if (typeflag === '5') {
      out.push({ name, size: 0, kind: 'dir', dir: true, read: () => Buffer.alloc(0) });
    } else if (typeflag === '1' || typeflag === '2') {
      out.push({ name, size: 0, kind: typeflag === '2' ? 'symlink' : 'hardlink', link: str(157, 100), read: () => Buffer.alloc(0) });
    }
    next();
  }
  return out;
}

export function readTar(file) {
  return parseTar(gunzipSync(readFileSync(file)));
}
