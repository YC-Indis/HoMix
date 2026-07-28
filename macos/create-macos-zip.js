const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [electronZipArgument, stageArgument, outputArgument, version = '0.20.5'] = process.argv.slice(2);
if (!electronZipArgument || !stageArgument || !outputArgument) {
  console.error('Usage: node create-macos-zip.js <electron.zip> <stage> <output.zip> [version]');
  process.exit(2);
}

const electronZip = path.resolve(electronZipArgument);
const stage = path.resolve(stageArgument);
const output = path.resolve(outputArgument);
const appRoot = 'HoMix.app';

function isMachO(file) {
  const descriptor = fs.openSync(file, 'r');
  const header = Buffer.alloc(4);
  try { fs.readSync(descriptor, header, 0, 4, 0); } finally { fs.closeSync(descriptor); }
  return ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(header.toString('hex'));
}

function plistValue(xml, key, value) {
  const pattern = new RegExp(`(<key>${key}<\\/key>\\s*<string>)[^<]*(<\\/string>)`);
  return xml.replace(pattern, `$1${value}$2`);
}

function rebrandPlist(buffer) {
  let xml = buffer.toString('utf8');
  xml = xml.replace(/\s*<key>ElectronAsarIntegrity<\/key>\s*<dict>[\s\S]*?<\/dict>\s*<\/dict>/, '');
  xml = plistValue(xml, 'CFBundleDisplayName', 'HoMix');
  xml = plistValue(xml, 'CFBundleExecutable', 'HoMix');
  xml = plistValue(xml, 'CFBundleIdentifier', 'com.homix.desktop');
  xml = plistValue(xml, 'CFBundleName', 'HoMix');
  xml = plistValue(xml, 'CFBundleShortVersionString', version);
  xml = plistValue(xml, 'CFBundleVersion', version);
  xml = plistValue(xml, 'LSApplicationCategoryType', 'public.app-category.video');
  return Buffer.from(xml, 'utf8');
}

function dosDateTime(date, time) {
  return new Date(
    ((date >> 9) & 0x7f) + 1980,
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

function readExactly(descriptor, length, position) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(descriptor, buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('Electron ZIP 文件不完整');
  return buffer;
}

function electronEntries(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const tailLength = Math.min(size, 65557);
    const tail = readExactly(descriptor, tailLength, size - tailLength);
    let endOffset = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
    }
    if (endOffset < 0) throw new Error('找不到 Electron ZIP 中央目录');
    const entryCount = tail.readUInt16LE(endOffset + 10);
    const directorySize = tail.readUInt32LE(endOffset + 12);
    const directoryOffset = tail.readUInt32LE(endOffset + 16);
    if (entryCount === 0xffff || directoryOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 Electron 包');
    const directory = readExactly(descriptor, directorySize, directoryOffset);
    const entries = [];
    let offset = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('Electron ZIP 中央目录损坏');
      const flags = directory.readUInt16LE(offset + 8);
      const method = directory.readUInt16LE(offset + 10);
      const modifiedTime = directory.readUInt16LE(offset + 12);
      const modifiedDate = directory.readUInt16LE(offset + 14);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const externalAttributes = directory.readUInt32LE(offset + 38);
      const localOffset = directory.readUInt32LE(offset + 42);
      const nameBuffer = directory.subarray(offset + 46, offset + 46 + nameLength);
      const fileName = nameBuffer.toString(flags & 0x800 ? 'utf8' : 'latin1');
      const localHeader = readExactly(descriptor, 30, localOffset);
      if (localHeader.readUInt32LE(0) !== 0x04034b50) throw new Error(`Electron ZIP 本地文件头损坏：${fileName}`);
      const dataOffset = localOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
      entries.push({ fileName, method, compressedSize, dataOffset, externalAttributes, date: dosDateTime(modifiedDate, modifiedTime) });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally { fs.closeSync(descriptor); }
}

function entryStream(entry) {
  if (!entry.compressedSize) return null;
  const source = fs.createReadStream(electronZip, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1 });
  if (entry.method === 0) return source;
  if (entry.method === 8) return source.pipe(zlib.createInflateRaw());
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`);
}

function readEntry(entry) {
  return new Promise((resolve, reject) => {
    const stream = entryStream(entry);
    if (!stream) return resolve(Buffer.alloc(0));
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function addElectron(archive) {
  for (const entry of electronEntries(electronZip)) {
    const sourceName = entry.fileName;
    if (sourceName.endsWith('/') || sourceName === 'Electron.app/Contents/Resources/default_app.asar') continue;
    if (sourceName.startsWith('Electron.app/Contents/_CodeSignature/') || sourceName === 'Electron.app/Contents/CodeResources') continue;
    let targetName = sourceName.replace(/^Electron\.app/, appRoot);
    if (targetName === `${appRoot}/Contents/MacOS/Electron`) targetName = `${appRoot}/Contents/MacOS/HoMix`;
    const mode = (entry.externalAttributes >>> 16) & 0xffff;
    const type = mode & 0o170000;
    if (type === 0o120000) {
      archive.symlink(targetName, (await readEntry(entry)).toString('utf8'), mode & 0o777 || 0o777);
    } else if (sourceName === 'Electron.app/Contents/MacOS/Electron') {
      archive.append(await readEntry(entry), { name: targetName, mode: 0o755, date: entry.date });
    } else if (sourceName === 'Electron.app/Contents/Info.plist') {
      archive.append(rebrandPlist(await readEntry(entry)), { name: targetName, mode: 0o644, date: entry.date });
    } else {
      await new Promise((resolve, reject) => {
        const stream = entryStream(entry);
        if (!stream) {
          archive.append(Buffer.alloc(0), { name: targetName, mode: mode & 0o777 || 0o644, date: entry.date });
          return resolve();
        }
        stream.on('error', reject);
        stream.on('end', resolve);
        archive.append(stream, { name: targetName, mode: mode & 0o777 || 0o644, date: entry.date });
      });
    }
  }
}

function addStage(archive, directory, relative = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    const targetName = path.posix.join(appRoot, 'Contents', 'Resources', 'app', relativePath);
    const stat = fs.lstatSync(fullPath);
    if (stat.isDirectory()) addStage(archive, fullPath, path.join(relative, entry.name));
    else if (stat.isFile()) {
      const executable = isMachO(fullPath) || /\/tools\/(ffmpeg|ffprobe)$/.test(targetName);
      archive.file(fullPath, { name: targetName, mode: executable ? 0o755 : 0o644, date: stat.mtime });
    }
  }
}

async function main() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stream = fs.createWriteStream(output);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const completed = new Promise((resolve, reject) => {
    stream.on('close', resolve);
    stream.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (error) => error.code === 'ENOENT' ? console.warn(error.message) : reject(error));
  });
  archive.pipe(stream);
  await addElectron(archive);
  addStage(archive, stage);
  const readme = path.join(stage, 'MACOS_README.txt');
  if (fs.existsSync(readme)) archive.file(readme, { name: '安装说明.txt', mode: 0o644 });
  const firstRun = path.join(stage, 'MACOS_FIRST_RUN.command');
  if (fs.existsSync(firstRun)) archive.file(firstRun, { name: '先运行这个.command', mode: 0o755 });
  await archive.finalize();
  await completed;
  console.log(`${output} (${archive.pointer()} bytes)`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
