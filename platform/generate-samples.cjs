// Synthetic CT phantom in every format the viewer reads. No patient data.
// Usage: node platform/generate-samples.cjs [outDir] [--force]
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { gzipSync } = require('node:zlib');

const W = 128, H = 128, D = 64;
const SPACING = [2.5, 2.5, 4]; // mm: x, y, z

// HU phantom: body with fat ring, lungs, heart, spine, liver with a tumor.
// Label classes: 1 liver, 2 tumor, 3 lungs.
function phantom() {
    const hu = new Int16Array(W * H * D), label = new Uint8Array(W * H * D);
    const inside = (u, v, w, cu, cv, cw, ru, rv, rw) => ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2 + ((w - cw) / rw) ** 2 <= 1;
    let seed = 1;
    const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 20; };
    for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W * 2 - 1, v = (y + 0.5) / H * 2 - 1, w = (z + 0.5) / D * 2 - 1;
        let value = -1000, cls = 0;
        if ((u / 0.85) ** 2 + (v / 0.65) ** 2 <= 1) {
            value = (u / 0.8) ** 2 + (v / 0.6) ** 2 <= 1 ? 40 : -100;
            if (w > -0.35 && (inside(u, v, w, -0.38, -0.05, 0.35, 0.25, 0.38, 0.65) || inside(u, v, w, 0.38, -0.05, 0.35, 0.25, 0.38, 0.65))) { value = -850; cls = 3; }
            if (inside(u, v, w, 0.08, -0.15, 0.3, 0.22, 0.2, 0.3)) { value = 45; cls = 0; }
            if (inside(u, v, w, -0.3, 0.05, -0.6, 0.4, 0.35, 0.5)) { value = 60; cls = 1; }
            if (inside(u, v, w, -0.35, 0, -0.55, 0.08, 0.08, 0.12)) { value = 120; cls = 2; }
            const r = Math.hypot(u, v - 0.45);
            if (r <= 0.09) value = r <= 0.04 ? 35 : 700;
            value += noise();
        }
        const i = z * W * H + y * W + x;
        hu[i] = Math.round(value); label[i] = cls;
    }
    return { hu, label };
}

const uid = name => `2.25.${BigInt('0x' + createHash('sha256').update(`dcmviewer-sample:${name}`).digest('hex').slice(0, 30))}`;

// Explicit VR Little Endian writer; elements must be given in ascending tag order.
function element(tag, vr, value) {
    let data;
    if (Buffer.isBuffer(value)) data = value;
    else if (vr === 'US') { data = Buffer.alloc(2); data.writeUInt16LE(value); }
    else if (vr === 'UL') { data = Buffer.alloc(4); data.writeUInt32LE(value); }
    else data = Buffer.from(String(value), 'latin1');
    if (data.length % 2) data = Buffer.concat([data, Buffer.from(vr === 'UI' || vr === 'OB' ? '\0' : ' ')]);
    const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
    const head = Buffer.alloc(long ? 12 : 8);
    head.writeUInt16LE(tag >>> 16, 0); head.writeUInt16LE(tag & 0xffff, 2); head.write(vr, 4, 'latin1');
    if (long) head.writeUInt32LE(data.length, 8); else head.writeUInt16LE(data.length, 6);
    return Buffer.concat([head, data]);
}
function dicomSlice(hu, z) {
    const sop = uid(`sop:${z}`);
    const meta = Buffer.concat([
        element(0x00020001, 'OB', Buffer.from([0, 1])),
        element(0x00020002, 'UI', '1.2.840.10008.5.1.4.1.1.2'),
        element(0x00020003, 'UI', sop),
        element(0x00020010, 'UI', '1.2.840.10008.1.2.1'),
        element(0x00020012, 'UI', uid('implementation')),
    ]);
    const pixels = Buffer.alloc(W * H * 2);
    for (let i = 0; i < W * H; i++) pixels.writeInt16LE(hu[z * W * H + i] + 1024, i * 2);
    const ds = (n) => n.toFixed(2);
    const body = Buffer.concat([
        element(0x00080008, 'CS', 'ORIGINAL\\PRIMARY\\AXIAL'),
        element(0x00080016, 'UI', '1.2.840.10008.5.1.4.1.1.2'),
        element(0x00080018, 'UI', sop),
        element(0x00080020, 'DA', '20260101'),
        element(0x00080060, 'CS', 'CT'),
        element(0x00080070, 'LO', 'DCMViewer sample generator'),
        element(0x0008103e, 'LO', 'Synthetic phantom'),
        element(0x00100010, 'PN', 'Sample^Phantom'),
        element(0x00100020, 'LO', 'sample-phantom'),
        element(0x00180050, 'DS', ds(SPACING[2])),
        element(0x0020000d, 'UI', uid('study')),
        element(0x0020000e, 'UI', uid('series')),
        element(0x00200010, 'SH', 'SAMPLE'),
        element(0x00200011, 'IS', '1'),
        element(0x00200013, 'IS', String(z + 1)),
        element(0x00200032, 'DS', `${ds(-W * SPACING[0] / 2)}\\${ds(-H * SPACING[1] / 2)}\\${ds(z * SPACING[2])}`),
        element(0x00200037, 'DS', '1\\0\\0\\0\\1\\0'),
        element(0x00280002, 'US', 1),
        element(0x00280004, 'CS', 'MONOCHROME2'),
        element(0x00280010, 'US', H),
        element(0x00280011, 'US', W),
        element(0x00280030, 'DS', `${ds(SPACING[1])}\\${ds(SPACING[0])}`),
        element(0x00280100, 'US', 16),
        element(0x00280101, 'US', 16),
        element(0x00280102, 'US', 15),
        element(0x00280103, 'US', 1),
        element(0x00281050, 'DS', '40'),
        element(0x00281051, 'DS', '400'),
        element(0x00281052, 'DS', '-1024'),
        element(0x00281053, 'DS', '1'),
        element(0x7fe00010, 'OW', pixels),
    ]);
    return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x00020000, 'UL', meta.length), meta, body]);
}

function npy(data) {
    let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${D}, ${H}, ${W}), }`;
    header += ' '.repeat(63 - ((10 + header.length) % 64)) + '\n';
    const prefix = Buffer.alloc(10);
    Buffer.from('\x93NUMPY', 'latin1').copy(prefix); prefix[6] = 1; prefix.writeUInt16LE(header.length, 8);
    return Buffer.concat([prefix, Buffer.from(header, 'latin1'), Buffer.from(Float32Array.from(data).buffer)]);
}

// NIfTI-1 single file: 348-byte header, 4-byte empty extension, voxels at 352.
function nifti(data, datatype, bitpix) {
    const header = Buffer.alloc(352);
    header.writeInt32LE(348, 0);
    [3, W, H, D, 1, 1, 1, 1].forEach((n, i) => header.writeInt16LE(n, 40 + i * 2));
    header.writeInt16LE(datatype, 70); header.writeInt16LE(bitpix, 72);
    [1, ...SPACING, 1, 1, 1, 1].forEach((n, i) => header.writeFloatLE(n, 76 + i * 4));
    header.writeFloatLE(352, 108); header.writeFloatLE(1, 112); header.writeFloatLE(0, 116);
    header.writeUInt8(2, 123); // mm
    header.writeInt16LE(1, 254); // sform: scanner coordinates
    [[SPACING[0], 0, 0, -W * SPACING[0] / 2], [0, SPACING[1], 0, -H * SPACING[1] / 2], [0, 0, SPACING[2], 0]]
        .forEach((row, r) => row.forEach((n, i) => header.writeFloatLE(n, 280 + r * 16 + i * 4)));
    header.write('n+1\0', 344, 'latin1');
    return Buffer.concat([header, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
}

function generate(outDir, force = false) {
    const dir = join(outDir, 'sample-phantom');
    if (existsSync(dir) && !force) return false;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'dicom'), { recursive: true });
    const { hu, label } = phantom();
    for (let z = 0; z < D; z++) writeFileSync(join(dir, 'dicom', `IM${String(z + 1).padStart(4, '0')}.dcm`), dicomSlice(hu, z));
    writeFileSync(join(dir, 'phantom.npy'), npy(hu));
    const image = nifti(hu, 4, 16); // INT16
    writeFileSync(join(dir, 'phantom.nii'), image);
    writeFileSync(join(dir, 'phantom.nii.gz'), gzipSync(image));
    writeFileSync(join(dir, 'phantom_label.nii.gz'), gzipSync(nifti(label, 2, 8))); // UINT8 mask
    return true;
}

module.exports = { generate, dimensions: [W, H, D] };
if (require.main === module) {
    const args = process.argv.slice(2);
    const outDir = resolve(args.find(arg => !arg.startsWith('--')) ?? join(__dirname, 'data'));
    console.log(generate(outDir, args.includes('--force'))
        ? `Sample volumes written to ${join(outDir, 'sample-phantom')}`
        : `Sample volumes already exist in ${join(outDir, 'sample-phantom')} (use --force to regenerate)`);
}
