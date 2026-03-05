const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3000;

const upload = multer({ dest: os.tmpdir() });

app.use(express.static(__dirname));
app.use(express.json({ limit: '200mb' }));

// ─── Utility: resolve tool paths ────────────────────────────────────────────
const isWindows = process.platform === 'win32';

function getAdbPath() {
    return 'adb'; // Expected in system PATH
}

function getAapt2Path() {
    const ext = isWindows ? '.exe' : '';
    return path.join(__dirname, 'tools', `aapt2${ext}`);
}

// ─── ADB: Detect root manager ──────────────────────────────────────────────
app.get('/api/adb/root-manager', (req, res) => {
    const device = req.query.device;
    const adb = getAdbPath();
    const serialArg = device ? `-s ${device}` : '';

    // Check for KernelSU first, then Magisk
    exec(`"${adb}" ${serialArg} shell "su -c 'ksud -V 2>/dev/null'"`, { timeout: 5000 }, (err, ksuOut) => {
        if (!err && ksuOut && ksuOut.trim().startsWith('ksud')) {
            return res.json({ manager: 'kernelsu', version: ksuOut.trim() });
        }
        exec(`"${adb}" ${serialArg} shell "su -c 'magisk -v 2>/dev/null'"`, { timeout: 5000 }, (err2, magiskOut) => {
            if (!err2 && magiskOut && magiskOut.trim()) {
                return res.json({ manager: 'magisk', version: magiskOut.trim() });
            }
            res.json({ manager: 'unknown', version: null });
        });
    });
});

// ─── Parse APK via aapt2 ────────────────────────────────────────────────────
app.post('/api/parse-apk', upload.single('apk'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No APK file uploaded' });

    const apkPath = req.file.path;
    const aapt2Path = getAapt2Path();

    execFile(aapt2Path, ['dump', 'badging', apkPath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        fs.unlink(apkPath, () => { });

        if (err) {
            console.error('aapt2 error:', stderr || err.message);
            return res.status(500).json({ error: 'Failed to parse APK. Is it a valid APK file?' });
        }

        const result = parseAapt2Output(stdout);
        result.originalFileName = req.file.originalname;
        result.fileSize = req.file.size;
        res.json(result);
    });
});

// ─── Build Module ZIP ───────────────────────────────────────────────────────
app.post('/api/build-module', upload.single('apk'), (req, res) => {
    const config = JSON.parse(req.body.config || '{}');
    const apkFile = req.file;

    if (!apkFile) return res.status(400).json({ error: 'No APK file provided' });

    const { moduleId, appName, packageName, version, versionCode, author, description, permissions } = config;

    if (!packageName || !appName) {
        fs.unlink(apkFile.path, () => { });
        return res.status(400).json({ error: 'Package name and app name are required' });
    }

    const apkFileName = req.file.originalname || `${appName.replace(/\s+/g, '')}.apk`;

    const moduleProp = [
        `id=${moduleId || packageName}`,
        `name=${appName}`,
        `version=${version || '1.0'}`,
        `versionCode=${versionCode || 1}`,
        `author=${author || 'Unknown'}`,
        `description=${description || 'Privileged app module'}`,
    ].join('\n') + '\n';

    const customizeSh = [
        '#!/system/bin/sh',
        '',
        '# Priv-App Module Installer',
        'ui_print "- Installing privileged app module"',
        '',
        '# Set correct permissions for system overlay',
        'set_perm_recursive $MODPATH 0 0 0755 0644',
        'set_perm_recursive $MODPATH/system/priv-app 0 0 0755 0644',
        'set_perm_recursive $MODPATH/system/etc 0 0 0755 0644',
        '',
    ].join('\n');

    const permEntries = (permissions || []).map(p => `        <permission name="${p}"/>`).join('\n');
    const permissionsXml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<permissions>',
        `    <privapp-permissions package="${packageName}">`,
        permEntries,
        '    </privapp-permissions>',
        '</permissions>', ''
    ].join('\n');

    const zipFileName = `${appName.replace(/\s+/g, '')}Module.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
        console.error('Archive error:', err);
        fs.unlink(apkFile.path, () => { });
        if (!res.headersSent) res.status(500).json({ error: 'Failed to create ZIP' });
    });

    archive.pipe(res);
    archive.append(moduleProp, { name: 'module.prop' });
    archive.append(customizeSh, { name: 'customize.sh', mode: 0o755 });
    archive.append(permissionsXml, { name: `system/etc/permissions/privapp-permissions-${packageName}.xml` });
    archive.file(apkFile.path, { name: `system/priv-app/${packageName}/${apkFileName}` });
    archive.finalize().then(() => fs.unlink(apkFile.path, () => { }));
});

// ─── ADB: List connected devices ───────────────────────────────────────────
app.get('/api/adb/devices', (req, res) => {
    const adb = getAdbPath();
    exec(`"${adb}" devices -l`, { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) return res.json({ devices: [], error: 'ADB not found or not responding' });

        const lines = stdout.split('\n').slice(1).filter(l => l.trim() && !l.startsWith('*'));
        const devices = lines.map(line => {
            const parts = line.trim().split(/\s+/);
            const serial = parts[0];
            const status = parts[1]; // device, offline, unauthorized
            const props = {};
            parts.slice(2).forEach(p => {
                const [k, v] = p.split(':');
                if (k && v) props[k] = v;
            });
            return {
                serial,
                status,
                model: props.model || props.device || serial,
                product: props.product || '',
                transport: props.transport_id || ''
            };
        }).filter(d => d.serial);

        res.json({ devices });
    });
});

// ─── ADB: Push & Flash module ───────────────────────────────────────────────
app.post('/api/adb/flash', upload.single('apk'), (req, res) => {
    const config = JSON.parse(req.body.config || '{}');
    const apkFile = req.file;
    const deviceSerial = req.body.device;

    if (!apkFile || !config.packageName || !config.appName) {
        if (apkFile) fs.unlink(apkFile.path, () => { });
        return res.status(400).json({ error: 'Missing APK or config' });
    }

    const adb = getAdbPath();
    const apkFileName = `${config.appName.replace(/\s+/g, '')}.apk`;
    const tmpDir = path.join(os.tmpdir(), `priv_module_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Build module files locally
    const moduleProp = [
        `id=${config.moduleId || config.packageName}`,
        `name=${config.appName}`,
        `version=${config.version || '1.0'}`,
        `versionCode=${config.versionCode || 1}`,
        `author=${config.author || 'Unknown'}`,
        `description=${config.description || 'Privileged app module'}`,
    ].join('\n') + '\n';

    const customizeSh = [
        '#!/system/bin/sh',
        '',
        '# Priv-App Module Installer',
        'ui_print "- Installing privileged app module"',
        '',
        '# Set correct permissions for system overlay',
        'set_perm_recursive $MODPATH 0 0 0755 0644',
        'set_perm_recursive $MODPATH/system/priv-app 0 0 0755 0644',
        'set_perm_recursive $MODPATH/system/etc 0 0 0755 0644',
        '',
    ].join('\n');

    const permEntries = (config.permissions || []).map(p => `        <permission name="${p}"/>`).join('\n');
    const permissionsXml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<permissions>',
        `    <privapp-permissions package="${config.packageName}">`,
        permEntries,
        '    </privapp-permissions>',
        '</permissions>', ''
    ].join('\n');

    // Create the ZIP
    const zipPath = path.join(tmpDir, 'module.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
        // Push to device
        const serialArg = deviceSerial ? ['-s', deviceSerial] : [];
        const pushDest = '/data/local/tmp/priv_module.zip';

        execFile(adb, [...serialArg, 'push', zipPath, pushDest], { timeout: 30000 }, (err) => {
            if (err) {
                cleanup();
                return res.json({ success: false, error: `Push failed: ${err.message}` });
            }

            // Step 1: Uninstall any existing user-installed copy (so priv-app overlay takes priority)
            const uninstallCmd = `pm uninstall ${config.packageName}`;
            exec(`"${adb}" ${serialArg.join(' ')} shell ${uninstallCmd}`, { timeout: 10000 }, (uninstallErr, uninstallOut) => {
                const wasUninstalled = !uninstallErr && uninstallOut && uninstallOut.includes('Success');

                // Step 2: Install the module via the selected root manager
                const mode = config.installMode || 'magisk';
                let installCmd;
                if (mode === 'kernelsu') {
                    installCmd = `su -c "ksud module install ${pushDest}"`;
                } else {
                    installCmd = `su -c "magisk --install-module ${pushDest}"`;
                }
                const managerName = mode === 'kernelsu' ? 'KernelSU' : 'Magisk';

                exec(`"${adb}" ${serialArg.join(' ')} shell ${installCmd}`, { timeout: 30000 }, (err2, stdout2, stderr2) => {
                    cleanup();
                    const steps = [];
                    if (wasUninstalled) steps.push(`Uninstalled existing user copy of ${config.packageName}`);
                    steps.push(`Module pushed to ${pushDest}`);

                    if (err2) {
                        return res.json({
                            success: false,
                            pushed: true,
                            error: `Module pushed but auto-install failed. Install manually via ${managerName} app.`,
                            output: [
                                ...steps,
                                `Install error: ${stdout2 || stderr2 || err2.message}`
                            ].join('\n')
                        });
                    }
                    res.json({
                        success: true,
                        output: [
                            ...steps,
                            `Installed via ${managerName}`,
                            stdout2 || ''
                        ].join('\n'),
                        message: `Module installed via ${managerName}. Reboot to activate.`
                    });
                });
            });
        });
    });

    archive.on('error', (err) => {
        cleanup();
        res.status(500).json({ error: 'Failed to create ZIP' });
    });

    archive.pipe(output);
    archive.append(moduleProp, { name: 'module.prop' });
    archive.append(customizeSh, { name: 'customize.sh', mode: 0o755 });
    archive.append(permissionsXml, { name: `system/etc/permissions/privapp-permissions-${config.packageName}.xml` });
    archive.file(apkFile.path, { name: `system/priv-app/${config.packageName}/${apkFileName}` });
    archive.finalize();

    function cleanup() {
        try {
            fs.unlinkSync(apkFile.path);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) { }
    }
});

// ─── ADB: Fetch privileged permissions from device ──────────────────────────
app.get('/api/adb/permissions', (req, res) => {
    const device = req.query.device;
    const adb = getAdbPath();
    const serialArg = device ? `-s ${device}` : '';

    // Run: pm list permissions -f, then filter for privileged/signature protection levels
    const cmd = `"${adb}" ${serialArg} shell "pm list permissions -f"`;

    exec(cmd, { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
            console.error('Permission fetch error:', err.message);
            return res.json({ permissions: [], error: 'Failed to fetch permissions from device' });
        }

        // Parse the output: each permission block starts with "+ permission:" and has "protectionLevel:" 
        // We want permissions with privileged protection (protectionLevel contains "privileged" or hex flags 0x12, 0x22)
        const blocks = stdout.split('+ permission:');
        const privileged = [];

        for (const block of blocks) {
            if (!block.trim()) continue;
            const lines = block.trim().split('\n');
            const permName = lines[0].trim();

            // Check if any line contains protectionLevel with privileged indicators
            const protLine = lines.find(l => l.includes('protectionLevel:'));
            if (protLine) {
                const level = protLine.toLowerCase();
                if (level.includes('privileged') || level.includes('0x12') || level.includes('0x22') ||
                    level.includes('signature|privileged') || level.includes('signatureorphysical')) {
                    privileged.push(permName);
                }
            }
        }

        privileged.sort();
        res.json({ permissions: privileged, count: privileged.length });
    });
});

// ─── ADB: Execute shell command ─────────────────────────────────────────────
app.post('/api/adb/shell', (req, res) => {
    const { command, device } = req.body;
    if (!command) return res.status(400).json({ error: 'No command provided' });

    const adb = getAdbPath();
    const serialArg = device ? `-s ${device}` : '';

    exec(`"${adb}" ${serialArg} shell ${command}`, { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) return res.json({ output: stderr || err.message, error: true });
        res.json({ output: stdout || '(no output)', error: false });
    });
});

// ─── Parse aapt2 output ─────────────────────────────────────────────────────
function parseAapt2Output(output) {
    const result = { packageName: '', appName: '', versionName: '', versionCode: '', minSdk: '', targetSdk: '', permissions: [] };

    const pkgMatch = output.match(/package:\s+name='([^']+)'\s+versionCode='([^']+)'\s+versionName='([^']*)'/);
    if (pkgMatch) { result.packageName = pkgMatch[1]; result.versionCode = pkgMatch[2]; result.versionName = pkgMatch[3]; }

    const labelMatch = output.match(/application-label(?:-[a-z]{2}(?:-[A-Z]{2})?)?:'([^']+)'/);
    if (labelMatch) result.appName = labelMatch[1];

    const minSdkMatch = output.match(/sdkVersion:'(\d+)'/);
    if (minSdkMatch) result.minSdk = minSdkMatch[1];

    const targetSdkMatch = output.match(/targetSdkVersion:'(\d+)'/);
    if (targetSdkMatch) result.targetSdk = targetSdkMatch[1];

    const permRegex = /uses-permission:\s+name='([^']+)'/g;
    let m;
    while ((m = permRegex.exec(output)) !== null) result.permissions.push(m[1]);

    return result;
}

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  ✅ Priv-App Module Generator running at:`);
    console.log(`     http://localhost:${PORT}\n`);
});
