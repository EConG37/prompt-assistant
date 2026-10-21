'use strict';
// Prints finding locations only, never the private values used for comparison.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const { defaultConfig } = require('../lib/config');
const root = path.join(__dirname, '..');
const version = require('../package.json').version;
function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error('Missing value for ' + name);
  return path.resolve(process.argv[index + 1]);
}
const release = path.join(root, 'dist', version);
const archive = option('--archive') || path.join(release, 'win-unpacked', 'resources', 'app.asar');
const includeHistory = process.argv.includes('--history');
const reportPath = option('--report') || path.join(root, 'output', 'privacy', includeHistory ? 'release-history-audit.json' : 'release-audit.json');
const findings = [];
const auditedContents = new Set();
const privateValues = new Set();
function remember(value) {
  if (typeof value === 'string' && value.length >= 8) privateValues.add(value);
}
function load(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const profile = process.env.RELEASE_AUDIT_PROFILE || path.join(process.env.APPDATA || '', '提示词助手');
const config = load(path.join(profile, 'config.json'));
const cache = load(path.join(profile, 'cache.json'));
if (config) {
  remember(config.baseToken); remember(config.baseUrl);
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(config.larkCliPath || '')) remember(config.larkCliPath);
  remember(config.storage?.mediaDir);
  for (const directory of config.skills?.roots || []) remember(directory);
  for (const item of Object.values(config.skills?.metadata || {})) {
    remember(item.alias); remember(item.note);
  }
  for (const item of Object.values(config.promptDeletions || {})) {
    remember(item.tableId); remember(item.recordId);
  }
  for (const source of config.sources || []) remember(source.tableId);
}
for (const item of [...(cache?.prompts || []), ...(cache?.phrases || [])]) {
  remember(item.recordId); remember(item.image?.fileToken); remember(item.video?.fileToken);
  // 比对私人长正文，短通用标签不参与，减少“默认分类”一类误报。
  if (typeof item.content === 'string' && item.content.length >= 24) remember(item.content);
  if (typeof item.title === 'string' && item.title.length >= 12) remember(item.title);
}
if (process.env.USERPROFILE) remember(process.env.USERPROFILE);
if (process.env.USERNAME) remember('Users\\' + process.env.USERNAME + '\\');
const checks = [
  ['github-credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{25,})\b/],
  ['api-key', /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['literal-secret', /(?:app_secret|appSecret|client_secret|clientSecret|access_token|refresh_token)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/],
  ['account-identifier', /\b(?:ou_|oc_)[a-f0-9]{24,}\b/],
];
function audit(scope, file, bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const contentKey = (file.startsWith('node_modules/') ? 'vendor:' : 'source:') + digest;
  if (auditedContents.has(contentKey)) return;
  auditedContents.add(contentKey);
  for (const value of privateValues) {
    if (bytes.includes(Buffer.from(value)) || bytes.includes(Buffer.from(value, 'utf16le'))) {
      findings.push({ scope, file, kind: 'matches-local-private-data' }); break;
    }
  }
  if (/\.(?:js|cjs|json|html|css|md|ps1|bat|vbs|txt)$/i.test(file) || !path.extname(file)) {
    const text = bytes.toString('utf8');
    for (const [kind, pattern] of checks) if (pattern.test(text)) findings.push({ scope, file, kind });
    // Retina 文件名（如 trayTemplate@2x.png）不是邮箱。
    const emails = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])
      .filter(email => !/@[2-9]x\.(?:png|jpe?g|webp|avif|svg)$/i.test(email));
    if (!file.startsWith('node_modules/') && emails.some(email => !/@(?:users\.noreply\.github\.com|example\.(?:com|org|net))$/i.test(email))) findings.push({ scope, file, kind: 'email-address' });
  }
  if (/\.png$/i.test(file) && bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) findings.push({ scope, file, kind: 'image-metadata-' + type });
      offset += 12 + size;
    }
  }
}
const sourceFiles = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean))];
for (const file of sourceFiles) {
  if (/(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|config\.json|cache\.json|stats\.json|skills\.json|credentials\.json|auth\.json)$|\.(?:pem|p12|pfx)$/i.test(file)) findings.push({ scope: 'source', file, kind: 'private-file-name' });
  audit('source', file, fs.readFileSync(path.join(root, file)));
}
const packagedFiles = asar.listPackage(archive).map(file => file.replace(/^[\\/]+/, '').replaceAll('\\', '/')).filter(file => asar.statFile(archive, path.normalize(file)).files === undefined);
for (const file of packagedFiles) {
  const vendorDependency = /^node_modules\/(?:js-yaml|argparse)\//.test(file);
  if (/^(?:cache|output|tools|\.git|\.agents)(?:[/\\]|$)/.test(file) || (file.startsWith('node_modules/') && !vendorDependency) || /(?:^|[/\\])(?:config|cache|stats|skills)\.json$/.test(file)) findings.push({ scope: 'package', file, kind: 'excluded-runtime-file' });
  audit('package', file, asar.extractFile(archive, path.normalize(file)));
}
const defaults = defaultConfig();
if (defaults.baseToken || defaults.baseUrl || defaults.sources.length || defaults.skills.roots !== null || defaults.skills.categories.length || Object.keys(defaults.skills.metadata).length) findings.push({ scope: 'defaults', file: 'lib/config.js', kind: 'nonempty-user-defaults' });
let gitCommitsChecked = 0, gitBlobsChecked = 0, gitTagObjectsChecked = 0;
if (includeHistory) {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  const objects = git(['rev-list', '--objects', '--all']).toString('utf8').trim().split('\n').filter(Boolean);
  // 批量读取历史对象，只在本机比较；报告不打印邮箱、正文或匹配到的私人值。
  const batch = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: objects.map(line => line.split(' ')[0]).join('\n') + '\n', maxBuffer: 128 * 1024 * 1024 });
  let offset = 0;
  for (const object of objects) {
    const newline = batch.indexOf(10, offset);
    const [oid, type, sizeText] = batch.toString('utf8', offset, newline).split(' ');
    const size = Number(sizeText), bytes = batch.subarray(newline + 1, newline + 1 + size);
    offset = newline + 1 + size + 1;
    if (type === 'commit' || type === 'tag') {
      if (type === 'commit') gitCommitsChecked++; else gitTagObjectsChecked++;
      const headers = bytes.toString('utf8').split('\n\n')[0];
      const identities = [...headers.matchAll(/^(?:author|committer|tagger) .*<([^>]+)>/gm)].map(match => match[1]);
      if (identities.some(email => !/@(?:users\.noreply\.github\.com|example\.(?:com|org|net))$/i.test(email))) findings.push({ scope: 'history', file: oid.slice(0, 12), kind: type === 'commit' ? 'nonpublic-commit-email' : 'nonpublic-tag-email' });
      audit('history', oid.slice(0, 12), bytes);
    } else if (type === 'blob') {
      gitBlobsChecked++;
      const file = object.includes(' ') ? object.slice(object.indexOf(' ') + 1) : oid;
      if (/(?:^|\/)(?:\.env(?:\..*)?|config\.json|cache\.json|stats\.json|skills\.json|credentials\.json|auth\.json|id_rsa|id_ed25519)$|\.(?:pem|p12|pfx)$/i.test(file) || /^(?:cache|output)\//.test(file)) findings.push({ scope: 'history', file, kind: 'private-file-name' });
      audit('history', file, bytes);
    }
  }
}
const installer = option('--artifact') || path.join(release, `提示词助手 Setup ${version}.exe`);
const extractedArchive = path.join(root, 'output', 'privacy', version, 'payload', 'resources', 'app.asar');
const installerPayloadVerified = fs.existsSync(extractedArchive) && fs.readFileSync(extractedArchive).equals(fs.readFileSync(archive));
if (fs.existsSync(extractedArchive) && !installerPayloadVerified) findings.push({ scope: 'installer', file: 'resources/app.asar', kind: 'extracted-payload-mismatch' });
const report = {
  version, checkedAt: new Date().toISOString(), sourceFiles: sourceFiles.length,
  packagedFiles: packagedFiles.length, localPrivateValueChecks: privateValues.size,
  installerSha256: crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),
  installerPayloadVerified, gitHistoryIncluded: includeHistory, gitCommitsChecked, gitBlobsChecked, gitTagObjectsChecked, findings, passed: findings.length === 0,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
