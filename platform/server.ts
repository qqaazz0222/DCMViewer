import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { VolumeServer } from '../vscode-extension/src/volumeServer';
import { encodeFile } from '../vscode-extension/src/transfer';
import { hasDicomPreamble, hasMedicalExtension } from '../src/medicalFileDetection';
import type { Axis } from '../src/types';

if (Boolean(process.env.TLS_CERT) !== Boolean(process.env.TLS_KEY)) { console.error('Set both TLS_CERT and TLS_KEY to enable HTTPS.'); process.exit(1); }
// ponytail: certificates load once at startup; restart after renewal.
const TLS = process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) } : undefined;
const PORT = Number(process.env.PORT ?? 8080);
// Default: sample volumes from `node platform/generate-samples.cjs`.
const DATA_ROOT = resolve(process.env.DATA_ROOT ?? join(__dirname, '..', 'data'));
const HOST = process.env.HOST ?? '0.0.0.0';
const STATE_DIR = resolve(process.env.STATE_DIR ?? join(__dirname, '..', 'state'));
const SESSION_MS = 12 * 3600_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 20_000;
const STATIC_DIR = resolve(__dirname, '..', 'dist');
// Sign-in and admin pages are plain HTML beside the server bundle's parent folder.
const PAGES_DIR = resolve(__dirname, '..');
const PAGE_ASSETS: Record<string, string> = {
    '/pages.css': 'pages.css', '/pages-theme.js': 'pages-theme.js', '/icon.png': 'assets/icon.png', '/favicon.ico': 'assets/icon.ico',
};
const volumes = new VolumeServer(Number(process.env.VOLUME_MEMORY_MIB ?? 2048) * 2 ** 20, true);

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

// ---- Accounts and platform settings: JSON files in STATE_DIR, written atomically.
type User = {
    username: string; salt: string; hash: string; createdAt: string;
    role: 'admin' | 'user'; status: 'pending' | 'approved' | 'rejected' | 'disabled';
    mustChangePassword?: boolean; reviewedAt?: string;
};
type Settings = { signupEnabled: boolean; inviteCode: string; dataRoot?: string };
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const usersFile = join(STATE_DIR, 'users.json');
const settingsFile = join(STATE_DIR, 'settings.json');
function writeJsonAtomic(file: string, value: unknown) {
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
}
// Accounts created before approval existed were already usable, so they load as approved users.
const users = new Map<string, User>(existsSync(usersFile)
    ? (JSON.parse(readFileSync(usersFile, 'utf8')) as Partial<User>[]).map(user => [user.username!, { role: 'user', status: 'approved', ...user } as User]) : []);
const saveUsers = () => writeJsonAtomic(usersFile, [...users.values()]);
const settings: Settings = { signupEnabled: true, inviteCode: process.env.INVITE_CODE ?? '',
    ...(existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) as Partial<Settings> : {}) };
const saveSettings = () => writeJsonAtomic(settingsFile, settings);

const hashPassword = promisify(scrypt) as (password: string, salt: string, length: number) => Promise<Buffer>;
const DUMMY_SALT = randomBytes(16).toString('hex');
async function setPassword(user: User, password: string) {
    user.salt = randomBytes(16).toString('hex');
    user.hash = (await hashPassword(password, user.salt, 64)).toString('hex');
}
async function passwordMatches(user: User | undefined, password: string) {
    // Hash even for unknown users so response time does not reveal accounts.
    const hash = await hashPassword(password, user?.salt ?? DUMMY_SALT, 64);
    return Boolean(user) && timingSafeEqual(hash, Buffer.from(user!.hash, 'hex'));
}
function validatePassword(password: unknown): asserts password is string {
    if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new HttpError(400, 'Password must be 8-256 characters.');
}
async function seedAdmin() {
    if ([...users.values()].some(user => user.role === 'admin')) return;
    if (users.has('admin')) { console.error("A non-admin account named 'admin' exists. Remove it from users.json, then restart."); process.exit(1); }
    const admin: User = { username: 'admin', salt: '', hash: '', createdAt: new Date().toISOString(), role: 'admin', status: 'approved', mustChangePassword: true };
    await setPassword(admin, 'admin');
    users.set('admin', admin);
    saveUsers();
    console.log('Created default administrator admin / admin. The password must be changed at first sign-in.');
}

// ponytail: sessions live in memory, a restart signs everyone out. Move to a store if that matters.
const sessions = new Map<string, { username: string; expires: number }>();
const failures = new Map<string, { count: number; until: number }>();
setInterval(() => {
    const now = Date.now();
    for (const [id, item] of sessions) if (item.expires < now) sessions.delete(id);
    for (const [key, item] of failures) if (item.until < now) failures.delete(key);
}, 600_000).unref();
const endSessions = (username: string, keep?: string) => {
    for (const [id, item] of sessions) if (item.username === username && id !== keep) sessions.delete(id);
};

function cookie(req: IncomingMessage, name: string) {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key === name) return value.join('=');
    }
}
// The account is re-read per request, so disabling or deleting it takes effect immediately.
function currentSession(req: IncomingMessage) {
    const id = cookie(req, 'sid');
    const item = id ? sessions.get(id) : undefined;
    if (!id || !item) return;
    const user = users.get(item.username);
    if (item.expires < Date.now() || user?.status !== 'approved') { sessions.delete(id); return; }
    item.expires = Date.now() + SESSION_MS;
    return { id, user };
}
function startSession(req: IncomingMessage, res: ServerResponse, username: string) {
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, { username, expires: Date.now() + SESSION_MS });
    const secure = Boolean(TLS) || process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `sid=${id}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
}
const home = (user: User) => user.mustChangePassword ? '/change-password' : user.role === 'admin' ? '/admin' : '/';

async function credentials(req: IncomingMessage) {
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    return { body, username, password };
}
async function signup(req: IncomingMessage, res: ServerResponse) {
    if (!settings.signupEnabled) throw new HttpError(403, 'Registration is closed. Contact the administrator.');
    const { body, username, password } = await credentials(req);
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, 'Username must be 3-32 characters: letters, digits, _ . -');
    validatePassword(password);
    if (settings.inviteCode && body.invite !== settings.inviteCode) throw new HttpError(403, 'Invalid invite code.');
    if (users.has(username)) throw new HttpError(409, 'Username is already taken.');
    const user: User = { username, salt: '', hash: '', createdAt: new Date().toISOString(), role: 'user', status: 'pending' };
    await setPassword(user, password);
    if (users.has(username)) throw new HttpError(409, 'Username is already taken.');
    users.set(username, user);
    saveUsers();
    json(res, 202, { message: 'Account created. You can sign in once an administrator approves it.' });
}
const BLOCKED: Record<string, string> = {
    pending: 'Your account is awaiting administrator approval.',
    rejected: 'Your registration was not approved. Contact the administrator.',
    disabled: 'This account is disabled. Contact the administrator.',
};
async function login(req: IncomingMessage, res: ServerResponse) {
    const { username, password } = await credentials(req);
    const key = `${req.socket.remoteAddress}|${username}`;
    const failure = failures.get(key);
    if (failure && failure.count >= 10 && failure.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const user = users.get(username);
    if (!await passwordMatches(user, password)) {
        if (!failure || failure.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + 900_000 });
        else failure.count++;
        throw new HttpError(401, 'Incorrect username or password.');
    }
    failures.delete(key);
    // Status is revealed only after the correct password.
    if (user!.status !== 'approved') throw new HttpError(403, BLOCKED[user!.status]);
    startSession(req, res, username);
    json(res, 200, { username, role: user!.role, next: home(user!) });
}
async function changePassword(req: IncomingMessage, res: ServerResponse, session: { id: string; user: User }) {
    const body = await readJson(req);
    if (!await passwordMatches(session.user, typeof body.current === 'string' ? body.current : '')) throw new HttpError(401, 'Current password is incorrect.');
    validatePassword(body.password);
    if (body.password === body.current) throw new HttpError(400, 'Choose a password different from the current one.');
    await setPassword(session.user, body.password);
    delete session.user.mustChangePassword;
    saveUsers();
    endSessions(session.user.username, session.id);
    json(res, 200, { next: home(session.user) });
}

// ---- Administration.
const publicUser = ({ username, role, status, createdAt, reviewedAt }: User) => ({ username, role, status, createdAt, reviewedAt });
function userAction(body: Record<string, unknown>) {
    const target = users.get(String(body.username));
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'admin') throw new HttpError(400, 'The administrator account cannot be changed here.');
    const next = { approve: 'approved', enable: 'approved', reject: 'rejected', disable: 'disabled', delete: 'deleted' }[String(body.action)];
    if (!next) throw new HttpError(400, 'Unknown action.');
    if (next === 'deleted') users.delete(target.username);
    else { target.status = next as User['status']; target.reviewedAt = new Date().toISOString(); }
    saveUsers();
    if (next !== 'approved') endSessions(target.username);
}
async function updateSettings(body: Record<string, unknown>) {
    // Validate everything first so a bad field never leaves settings half-applied.
    if ('signupEnabled' in body && typeof body.signupEnabled !== 'boolean') throw new HttpError(400, 'signupEnabled must be true or false.');
    if ('inviteCode' in body && (typeof body.inviteCode !== 'string' || body.inviteCode.length > 128)) throw new HttpError(400, 'Invite code must be at most 128 characters.');
    let root: string | undefined;
    if ('dataRoot' in body) {
        if (typeof body.dataRoot !== 'string' || !body.dataRoot.trim()) throw new HttpError(400, 'Enter a data directory.');
        root = await realpath(resolve(body.dataRoot.trim())).catch(() => { throw new HttpError(400, 'The data directory does not exist.'); });
        if (!(await stat(root)).isDirectory()) throw new HttpError(400, 'The data directory is not a folder.');
    }
    if (typeof body.signupEnabled === 'boolean') settings.signupEnabled = body.signupEnabled;
    if (typeof body.inviteCode === 'string') settings.inviteCode = body.inviteCode.trim();
    if (root) {
        // Open volumes belong to the old directory.
        if (root !== dataRoot) volumes.clear();
        dataRoot = settings.dataRoot = root;
    }
    saveSettings();
}
const adminSettings = () => ({ signupEnabled: settings.signupEnabled, inviteCode: settings.inviteCode, dataRoot, activeSessions: sessions.size });

// ---- Data directory: every client path is relative and must resolve inside DATA_ROOT.
let dataRoot = '';
async function resolveData(path: unknown) {
    if (typeof path !== 'string' || path.includes('\0')) throw new HttpError(400, 'Invalid path.');
    const full = await realpath(resolve(dataRoot, path)).catch(() => { throw new HttpError(404, 'File not found.'); });
    if (full !== dataRoot && !full.startsWith(dataRoot + sep)) throw new HttpError(403, 'Path is outside the data directory.');
    return full;
}
const toClient = (full: string) => relative(dataRoot, full).split(sep).join('/');
async function isMedical(full: string, name: string) {
    if (hasMedicalExtension(name)) return true;
    const handle = await open(full, 'r');
    try {
        const head = new Uint8Array(132);
        await handle.read(head, 0, 132, 0);
        return hasDicomPreamble(head);
    } finally { await handle.close(); }
}
async function listDirectory(path: unknown) {
    const dir = await resolveData(path ?? '');
    if (!(await stat(dir)).isDirectory()) throw new HttpError(400, 'Not a directory.');
    const entries: Array<{ name: string; path: string; type: 'dir' | 'file'; size?: number }> = [];
    // ponytail: sniffs every extensionless file per listing; cache headers if huge folders are slow.
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) entries.push({ name: entry.name, path: toClient(full), type: 'dir' });
        else if (entry.isFile() && await isMedical(full, entry.name).catch(() => false)) {
            entries.push({ name: entry.name, path: toClient(full), type: 'file', size: (await stat(full)).size });
        }
    }
    entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1);
    return { path: toClient(dir), entries };
}
async function collect(paths: unknown) {
    if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Select at least one file or folder.');
    const files = new Map<string, { path: string; name: string; size: number; mtime: number }>();
    async function visit(full: string) {
        const info = await stat(full);
        if (info.isDirectory()) {
            for (const entry of await readdir(full, { withFileTypes: true })) {
                if (!entry.name.startsWith('.') && !entry.isSymbolicLink()) await visit(join(full, entry.name));
            }
        } else if (info.isFile() && !files.has(full) && await isMedical(full, full.slice(full.lastIndexOf(sep) + 1)).catch(() => false)) {
            if (files.size >= MAX_FILES) throw new HttpError(413, `Selection has more than ${MAX_FILES} files. Select a smaller folder.`);
            files.set(full, { path: toClient(full), name: full.slice(full.lastIndexOf(sep) + 1), size: info.size, mtime: info.mtimeMs });
        }
    }
    for (const path of paths) await visit(await resolveData(path));
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
let prepareQueue: Promise<unknown> = Promise.resolve();
async function prepare(paths: unknown) {
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FILES) throw new HttpError(400, 'Invalid file selection.');
    const fulls = await Promise.all(paths.map(resolveData));
    const infos = await Promise.all(fulls.map(full => stat(full)));
    if (infos.some(info => !info.isFile())) throw new HttpError(400, 'Only files can be prepared.');
    if (infos.reduce((n, info) => n + info.size, 0) > MAX_SOURCE_BYTES) throw new HttpError(413, 'Source files exceed the 512 MiB preparation limit.');
    // Serialize preparation to bound server memory and duplicate parsing.
    const task = prepareQueue.then(async () => {
        const files = [], versions = [], errors: string[] = [];
        for (const [index, full] of fulls.entries()) {
            const path = toClient(full), name = path.split('/').pop()!;
            try {
                const bytes = await readFile(full);
                const after = await stat(full);
                if (after.mtimeMs !== infos[index].mtimeMs || after.size !== bytes.byteLength) throw new Error('The file changed while reading. Select it again.');
                files.push({ path, name, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
                versions.push({ path, size: after.size, mtime: after.mtimeMs });
            } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        const prepared = await volumes.prepare(files, versions);
        return { volumes: prepared.volumes, errors: [...errors, ...prepared.errors] };
    });
    prepareQueue = task.catch(() => {});
    return task;
}
async function sendSlice(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, whole = false) {
    let bytes: Uint8Array;
    try {
        const token = query.get('token') ?? '';
        bytes = whole ? volumes.volume(token) : volumes.slice(token, query.get('axis') as Axis, Number(query.get('slice')));
    } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)); }
    const encoded = await encodeFile(bytes, 'slice.raw', /\bgzip\b/.test(String(req.headers['accept-encoding'])));
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        ...(encoded.encoding === 'gzip' ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(Buffer.from(encoded.bytes));
}

// ---- HTTP plumbing.
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    // JSON-only POSTs plus SameSite=Strict cookies block cross-site form submissions.
    if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new HttpError(413, 'Request is too large.');
        chunks.push(chunk);
    }
    try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    } catch { /* fall through */ }
    throw new HttpError(400, 'Invalid JSON.');
}
function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}
const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};
async function sendPage(res: ServerResponse, name: string) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(await readFile(join(PAGES_DIR, name)));
}
async function sendStatic(res: ServerResponse, pathname: string) {
    const file = resolve(STATIC_DIR, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
    if (!file.startsWith(STATIC_DIR + sep)) throw new HttpError(404, 'Not found.');
    const body = await readFile(file).catch(() => { throw new HttpError(404, 'Not found.'); });
    res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (TLS) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = `${req.method} ${url.pathname}`;
        const redirect = (location: string) => { res.writeHead(302, { Location: location }); res.end(); };
        if (req.method === 'GET' && PAGE_ASSETS[url.pathname]) {
            res.writeHead(200, { 'Content-Type': TYPES[extname(url.pathname)], 'Cache-Control': 'no-cache' });
            res.end(await readFile(join(PAGES_DIR, PAGE_ASSETS[url.pathname])));
            return;
        }
        if (route === 'GET /api/auth-config') return json(res, 200, { inviteRequired: Boolean(settings.inviteCode), signupEnabled: settings.signupEnabled });
        if (route === 'POST /api/signup') return await signup(req, res);
        if (route === 'POST /api/login') return await login(req, res);
        const session = currentSession(req);
        if (route === 'GET /login') return session ? redirect(home(session.user)) : await sendPage(res, 'login.html');
        if (!session) return url.pathname.startsWith('/api/') ? json(res, 401, { error: 'Sign in required.' }) : redirect('/login');
        const { user } = session;
        switch (route) {
            case 'POST /api/logout':
                sessions.delete(session.id);
                res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
                return json(res, 200, {});
            case 'GET /api/me': return json(res, 200, { username: user.username, role: user.role, mustChangePassword: Boolean(user.mustChangePassword) });
            case 'POST /api/change-password': return await changePassword(req, res, session);
            case 'GET /change-password': return await sendPage(res, 'login.html');
        }
        const deny = (message: string, location: string) => url.pathname.startsWith('/api/') ? json(res, 403, { error: message }) : redirect(location);
        if (user.mustChangePassword) return deny('Change your password to continue.', '/change-password');
        if (user.role === 'admin') {
            switch (route) {
                case 'GET /admin': return await sendPage(res, 'admin.html');
                case 'GET /api/admin/users': return json(res, 200, [...users.values()].map(publicUser));
                case 'POST /api/admin/users': userAction(await readJson(req)); return json(res, 200, [...users.values()].map(publicUser));
                case 'GET /api/admin/settings': return json(res, 200, adminSettings());
                case 'POST /api/admin/settings': await updateSettings(await readJson(req)); return json(res, 200, adminSettings());
            }
            // Administrators manage the platform; viewing images needs a user account.
            return deny('Administrator accounts manage the platform and cannot open images. Sign in with a user account.', '/admin');
        }
        if (url.pathname === '/admin' || url.pathname.startsWith('/api/admin/')) return deny('Administrator access required.', '/');
        switch (route) {
            case 'GET /api/files': return json(res, 200, await listDirectory(url.searchParams.get('path')));
            case 'POST /api/collect': return json(res, 200, await collect((await readJson(req)).paths));
            case 'POST /api/volumes': return json(res, 200, await prepare((await readJson(req)).paths));
            case 'GET /api/slice': return await sendSlice(req, res, url.searchParams);
            case 'GET /api/volume': return await sendSlice(req, res, url.searchParams, true);
        }
        if (req.method !== 'GET' || url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
        res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'");
        await sendStatic(res, url.pathname);
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error(error);
        if (!res.headersSent) json(res, status, { error: status === 500 ? 'Internal server error.' : (error as Error).message });
        else res.destroy();
    }
}
const server = TLS ? createHttpsServer(TLS, handle) : createServer(handle);

// An administrator's saved data directory wins over DATA_ROOT.
const initialRoot = settings.dataRoot ?? DATA_ROOT;
void seedAdmin().then(() => realpath(initialRoot)).catch(() => {
    console.error(`Data directory does not exist: ${initialRoot}${process.env.DATA_ROOT || settings.dataRoot ? '' : '. Run npm run samples:web to create sample volumes.'}`); process.exit(1);
}).then(root => {
    dataRoot = root;
    server.listen(PORT, HOST, () => {
        const address = server.address();
        console.log(`DCMViewer platform listening on ${TLS ? 'https' : 'http'}://${HOST}:${typeof address === 'object' && address ? address.port : PORT} (data: ${dataRoot})`);
    });
});
