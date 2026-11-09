/**
 * dsh-hear — 耳朵。
 *
 * 两件事：
 *   1. 把整段波形交给本地的音频模型（默认 Qwen2-Audio 4bit），让它听完说听感；
 *   2. 自己再算一遍基频 / 能量 / 频谱重心 / 停顿，两边对得上才敢下结论。
 *
 * 插件只管调度和生命周期，真正的「听」还是走 127.0.0.1:8779 那个服务。
 * 规则见 tts/耳朵规则.md，这里只做落地。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = readJson(path.join(HERE, 'package.json'), {}).version || '0.1.0';
const HOME = os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const STATE_DIR = path.join(DSH_HOME, 'hear');
const DEFAULT_MEDIA_DIR = path.join(DSH_HOME, 'media', 'onebot');
const PENDING_FILE = path.join(STATE_DIR, 'qq-pending.json');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const ERROR_FILE = path.join(STATE_DIR, 'errors.jsonl');
const ANALYZE = path.join(HERE, 'scripts', 'analyze.py');
const SPLIT = path.join(HERE, 'scripts', 'split_wav.py');

const DEFAULTS = {
  enabled: true,
  url: 'http://127.0.0.1:8779',
  port: 8779,
  serviceScript: path.join(HERE, 'server', 'hear_server.py'),
  pythonPath: '',
  modelId: 'Qwen/Qwen2-Audio-7B-Instruct',
  modelDirs: {},
  modelDir: path.join(STATE_DIR, 'models', 'qwen2-audio-7b'),
  bits: 4,
  settleMs: 9000,
  idleUnloadMs: 300000,
  judgeMode: 'auto',
  features: true,
  recordEnabled: true,
  recordDir: path.join(STATE_DIR, 'records'),
  vramPriority: 'voice',
  voicePorts: [8770, 9880],
  engine: 'local',
  qqWatch: { enabled: true, mediaDir: '', prefix: 'media_' },
  bridges: [],
  reply: { enabled: false, provider: 'none', baseUrl: '', token: '', target: '', webhookUrl: '', cooldownMs: 60000, maxPerBatch: 1 },
  cleanupReminder: { enabled: true, intervalDays: 2, hour: 22, lastAskedAt: '' },
  onboarded: false,
  cloud: { provider: 'none', baseUrl: '', apiKey: '', model: '' },
};

const MODELS = [
  { id: 'Qwen/Qwen2-Audio-7B-Instruct', name: 'Qwen2-Audio-7B-Instruct', size: '16.8G', vram: '显存12G起（4bit 约 4.5G）', note: '默认，中文听感稳', dir: 'qwen2-audio-7b', requires: { modules: ['torch', 'transformers', 'soundfile', 'numpy'], bitsandbytes: true, trustRemoteCode: false, vram: 12, engine: 'qwen2audio' } },
  { id: 'OpenBMB/MiniCPM-o-2_6-int4', name: 'MiniCPM-o-2_6-int4', size: '7.7G', vram: '显存8G起', note: '显存紧的人首选（引擎已写，未实测）', dir: 'minicpm-o-2_6-int4', requires: { modules: ['torch', 'transformers', 'soundfile', 'numpy'], bitsandbytes: false, trustRemoteCode: true, vram: 8, engine: 'minicpm' } },
  { id: 'Qwen/Qwen2.5-Omni-3B', name: 'Qwen2.5-Omni-3B', size: '7.5G', vram: '显存6G起（4bit 约 3G）', note: '低配首选，小显存也能跑（引擎已写，未实测）', dir: 'qwen2.5-omni-3b', requires: { modules: ['torch', 'transformers', 'soundfile', 'numpy', 'qwen_omni_utils'], bitsandbytes: false, trustRemoteCode: false, vram: 6, engine: 'qwen2omni' } },
  { id: 'OpenBMB/MiniCPM-o-2_6', name: 'MiniCPM-o-2_6', size: '17.4G', vram: '显存12G起', note: '同系列全精度（引擎已写，未实测）', dir: 'minicpm-o-2_6', requires: { modules: ['torch', 'transformers', 'soundfile', 'numpy'], bitsandbytes: false, trustRemoteCode: true, vram: 12, engine: 'minicpm' } },
  { id: 'Qwen/Qwen2.5-Omni-7B', name: 'Qwen2.5-Omni-7B', size: '22.4G', vram: '显存16G起或4bit', note: '听感更强，慢（引擎已写，未实测）', dir: 'qwen2.5-omni-7b', requires: { modules: ['torch', 'transformers', 'soundfile', 'numpy', 'qwen_omni_utils'], bitsandbytes: false, trustRemoteCode: false, vram: 16, engine: 'qwen2omni' } },
  { id: 'THUDM/GLM-4-Voice', name: 'GLM-4-Voice 9B', size: '19.1G', vram: '显存16G起', note: '偏聊天，不是纯听；还没接推理，只能下载', dir: 'glm-4-voice', requires: { modules: ['torch', 'transformers', 'soundfile', 'numpy'], bitsandbytes: false, trustRemoteCode: true, vram: 16, engine: null } },
  { id: 'stepfun-ai/Step-Audio-2-mini', name: 'Step-Audio-2-mini', size: '17.9G', vram: '显存16G起', note: '备选；还没接推理，只能下载', dir: 'step-audio-2-mini', requires: { modules: ['torch', 'transformers', 'soundfile', 'numpy'], bitsandbytes: false, trustRemoteCode: true, vram: 16, engine: null } },
  { id: 'moonshotai/Kimi-Audio-7B-Instruct', name: 'Kimi-Audio-7B-Instruct', size: '42.6G', vram: '显存24G起', note: '佬级配置；还没接推理，只能下载', dir: 'kimi-audio-7b', requires: { modules: ['torch', 'transformers', 'soundfile', 'numpy'], bitsandbytes: false, trustRemoteCode: true, vram: 24, engine: null } },
];

/** 这个模型用哪个引擎；没接推理的给 'unsupported'，别拿错的引擎硬跑。 */
function engineOf(modelId) {
  const model = MODELS.find((m) => m.id === modelId);
  if (!model) return 'unsupported';
  return (model.requires && model.requires.engine) || 'unsupported';
}

function listenableModel(modelId) {
  const model = MODELS.find((m) => m.id === modelId);
  return Boolean(model && model.requires && model.requires.engine);
}

function mkdirp(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // 有的编辑器/脚本会写 BOM，JSON.parse 见到就直接抛，配置会被静默当成空的。
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readConfig() {
  const raw = readJson(CONFIG_FILE, {});
  const merged = {
    ...DEFAULTS,
    ...raw,
    cloud: { ...DEFAULTS.cloud, ...(raw.cloud || {}) },
    qqWatch: { ...DEFAULTS.qqWatch, ...(raw.qqWatch || {}) },
    reply: { ...DEFAULTS.reply, ...(raw.reply || {}) },
    cleanupReminder: { ...DEFAULTS.cleanupReminder, ...(raw.cleanupReminder || {}) },
  };
  // 老配置里的「先关 IndexTTS」已经去掉，统一落到先关语音合成。
  if (merged.vramPriority === 'indextts') merged.vramPriority = 'voice';
  // 老的单桥接配置迁移成桥接列表：默认常驻两条，第二条先停用。
  if (!Array.isArray(merged.bridges) || merged.bridges.length === 0) {
    merged.bridges = [
      {
        name: '主号',
        enabled: merged.qqWatch?.enabled !== false,
        mediaDir: merged.qqWatch?.mediaDir || '',
        prefix: merged.qqWatch?.prefix || 'media_',
        send: Boolean(merged.reply?.enabled && merged.reply?.provider === 'onebot'),
        baseUrl: merged.reply?.baseUrl || '',
        token: merged.reply?.token || '',
        target: merged.reply?.target || '',
      },
      {
        name: '第二个号',
        enabled: false,
        mediaDir: '',
        prefix: 'media_',
        send: false,
        baseUrl: '',
        token: '',
        target: '',
      },
    ];
  }
  return merged;
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  if (patch && patch.port != null) next.url = `http://127.0.0.1:${Number(next.port) || 8779}`;
  if (patch && patch.url && patch.port == null) next.port = Number(String(next.url).split(':').pop()) || next.port;
  mkdirp(STATE_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 每台机器的 Python 位置不一样：先认配置里的，再认常见的，最后查 PATH。 */
function resolvePython(cfg) {
  const candidates = [
    cfg.pythonPath,
    path.join(STATE_DIR, 'venv', 'Scripts', 'python.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  for (const name of ['python', 'python3']) {
    try {
      const found = execFileSync('where', [name], { encoding: 'utf8', timeout: 3000, windowsHide: true })
        .split('\n')
        .map((s) => s.trim())
        .find((p) => p && fs.existsSync(p) && !p.toLowerCase().includes('windowsapps'));
      if (found) return found;
    } catch {}
  }
  return cfg.pythonPath || 'python';
}

let lastLoggedError = { message: '', at: 0 };

function logError(source, message, stack) {
  try {
    const text = String(message ?? '');
    const now = Date.now();
    // 同一种错误十分钟内只记一次，桥接抖一下不会刷屏。
    if (text === lastLoggedError.message && now - lastLoggedError.at < 10 * 60 * 1000) return;
    lastLoggedError = { message: text, at: now };
    mkdirp(STATE_DIR);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      source,
      engine: readConfig().engine || 'local',
      message: text,
      stack: stack ? String(stack).slice(0, 4000) : undefined,
    });
    fs.appendFileSync(ERROR_FILE, line + '\n', 'utf8');
    const lines = fs.readFileSync(ERROR_FILE, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length > 200) fs.writeFileSync(ERROR_FILE, lines.slice(-50).join('\n') + '\n', 'utf8');
  } catch {}
}

function readErrors(limit = 50) {
  try {
    const lines = fs.readFileSync(ERROR_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { at: '', source: 'unknown', message: line };
      }
    }).reverse();
  } catch {
    return [];
  }
}

async function httpJson(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function gpuInfo() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    }).trim().split('\n')[0];
    const [name, used, total] = out.split(',').map((s) => s.trim());
    return { name, usedMiB: Number(used), totalMiB: Number(total) };
  } catch {
    return null;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(Number(port), '127.0.0.1');
  });
}

async function pickFreePort(start, span = 50) {
  for (let port = Number(start); port < Number(start) + span; port += 1) {
    if (port > 65535) break;
    if (await portFree(port)) return port;
  }
  throw new Error(`从 ${start} 起找不到空闲端口`);
}

function pidOnPort(port) {  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    for (const line of out.split('\n')) {
      if (!line.includes(`:${port}`)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[3] === 'LISTENING') return Number(cols[4]);
    }
  } catch {}
  return null;
}

/** 端口上那个进程是谁：名字 + 命令行。 */
function describeProc(pid) {
  if (!pid) return null;
  try {
    const cmd = `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object -First 1 Name,CommandLine | ConvertTo-Json -Compress`;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    const info = JSON.parse(String(out || '').trim() || 'null');
    if (!info) return { pid: Number(pid), name: '', cmdline: '' };
    return { pid: Number(pid), name: String(info.Name || ''), cmdline: String(info.CommandLine || '') };
  } catch {
    return { pid: Number(pid), name: '', cmdline: '' };
  }
}

/** 是不是耳朵自己上次没退干净的那一份。 */
function looksLikeHear(info) {
  if (!info) return false;
  return `${info.name} ${info.cmdline}`.toLowerCase().includes('hear_server.py');
}

/** 端口上有东西，而且是我们自己的 → 僵尸。别的程序不算。 */
function zombieOnPort(port) {
  const pid = pidOnPort(port);
  if (!pid) return null;
  const info = describeProc(pid);
  return looksLikeHear(info) ? info : null;
}

function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
  } catch {}
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(p);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {}
      }
    }
  } catch {}
  return total;
}

function formatGB(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** The service lifecycle: off → starting → awake; owns only what it started. */
class EarsService {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.phase = 'off';
    this.proc = null;
    this.pid = null;
    this.owned = false;
    this.error = null;
    this.startedAt = 0;
    this.lastHearAt = 0;
    this.lastHearSecs = 0;
    this.lastHearPath = '';
    this.loading = false;
    this.idleTimer = null;
    this.idleAt = 0;
    this.poller = null;
    this.portMoved = null;
    this.logFile = path.join(STATE_DIR, 'service.log');
  }

  get cfg() {
    return this.getConfig();
  }

  async health(timeoutMs = 1500) {
    try {
      const { ok, data } = await httpJson(`${this.cfg.url}/health`, {}, timeoutMs);
      return ok && data ? data : null;
    } catch {
      return null;
    }
  }

  async status() {
    const cfg = this.cfg;
    const h = await this.health();
    const gpu = gpuInfo();
    // 服务还在跑但本进程没见过它的 pid（比如插件刚重载）：认回来，
    // 只是记住地址、不算自己启的，退出时不会误杀。
    if (h && !this.pid) this.pid = pidOnPort(cfg.port);
    let phase = this.phase;
    if (h && h.supported === false) phase = 'error';
    else if (h) phase = h.ok ? 'awake' : 'starting';
    else if (this.proc || this.pid) phase = 'starting';
    else phase = 'off';
    return {
      phase,
      serviceUp: Boolean(h),
      modelLoaded: Boolean(h && h.ok),
      supported: h ? h.supported !== false : listenableModel(cfg.modelId),
      engineId: h?.engine ?? engineOf(cfg.modelId),
      engineError: h?.supported === false ? (h.error || '这个模型还没接推理') : null,
      device: h?.device ?? null,
      fourBit: h?.four_bit ?? null,
      gpuName: h?.gpu ?? gpu?.name ?? null,
      gpu,
      vram: gpu ? { usedMiB: gpu.usedMiB, totalMiB: gpu.totalMiB, freeMiB: gpu.totalMiB - gpu.usedMiB } : null,
      pid: this.pid ?? pidOnPort(cfg.port),
      owned: this.owned,
      startedAt: this.startedAt || null,
      lastHearAt: this.lastHearAt || null,
      lastHearSecs: this.lastHearSecs || null,
      lastHearPath: this.lastHearPath || null,
      loading: this.loading,
      error: this.error,
      version: VERSION,
      lastAction: this.lastAction || '',
      idleUntil: this.idleAt ? this.idleAt + (Number(cfg.idleUnloadMs) || 300000) : null,
      engine: cfg.engine || 'local',
      cloud: { provider: cfg.cloud?.provider || 'none', model: cfg.cloud?.model || '' },
      portMoved: this.portMoved && this.portMoved.to === cfg.port ? this.portMoved : null,
      url: cfg.url,
      settleMs: cfg.settleMs,
      idleUnloadMs: cfg.idleUnloadMs,
    };
  }

  async freeVoicePorts() {
    const ports = Array.isArray(this.cfg.voicePorts) ? this.cfg.voicePorts : [];
    const killed = [];
    for (const raw of ports) {
      const port = Number(raw);
      if (!port || port === Number(this.cfg.port)) continue;
      const pid = pidOnPort(port);
      if (pid) {
        killTree(pid);
        killed.push(port);
      }
    }
    this.lastAction = `显存不够，已关掉语音合成端口：${killed.join(', ') || '没有在跑的'}`;
    return killed;  }

  async start(force = false) {
    let cfg = this.cfg;
    const existing = await this.health();
    if (existing) {
      if (!this.pid) this.pid = pidOnPort(cfg.port);
      this.phase = existing.ok ? 'awake' : 'starting';
      this.owned = false;
      if (!existing.ok) this.warm();
      return this.status();
    }
    if (this.proc) return this.status();
    // 显存不够先问一句，别直接 OOM；确认了才去关语音合成。
    const gpu = gpuInfo();
    const need = 4500;
    if (gpu && gpu.totalMiB - gpu.usedMiB < need) {
      const free = gpu.totalMiB - gpu.usedMiB;
      if (!force && this.cfg.vramPriority !== 'last') {
        return { needsConfirm: true, vram: { freeMiB: free, needMiB: need } };
      }
      if (force) await this.freeVoicePorts();
    }
    // 端口被别的程序占了：换一个空闲的，并把配置一起改掉，下次还是这个。
    // 要是占着的是自己上次没退干净的那份，别偷偷换端口——先告诉主人，让他决定杀不杀。
    if (!existing && pidOnPort(cfg.port)) {
      const zombie = zombieOnPort(cfg.port);
      if (zombie && zombie.pid !== this.pid) {
        this.zombie = zombie;
        return {
          needsConfirm: true,
          zombie,
          port: cfg.port,
          message: `端口 ${cfg.port} 上还挂着一个上次没退干净的听音服务（PID ${zombie.pid}${zombie.name ? ` ${zombie.name}` : ''}），它还占着显存。要我结束它吗？说「结束」我就杀；不想动我就换端口。`,
        };
      }
      const from = cfg.port;
      const free = await pickFreePort(from + 1);
      writeConfig({ port: free, url: `http://127.0.0.1:${free}` });
      cfg = this.cfg;
      this.portMoved = { from, to: free };
      logError('service', `端口 ${from} 被占用，已改用 ${free}`);
    }
    // 配置里记的脚本路径可能指向旧的安装位置（插件挪过目录），脚本还在自带目录里就用自带的。
    if (!fs.existsSync(cfg.serviceScript)) {
      const bundled = path.join(HERE, 'server', 'hear_server.py');
      if (fs.existsSync(bundled)) {
        writeConfig({ serviceScript: bundled });
        cfg = this.cfg;
      }
    }
    if (!fs.existsSync(cfg.serviceScript)) {
      this.error = `服务脚本不存在：${cfg.serviceScript}`;
      this.phase = 'error';
      logError('service', this.error);
      throw new Error(this.error);
    }
    const python = resolvePython(cfg);
    if (!fs.existsSync(python)) {
      this.error = `找不到 Python：${cfg.pythonPath || '未配置，也没在 PATH 里找到'}`;
      this.phase = 'error';
      logError('service', this.error);
      throw new Error(this.error);
    }
    mkdirp(STATE_DIR);
    let logFd = 'ignore';
    try {
      logFd = fs.openSync(this.logFile, 'a');
    } catch {}
    const env = {
      ...process.env,
      QWEN_AUDIO_DIR: cfg.modelDir,
      QWEN_AUDIO_PORT: String(cfg.port),
      QWEN_AUDIO_BITS: String(cfg.bits),
      HEAR_MODEL_DIR: cfg.modelDir,
      HEAR_PORT: String(cfg.port),
      HEAR_BITS: String(cfg.bits),
      HEAR_ENGINE: engineOf(cfg.modelId),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    };
    this.phase = 'starting';
    this.error = null;
    this.owned = true;
    this.startedAt = Date.now();
    this.proc = spawn(python, [cfg.serviceScript], {
      cwd: path.dirname(cfg.serviceScript),
      env,
      windowsHide: true,
      stdio: ['ignore', logFd === 'ignore' ? 'ignore' : logFd, logFd === 'ignore' ? 'ignore' : logFd],
    });
    this.pid = this.proc.pid ?? null;
    this.proc.on('exit', (code) => {
      if (this.phase !== 'off') {
        this.phase = 'off';
        this.owned = false;
        this.proc = null;
        this.pid = null;
        if (code !== 0 && code !== null) {
          this.error = `耳朵服务退出（code ${code}）`;
          logError('service', this.error);
        }
      }
    });
    // 等端口起来（模型还没加载），最多 45 秒。
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      const h = await this.health(1200);
      if (h) {
        if (h.supported === false) {
          this.error = h.error || '这个模型还没接推理';
          this.phase = 'error';
          logError('service', `引擎未支持：${this.error}`);
          throw new Error(`这个模型还没接推理：${this.error}。模型能下载、能体检，但暂时听不了`);
        }
        this.phase = h.ok ? 'awake' : 'starting';
        if (!h.ok) this.warm();
        this.armIdle();
        return this.status();
      }
      if (!this.proc) break;
    }
    this.error = '耳朵服务启动超时（端口没起来）';
    this.phase = 'error';
    logError('service', this.error);
    throw new Error(this.error);
  }

  /** 服务起来了但模型还没进显存：拿一小段静音把它叫醒，别让用户等第一次真听。 */
  warm() {
    if (this.loading) return;
    this.loading = true;
    const file = path.join(STATE_DIR, 'warmup.wav');
    try {
      mkdirp(STATE_DIR);
      const seconds = 0.5;
      const rate = 16000;
      const samples = Math.round(seconds * rate);
      const buf = Buffer.alloc(44 + samples * 2);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(36 + samples * 2, 4);
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20);
      buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(rate, 24);
      buf.writeUInt32LE(rate * 2, 28);
      buf.writeUInt16LE(2, 32);
      buf.writeUInt16LE(16, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(samples * 2, 40);
      fs.writeFileSync(file, buf);
    } catch (error) {
      this.loading = false;
      logError('warm', error?.message ?? error);
      return;
    }
    httpJson(`${this.cfg.url}/hear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file, question: '只回答两个字：好了' }),
    }, 300000)
      .then(() => {
        this.phase = 'awake';
      })
      .catch((error) => {
        logError('warm', error?.message ?? error);
      })
      .finally(() => {
        this.loading = false;
      });
  }

  async stop() {
    const cfg = this.cfg;
    this.clearIdle();
    const pid = this.pid ?? pidOnPort(cfg.port);
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
    }
    killTree(pid);
    this.phase = 'off';
    this.proc = null;
    this.pid = null;
    this.owned = false;
    this.startedAt = 0;
    this.loading = false;
    this.portMoved = null;
    return this.status();
  }

  /** Run one listen; the model loads lazily on the first call. */
  async hear(file, question) {
    const cfg = this.cfg;
    if (!cfg.enabled) throw new Error('耳朵总开关是关的');
    if (!fs.existsSync(file)) throw new Error(`音频不存在：${file}`);
    if (cfg.engine === 'cloud') {
      const result = await cloudHear(file, question, cfg);
      this.lastHearAt = Date.now();
      this.lastHearSecs = result.secs;
      this.lastHearPath = file;
      return { answer: result.answer, secs: result.secs, sampleSeconds: null, wakeMs: 0, woke: false, cloud: result.provider };
    }
    const before = await this.health(1200);
    if (!before) {
      const started = await this.start();
      if (started && started.needsConfirm) {
        if (started.zombie) throw new Error(started.message);
        throw new Error(`显存不够加载耳朵（空闲 ${started.vram?.freeMiB ?? '?'} MiB，需要约 ${started.vram?.needMiB ?? 4500} MiB）。先关掉语音合成再试，或者在设置里点启动确认`);
      }
    }
    const wasLoaded = Boolean(before && before.ok);
    const t0 = Date.now();
    this.loading = !wasLoaded;
    let res;
    try {
      res = await httpJson(`${cfg.url}/hear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file, question }),
      }, 420000);
    } finally {
      this.loading = false;
    }
    if (!res.ok) {
      const msg = res.data?.error || `HTTP ${res.status}`;
      logError('service', `听失败：${msg}`);
      if (res.status === 501 || res.data?.unsupported) {
        throw new Error(`这个模型还没接推理：${msg}。模型能下载、能体检，但暂时听不了`);
      }
      throw new Error(`耳朵没听成：${msg}`);
    }
    this.phase = 'awake';
    this.lastHearAt = Date.now();
    this.lastHearSecs = res.data?.secs ?? null;
    this.lastHearPath = file;
    this.armIdle();
    return {
      answer: String(res.data?.answer ?? ''),
      secs: res.data?.secs ?? null,
      sampleSeconds: res.data?.sample_seconds ?? null,
      wakeMs: wasLoaded ? 0 : Date.now() - t0 - (res.data?.secs ?? 0) * 1000,
      woke: !wasLoaded,
    };
  }

  armIdle() {
    this.clearIdle();
    const ms = Number(this.cfg.idleUnloadMs) || 300000;
    this.idleAt = Date.now();
    this.idleTimer = setTimeout(() => {
      this.stop().catch(() => {});
    }, ms);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleAt = 0;
  }
}

function ensureWav(file) {
  if (/\.wav$/i.test(file)) return file;
  const cfg = readConfig();
  const out = path.join(os.tmpdir(), `dsh-hear-${Date.now()}.wav`);
  execFileSync(resolvePython(cfg), [path.join(HERE, 'scripts', 'to_wav.py'), file, out], {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return out;
}

/** 走云端听：不用本地显存，代价是网和钱。 */
async function cloudHear(file, question, cfg) {
  const cloud = cfg.cloud || {};
  if (!cloud.provider || cloud.provider === 'none') throw new Error('云端还没选服务商');
  if (!cloud.apiKey) throw new Error('云端还没填 API Key');
  const wav = ensureWav(file);
  const bytes = fs.statSync(wav).size;
  if (bytes > 15 * 1024 * 1024) {
    throw new Error(`转成 wav 后有 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过云端单次上限，先切短一点`);
  }
  const data = fs.readFileSync(wav).toString('base64');
  const prompt = question || '请用中文说说这段音频里的听感：音色、气声、语速、停顿、情绪、背景干不干净。';
  const t0 = Date.now();
  let url;
  let body;
  const headers = { 'content-type': 'application/json' };
  if (cloud.provider === 'gemini') {
    const model = cloud.model || 'gemini-2.0-flash';
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cloud.apiKey)}`;
    body = { contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data } }] }] };
  } else {
    const fallback = cloud.provider === 'qwen' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : 'https://api.openai.com/v1';
    const base = String(cloud.baseUrl || fallback).replace(/\/+$/, '');
    const model = cloud.model || (cloud.provider === 'qwen' ? 'qwen2.5-omni-7b' : 'gpt-4o-audio-preview');
    url = `${base}/chat/completions`;
    headers.authorization = `Bearer ${cloud.apiKey}`;
    body = {
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data, format: 'wav' } }] }],
    };
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  if (!res.ok) throw new Error(`云端返回 ${res.status}：${String(json?.error?.message || raw).slice(0, 300)}`);
  const answer = cloud.provider === 'gemini'
    ? (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim()
    : String(json?.choices?.[0]?.message?.content || '').trim();
  if (!answer) throw new Error('云端没有返回内容');
  return { answer, secs: Math.round((Date.now() - t0) / 100) / 10, provider: cloud.provider };
}

/** 盯 QQ 桥接落盘的语音文件：看到新的就等静默，再一只只听。 */
class QqWatcher {
  constructor(getConfig, getEars) {
    this.getConfig = getConfig;
    this.getEars = getEars;
    this.watcher = null;
    this.watchers = new Map();
    this.dirs = [];
    this.lastReplyByBridge = new Map();
    this.timer = null;
    this.queue = [];
    this.seen = new Map();
    this.listening = false;
    this.dir = '';
    this.lastError = '';
    this.conflicts = [];
    this.lastSeen = 0;
    this.busy = false;
    this.pending = readJson(PENDING_FILE, []) || [];
  }

  get bridges() {
    const list = Array.isArray(this.getConfig().bridges) ? this.getConfig().bridges : [];
    return list.filter((item) => item && item.enabled !== false);
  }

  start() {
    this.stop();
    this.conflicts = [];
    if (!this.bridges.length) return;
    const byDir = new Map();
    for (const bridge of this.bridges) {
      const dir = bridge.mediaDir || DEFAULT_MEDIA_DIR;
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(bridge);
    }
    // 同一个目录 + 同一个前缀的两条桥，文件名里没有账号信息，只会被第一条取走。
    for (const [dir, list] of byDir) {
      const byPrefix = new Map();
      for (const bridge of list) {
        const prefix = String(bridge.prefix ?? 'media_').toLowerCase();
        const key = prefix === '*' ? '(全部)' : prefix;
        if (!byPrefix.has(key)) byPrefix.set(key, []);
        byPrefix.get(key).push(bridge.name || bridge.baseUrl || '未命名');
      }
      for (const [prefix, names] of byPrefix) {
        if (names.length < 2) continue;
        this.conflicts.push({
          dir,
          prefix,
          bridges: names,
          text: `桥接冲突：${names.join(' 和 ')} 都盯 ${dir}，前缀都是「${prefix}」，文件里没有账号信息，只会被第一条取走，后面那条永远收不到。给每条桥配自己的目录或前缀。`,
        });
      }
    }
    const dirs = [];
    for (const [dir, list] of byDir) {
      dirs.push(dir);
      if (!fs.existsSync(dir)) {
        this.lastError = `目录不存在：${dir}`;
        continue;
      }
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          if (filename) this.onFile(dir, String(filename));
        });
        this.watchers.set(dir, { watcher, bridges: list });
      } catch (error) {
        this.lastError = String(error?.message ?? error);
      }
    }
    this.dirs = dirs;
    this.listening = this.watchers.size > 0;
    if (this.listening) this.lastError = '';
  }

  stop() {
    for (const entry of this.watchers.values()) {
      try {
        entry.watcher.close();
      } catch {}
    }
    this.watchers.clear();
    this.watcher = null;
    this.listening = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  onFile(dir, name) {
    const entry = this.watchers.get(dir);
    if (!entry) return;
    if (!/\.(mp3|silk|wav|amr|m4a|ogg)$/i.test(name)) return;
    const bridge = entry.bridges.find((item) => {
      const prefix = String(item.prefix ?? 'media_');
      return prefix === '*' || prefix === '' || name.toLowerCase().startsWith(prefix.toLowerCase());
    });
    if (!bridge) return;
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) return;
    const now = Date.now();
    if (now - (this.seen.get(full) || 0) < 5000) return;
    this.seen.set(full, now);
    this.queue.push({ file: full, dir, bridge });
    this.lastSeen = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Number(this.getConfig().settleMs) || 9000;
    this.timer = setTimeout(() => {
      this.flush().catch(() => {});
    }, wait);
  }

  async flush() {
    if (this.busy) return;
    const items = this.queue.splice(0);
    if (!items.length) return;
    this.busy = true;
    try {
      const notes = [];
      const questions = [];
      for (const item of items) {
        const features = featuresOf(item.file, this.getConfig());
        const duration = features?.ok ? features.duration_s : null;
        // 超过一分钟不自己硬听，先问要不要分段。
        if (duration && duration > 60) {
          const minutes = Math.floor(duration / 60);
          const seconds = Math.round(duration % 60);
          const text = `这段音频 ${minutes} 分 ${seconds} 秒，超过一分钟。要分段听吗？回「分段」我就按 30 秒一段切开听，回「不用」就整段听。`;
          questions.push({ bridge: item.bridge, text });
          notes.push({
            at: new Date().toISOString(),
            path: item.file,
            bridge: item.bridge,
            awaiting: true,
            duration,
            answer: text,
            extras: '',
            timeline: '',
          });
          continue;
        }
        try {
          const heard = await this.getEars().hear(item.file, '这是 QQ 里发来的一段语音。请用中文说说：说了什么、语气情绪、语速停顿、背景干不干净。');
          const parsed = parseAnswer(heard.answer);
          notes.push({ at: new Date().toISOString(), path: item.file, bridge: item.bridge, ...parsed });
        } catch (error) {
          notes.push({ at: new Date().toISOString(), path: item.file, bridge: item.bridge, error: String(error?.message ?? error) });
        }
      }

      // 同一个文件重新处理时，把旧的待办换掉。
      const paths = new Set(items.map((item) => item.file));
      this.pending = this.pending.filter((row) => !paths.has(row.path));
      this.pending = [...this.pending, ...notes.map(({ bridge, ...rest }) => rest)].slice(-10);
      mkdirp(STATE_DIR);
      fs.writeFileSync(PENDING_FILE, JSON.stringify(this.pending, null, 2), 'utf8');

      // 先问分段，再处理听完的主动回复。
      const askGroups = new Map();
      for (const question of questions) {
        const bridge = question.bridge;
        if (!bridge || !bridge.send) continue;
        if (!askGroups.has(bridge)) askGroups.set(bridge, []);
        askGroups.get(bridge).push(question.text);
      }
      for (const [bridge, texts] of askGroups) {
        for (const text of texts.slice(0, 3)) {
          try {
            await sendQqText(text, bridge);
            await new Promise((r) => setTimeout(r, 600));
          } catch (error) {
            logError('reply', error?.message ?? error);
            break;
          }
        }
      }

      // 每条桥接只管自己听来的那几段，带冷却，避免刷屏。
      const groups = new Map();
      for (const note of notes) {
        const bridge = note.bridge;
        if (!bridge || !bridge.send || note.awaiting) continue;
        if (!groups.has(bridge)) groups.set(bridge, []);
        groups.get(bridge).push(note);
      }
      for (const [bridge, batch] of groups) {
        const key = bridge.name || bridge.baseUrl || 'bridge';
        const now = Date.now();
        const fallback = this.getConfig().reply || {};
        const cooldown = Number(bridge.cooldownMs ?? fallback.cooldownMs ?? 60000) || 60000;
        if (now - (this.lastReplyByBridge.get(key) || 0) < cooldown) continue;
        const texts = buildReplyTexts(batch, bridge.maxPerBatch ?? fallback.maxPerBatch ?? 1);
        const sent = [];
        for (const text of texts) {
          try {
            await sendQqText(text, bridge);
            sent.push(text);
            await new Promise((r) => setTimeout(r, 800));
          } catch (error) {
            logError('reply', error?.message ?? error);
            break;
          }
        }
        if (sent.length) {
          this.lastReplyByBridge.set(key, now);
          this.lastReplyAt = now;
          this.lastReply = sent.join(' / ');
        }
      }
    } finally {
      this.busy = false;
    }
  }

  status() {
    return {
      enabled: this.bridges.length > 0,
      dir: this.dirs.join('；') || DEFAULT_MEDIA_DIR,
      dirs: this.dirs,
      bridges: this.bridges.length,
      listening: this.listening,
      lastSeen: this.lastSeen || null,
      pending: this.pending.length,
      lastError: this.lastError,
      conflicts: this.conflicts || [],
      lastReplyAt: this.lastReplyAt || null,
      lastReply: this.lastReply || '',
      busy: this.busy,
    };
  }

  contextText() {
    const parts = [];
    for (const row of this.conflicts || []) parts.push(row.text);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const rows = this.pending.filter((row) => Date.parse(row.at) > cutoff);
    if (rows.length) {
      parts.push([
        '最近听到的 QQ 语音（耳朵自动听的，原文在 ~/.dsh/hear/qq-pending.json）：',
        ...rows.slice(-5).map((row) => `- ${row.at}｜${path.basename(row.path)}｜${row.error ? `没听成：${row.error}` : row.answer}`),
      ].join('\n'));
    }
    return parts.join('\n\n');
  }

  forget(file) {
    this.pending = this.pending.filter((row) => row.path !== file);
    try {
      fs.writeFileSync(PENDING_FILE, JSON.stringify(this.pending, null, 2), 'utf8');
    } catch {}
  }

  clear() {
    this.pending = [];
    try {
      fs.writeFileSync(PENDING_FILE, '[]', 'utf8');
    } catch {}
  }
}

/** 选项页上那些解释就是规矩：数字怎么调，行为就怎么变，也同步进提示词。 */
function rulesText() {
  const cfg = readConfig();
  const settle = Math.round((Number(cfg.settleMs) || 9000) / 1000);
  const idle = Math.round((Number(cfg.idleUnloadMs) || 300000) / 60000);
  const modeMap = { auto: '自动判断', ask: '每次都先问', dialog: '一律当对话', material: '一律当素材' };
  return [
    '耳朵的规矩（插件在跑，按这个来）：',
    `- 连续发音频时，以最后一条之后静默 ${settle} 秒为准，凑齐了才回一次，期间不要逐条回复。`,
    `- 我把话说完后 ${idle} 分钟没动静，识别模型会自动从显存卸载；下次再来会自动拉起。`,
    `- 判断模式：${modeMap[cfg.judgeMode] || '自动判断'}；拿不准就先问一句这是对话还是素材。`,
    '- 只能听，不会生成音乐。',
  ].join('\n');
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}G`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)}M`;
  if (value >= 1024) return `${Math.round(value / 1024)}K`;
  return `${Math.round(value)}B`;
}

function nextCleanupAt(cfg) {
  const rule = cfg.cleanupReminder || {};
  const hour = Number(rule.hour ?? 22);
  const days = Number(rule.intervalDays ?? 2) || 2;
  const last = Date.parse(rule.lastAskedAt || '') || 0;
  const next = new Date(last || Date.now());
  if (!last) {
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() < Date.now()) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  next.setTime(last + days * 86400000);
  next.setHours(hour, 0, 0, 0);
  return next.getTime();
}

function tempLeftovers(since) {
  const out = [];
  const protect = Date.now() - 10 * 60 * 1000;
  const dir = os.tmpdir();
  try {
    for (const name of fs.readdirSync(dir)) {
      // 切段目录 dsh-hear-split-*、转换出来的 dsh-hear-*.wav，都是这支自己留的
      if (!/^dsh-hear-/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        // 正在听的那一份别动
        if (st.mtimeMs < since || st.mtimeMs > protect) continue;
        out.push(full);
      } catch {}
    }
  } catch {}
  return out;
}

function sizeOfPath(target) {
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(target).reduce((sum, name) => sum + sizeOfPath(path.join(target, name)), 0);
  } catch {
    return 0;
  }
}

function cleanupCandidates(cfg = readConfig()) {
  const since = Date.now() - 2 * 86400000;
  const voices = [];
  const records = [];
  for (const bridge of cfg.bridges || []) {
    const dir = bridge.mediaDir || DEFAULT_MEDIA_DIR;
    const prefix = String(bridge.prefix ?? 'media_');
    try {
      for (const name of fs.readdirSync(dir)) {
        const isAudio = /\.(mp3|silk|wav|amr|m4a|ogg)$/i.test(name);
        const matched = isAudio && (prefix === '*' || prefix === '' || name.toLowerCase().startsWith(prefix.toLowerCase()));
        if (!matched) continue;
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).mtimeMs >= since) voices.push(full);
        } catch {}
      }
    } catch {}
  }
  try {
    for (const name of fs.readdirSync(cfg.recordDir)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(cfg.recordDir, name);
      try {
        if (fs.statSync(full).mtimeMs >= since) records.push(full);
      } catch {}
    }
  } catch {}
  const temps = tempLeftovers(since);
  const bytesOf = (list) => list.reduce((sum, p) => sum + sizeOfPath(p), 0);
  return {
    voices,
    records,
    temps,
    voiceBytes: bytesOf(voices),
    recordBytes: bytesOf(records),
    tempBytes: bytesOf(temps),
  };
}

let zombieCache = { at: 0, port: 0, value: null, pid: 0, firstSeen: 0 };

/**
 * 端口上的僵尸：要连看两次、而且服务不在 awake 状态，才算。
 * 插件刚重载时最容易误判——服务明明是我们起的，只是 pid 还没认回来。
 */
function zombieNotice(cfg = readConfig(), ownedPid = 0, phase = '') {
  const port = Number(cfg.port);
  const now = Date.now();
  if (zombieCache.port === port && now - zombieCache.at < (zombieCache.pid ? 5000 : 30000)) {
    return zombieCache.value;
  }
  const pid = pidOnPort(port);
  const suspect = Boolean(pid) && pid !== Number(ownedPid || 0) && phase !== 'awake';
  if (!suspect) {
    zombieCache = { at: now, port, value: null, pid: 0, firstSeen: 0 };
    return null;
  }
  const info = describeProc(pid);
  if (!looksLikeHear(info)) {
    zombieCache = { at: now, port, value: null, pid: 0, firstSeen: 0 };
    return null;
  }
  const firstSeen = zombieCache.pid === pid ? zombieCache.firstSeen : now;
  const confirmed = now - firstSeen >= 15000;
  const value = confirmed
    ? `端口检查：${port} 上有个僵尸进程 PID ${pid}${info.name ? ` ${info.name}` : ''}，是上次的听音服务没退干净，还占着显存。该跟主人说一声，问他是结束它还是换端口；他没点头就别杀。`
    : null;
  zombieCache = { at: now, port, value, pid, firstSeen };
  return value;
}

function cleanupStatus() {  const cfg = readConfig();
  const rule = cfg.cleanupReminder || {};
  const next = nextCleanupAt(cfg);
  const list = cleanupCandidates(cfg);
  return {
    enabled: Boolean(rule.enabled),
    due: Boolean(rule.enabled) && Date.now() >= next,
    nextAt: next,
    intervalDays: Number(rule.intervalDays ?? 2),
    hour: Number(rule.hour ?? 22),
    voices: list.voices.length,
    records: list.records.length,
    temps: list.temps.length,
    bytes: list.voiceBytes + list.recordBytes + list.tempBytes,
  };
}

function runCleanup(scope) {
  const cfg = readConfig();
  const list = cleanupCandidates(cfg);
  const targets = scope === 'voices'
    ? list.voices
    : scope === 'records'
      ? list.records
      : [...list.voices, ...list.records, ...list.temps];
  let removed = 0;
  for (const file of targets) {
    try {
      fs.rmSync(file, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  if (scope === 'all' || scope === 'records') {
    try {
      fs.writeFileSync(PENDING_FILE, '[]', 'utf8');
    } catch {}
  }
  writeConfig({ cleanupReminder: { ...(cfg.cleanupReminder || {}), lastAskedAt: new Date().toISOString() } });
  return { removed, cleanup: cleanupStatus() };
}

async function onboardCheck() {
  const cfg = readConfig();
  const gpu = gpuInfo();
  let disk = null;
  try {
    const stat = fs.statfsSync(path.dirname(cfg.modelDir));
    disk = { freeBytes: Number(stat.bfree) * Number(stat.bsize), totalBytes: Number(stat.blocks) * Number(stat.bsize) };
  } catch {}
  let network = false;
  try {
    const res = await fetch('https://www.modelscope.cn', { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    network = res.status < 500;
  } catch {}
  const python = resolvePython(cfg);
  let pythonVersion = '';
  try {
    pythonVersion = execFileSync(python, ['-V'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  } catch {}
  let deps = null;
  try {
    const out = execFileSync(python, ['-c', 'import json\nmods={}\nfor m in ("torch","transformers","bitsandbytes","soundfile"):\n    try:\n        __import__(m); mods[m]=True\n    except Exception: mods[m]=False\nprint(json.dumps(mods))'], {
      encoding: 'utf8',
      timeout: 90000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    deps = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
  } catch {}
  const gpuGb = gpu ? Math.round(gpu.totalMiB / 1024) : null;
  const pick = gpuGb == null
    ? { id: 'cloud', name: '云端', why: '没读到独显，走云端最省事' }
    : gpuGb >= 16 ? { id: 'Qwen/Qwen2-Audio-7B-Instruct', name: 'Qwen2-Audio-7B-Instruct', why: '显存够，默认这个中文听感最稳' }
      : gpuGb >= 12 ? { id: 'Qwen/Qwen2-Audio-7B-Instruct', name: 'Qwen2-Audio-7B-Instruct', why: '12G 用 4bit 刚好，中文听感最稳' }
        : gpuGb >= 8 ? { id: 'OpenBMB/MiniCPM-o-2_6-int4', name: 'MiniCPM-o-2_6-int4', why: '8G 左右用自带 int4 的这个' }
          : gpuGb >= 6 ? { id: 'Qwen/Qwen2.5-Omni-3B', name: 'Qwen2.5-Omni-3B', why: '显存小，用 3B 这个' }
            : { id: 'cloud', name: '云端', why: '显存太小，建议走云端' };
  const target = MODELS.find((m) => m.id === pick.id);
  const sizeBytes = target ? expectedBytes(target.size) : 0;
  return {
    gpu,
    gpuGb,
    disk,
    network,
    python: { path: python, version: pythonVersion, exists: fs.existsSync(python) },
    deps,
    recommend: { ...pick, size: target ? target.size : '', dir: target ? modelDirOf(target, cfg) : '', minutes: sizeBytes ? Math.max(1, Math.round(sizeBytes / (5 * 1024 * 1024) / 60)) : 0 },
    onboarded: Boolean(cfg.onboarded),
  };
}

/**
 * 主动发一条 QQ 消息。不同的桥接不一样，所以这里只认两种通用口子：
 * onebot（SnowLuma / NapCat / Lagrange 这类标准 OneBot 11）和 webhook（对方自己接一个 HTTP）。
 */
async function sendQqText(text, channel) {
  if (!channel || typeof channel !== 'object') throw new Error('没有可用的发送通道');
  if (channel.webhookUrl) {
    const res = await fetch(channel.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`webhook 返回 ${res.status}`);
    return { sent: true, provider: 'webhook' };
  }
  const base = String(channel.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('这条桥接没填 OneBot 地址');
  const rawTarget = String(channel.target || '').trim();
  const cut = rawTarget.indexOf(':');
  const kindRaw = cut >= 0 ? rawTarget.slice(0, cut) : '个人';
  const id = cut >= 0 ? rawTarget.slice(cut + 1) : rawTarget;
  if (!id) throw new Error('发给谁要写成 个人:QQ号 或 群组:群号');
  const kind = /群|group/i.test(kindRaw) ? 'group' : 'private';
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const body = kind === 'group' ? { group_id: Number(id), message: text } : { user_id: Number(id), message: text };
  const url = `${base}/${action}${channel.token ? `?access_token=${encodeURIComponent(channel.token)}` : ''}`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.status === 'failed')) throw new Error(`发送失败：${json?.message || res.status}`);
  return { sent: true, provider: 'onebot' };
}

function buildReplyTexts(notes, maxPerBatch) {
  const limit = Math.max(0, Math.min(10, Number(maxPerBatch) || 0));
  if (limit === 0) return [];
  const rows = notes.filter((n) => n.answer).slice(0, limit);
  return rows.map((row, index) => {
    const text = row.answer.replace(/\s+/g, ' ').trim().slice(0, 160);
    return rows.length === 1 ? `我听到了：${text}` : `第 ${index + 1} 段：${text}`;
  });
}

/** 分段听的时间轴由插件自己拼，不信模型写的数字。 */
function stripClock(text) {
  return String(text || '')
    .replace(/\d{1,2}:\d{2}(\s*[-–~至到]\s*\d{1,2}:\d{2})?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function clockOf(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function segmentLabel(start, dur) {
  return `${clockOf(start)}–${clockOf(Number(start) + Number(dur || 0))}`;
}

/** 00:69 这种非法秒数直接去掉。 */
function stripInvalidClock(text) {
  return String(text || '')
    .replace(/(\d{1,2}):(\d{2})/g, (whole, _m, sec) => (Number(sec) >= 60 ? '' : whole))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 正文里的时间一并刮掉：模型给的秒数不可信，时间统一由分段区间负责。 */
function stripClockEverywhere(text) {
  let s = String(text || '').replace(/(\d{1,2}):(\d{2})/g, '');
  s = s
    .replace(/从\s*\d*\s*分钟?\s*开始/g, '')
    .replace(/到\s*\d*\s*分钟?\s*结束/g, '')
    .replace(/从\s*开始/g, '')
    .replace(/到\s*结束/g, '')
    .replace(/在?\s*秒?\s*至\s*秒?\s*之间/g, '')
    .replace(/在?\s*的?\s*时间段内/g, '')
    .replace(/[（(]\s*[-–~至到]?\s*[)）]/g, '')
    .replace(/，\s*([。；;])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，、；;。\s]+/, '')
    .trim();
  return s;
}

/** 时间点超过这段音频实际长度的，整条丢掉。 */
function cleanTimeline(text, maxSec) {
  const limit = Number(maxSec) > 0 ? Number(maxSec) + 2 : Infinity;
  const kept = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const matches = [...line.matchAll(/(\d{1,2}):(\d{2})/g)];
    const bad = matches.some((m) => {
      const sec = Number(m[2]);
      const total = Number(m[1]) * 60 + sec;
      return sec >= 60 || total > limit;
    });
    if (matches.length && bad) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function featuresOf(file, cfg) {  try {
    const out = execFileSync(resolvePython(cfg), [ANALYZE, file], {
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const line = out.trim().split('\n').filter(Boolean).pop();
    return JSON.parse(line);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function parseAnswer(raw) {
  const text = String(raw ?? '').trim();
  const lines = text.split(/\r?\n/);
  const timeline = [];
  const extras = [];
  let mode = 'answer';
  const answer = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // 「时间点：」不一定在行首，出现在中间也要拆出来。
    const inlineAt = t.search(/(时间点|时间线|时间轴)[:：]/);
    if (inlineAt > 0) {
      const left = t.slice(0, inlineAt).trim();
      const right = t.slice(inlineAt).replace(/^(时间点|时间线|时间轴)[:：]\s*/, '').trim();
      if (left) {
        if (mode === 'extras') extras.push(left);
        else answer.push(left);
      }
      if (right && !/^(无|没有|none)/i.test(right)) timeline.push(right);
      continue;
    }
    if (/^(时间点|时间线|时间轴)[:：]/.test(t)) {
      const v = t.replace(/^(时间点|时间线|时间轴)[:：]\s*/, '');
      if (v && !/^(无|没有|none)/i.test(v)) timeline.push(v);
      mode = 'timeline';
      continue;
    }
    if (/^(补充|额外|没被问到|其它听感|其他听感)[:：]/.test(t)) {
      const v = t.replace(/^(补充|额外|没被问到|其它听感|其他听感)[:：]\s*/, '');
      if (v) extras.push(v);
      mode = 'extras';
      continue;
    }
    if (/^(回答|结论)[:：]/.test(t)) {
      answer.push(t.replace(/^(回答|结论)[:：]\s*/, ''));
      mode = 'answer';
      continue;
    }
    if (mode === 'timeline') timeline.push(t);
    else if (mode === 'extras') extras.push(t);
    else answer.push(t);
  }
  return {
    answer: answer.join('\n').trim() || text,
    extras: extras.join('\n').trim(),
    timeline: timeline.join('\n').trim(),
  };
}

function buildQuestion(userQuestion, questions) {
  const asked = [userQuestion, ...(Array.isArray(questions) ? questions : [])].filter(Boolean).join('；');
  return [
    '你在听一段音频。请认真听完，用中文回答，不要客套。',
    asked ? `我最想知道的：${asked}` : '请说说你听到的：音色、气声、语速、停顿、情绪、背景干不干净。',
    '先用一两句说这段里说了什么、发生了什么；听不清就说听不清，不要补。',
    '再说语气和情绪：是平铺直叙，还是带着明确态度；情绪给一个词。「坚定、认真、急切、敷衍」这类也算态度，语气稳不等于平静。',
    '然后写一行「总情绪：X」，X 只能是一个词，从平静/愉快/难过/生气/紧张/害怕/委屈/疲惫/激动/坚定/认真/急切/不确定里选一个。',
    '再说背景：只要有一层持续的声音就算「有背景声」，完全干净才说「安静」。',
    '最后说依据：你是从气声、语速、音高、停顿、轻重里哪几点听出来的。',
    '只说耳朵真听见的。不猜地点、人物、年代、曲风、乐器型号，不补场景。',
    '具体物件（掌声、碰杯、键盘、雨声这类）一律不点名字，只许说「杂音」或「背景声」。',
    '不要写超过这段长度的秒数；没听清的事不要编，宁可少说。',
  ].join('\n');
}

function decideMode(judgeMode, durationS, question) {
  if (judgeMode === 'dialog') return { mode: 'dialog', note: '当对话听' };
  if (judgeMode === 'material') return { mode: 'material', note: '当素材收了' };
  if (judgeMode === 'ask') return { mode: 'ask', note: '拿不准，先问一句：这是你在跟我说话，还是让我听东西' };
  const text = String(question || '');
  if (durationS == null) {
    if (/参考|素材|听听|听一下/.test(text)) return { mode: 'material', note: '当素材收了' };
    return { mode: 'ask', note: '拿不准，先问一句：这是你在跟我说话，还是让我听东西' };
  }
  if (durationS <= 20) return { mode: 'dialog', note: '当对话听' };
  if (durationS >= 60) return { mode: 'material', note: '当素材收了（超过一分钟，整段听可能漏细节）' };
  return { mode: 'ask', note: '拿不准，先问一句：这是你在跟我说话，还是让我听东西' };
}

function splitAudio(file, seconds = 60) {
  const cfg = readConfig();
  const outDir = path.join(os.tmpdir(), `dsh-hear-split-${Date.now()}`);
  const out = execFileSync(resolvePython(cfg), [SPLIT, file, outDir, String(seconds)], {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

/** 分段听的时候，每段的时间点要加上这一段的起点。 */
function offsetTimeline(text, offsetSec) {
  const offset = Math.round(Number(offsetSec) || 0);
  if (!text || !offset) return String(text || '');
  return String(text).replace(/(\d{1,2}):(\d{2})/g, (_m, m, s) => {
    const total = Number(m) * 60 + Number(s) + offset;
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  });
}

/** 模型给的情绪跟数值对不上时，提醒一句，不直接采信。 */
function checkEmotion(emotion, features) {
  if (!emotion || !features || !features.ok) return '';
  const f0Std = Number(features.f0_std_hz);
  const rmsStd = Number(features.rms_db_std);
  if (!Number.isFinite(f0Std) || !Number.isFinite(rmsStd)) return '';
  const flat = f0Std < 25 && rmsStd < 6;
  if (flat && /悲伤|难过|激动|生气|愤怒|狂喜/.test(emotion)) {
    return `数值上音高和能量起伏都很小（基频标准差 ${f0Std}Hz，能量标准差 ${rmsStd}dB），更像平静，不该直接判成「${emotion}」`;
  }
  return '';
}

/** 从回答里抠「总情绪」，格式乱了也能兜住。 */
const EMOTION_WORDS = ['平静', '愉快', '难过', '生气', '紧张', '害怕', '委屈', '疲惫', '激动', '坚定', '认真', '急切', '不确定', '轻松', '开心', '兴奋', '温和', '平淡', '友好'];

function extractEmotion(text) {
  const s = String(text || '');
  const strict = s.match(/总情绪[:：]\s*([^\n，。;；]{1,8})/);
  if (strict) return strict[1].trim();
  const loose = s.match(/(?:情绪|语气)(?:是|为|偏向)?\s*[:：]?\s*([^\n，。;；]{1,8})/);
  if (loose) {
    let word = loose[1].trim();
    for (let i = 0; i < 3; i += 1) {
      word = word.replace(/^(听起来|听上去|显得|比较|很|有点|像是|像|挺|蛮|非常|是)/, '');
    }
    word = word.replace(/[的地了]$/, '').split(/[和与及]/)[0].trim();
    // 「没有明显的情绪表达」这种，抓到的不是情绪词，别当情绪用。
    if (word && !/^(表达|波动|起伏|变化|感|的)/.test(word)) return word;
  }
  // 它把情绪写成「语气听起来很轻松」这种，就按词表捞第一个中的
  for (const w of EMOTION_WORDS) {
    if (s.includes(w)) return w;
  }
  return '';
}

function summarize(value) {
  if (value && value.needsConfirm) return String(value.message || '这段比较长，要不要分段听？');
  if (!value || typeof value !== 'object') return String(value);
  const lines = [];
  lines.push(value.answer ? value.answer : '（耳朵没给出结论）');
  if (value.extras) lines.push(`补充：${value.extras}`);
  if (value.timeline) lines.push(`时间点：${value.timeline}`);
  const f = value.features;
  if (f && f.ok) {
    lines.push(
      `数值：时长 ${f.duration_s}s｜基频中位 ${f.f0_median_hz ?? '-'}Hz｜能量 ${f.rms_db_mean ?? '-'}dB｜频谱重心 ${f.centroid_mean_hz ?? '-'}Hz｜停顿 ${f.pause_count ?? 0} 处`,
    );
  } else if (f && f.error) {
    lines.push(`数值：没算出来（${f.error}）`);
  }
  if (value.woke) lines.push('（这次是刚启动的，首句会慢一些）');
  if (value.segments > 1) lines.push(`（分成 ${value.segments} 段听的）`);
  if (value.consistency) lines.push(`（数值校对：${value.consistency}）`);
  if (value.modeNote) lines.push(`（${value.modeNote}）`);
  return lines.join('\n');
}

export function apply(ctx) {
  const ears = new EarsService(readConfig);
  const watcher = new QqWatcher(readConfig, () => ears);
  watcher.start();

  const guard = (req, res) => {
    const host = String(req.headers?.host ?? '').toLowerCase();
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    if (!(name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || host === '::1')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '只接受本机访问' }));
      return false;
    }
    if (req.method !== 'GET') {
      const origin = req.headers?.origin;
      if (origin) {
        try {
          if (new URL(String(origin)).host.toLowerCase() !== host) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: '跨站请求被拒绝' }));
            return false;
          }
        } catch {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '来源不明' }));
          return false;
        }
      }
    }
    return true;
  };

  function json(res, code, value) {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    } catch {}
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  // ── routes ────────────────────────────────────────────────────────────────
  const webServer = ctx.get('webServer');
  if (webServer) {
    const API = '/dsh-hear/api';
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: API,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const url = new URL(req.url, 'http://127.0.0.1');
        const sub = url.pathname.slice(API.length) || '/';
        try {
          if (sub === '/status' && req.method === 'GET') return json(res, 200, { ok: true, status: await ears.status(), qq: watcher.status(), cleanup: cleanupStatus(), config: readConfig() });
          if (sub === '/update/check' && req.method === 'GET') {
            let latest = null;
            let hasUpdate = false;
            try {
              const res = await fetch('https://registry.npmjs.org/dsh-hear/latest', { signal: AbortSignal.timeout(5000) });
              if (res.ok) {
                const json = await res.json();
                latest = json?.version || null;
                hasUpdate = Boolean(latest && latest !== VERSION);
              }
            } catch {}
            return json(res, 200, { ok: true, current: VERSION, latest, hasUpdate });
          }
          if (sub === '/onboard/check' && req.method === 'GET') return json(res, 200, { ok: true, check: await onboardCheck() });
          if (sub === '/onboard/done' && req.method === 'POST') {
            const next = writeConfig({ onboarded: true });
            return json(res, 200, { ok: true, config: next });
          }
          if (sub === '/cleanup' && req.method === 'POST') {
            const body = await readBody(req);
            const scope = ['voices', 'records', 'all'].includes(String(body?.scope)) ? String(body.scope) : 'all';
            const result = runCleanup(scope);
            if (scope !== 'voices') watcher.clear();
            return json(res, 200, { ok: true, ...result });
          }
          if (sub === '/reply/test' && req.method === 'POST') {
            const body = await readBody(req).catch(() => ({}));
            const text = String(body?.text || '耳朵试一条，能收到吗');
            const channel = (readConfig().bridges || [])[0];
            if (!channel || (!channel.baseUrl && !channel.webhookUrl)) {
              return json(res, 200, { ok: true, result: { sent: false, reason: '还没有填可用的桥接' } });
            }
            const result = await sendQqText(text, channel);
            return json(res, 200, { ok: true, result });
          }
          if (sub === '/cleanup/ack' && req.method === 'POST') {
            const cfg = readConfig();
            writeConfig({ cleanupReminder: { ...(cfg.cleanupReminder || {}), lastAskedAt: new Date().toISOString() } });
            return json(res, 200, { ok: true, cleanup: cleanupStatus() });
          }
          if (sub === '/start' && req.method === 'POST') {
            const body = await readBody(req).catch(() => ({}));
            const result = await ears.start(body?.force === true);
            if (result && result.needsConfirm) return json(res, 200, { ok: true, needsConfirm: true, vram: result.vram });
            return json(res, 200, { ok: true, status: result, config: readConfig() });
          }
          if (sub === '/port/free' && (req.method === 'GET' || req.method === 'POST')) {
            const cfg = readConfig();
            const start = Number(url.searchParams.get('start')) || cfg.port;
            const busy = Boolean(pidOnPort(start));
            const suggestion = busy ? await pickFreePort(start + 1) : start;
            return json(res, 200, { ok: true, port: start, busy, suggestion, url: `http://127.0.0.1:${suggestion}` });
          }
          // 只看不动：端口上是谁，是不是我们自己留下的。
          if (sub === '/port/check' && req.method === 'GET') {
            const cfg = readConfig();
            const port = Number(url.searchParams.get('port')) || cfg.port;
            const pid = pidOnPort(port);
            const info = pid ? describeProc(pid) : null;
            const ours = ears.pid || null;
            return json(res, 200, {
              ok: true,
              port,
              busy: Boolean(pid),
              pid: pid || null,
              name: info ? info.name : '',
              cmdline: info ? info.cmdline : '',
              owned: Boolean(pid) && pid === ours,
              zombie: Boolean(pid) && pid !== ours && looksLikeHear(info),
              suggestion: pid ? await pickFreePort(port + 1) : port,
            });
          }
          // 杀之前再核一遍：得是那只占着这个端口、而且确实是我们自己的进程。
          if (sub === '/port/kill' && req.method === 'POST') {
            const body = await readBody(req);
            const cfg = readConfig();
            const port = Number(body?.port) || cfg.port;
            const onPort = pidOnPort(port);
            const asked = Number(body?.pid || onPort || 0);
            if (!asked || asked !== onPort) {
              return json(res, 400, { ok: false, error: '这个 PID 现在没占着这个端口，没动' });
            }
            if (ears.pid && asked === ears.pid) {
              return json(res, 200, { ok: true, result: { killed: false, reason: '这是正在跑的那份，用停止按钮，别直接杀', pid: asked } });
            }
            const info = describeProc(asked);
            if (!looksLikeHear(info)) {
              return json(res, 200, { ok: true, result: { killed: false, reason: '这个进程不像耳朵的，没杀', info } });
            }
            killTree(asked);
            return json(res, 200, { ok: true, result: { killed: true, info } });
          }
          if (sub === '/stop' && req.method === 'POST') return json(res, 200, { ok: true, status: await ears.stop() });
          if (sub === '/config' && req.method === 'GET') return json(res, 200, { ok: true, config: readConfig() });
          if (sub === '/config' && req.method === 'POST') {
            const patch = await readBody(req);
            const next = writeConfig(patch && typeof patch === 'object' ? patch : {});
            // 切到云端就没有本地服务要养了，顺手关掉省显存。
            if (next.engine === 'cloud') await ears.stop().catch(() => {});
            return json(res, 200, { ok: true, config: next });
          }
          if (sub === '/records' && req.method === 'GET') {
            const limit = Number(url.searchParams.get('limit') || 20);
            return json(res, 200, { ok: true, records: listRecords(limit) });
          }
          if (sub === '/test' && req.method === 'POST') {
            const candidates = [
              path.join(HERE, 'samples', 'sample.wav'),
              'D:\\ai\\qwen-audio\\test.wav',
            ];
            const sample = candidates.find((p) => fs.existsSync(p));
            if (!sample) throw new Error('没有可试听的样例：放一个 wav 到 ' + candidates[0]);
            const cfg = readConfig();
            const heard = await ears.hear(sample, buildQuestion('这段音频里的人在说什么，语气什么样？'));
            const parsed = parseAnswer(heard.answer);
            return json(res, 200, {
              ok: true,
              sample,
              ...parsed,
              features: cfg.features ? featuresOf(sample, cfg) : null,
              secs: heard.secs,
              woke: heard.woke,
            });
          }
          if (sub === '/diagnose' && req.method === 'GET') return json(res, 200, await diagnose(ears));
          if (sub === '/repair' && req.method === 'POST') {
            const body = await readBody(req);
            return json(res, 200, { ok: true, ...(await repairChecks(ears, body?.ids)) });
          }
          if (sub === '/models' && req.method === 'GET') {
            return json(res, 200, { ok: true, models: modelStatus(readConfig()), disk: diskFree(), job: downloadSnapshot() });
          }
          if (sub === '/models/download' && req.method === 'POST') {
            const body = await readBody(req);
            return json(res, 200, { ok: true, job: startModelDownload(String(body?.id ?? '')) });
          }
          if (sub === '/models/progress' && req.method === 'GET') return json(res, 200, { ok: true, job: downloadSnapshot() });
          if (sub === '/models/cancel' && req.method === 'POST') return json(res, 200, { ok: true, job: cancelDownload() });
          if (sub === '/models/remove' && req.method === 'POST') {
            const body = await readBody(req);
            return json(res, 200, { ok: true, ...(await removeModel(String(body?.id ?? ''), ears)) });
          }
          if (sub === '/models/select' && req.method === 'POST') {
            const body = await readBody(req);
            const cfg = readConfig();
            const model = MODELS.find((m) => m.id === String(body?.id ?? ''));
            if (!model) throw new Error(`未知模型：${body?.id}`);
            if (!model.requires || !model.requires.engine) {
              return json(res, 200, {
                ok: false,
                error: `${model.name} 还没接推理，现在只会下载和体检，切过去也听不了`,
                model: { id: model.id, name: model.name },
              });
            }
            const dirs = { ...(cfg.modelDirs || {}) };
            if (!dirs[cfg.modelId]) dirs[cfg.modelId] = cfg.modelDir;
            const dir = dirs[model.id] || (model.id === cfg.modelId ? cfg.modelDir : path.join(path.dirname(cfg.modelDir), model.dir));
            const next = writeConfig({
              modelId: model.id,
              modelDir: dir,
              modelDirs: { ...dirs, [model.id]: dir },
              engine: 'local',
            });
            await ears.stop();
            return json(res, 200, { ok: true, config: next, status: await ears.status() });
          }
          if (sub === '/errors' && req.method === 'GET') return json(res, 200, { ok: true, errors: readErrors(50) });
          if (sub === '/qq/status' && req.method === 'GET') return json(res, 200, { ok: true, qq: watcher.status() });
          if (sub === '/qq/clear' && req.method === 'POST') {
            watcher.clear();
            return json(res, 200, { ok: true, qq: watcher.status() });
          }
          if (sub === '/qq/restart' && req.method === 'POST') {
            watcher.start();
            return json(res, 200, { ok: true, qq: watcher.status() });
          }
          // 试一下某条桥到底发不发得出去：这是「回复没接上」最直接的验证。
          if (sub === '/qq/test' && req.method === 'POST') {
            const body = await readBody(req).catch(() => ({}));
            const list = (readConfig().bridges || []).filter((b) => b && b.enabled !== false);
            const target = body?.name ? list.find((b) => b.name === body.name) : list[0];
            if (!target) return json(res, 200, { ok: true, result: { sent: false, reason: '没有启用的桥接' } });
            if (!target.baseUrl) return json(res, 200, { ok: true, result: { sent: false, reason: `${target.name || '这条桥'}没填 OneBot 地址，发不出去` } });
            if (!target.target) return json(res, 200, { ok: true, result: { sent: false, reason: `${target.name || '这条桥'}没填发给谁` } });
            try {
              await sendQqText(String(body?.text || '耳朵试一条，能收到吗'), target);
              return json(res, 200, { ok: true, result: { sent: true, bridge: target.name || '', to: target.target } });
            } catch (error) {
              return json(res, 200, { ok: true, result: { sent: false, reason: String(error?.message ?? error) } });
            }
          }
          if (sub === '/client-error' && req.method === 'POST') {
            const body = await readBody(req);
            logError('client', String(body?.message ?? 'unknown'), body?.stack);
            return json(res, 200, { ok: true });
          }
          if (sub === '/errors/clear' && req.method === 'POST') {
            try {
              fs.writeFileSync(ERROR_FILE, '', 'utf8');
            } catch {}
            return json(res, 200, { ok: true });
          }
          return json(res, 404, { ok: false, error: `未知接口：${sub}` });
        } catch (error) {
          logError('api', error?.message ?? error, error?.stack);
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }));
  }

  // ── tools ─────────────────────────────────────────────────────────────────
  const tools = ctx.get('tools');
  if (tools) {
    ctx.effect(() => tools.register({
      name: 'hear',
      description: [
        '听一段音频（wav / mp3 / QQ 的 silk 都行），返回四块：听感结论、它自己补充的、情绪或状态的时间点、以及本地算的数值。',
        '输入音频绝对路径和你想知道的问题。第一次调用会启动服务并加载模型（约 40 秒），返回值里会注明这次是不是刚启动的。',
        '这不是转文字：整段波形直接交给会听音频的模型。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '音频文件的绝对路径' },
          question: { type: 'string', description: '想问耳朵什么，可不填' },
          questions: { type: 'array', items: { type: 'string' }, description: '一次问几条，可选' },
          analyze: { type: 'boolean', description: '是否同时算基频/能量/频谱/停顿，默认开' },
          segment: { type: 'boolean', description: '超过一分钟的音频是否分段听；不传会先返回一句询问，由你问用户后再带这个参数重调' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: summarize(value) }],
      },
      execute: async (args) => {
        const cfg = readConfig();
        const file = path.resolve(String(args.path));
        const features = args.analyze === false || !cfg.features ? null : featuresOf(file, cfg);
        const duration = features?.ok ? features.duration_s : null;

        // 超过一分钟先问一句，别自己决定整段硬听。
        if (duration && duration > 60 && args.segment !== true && args.segment !== false) {
          const minutes = Math.floor(duration / 60);
          const seconds = Math.round(duration % 60);
          return {
            needsConfirm: true,
            path: file,
            duration,
            message: `这段音频 ${minutes} 分 ${seconds} 秒，超过一分钟。要分段听吗？分段会多花一点时间，但不容易漏细节；不分就是整段听。告诉我选哪个，我再继续。`,
          };
        }

        const { mode, note } = decideMode(cfg.judgeMode, duration, args.question);
        const listen = async (target, question) => {
          const heard = await ears.hear(target, question);
          const parsed = parseAnswer(heard.answer);
          return { ...parsed, secs: heard.secs, woke: heard.woke };
        };

        let result;
        if (args.segment === true && duration && duration > 60) {
          const split = splitAudio(file, 30);
          const pieces = [];
          for (let i = 0; i < split.chunks.length; i += 1) {
            const chunk = split.chunks[i];
            const part = await listen(chunk.path, buildQuestion(
              `第 ${i + 1}/${split.chunks.length} 段，本段从整段的 ${Math.round(chunk.start)} 秒开始，只描述这一段；时间点一律用本段内的 mm:ss，从 0:00 起算。${args.question || ''}`,
              args.questions,
            ));
            part.answer = stripClockEverywhere(part.answer);
            part.extras = stripClockEverywhere(part.extras);
            pieces.push({ start: chunk.start, dur: chunk.dur, ...part });
          }
          result = {
            answer: pieces.map((p, i) => `第 ${i + 1} 段（${segmentLabel(p.start, p.dur)}）：${p.answer}`).join('\n'),
            extras: pieces.map((p) => p.extras).filter(Boolean).join('\n'),
            // 时间点不让模型自己标，只保留它在段内看到的变化，时间用段的起止。
            timeline: pieces.map((p) => {
              const text = stripClock(p.timeline);
              return text ? `${segmentLabel(p.start, p.dur)} ${text}` : '';
            }).filter(Boolean).join('\n'),
            segments: pieces.length,
            secs: Math.round(pieces.reduce((sum, p) => sum + (Number(p.secs) || 0), 0) * 10) / 10,
            woke: pieces.some((p) => p.woke),
          };
        } else {
          const single = await listen(file, buildQuestion(args.question, args.questions));
          single.answer = stripClockEverywhere(single.answer);
          single.extras = stripClockEverywhere(single.extras);
          single.timeline = cleanTimeline(single.timeline, duration);
          result = { ...single, segments: 1 };
        }

        let finalMode = mode;
        let finalNote = note;
        // 短音频里说的是「你听听这个」这种，多半是素材，不该当问话。
        if (finalMode === 'dialog' && /你听听|听听这个|听一下这个|你听一下/.test(String(result.answer))) {
          finalMode = 'material';
          finalNote = '当素材收了（里面是让我听东西，不是问话）';
        }
        // 它自己都说判断不出意图，就别替它下结论，先问一句。
        // 只看「意图/目的」这类说法，别把「总情绪：不确定」也算进来。
        if (finalMode !== 'ask' && cfg.judgeMode === 'auto'
          && /(无法确定|无法判断|不能确定|不确定|不清楚|拿不准|分不清|看不出来)[^。\n]{0,15}(意图|目的|是跟我说话|冲我说话|对话还是)/.test(String(result.answer))) {
          finalMode = 'ask';
          finalNote = '拿不准，先问一句：这是你在跟我说话，还是让我听东西';
        }

        const record = {
          at: new Date().toISOString(),
          path: file,
          question: String(args.question ?? ''),
          questions: args.questions ?? [],
          raw: result.answer,
          mode: finalMode,
          modeNote: finalNote,
          emotion: extractEmotion(result.answer),
          consistency: checkEmotion(extractEmotion(result.answer), features),
          answer: result.answer,
          extras: result.extras,
          timeline: result.timeline,
          segments: result.segments,
          features,
          secs: result.secs,
          sampleSeconds: duration,
          woke: result.woke,
        };
        if (cfg.recordEnabled) saveRecord(cfg, record);
        watcher.forget(file);
        return record;
      },
    }));

    ctx.effect(() => tools.register({
      name: 'hear_control',
      description: '耳朵的手动开关：查状态（已启动还是未启动、占多少显存）、启动、关闭、看最近听过的记录。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'stop', 'records'], description: '要做什么' },
          limit: { type: 'number', description: 'records 时取几条，默认 5' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value).slice(0, 2000) }],
      },
      execute: async (args) => {
        if (args.action === 'start') {
          const status = await ears.start();
          if (status && status.needsConfirm) {
            return { text: `显存不够加载耳朵（空闲 ${status.vram.freeMiB} MiB，需要约 ${status.vram.needMiB} MiB）。问他一句要不要先关掉语音合成再启动` };
          }
          return { text: `耳朵已启动${status.modelLoaded ? '，模型也加载好了' : '，模型还在加载，第一句会慢一点'}` };
        }
        if (args.action === 'stop') {
          await ears.stop();
          return { text: '耳朵已关闭，显存放开了' };
        }
        if (args.action === 'records') {
          const rows = listRecords(Number(args.limit) || 5);
          if (!rows.length) return { text: '还没有听过的记录' };
          return { text: rows.map((r) => `${r.at}｜${path.basename(r.path)}｜${String(r.answer ?? '').slice(0, 80)}`).join('\n') };
        }
        const s = await ears.status();
        const vram = s.vram ? `显存 ${s.vram.usedMiB}/${s.vram.totalMiB} MiB` : '显存读不到';
        const phase = s.modelLoaded ? '已启动' : s.serviceUp ? '正在启动（模型还在加载）' : '未启动';
        return {
          text: `${phase}｜${vram}｜最近一次听：${s.lastHearAt ? new Date(s.lastHearAt).toLocaleString('zh-CN') : '还没有'}`,
        };
      },
    }));
  }

  // 卸载倒计时不听完就开始：等这一轮说完、agent 回到 idle 之后，才按配置的分钟数起算。
  ctx.on('agent/status', (payload) => {
    try {
      if (!payload || !payload.agent) return;
      if (payload.status === 'running') {
        ears.clearIdle();
      } else if (payload.status === 'idle') {
        if (ears.proc || ears.pid) ears.armIdle();
      }
    } catch {}
  });
  ctx.on('agent/inbox/inserted', () => {
    try {
      ears.clearIdle();
    } catch {}
  });

  // 把自动听到的 QQ 语音带进上下文，不用手动问。
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'dsh-hear-qq',
      order: 55,
      text: () => {
        // 这一段每一轮都会跑，里面任何一处抛错都会把整轮 agent 带崩，所以兜住。
        try {
          const parts = [watcher.contextText(), rulesText()];
          const zombie = zombieNotice(readConfig(), ears.pid || 0, ears.phase);
          if (zombie) parts.push(zombie);
          const cleanup = cleanupStatus();
          if (cleanup.due) {
            parts.push(`清理提醒：这两天有 ${cleanup.voices} 个语音文件、${cleanup.records} 条听音记录、${cleanup.temps} 份切段临时文件（约 ${formatSize(cleanup.bytes)}）。该问主人一次要不要清掉，他说清再删，没说清就一条都别动。`);
          }
          return parts.filter(Boolean).join('\n\n');
        } catch (error) {
          logError('prompt', String(error?.message ?? error));
          return '';
        }
      },
    }));
  }

  // 卸载插件或退出进程时，只收自己起的那个进程。
  const onExit = () => {
    if (ears.owned && ears.pid) killTree(ears.pid);
  };
  process.once('exit', onExit);
  ctx.effect(() => () => {
    watcher.stop();
    process.removeListener('exit', onExit);
    ears.clearIdle();
    if (ears.owned) {
      const pid = ears.pid;
      ears.phase = 'off';
      killTree(pid);
    }
  });
}

function saveRecord(cfg, record) {
  try {
    mkdirp(cfg.recordDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(cfg.recordDir, `${stamp}.json`), JSON.stringify(record, null, 2), 'utf8');
  } catch (error) {
    logError('record', error?.message ?? error, error?.stack);
  }
}

function listRecords(limit = 20) {
  const cfg = readConfig();
  try {
    const files = fs.readdirSync(cfg.recordDir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, Math.max(1, limit));
    return files.map((f) => {
      const data = readJson(path.join(cfg.recordDir, f), null);
      return data ? { file: f, ...data } : { file: f, at: '', path: '', answer: '' };
    });
  } catch {
    return [];
  }
}

function modelStatus(cfg) {
  return MODELS.map((m) => {
    const check = modelCheck(m, cfg);
    return {
      ...m,
      dir: check.dir,
      installed: check.complete,
      installedSize: check.exists ? check.sizeText : null,
      current: check.current,
      files: check.files,
      complete: check.complete,
    };
  });
}

function modelDirOf(model, cfg = readConfig()) {
  const pinned = cfg.modelDirs && cfg.modelDirs[model.id];
  if (pinned) return pinned;
  if (model.id === cfg.modelId) return cfg.modelDir;
  return path.join(path.dirname(cfg.modelDir), model.dir);
}

function expectedBytes(sizeText) {
  const value = Number(String(sizeText).replace(/[^\d.]/g, ''));
  return Number.isFinite(value) ? value * 1024 ** 3 : 0;
}

/** 一个模型的体检：目录在不在、关键文件齐不齐、大小对不对。 */
function modelCheck(model, cfg = readConfig()) {
  const dir = modelDirOf(model, cfg);
  const exists = fs.existsSync(dir);
  let files = 0;
  let weights = 0;
  let sizeBytes = 0;
  if (exists) {
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {}
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          files += 1;
          try {
            sizeBytes += fs.statSync(full).size;
          } catch {}
          if (/\.(safetensors|bin|pth|gguf)$/i.test(entry.name)) weights += 1;
        }
      }
    }
  }
  const hasConfig = exists && fs.existsSync(path.join(dir, 'config.json'));
  const expected = expectedBytes(model.size);
  const complete = Boolean(exists && hasConfig && weights > 0 && (expected === 0 || sizeBytes >= expected * 0.5));
  return {
    id: model.id,
    name: model.name,
    dir,
    exists,
    files,
    weights,
    sizeBytes,
    expectedBytes: expected,
    sizeText: exists ? formatGB(sizeBytes) : '—',
    complete,
    current: model.id === cfg.modelId,
    engine: (model.requires && model.requires.engine) || null,
    listenable: Boolean(model.requires && model.requires.engine),
    note: model.note,
  };
}

function diskFree() {
  try {
    const s = fs.statfsSync(path.dirname(readConfig().modelDir));
    return { freeBytes: Number(s.bfree) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

// 一个下载任务，插件里同时只跑一个。
const downloads = { job: null };

async function listModelFiles(id) {
  const res = await fetch(`https://www.modelscope.cn/api/v1/models/${id}/repo/files?Revision=master&Recursive=true`, {
    headers: { 'user-agent': 'dsh-hear' },
  });
  if (!res.ok) throw new Error(`列文件失败：HTTP ${res.status}`);
  const data = await res.json();
  const files = data?.Data?.Files ?? [];
  return files
    .filter((f) => f?.Type === 'blob' && Number(f.Size) >= 0)
    .map((f) => ({ path: String(f.Path), size: Number(f.Size) }));
}

function downloadSnapshot() {
  const job = downloads.job;
  if (!job) return null;
  const now = Date.now();
  job.samples.push({ t: now, done: job.done });
  while (job.samples.length > 2 && now - job.samples[0].t > 3000) job.samples.shift();
  const first = job.samples[0];
  const span = (now - first.t) / 1000;
  const speed = span > 0.3 ? Math.max(0, (job.done - first.done) / span) : 0;
  return {
    id: job.id,
    name: job.name,
    dir: job.dir,
    phase: job.phase,
    total: job.total,
    done: job.done,
    percent: job.total ? Math.round((job.done / job.total) * 1000) / 10 : 0,
    file: job.file,
    fileIndex: job.fileIndex,
    files: job.files,
    speed,
    error: job.error,
    startedAt: job.startedAt,
  };
}

function startModelDownload(id) {
  if (downloads.job && ['listing', 'downloading'].includes(downloads.job.phase)) {
    throw new Error('已经有一个模型在下载了');
  }
  const cfg = readConfig();
  const model = MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`未知模型：${id}`);
  const job = {
    id,
    name: model.name,
    dir: modelDirOf(model, cfg),
    phase: 'listing',
    total: 0,
    done: 0,
    files: 0,
    fileIndex: 0,
    file: '',
    error: null,
    startedAt: Date.now(),
    samples: [{ t: Date.now(), done: 0 }],
    controller: new AbortController(),
  };
  downloads.job = job;
  writeConfig({ modelDirs: { ...(cfg.modelDirs || {}), [id]: job.dir } });
  runDownload(job).catch((error) => {
    if (String(error?.name) === 'AbortError') {
      job.phase = 'cancelled';
      return;
    }
    job.phase = 'error';
    job.error = String(error?.message ?? error);
    logError('download', `${id}: ${job.error}`, error?.stack);
  });
  return downloadSnapshot();
}

async function runDownload(job) {
  const files = await listModelFiles(job.id);
  if (!files.length) throw new Error('这个模型没有可下载的文件');
  job.total = files.reduce((sum, f) => sum + f.size, 0);
  job.files = files.length;
  job.phase = 'downloading';
  mkdirp(job.dir);
  for (let i = 0; i < files.length; i += 1) {
    if (job.controller.signal.aborted) throw new Error('已取消');
    const file = files[i];
    job.file = file.path;
    job.fileIndex = i + 1;
    const dest = path.join(job.dir, ...file.path.split('/'));
    try {
      const stat = fs.statSync(dest);
      if (stat.size === file.size) {
        job.done += file.size;
        continue;
      }
    } catch {}
    mkdirp(path.dirname(dest));
    const url = `https://www.modelscope.cn/api/v1/models/${job.id}/repo?Revision=master&FilePath=${encodeURIComponent(file.path)}`;
    const res = await fetch(url, { signal: job.controller.signal, headers: { 'user-agent': 'dsh-hear' } });
    if (!res.ok || !res.body) throw new Error(`下载 ${file.path} 失败：HTTP ${res.status}`);
    const tmp = `${dest}.part`;
    const counter = async function* (source) {
      for await (const chunk of source) {
        job.done += chunk.length;
        yield chunk;
      }
    };
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  }
  job.phase = 'done';
}

function cancelDownload() {
  if (downloads.job && ['listing', 'downloading'].includes(downloads.job.phase)) {
    downloads.job.controller.abort();
    downloads.job.phase = 'cancelled';
    return downloadSnapshot();
  }
  return downloadSnapshot();
}

async function removeModel(id, ears) {
  const cfg = readConfig();
  const model = MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`未知模型：${id}`);
  const dir = modelDirOf(model, cfg);
  const base = path.resolve(path.dirname(cfg.modelDir));
  const target = path.resolve(dir);
  if (target === base || !target.startsWith(base + path.sep)) throw new Error('这个目录不在模型目录下，不敢删');
  if (path.resolve(cfg.modelDir) === target && ears) await ears.stop();
  if (!fs.existsSync(target)) return { removed: false, dir: target };
  fs.rmSync(target, { recursive: true, force: true });
  return { removed: true, dir: target };
}

async function diagnose(ears) {
  const cfg = readConfig();
  const checks = [];
  const add = (id, title, ok, detail, fix = '', action = '') => checks.push({ id, title, ok, detail, fix, action, fixable: Boolean(action) });

  const health = await ears.health(1500);
  add('service', '/health 能不能通', Boolean(health), health ? `已通（${health.device ?? '?'}）` : '连不上，服务没起来或崩了', '点「一键启动」', 'start');

  add('script', '耳朵服务脚本存在', fs.existsSync(cfg.serviceScript), cfg.serviceScript, '改「服务脚本」路径');

  const py = resolvePython(cfg);
  add('python', 'Python 解释器存在', fs.existsSync(py), py || '没找到，去「选项」填路径', '去「选项」填 Python 路径');

  const active = MODELS.find((m) => m.id === cfg.modelId) || MODELS[0];
  const activeCheck = modelCheck(active, cfg);
  add('model', `当前模型：${active.name}`, activeCheck.complete, `${activeCheck.sizeText}｜${activeCheck.dir}${activeCheck.complete ? '' : '｜文件不全，去模型页补'}`);

  const pid = pidOnPort(cfg.port);
  add('port', `端口 ${cfg.port}`, Boolean(health) ? Boolean(pid) : !pid, health ? (pid ? `被 PID ${pid} 占着（就是耳朵）` : '健康但查不到占用进程') : (pid ? `被 PID ${pid} 占着，不是耳朵` : '空着'), '看「诊断」里的占用进程');

  const gpu = gpuInfo();
  if (gpu) {
    const free = gpu.totalMiB - gpu.usedMiB;
    add('vram', '显存余量够 4.5G', free >= 4500, `空闲 ${free} MiB / 共 ${gpu.totalMiB} MiB`, '先关 IndexTTS，再考虑关合成');
  } else {
    add('vram', '显卡', false, 'nvidia-smi 读不到，可能没独显', '走云端或纯 CPU');
  }

  const recordDirOk = (() => {
    try {
      mkdirp(cfg.recordDir);
      const probe = path.join(cfg.recordDir, '.probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  })();
  add('records', '记录目录可写', recordDirOk, cfg.recordDir, '改「记录目录」', 'mkdir-records');

  let ffmpeg = '';
  try {
    ffmpeg = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).split('\n')[0].trim();
  } catch {}
  add('ffmpeg', 'ffmpeg 在不在', Boolean(ffmpeg), ffmpeg || '没找到，mp4 / m4a 这类格式可能解不开（wav、mp3、silk 不受影响）', '点「修复」用 winget 装，或自己填路径', 'winget-ffmpeg');

  // Python 侧一次问完，省时间。
  let pyInfo = null;
  try {
    const out = execFileSync(py, ['-c', 'import json,sys\nmods={}\nfor m in ("torch","bitsandbytes","pysilk","numpy","soundfile","transformers","librosa","sentencepiece","accelerate"):\n    try:\n        __import__(m); mods[m]=True\n    except Exception: mods[m]=False\ntry:\n    import torch\n    mods["cuda"]=bool(torch.cuda.is_available())\n    mods["cuda_name"]=torch.cuda.get_device_name(0) if torch.cuda.is_available() else None\nexcept Exception as e:\n    mods["cuda"]=False\nprint(json.dumps(mods))'], {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    pyInfo = JSON.parse(out.trim().split('\n').pop());
  } catch (error) {
    pyInfo = { error: String(error?.message ?? error) };
  }
  if (pyInfo && !pyInfo.error) {
    add('torch', 'torch 能见到显卡', Boolean(pyInfo.cuda), pyInfo.cuda ? String(pyInfo.cuda_name) : '只能 CPU 跑，很慢', '按 CUDA 版本装 torch');
    add('bnb', 'bitsandbytes（4bit 靠它）', Boolean(pyInfo.bitsandbytes), pyInfo.bitsandbytes ? '在' : '缺了装不下 16G 模型', '点「修复」用 pip 装', 'pip:bitsandbytes');
    add('silk', 'pysilk（QQ 语音是 silk）', Boolean(pyInfo.pysilk), pyInfo.pysilk ? '在' : '听不了 QQ 语音条', '点「修复」用 pip 装', 'pip:pysilk');
    add('numpy', 'numpy / soundfile', Boolean(pyInfo.numpy && pyInfo.soundfile), `${pyInfo.numpy ? 'numpy 在' : 'numpy 缺'} / ${pyInfo.soundfile ? 'soundfile 在' : 'soundfile 缺'}`, '点「修复」用 pip 装', 'pip:numpy,soundfile');
  } else {
    add('python', 'Python 依赖检查', false, pyInfo?.error ?? '跑不起来', '先修 Python 环境');
  }

  const ok = checks.filter((c) => c.ok).length;
  const fail = checks.length - ok;

  // 每个模型的体检项不一样：有的要 4bit 量化，有的要 trust_remote_code，有的自带 int4。
  const modelReports = MODELS.map((model) => {
    const check = modelCheck(model, cfg);
    const req = model.requires || {};
    const missingModules = (req.modules || []).filter((name) => pyInfo && pyInfo[name] === false);
    const needBnb = Boolean(req.bitsandbytes);
    const vramOk = gpu ? Math.round(gpu.totalMiB / 1024) >= Number(req.vram || 0) : false;
    const engineOk = req.engine === 'qwen2audio';
    const requirements = [
      { key: 'files', title: '模型文件', ok: check.complete, detail: check.complete ? `${check.sizeText} 齐` : check.exists ? `文件不全（${check.sizeText}）` : '没有这个目录' },
      { key: 'modules', title: 'Python 依赖', ok: missingModules.length === 0, detail: missingModules.length ? `缺 ${missingModules.join('、')}` : '齐' },
      { key: 'bitsandbytes', title: 'bitsandbytes（4bit）', ok: needBnb ? Boolean(pyInfo?.bitsandbytes) : true, detail: needBnb ? (pyInfo?.bitsandbytes ? '在，能按 4bit 加载' : '缺，这个模型要靠它压进显存') : '这个模型不用 4bit 量化' },
      { key: 'trust', title: 'trust_remote_code', ok: true, detail: req.trustRemoteCode ? '需要（服务里得开）' : '不需要' },
      { key: 'vram', title: `显存 ${req.vram}G`, ok: vramOk, detail: gpu ? `显卡共 ${Math.round(gpu.totalMiB / 1024)}G` : '读不到显卡' },
      { key: 'engine', title: '推理适配', ok: engineOk, detail: engineOk ? '内置，能直接听' : '还没内置，选它暂时听不了' },
    ];
    return { ...check, requires: req, requirements };
  }).filter((item) => item.complete || item.current);

  const report = {
    ok: fail === 0,
    summary: { ok, fail, total: checks.length },
    checks,
    models: modelReports,
    activeModel: active.id,
    gpu,
    at: new Date().toISOString(),
  };
  // 诊断结果落盘，方便前后对比。
  try {
    const dir = path.join(STATE_DIR, 'diagnose');
    mkdirp(dir);
    fs.writeFileSync(path.join(dir, `${report.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2), 'utf8');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    while (files.length > 10) {
      const oldest = files.shift();
      try {
        fs.unlinkSync(path.join(dir, oldest));
      } catch {}
    }
  } catch {}
  return report;
}

function tail(text, n = 600) {
  const s = String(text ?? '').trim();
  return s.length > n ? '…' + s.slice(-n) : s;
}

/** 一键修复：只动那些标了 action 的失败项，跑完重新体检一次。 */
async function repairChecks(ears, ids) {
  const cfg = readConfig();
  const before = await diagnose(ears);
  let targets = before.checks.filter((c) => !c.ok && c.fixable);
  if (Array.isArray(ids) && ids.length) targets = targets.filter((c) => ids.includes(c.id));
  const results = [];
  for (const check of targets) {
    const started = Date.now();
    try {
      const detail = await runFix(check.action, cfg, ears);
      results.push({ id: check.id, title: check.title, ok: true, detail, ms: Date.now() - started });
    } catch (error) {
      logError('repair', `${check.id}: ${error?.message ?? error}`, error?.stack);
      results.push({ id: check.id, title: check.title, ok: false, detail: String(error?.message ?? error), ms: Date.now() - started });
    }
  }
  return { results, repaired: results.filter((r) => r.ok).length, diagnose: await diagnose(ears) };
}

async function runFix(action, cfg, ears) {
  if (action === 'start') {
    const status = await ears.start();
    return status.serviceUp ? '服务已启动' : '服务还没起来';
  }
  if (action === 'mkdir-records') {
    mkdirp(cfg.recordDir);
    fs.accessSync(cfg.recordDir, fs.constants.W_OK);
    return '记录目录已可写';
  }
  if (action.startsWith('pip:')) {
    const pkgs = action.slice(4).split(',').map((s) => s.trim()).filter(Boolean);
    const out = execFileSync(resolvePython(cfg), ['-m', 'pip', 'install', '--disable-pip-version-check', ...pkgs], {
      encoding: 'utf8',
      timeout: 600000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    return `已装 ${pkgs.join(', ')}\n${tail(out)}`;
  }
  if (action === 'winget-ffmpeg') {
    const out = execFileSync('winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-package-agreements', '--accept-source-agreements', '--silent'], {
      encoding: 'utf8',
      timeout: 900000,
      windowsHide: true,
    });
    return `winget 已执行（新开的窗口才认 PATH）\n${tail(out)}`;
  }
  throw new Error(`没有对应的修复动作：${action}`);
}
