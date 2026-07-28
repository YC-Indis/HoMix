import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { notarize } from '@electron/notarize';
import { sign } from '@electron/osx-sign';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const inputArgument = process.argv[2];
const outputArgument = process.argv[3];
const identity = process.env.HOMIX_SIGN_IDENTITY;
const keychainProfile = process.env.HOMIX_NOTARY_PROFILE;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, argumentsList, options = {}) {
  process.stdout.write(`> ${path.basename(command)} ${argumentsList.join(' ')}\n`);
  execFileSync(command, argumentsList, { stdio: 'inherit', ...options });
}

function inspectSignature(app) {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8' });
  const details = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0) fail(`无法读取代码签名：\n${details}`);
  if (!/flags=.*\bruntime\b/i.test(details)) fail('代码签名没有启用 Hardened Runtime，停止发布。');
  process.stdout.write(details);
}

if (process.platform !== 'darwin') fail('正式签名与 Apple 公证必须在安装了 Xcode 的 macOS 上运行。');
if (!inputArgument) fail('用法：pnpm release -- <unsigned.zip> [output.zip]');
if (!identity?.startsWith('Developer ID Application:')) {
  fail('请把 HOMIX_SIGN_IDENTITY 设置为完整的 Developer ID Application 证书名称。');
}
if (!keychainProfile) {
  fail('请先用 xcrun notarytool store-credentials 保存凭据，再设置 HOMIX_NOTARY_PROFILE。');
}

const inputArchive = path.resolve(projectRoot, inputArgument);
if (!fs.existsSync(inputArchive)) fail(`找不到未签名构建：${inputArchive}`);

const defaultOutputName = path.basename(inputArchive).includes('-unsigned.zip')
  ? path.basename(inputArchive).replace('-unsigned.zip', '.zip')
  : `${path.basename(inputArchive, '.zip')}-signed-notarized.zip`;
const outputArchive = outputArgument
  ? path.resolve(projectRoot, outputArgument)
  : path.join(path.dirname(inputArchive), defaultOutputName);
if (path.resolve(outputArchive) === path.resolve(inputArchive)) fail('发行包不能覆盖未签名构建。');
if (fs.existsSync(outputArchive)) fail(`发行包已存在，请先确认并移走：${outputArchive}`);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'homix-release-'));
const appPath = path.join(temporaryRoot, 'HoMix.app');

try {
  run('/usr/bin/xcrun', ['--find', 'notarytool']);
  run('/usr/bin/ditto', ['-x', '-k', inputArchive, temporaryRoot]);
  if (!fs.existsSync(appPath)) fail('未签名构建中没有 HoMix.app。');

  const bundledBinaries = [
    path.join(appPath, 'Contents', 'Resources', 'app', 'tools', 'ffmpeg'),
    path.join(appPath, 'Contents', 'Resources', 'app', 'tools', 'ffprobe'),
  ];
  for (const binary of bundledBinaries) {
    if (!fs.existsSync(binary)) fail(`缺少需要签名的运行文件：${binary}`);
  }

  process.stdout.write('正在使用 Developer ID 签名应用和所有内嵌可执行文件…\n');
  await sign({
    app: appPath,
    platform: 'darwin',
    identity,
    binaries: bundledBinaries,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
  });

  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  inspectSignature(appPath);

  process.stdout.write('正在提交 Apple 公证；成功后会自动把票据装订到应用…\n');
  await notarize({ appPath, keychainProfile });

  run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, outputArchive]);

  process.stdout.write(`\n发行包已通过签名、公证和 Gatekeeper 验证：\n${outputArchive}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
