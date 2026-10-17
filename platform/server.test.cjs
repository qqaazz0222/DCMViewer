const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function npy(shape, values) {
    let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`;
    header += ' '.repeat(63 - ((10 + header.length) % 64)) + '\n';
    const prefix = Buffer.alloc(10);
    Buffer.from('\x93NUMPY', 'latin1').copy(prefix);
    prefix[6] = 1; prefix.writeUInt16LE(header.length, 8);
    return Buffer.concat([prefix, Buffer.from(header, 'latin1'), Buffer.from(new Float32Array(values).buffer)]);
}

function start(dir, env) {
    const server = spawn(process.execPath, [join(__dirname, 'out', 'server.cjs')], {
        env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_ROOT: join(dir, 'data'), STATE_DIR: join(dir, 'state'), ...env },
    });
    const base = new Promise((resolve, reject) => {
        server.stdout.on('data', chunk => { const m = /https?:\/\/[\d.]+:\d+/.exec(String(chunk)); if (m) resolve(m[0]); });
        server.on('exit', code => reject(new Error(`server exited ${code}`)));
    });
    return { server, base };
}

// One cookie jar per simulated browser.
function client(base) {
    let sid = '';
    const call = async (path, body, headers = {}) => {
        const response = await fetch(base + path, {
            redirect: 'manual',
            headers: { cookie: sid, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
            ...(body ? { method: 'POST', body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
        });
        const cookie = response.headers.get('set-cookie');
        if (cookie) sid = cookie.split(';')[0];
        return response;
    };
    return call;
}
// Default admin signs in, replaces admin/admin, then approves a new account.
async function approvedUser(base, username) {
    const admin = client(base);
    let login = await admin('/api/login', { username: 'admin', password: 'admin' });
    if (login.status === 200) await admin('/api/change-password', { current: 'admin', password: 'admin-password-1' });
    else login = await admin('/api/login', { username: 'admin', password: 'admin-password-1' });
    const user = client(base);
    assert.equal((await user('/api/signup', { username, password: 'longpassword' })).status, 202);
    assert.equal((await admin('/api/admin/users', { username, action: 'approve' })).status, 200);
    assert.equal((await user('/api/login', { username, password: 'longpassword' })).status, 200);
    return { admin, user };
}

test('admin first sign-in, approval, roles, browsing, path guard and slice streaming', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcm-platform-'));
    mkdirSync(join(dir, 'data', 'ct'), { recursive: true });
    writeFileSync(join(dir, 'data', 'ct', 'vol.npy'), npy([2, 3, 4], Array.from({ length: 24 }, (_, i) => i)));
    writeFileSync(join(dir, 'secret.txt'), 'outside');
    const { server, base: started } = start(dir, { INVITE_CODE: 'letmein' });
    try {
        const base = await started;
        const anon = client(base), admin = client(base), call = client(base);

        assert.equal((await anon('/api/files')).status, 401);
        assert.equal((await anon('/')).headers.get('location'), '/login');
        for (const asset of ['/icon.png', '/favicon.ico', '/pages.css', '/pages-theme.js']) assert.equal((await anon(asset)).status, 200, `${asset} is public`);
        assert.equal((await anon('/icon.png')).headers.get('content-type'), 'image/png');

        // Default admin must replace admin/admin before anything else.
        const first = await admin('/api/login', { username: 'admin', password: 'admin' });
        assert.equal(first.status, 200);
        assert.equal((await first.json()).next, '/change-password');
        assert.equal((await admin('/api/admin/users')).status, 403, 'blocked until password changes');
        assert.equal((await admin('/admin')).headers.get('location'), '/change-password');
        assert.equal((await admin('/change-password')).status, 200);
        assert.equal((await admin('/api/change-password', { current: 'wrong', password: 'new-password-1' })).status, 401);
        assert.equal((await admin('/api/change-password', { current: 'admin', password: 'short' })).status, 400);
        assert.equal((await admin('/api/change-password', { current: 'admin', password: 'admin' })).status, 400);
        const changed = await admin('/api/change-password', { current: 'admin', password: 'admin-password-1' });
        assert.deepEqual(await changed.json(), { next: '/admin' });
        assert.equal((await anon('/api/login', { username: 'admin', password: 'admin' })).status, 401, 'old password stops working');
        assert.equal((await admin('/admin')).status, 200);
        assert.equal((await admin('/api/files')).status, 403, 'admins do not open images');
        assert.equal((await admin('/')).headers.get('location'), '/admin');

        // Registration waits for approval.
        assert.equal((await call('/api/signup', { username: 'doctor', password: 'longpassword' })).status, 403, 'invite code enforced');
        assert.equal((await call('/api/signup', { username: 'doctor', password: 'short', invite: 'letmein' })).status, 400);
        const created = await call('/api/signup', { username: 'Doctor', password: 'longpassword', invite: 'letmein' });
        assert.equal(created.status, 202);
        assert.equal(created.headers.get('set-cookie'), null, 'no session before approval');
        assert.equal((await call('/api/signup', { username: 'doctor', password: 'longpassword', invite: 'letmein' })).status, 409);
        assert.equal((await call('/api/login', { username: 'doctor', password: 'wrongpassword' })).status, 401);
        const pending = await call('/api/login', { username: 'doctor', password: 'longpassword' });
        assert.equal(pending.status, 403);
        assert.match((await pending.json()).error, /awaiting administrator approval/);
        const listed = await (await admin('/api/admin/users')).json();
        assert.deepEqual(listed.find(user => user.username === 'doctor').status, 'pending');
        assert.equal(listed[0].hash, undefined, 'password hashes never leave the server');
        assert.equal((await admin('/api/admin/users', { username: 'admin', action: 'disable' })).status, 400);
        assert.equal((await admin('/api/admin/users', { username: 'doctor', action: 'approve' })).status, 200);
        const login = await call('/api/login', { username: 'doctor', password: 'longpassword' });
        assert.equal(login.status, 200);
        assert.equal((await login.json()).next, '/');
        assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
        assert.deepEqual(await (await call('/api/me')).json(), { username: 'doctor', role: 'user', mustChangePassword: false });
        assert.equal((await call('/api/admin/users')).status, 403);
        assert.equal((await call('/admin')).headers.get('location'), '/');

        const root = await (await call('/api/files')).json();
        assert.deepEqual(root.entries.map(e => [e.name, e.type]), [['ct', 'dir']]);
        assert.equal((await call('/api/files?path=..')).status, 403);
        assert.equal((await call('/api/collect', { paths: ['../secret.txt'] })).status, 403);
        assert.equal((await call('/api/collect', {}, { 'Content-Type': 'text/plain' })).status, 415);

        const refs = await (await call('/api/collect', { paths: ['ct'] })).json();
        assert.deepEqual(refs.map(r => r.path), ['ct/vol.npy']);
        const prepared = await (await call('/api/volumes', { paths: refs.map(r => r.path) })).json();
        assert.equal(prepared.volumes.length, 1);
        const [w, h] = prepared.volumes[0].dimensions;
        const slice = await call(`/api/slice?token=${prepared.volumes[0].token}&axis=axial&slice=0`);
        assert.equal(slice.status, 200);
        assert.equal((await slice.arrayBuffer()).byteLength, w * h * 4);
        assert.equal((await call(`/api/slice?token=${prepared.volumes[0].token}&axis=axial&slice=999`)).status, 400);
        const whole = new Float32Array(await (await call(`/api/volume?token=${prepared.volumes[0].token}`)).arrayBuffer());
        assert.equal(whole.length, w * h * prepared.volumes[0].dimensions[2]);
        assert.deepEqual([...whole.subarray(0, w * h)], [...new Float32Array(await (await call(`/api/slice?token=${prepared.volumes[0].token}&axis=axial&slice=0`)).arrayBuffer())]);
        assert.equal((await call('/api/volume?token=bogus')).status, 400);

        // Platform settings.
        assert.equal((await admin('/api/admin/settings', { dataRoot: join(dir, 'missing') })).status, 400);
        assert.equal((await admin('/api/admin/settings', { signupEnabled: 'no' })).status, 400);
        const saved = await (await admin('/api/admin/settings', { signupEnabled: false, inviteCode: '' })).json();
        assert.equal(saved.signupEnabled, false);
        assert.equal((await anon('/api/signup', { username: 'late', password: 'longpassword' })).status, 403, 'registration closed');
        assert.deepEqual(await (await anon('/api/auth-config')).json(), { inviteRequired: false, signupEnabled: false });

        // Disabling ends the user's live session.
        assert.equal((await admin('/api/admin/users', { username: 'doctor', action: 'disable' })).status, 200);
        assert.equal((await call('/api/files')).status, 401);
        assert.match((await (await call('/api/login', { username: 'doctor', password: 'longpassword' })).json()).error, /disabled/);

        assert.equal((await admin('/api/logout', {})).status, 200);
        assert.equal((await admin('/api/admin/users')).status, 401);
    } finally { server.kill(); }
});

test('HTTPS with TLS_CERT/TLS_KEY sets Secure cookies and HSTS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcm-platform-tls-'));
    mkdirSync(join(dir, 'data'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    const { server, base: started } = start(dir, { TLS_CERT: join(dir, 'cert.pem'), TLS_KEY: join(dir, 'key.pem') });
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed test certificate
    try {
        const base = await started;
        assert.match(base, /^https:/);
        const login = await client(base)('/api/login', { username: 'admin', password: 'admin' });
        assert.equal(login.status, 200);
        assert.match(login.headers.get('set-cookie'), /; Secure/);
        assert.match(login.headers.get('strict-transport-security'), /max-age=/);
    } finally { delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; server.kill(); }
});

test('generated sample volumes load in every format', async () => {
    const { generate, dimensions } = require('./generate-samples.cjs');
    const dir = mkdtempSync(join(tmpdir(), 'dcm-platform-samples-'));
    assert.equal(generate(join(dir, 'data')), true);
    assert.equal(generate(join(dir, 'data')), false, 'existing samples are kept');
    const { server, base: started } = start(dir, {});
    try {
        const base = await started;
        const { user } = await approvedUser(base, 'sampler');
        const post = async (path, body) => (await user(path, body)).json();
        const refs = await post('/api/collect', { paths: ['sample-phantom'] });
        const dicom = refs.filter(ref => ref.name.endsWith('.dcm')).map(ref => ref.path);
        assert.equal(dicom.length, dimensions[2]);
        const series = await post('/api/volumes', { paths: dicom });
        assert.deepEqual(series.errors, []);
        assert.equal(series.volumes.length, 1, 'one DICOM series');
        assert.deepEqual(series.volumes[0].dimensions, dimensions);
        for (const name of ['phantom.npy', 'phantom.nii', 'phantom.nii.gz', 'phantom_label.nii.gz']) {
            const result = await post('/api/volumes', { paths: [`sample-phantom/${name}`] });
            assert.deepEqual(result.errors, [], name);
            assert.deepEqual(result.volumes[0].dimensions, dimensions, name);
            assert.ok(result.volumes[0].min <= -1000 || name.includes('label'), `${name} keeps HU`);
        }
        const label = await post('/api/volumes', { paths: ['sample-phantom/phantom_label.nii.gz'] });
        assert.deepEqual(label.volumes[0].labelClasses, [1, 2, 3]);
    } finally { server.kill(); }
});

test('uploads land in the user folder with a timestamp and never overwrite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcm-platform-upload-'));
    mkdirSync(join(dir, 'data'));
    const { server, base: started } = start(dir, {});
    try {
        const base = await started;
        const { user } = await approvedUser(base, 'uploader');
        const vol = npy([2, 3, 4], Array.from({ length: 24 }, (_, i) => i));
        const upload = (name, body, type = 'application/octet-stream') => user(`/api/upload?name=${encodeURIComponent(name)}`, body, { 'Content-Type': type });

        const first = await upload('../scan.nii.gz', vol.subarray(0, 0));
        assert.equal(first.status, 400, 'empty files are rejected');
        assert.equal((await upload('scan.npy', vol, 'text/plain')).status, 415);
        assert.equal((await upload('notes.txt', Buffer.from('hello'))).status, 400, 'non-medical files are rejected');

        const a = await (await upload('../../scan.npy', vol)).json();
        const b = await (await upload('scan.npy', vol)).json();
        assert.match(a.path, /^uploader\/scan_\d{14}(_\d+)?\.npy$/, 'path stays inside the user folder');
        assert.notEqual(a.path, b.path, 'same-second uploads do not overwrite');
        assert.match((await (await upload('ct.nii.gz', vol)).json()).name, /^ct_\d{14}\.nii\.gz$/, 'double extensions are kept');
        assert.deepEqual(readdirSync(join(dir, 'data', 'uploader')).length, 3, 'rejected uploads leave no files');
        const prepared = await (await user('/api/volumes', { paths: [a.path] })).json();
        assert.deepEqual(prepared.volumes[0].dimensions, [4, 3, 2]);
    } finally { server.kill(); }
});
