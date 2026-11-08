#!/usr/bin/env node
// 鱼鱼的耳朵 · 回滚工具
// 规矩：一次只改一样；改之前存一份，改坏了立刻回来。
//
// 用法（在这个目录下）：
//   node rollback.mjs snap "改了什么"      存一份快照
//   node rollback.mjs list                 看都有哪些快照
//   node rollback.mjs back                 回到最近一份
//   node rollback.mjs back 3               回到第 3 份
//   node rollback.mjs diff 3               看第 3 份跟现在差在哪
//   node rollback.mjs check                语法自检（node --check）
//
// 回滚前会自动把当前状态再存一份，所以回滚本身也能退回来。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(ROOT, '.rollback');
const HOME = process.env.USERPROFILE || process.env.HOME || '';

// 要跟着回滚走的东西：插件源码 + 测试口径 + 那个唯一的配置
const TARGETS = [
  { src: path.join(ROOT, 'dsh-hear', 'index.js'), rel: 'dsh-hear/index.js' },
  { src: path.join(ROOT, 'dsh-hear', 'client.js'), rel: 'dsh-hear/client.js' },
  { src: path.join(ROOT, 'dsh-hear', 'package.json'), rel: 'dsh-hear/package.json' },
  { src: path.join(ROOT, '测试音频', '测试记录.md'), rel: '测试音频/测试记录.md' },
  { src: path.join(ROOT, '测试音频', '预期.md'), rel: '测试音频/预期.md' },
  { src: path.join(HOME, '.dsh', 'hear', 'config.json'), rel: 'external/hear-config.json' },
];

const pad = (n) => String(n).padStart(2, '0');
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

function snapDirs() {
  if (!fs.existsSync(STORE)) return [];
  return fs.readdirSync(STORE)
    .filter((n) => fs.existsSync(path.join(STORE, n, 'manifest.json')))
    .sort();
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

function snap(note) {
  const id = stamp();
  let dir = path.join(STORE, id);
  let i = 2;
  while (fs.existsSync(dir)) dir = path.join(STORE, `${id}-${i++}`);
  fs.mkdirSync(dir, { recursive: true });

  const files = [];
  const missing = [];
  for (const t of TARGETS) {
    if (!fs.existsSync(t.src)) {
      missing.push(t.rel);
      continue;
    }
    const dst = path.join(dir, t.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(t.src, dst);
    files.push({ rel: t.rel, bytes: fs.statSync(t.src).size });
  }

  const manifest = { id: path.basename(dir), at: new Date().toISOString(), note: note || '', files, missing };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`存好了：第 ${snapDirs().length} 份  ${manifest.id}`);
  console.log(`  ${files.length} 个文件  ${files.reduce((s, f) => s + f.bytes, 0)} 字节`);
  if (missing.length) console.log(`  没找到（跳过）：${missing.join('、')}`);
  return manifest;
}

function list() {
  const dirs = snapDirs();
  if (!dirs.length) {
    console.log('还没有快照。改东西之前先：node rollback.mjs snap "说明"');
    return;
  }
  dirs.forEach((name, i) => {
    const m = readManifest(path.join(STORE, name));
    const when = new Date(m.at);
    console.log(`${String(i + 1).padStart(2)}  ${name}  ${m.note || '（无说明）'}  [${m.files.length} 个文件]`);
    void when;
  });
}

function byIndex(arg) {
  const dirs = snapDirs();
  if (!dirs.length) throw new Error('还没有快照，没得回');
  const n = arg == null ? dirs.length : Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > dirs.length) {
    throw new Error(`第 ${arg} 份不存在；现在一共 ${dirs.length} 份，用 list 看`);
  }
  return { name: dirs[n - 1], index: n, total: dirs.length };
}

function back(arg) {
  const { name, index, total } = byIndex(arg);
  const dir = path.join(STORE, name);
  const m = readManifest(dir);

  const pre = snap('回滚前自动存一份');
  console.log(`要回到第 ${index}/${total} 份：${name}  ${m.note}`);

  let done = 0;
  const gone = [];
  for (const f of m.files) {
    const t = TARGETS.find((x) => x.rel === f.rel);
    if (!t) {
      gone.push(f.rel);
      continue;
    }
    const src = path.join(dir, f.rel);
    if (!fs.existsSync(src)) {
      gone.push(f.rel);
      continue;
    }
    fs.mkdirSync(path.dirname(t.src), { recursive: true });
    fs.copyFileSync(src, t.src);
    done += 1;
  }

  console.log(`回来了：${done} 个文件`);
  if (gone.length) console.log(`  认不出的路径（没动）：${gone.join('、')}`);
  console.log(`  回滚前那份存成了：${pre.id}（要是回错了，再 back 一次就行）`);
  console.log('  记得重载插件：设置 → 插件 → dsh-hear 关一次再开');
}

function diff(arg) {
  const { name } = byIndex(arg);
  const dir = path.join(STORE, name);
  const m = readManifest(dir);
  console.log(`比一比：第 ${name} 份（${m.note || '无说明'}） ←→ 现在`);
  let same = 0;
  for (const f of m.files) {
    const t = TARGETS.find((x) => x.rel === f.rel);
    if (!t) continue;
    const old = fs.readFileSync(path.join(dir, f.rel), 'utf8');
    const now = fs.existsSync(t.src) ? fs.readFileSync(t.src, 'utf8') : '';
    if (old === now) {
      same += 1;
      continue;
    }
    const a = old.split('\n');
    const b = now.split('\n');
    let line = 0;
    while (line < Math.max(a.length, b.length) && a[line] === b[line]) line += 1;
    console.log(`  改了：${f.rel}  第 ${line + 1} 行开始不一样  行数 ${a.length} → ${b.length}`);
  }
  console.log(`  没变的：${same} 个`);
}

function check() {
  const js = [path.join(ROOT, 'dsh-hear', 'index.js'), path.join(ROOT, 'dsh-hear', 'client.js')];
  let bad = 0;
  for (const file of js) {
    if (!fs.existsSync(file)) {
      console.log(`  缺文件：${file}`);
      bad += 1;
      continue;
    }
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status === 0) console.log(`  好：${path.basename(file)}`);
    else {
      bad += 1;
      console.log(`  语法错：${path.basename(file)}\n${r.stderr.trim()}`);
    }
  }
  if (bad) process.exitCode = 1;
  else console.log('语法都对');
}

function help() {
  console.log([
    '鱼鱼的耳朵 · 回滚工具',
    '',
    '  snap "改了什么"   存一份',
    '  list              看快照',
    '  back [n]          回到第 n 份（不写就是最近一份）',
    '  diff [n]          看第 n 份跟现在差在哪',
    '  check             语法自检',
    '',
    '回滚前会自动再存一份，所以回滚本身也能退。',
  ].join('\n'));
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'snap') snap(rest.join(' ').trim());
  else if (cmd === 'list') list();
  else if (cmd === 'back') back(rest[0]);
  else if (cmd === 'diff') diff(rest[0]);
  else if (cmd === 'check') check();
  else help();
} catch (err) {
  console.error(`出事了：${err.message}`);
  process.exitCode = 1;
}
