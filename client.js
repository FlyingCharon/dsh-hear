/**
 * dsh-hear 的设置页（Client 半）。
 *
 * 四个页签：状态 / 选项 / 模型 / 诊断。
 * 数据全部走同源 /dsh-hear/api/*，不直接碰宿主 DOM。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hear',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = '/dsh-hear/api';

    const CLOUD = [
      { id: 'gemini', name: 'Gemini 2.x', note: '音频理解强，按量计费' },
      { id: 'openai', name: 'GPT-4o', note: '音频理解强，按量计费' },
      { id: 'qwen', name: '通义 Qwen-Omni', note: '国内可直连，便宜' },
    ];

    const ZH = {
      nav: '鱼鱼的耳朵',
      title: '鱼鱼的耳朵',
      sub: '整段波形交给音频模型，再用基频、能量、频谱、停顿去核对',
      status: '状态',
      options: '选项',
      models: '模型',
      doctor: '诊断',
      on: '已启动',
      off: '未启动',
      loading: '正在启动',
      error: '出错',
      start: '一键启动',
      stop: '一键停止',
      wake: '立即启动',
      sleep: '立即关闭',
      sample: '试听一段示例',
      vram: '显存',
      modelState: '模型',
      lastHear: '最近一次听',
      never: '还没有',
      port: '端口',
      pid: '进程',
      serviceUrl: '服务地址',
      pythonPath: 'Python 路径',
      serviceScript: '服务脚本',
      modelDir: '模型目录',
      settle: '说完判定',
      idle: '空闲卸载',
      settleHint: '连续发送音频时，发送的最后一条静默多久之后才算是完整的一段信息，在此期间，鱼鱼不会逐条回复，而是等到信息凑齐之后再进行回复',
      idleHint: '小鱼鱼回话完多久之后，若主人没再发送新音频就会自动将识别模型从后台卸载，以解放显存',
      judge: '判断模式',
      engine: '引擎',
      engineLocal: '本地',
      engineCloud: '云端',
      provider: '服务商',
      apiKey: 'API Key',
      cloudModel: '模型',
      baseUrl: '接口地址',
      engineHint: '本地用显卡，云端用 API，不占显存也不用下载模型',
      features: '数值块',
      record: '落盘记录',
      recordDir: '记录目录',
      vramPrio: '显存优先级',
      save: '保存',
      saveRestart: '保存并重启 QQ 桥接',
      revert: '撤销改动',
      reload: '重新读取',
      dirty: '有改动还没保存',
      saved: '已保存',
      tabStatusHint: '先启动，第一次听会加载模型，大约几十秒',
      tabOptionsHint: '改完点保存；能立刻生效的不用重启',
      tabModelsHint: '根据自身情况选择合适的模型~',
      tabDoctorHint: '一条一项，红了先看诊断',
      check: '一键体检',
      copyReport: '复制诊断报告',
      copyCmd: '复制下载命令',
      installed: '已安装',
      notInstalled: '未安装',
      current: '当前',
      gpuTotal: '共',
      free: '空闲',
      recent: '最近听过',
      empty: '还没有记录',
      bridge: '桥接',
      bridgeOff: '未接',
      auto: '自动判断',
      ask: '每次都先问',
      dialog: '一律当对话',
      material: '一律当素材',
      prioIndex: '先关 IndexTTS',
      prioVoice: '先关语音合成',
      prioLast: '先关耳朵',
      testOk: '示例听完了，下面是最新的一条记录',
      busy: '处理中',
      failed: '出错了',
    };
    const EN = {
      nav: 'Ears', title: 'Ears', sub: 'Whole waveform to an audio model, verified with pitch, energy, spectrum and pauses',
      status: 'Status', options: 'Options', models: 'Models', doctor: 'Diagnostics',
      on: 'started', off: 'not started', loading: 'starting', error: 'error',
      start: 'Start', stop: 'Stop', wake: 'Start now', sleep: 'Stop now', sample: 'Try a sample',
      vram: 'VRAM', modelState: 'Model', lastHear: 'Last heard', never: 'never', port: 'Port', pid: 'PID',
      serviceUrl: 'Service URL', settle: 'Settle', idle: 'Idle unload',
      settleHint: 'Quiet time after the last audio before it counts as finished; nothing is answered until then.',
      idleHint: 'Unload the model from VRAM after this much silence; it reloads on demand next time.', judge: 'Judge mode',
      engine: 'Engine', engineLocal: 'Local', engineCloud: 'Cloud',
      provider: 'Provider', apiKey: 'API key', cloudModel: 'Model', baseUrl: 'Base URL',
      engineHint: 'Local uses the GPU; cloud uses an API with no VRAM and no model download',
      features: 'Measurements', record: 'Save records', recordDir: 'Record dir', vramPrio: 'VRAM priority',
      save: 'Save', saveRestart: 'Save and restart QQ bridge', revert: 'Revert', reload: 'Reload', dirty: 'Unsaved changes', saved: 'Saved',
      check: 'Run checks', copyReport: 'Copy report', copyCmd: 'Copy command', installed: 'installed', notInstalled: 'not installed', current: 'current',
      gpuTotal: 'total', free: 'free', recent: 'Recently heard', empty: 'nothing yet', bridge: 'Bridge', bridgeOff: 'disconnected',
      auto: 'auto', ask: 'ask first', dialog: 'always dialogue', material: 'always material',
      prioIndex: 'Close IndexTTS first', prioVoice: 'Close voice first', prioLast: 'Close ears first',
      testOk: 'Sample heard', busy: 'working', failed: 'failed',
    };

    function makeT(ctx) {
      const dicts = { zh: ZH, en: EN };
      try {
        if (ctx.locale) {
          for (const id of Object.keys(dicts)) ctx.locale.register('dsh-hear', id, dicts[id]);
          const bound = ctx.locale.bind('dsh-hear');
          return (key) => {
            try {
              const v = bound(key);
              return typeof v === 'string' ? v : ZH[key] || key;
            } catch {
              return ZH[key] || key;
            }
          };
        }
      } catch {}
      return (key) => ZH[key] || key;
    }

    function padBridges(cfg) {
      const list = [...((cfg && cfg.bridges) || [])];
      while (list.length < 2) {
        list.push({
          name: list.length === 0 ? '主号' : '第二个号',
          enabled: list.length === 0,
          mediaDir: '',
          prefix: 'media_',
          send: false,
          baseUrl: '',
          token: '',
          target: '',
        });
      }
      return { ...cfg, bridges: list };
    }

    async function api(path, options) {
      const init = { ...(options || {}) };
      init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
      if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
      const res = await fetch(API + path, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${path} → HTTP ${res.status}`);
      if (data.ok === false && data.error) throw new Error(data.error);
      return data;
    }

    function report(message, stack) {
      try {
        fetch(API + '/client-error', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: String(message ?? ''), stack: String(stack ?? '') }),
        });
      } catch {}
    }

    try {
      window.addEventListener('error', (event) => {
        report(event.message || 'window error', event.error && event.error.stack);
      });
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        report('unhandled rejection: ' + ((reason && reason.message) || reason), reason && reason.stack);
      });
    } catch {}

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err };
      }
      componentDidCatch(err, info) {
        report('render: ' + ((err && err.message) || err), ((err && err.stack) || '') + '\n' + ((info && info.componentStack) || ''));
      }
      render() {
        if (this.state.err) {
          return h('div', {
            style: { padding: '16px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12.5px', whiteSpace: 'pre-wrap', lineHeight: '20px' },
          }, [
            h('b', { key: 't' }, '耳朵页面出错了'),
            h('div', { key: 'm', style: { marginTop: '8px' } }, String((this.state.err && this.state.err.message) || this.state.err)),
            h('pre', { key: 's', style: { marginTop: '8px', opacity: 0.7, fontSize: '11px', whiteSpace: 'pre-wrap' } }, String((this.state.err && this.state.err.stack) || '')),
          ]);
        }
        return this.props.children;
      }
    }

    const CSS = `
.hear-app{position:relative;max-width:1020px;margin:0 auto;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden;background:rgba(127,127,127,.02)}
.hear-head{padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;align-items:flex-start;justify-content:space-between;gap:12px;background:linear-gradient(135deg,rgba(47,125,246,.10),rgba(124,92,255,.08))}
.hear-title{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}
.hear-sub{margin:3px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hear-dot{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px;border-radius:999px;background:rgba(127,127,127,.10);color:var(--dsw-alias-label-secondary)}
.hear-dot i{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);display:inline-block}
.hear-dot.ok i{background:var(--dsw-alias-state-success-primary)}
.hear-dot.warn i{background:var(--dsw-alias-state-warn-primary)}
.hear-dot.bad i{background:var(--dsw-alias-state-error-primary)}
.hear-tabs{display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l2);background:rgba(127,127,127,.025)}
.hear-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:8px 10px 9px;border-bottom:2px solid transparent;cursor:pointer}
.hear-tab:hover{color:var(--dsw-alias-label-primary);background:rgba(127,127,127,.07)}
.hear-tab.on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.hear-body{padding:16px 20px 18px}
.hear-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.hear-cell{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:rgba(127,127,127,.03)}
.hear-cell b{display:block;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);margin-bottom:3px}
.hear-cell span{font-size:14px}
.hear-btn{border:1px solid var(--dsw-alias-border-l2);background:rgba(127,127,127,.05);color:var(--dsw-alias-label-primary);border-radius:9px;padding:7px 12px;font-size:12.5px;cursor:pointer}
.hear-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.hear-btn:disabled{opacity:.5;cursor:not-allowed}
.hear-btn.primary{background:#2f7df6;border-color:#2f7df6;color:#fff}
.hear-btn.big{padding:10px 18px;font-size:13.5px;font-weight:600}
.hear-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.hear-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.hear-field{display:grid;grid-template-columns:180px 1fr;gap:10px;align-items:center;padding:9px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.hear-field:last-child{border-bottom:none}
.hear-field>label{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.hear-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:6px 9px;font-size:12.5px}
.hear-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.hear-slider{display:flex;align-items:center;gap:10px}
.hear-slider input{flex:1}
.hear-banner{margin:0 0 12px;padding:9px 12px;border-radius:9px;border:1px solid var(--dsw-alias-state-error-primary);background:rgba(220,60,60,.08);color:var(--dsw-alias-state-error-primary);font-size:12.5px}
.hear-footer{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l2);background:rgba(127,127,127,.03)}
.hear-warnbar{color:var(--dsw-alias-state-warn-primary);font-size:12px;margin-right:auto}
.hear-check{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.hear-check:last-child{border-bottom:none}
.hear-req{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.hear-req-item{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.hear-req-item.ok{border-color:rgba(46,160,67,.45);color:var(--dsw-alias-state-success-primary)}
.hear-req-item.bad{border-color:rgba(220,60,60,.45);color:var(--dsw-alias-state-error-primary)}
.hear-mark{width:14px;flex:none;text-align:center;font-size:12.5px;font-weight:700;line-height:20px;color:var(--dsw-alias-state-success-primary)}
.hear-mark.bad{color:var(--dsw-alias-state-error-primary)}.hear-check b{font-size:12.5px;font-weight:500}
.hear-check p{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hear-model{display:flex;gap:12px;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.hear-prog{margin-top:6px;min-width:200px}
.hear-prog-bar{height:6px;border-radius:999px;background:rgba(127,127,127,.18);overflow:hidden}
.hear-prog-bar i{display:block;height:100%;background:#2f7df6;transition:width .4s ease}
.hear-model:last-child{border-bottom:none}
.hear-tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.hear-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.hear-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.hear-empty{padding:20px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
`;

    function dotClass(status) {
      if (!status) return 'hear-dot';
      if (status.phase === 'error') return 'hear-dot bad';
      if (status.modelLoaded) return 'hear-dot ok';
      if (status.serviceUp) return 'hear-dot warn';
      return 'hear-dot';
    }

    function fmtTime(ms) {
      if (!ms) return '—';
      try {
        return new Date(ms).toLocaleString('zh-CN', { hour12: false });
      } catch {
        return '—';
      }
    }

    function fmtBytes(n) {
      const v = Number(n) || 0;
      if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)}G`;
      if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(0)}M`;
      if (v >= 1024) return `${(v / 1024).toFixed(0)}K`;
      return `${Math.round(v)}B`;
    }

    function HearPage() {
      const [tab, setTab] = useState('status');
      const [status, setStatus] = useState(null);
      const [qq, setQq] = useState(null);
      const [cleanup, setCleanup] = useState(null);
      const [portInfo, setPortInfo] = useState(null);
      const [dismissedPid, setDismissedPid] = useState(0);
      const [onboard, setOnboard] = useState(null);
      const autoStart = useRef(false);
      const [config, setConfig] = useState(null);
      const [draft, setDraft] = useState(null);
      const [records, setRecords] = useState([]);
      const [diag, setDiag] = useState(null);
      const [models, setModels] = useState([]);
      const [disk, setDisk] = useState(null);
      const [job, setJob] = useState(null);
      const [busy, setBusy] = useState('');
      const [banner, setBanner] = useState('');
      const [errors, setErrors] = useState([]);
      const [toast, setToast] = useState('');
      const alive = useRef(true);
      const retryRef = useRef(0);

      const dirty = Boolean(draft && config && JSON.stringify(draft) !== JSON.stringify(config));

      const refresh = useCallback(async () => {
        try {
          const data = await api('/status');
          if (!alive.current) return;
          retryRef.current = 0;
          setStatus(data.status);
          setQq(data.qq || null);
          setCleanup(data.cleanup || null);
          setConfig(data.config);
          setDraft((prev) => prev ?? padBridges(data.config));
          const errs = await api('/errors').catch(() => null);
          if (errs && alive.current) setErrors(errs.errors || []);
        } catch (error) {
          const msg = String(error.message || error);
          if (!alive.current) return;
          if (msg.includes('404')) {
            // 宿主刚重启或插件刚重载时后台会短暂 404，先自己重试一会儿，别直接报红。
            retryRef.current += 1;
            const tries = retryRef.current;
            if (tries <= 8) {
              setBanner(`插件后台还没挂上，正在重连（第 ${tries} 次）…`);
              setTimeout(() => {
                if (alive.current) refresh();
              }, 2500);
              return;
            }
            setBanner('插件后台没挂上：去 设置 → 插件 把「鱼鱼的耳朵」关掉再打开一次');
            return;
          }
          setBanner(msg);
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        refresh();
        const timer = setInterval(refresh, 4000);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, [refresh]);

      useEffect(() => {
        if (!config || config.onboarded || onboard) return;
        api('/onboard/check').then((data) => setOnboard(data.check || null)).catch(() => {});
      }, [config, onboard]);

      useEffect(() => {
        if (tab !== 'records') return;
        api('/records?limit=8').then((d) => setRecords(d.records || [])).catch(() => {});
      }, [tab]);

      const loadModels = useCallback(async () => {
        try {
          const data = await api('/models');
          setModels(data.models || []);
          setDisk(data.disk || null);
          setJob(data.job || null);
        } catch (error) {
          setBanner(String(error.message || error));
        }
      }, []);

      useEffect(() => {
        if (!config || draft) return;
        let restored = null;
        try {
          const raw = window.localStorage.getItem('dsh-hear:draft');
          if (raw) restored = JSON.parse(raw);
        } catch {}
        setDraft(padBridges(restored || config));
      }, [config, draft]);

      useEffect(() => {
        if (!draft) return;
        try {
          window.localStorage.setItem('dsh-hear:draft', JSON.stringify(draft));
        } catch {}
      }, [draft]);

      useEffect(() => {
        if (tab === 'models') loadModels();
        if (tab === 'doctor' && !diag) api('/diagnose').then(setDiag).catch((e) => setBanner(String(e.message)));
      }, [tab, diag, loadModels]);

      useEffect(() => {
        if (tab !== 'models') return;
        if (!job || !['listing', 'downloading'].includes(job.phase)) return;
        const timer = setInterval(async () => {
          try {
            const data = await api('/models/progress');
            setJob(data.job || null);
            if (!data.job || data.job.phase !== job.phase) loadModels();
          } catch {}
        }, 1500);
        return () => clearInterval(timer);
      }, [tab, job?.phase, loadModels]);

      useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(''), 4000);
        return () => clearTimeout(timer);
      }, [toast]);

      const act = async (name, path, body) => {
        setBusy(name);
        setBanner('');
        try {
          const data = await api(path, { method: 'POST', body: body || {} });
          if (data.status) setStatus(data.status);
          await refresh();
          return data;
        } catch (error) {
          setBanner(String(error.message || error));
          return null;
        } finally {
          setBusy('');
        }
      };

      const startEars = async () => {
        setBusy('start');
        setBanner('');
        try {
          let data = await api('/start', { method: 'POST', body: {} });
          if (data.needsConfirm) {
            const ok = window.confirm(`显存只剩 ${data.vram.freeMiB} MB，加载耳朵大约要 ${data.vram.needMiB} MB。\n要先关掉语音合成再启动吗？关掉以后 QQ 里暂时发不了语音。`);
            if (!ok) {
              setToast('没启动，显存不够');
              return;
            }
            data = await api('/start', { method: 'POST', body: { force: true } });
          }
          if (data.status) setStatus(data.status);
          if (data.config) {
            setConfig(data.config);
            if (!dirty) setDraft(data.config);
          }
          if (data.status?.portMoved) setToast(`端口 ${data.status.portMoved.from} 被占用，已改用 ${data.status.portMoved.to}`);
          await refresh();
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const alignPort = async () => {
        if (!draft) return;
        setBusy('port');
        setBanner('');
        try {
          const data = await api(`/port/free?start=${Number(draft.port) || 8779}`);
          setDraft({ ...draft, port: data.suggestion, url: data.url });
          setToast(data.busy ? `端口 ${data.port} 被占用，改成 ${data.suggestion}` : `端口 ${data.port} 是空的`);
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const ackCleanup = async () => {
        try {
          const data = await api('/cleanup/ack', { method: 'POST', body: {} });
          setCleanup(data.cleanup || null);
          setToast('好，两天后再问');
        } catch (error) {
          setBanner(String(error.message || error));
        }
      };

      // 端口上的僵尸：先让人看一眼，再决定杀不杀。
      const checkPort = useCallback(async () => {
        try {
          const data = await api('/port/check');
          if (alive.current) setPortInfo(data);
        } catch {}
      }, []);

      const killZombie = async () => {
        if (!portInfo?.pid) return;
        if (!window.confirm(`结束 PID ${portInfo.pid}（${portInfo.name || '这个进程'}）？它占着 ${portInfo.port}，是耳朵自己留下的。`)) return;
        setBusy('killport');
        try {
          const data = await api('/port/kill', { method: 'POST', body: { pid: portInfo.pid } });
          const killed = data.result?.killed;
          setToast(killed ? `结束了 PID ${portInfo.pid}，现在可以启动耳朵了` : `没杀：${data.result?.reason || '不是耳朵的进程'}`);
          await checkPort();
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const switchPort = async () => {
        if (!portInfo?.suggestion) return;
        try {
          await api('/config', { method: 'POST', body: { port: portInfo.suggestion, url: `http://127.0.0.1:${portInfo.suggestion}` } });
          setToast(`端口改成 ${portInfo.suggestion} 了`);
          await checkPort();
          await refresh();
        } catch (error) {
          setBanner(String(error.message || error));
        }
      };

      useEffect(() => {
        checkPort();
        const timer = setInterval(checkPort, 20000);
        return () => clearInterval(timer);
      }, [checkPort]);

      const doCleanup = async () => {
        if (!window.confirm('清掉最近两天的语音文件和听音记录？删了就找不回来。')) return;
        setBusy('cleanup');
        setBanner('');
        try {
          const data = await api('/cleanup', { method: 'POST', body: { scope: 'all' } });
          setCleanup(data.cleanup || null);
          setToast(`清了 ${data.removed} 个文件`);
          await refresh();
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const finishOnboard = async () => {
        try {
          const data = await api('/onboard/done', { method: 'POST', body: {} });
          setConfig(data.config);
          setDraft(data.config);
        } catch {}
        setOnboard(null);
      };

      const onboardDownload = async () => {
        const target = onboard?.recommend;
        if (!target || target.id === 'cloud') return;
        await finishOnboard();
        setTab('models');
        autoStart.current = true;
        await downloadModel({ id: target.id, name: target.name, size: target.size });
      };

      const onboardCloud = async () => {
        await finishOnboard();
        setTab('models');
        await useCloud('gemini');
      };

      useEffect(() => {
        if (job?.phase === 'done' && autoStart.current) {
          autoStart.current = false;
          startEars();
        }
      }, [job?.phase]);

      const checkUpdate = async () => {
        setBusy('update');
        setBanner('');
        try {
          const data = await api('/update/check');
          if (data.hasUpdate) setToast(`有新版本 ${data.latest}，当前 ${data.current}，去设置里的插件页点更新`);
          else if (data.latest) setToast(`已是最新（${data.current}）`);
          else setToast(`当前 ${data.current}，还没发布到 npm，查不到新版`);
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const t = (key) => ZH[key] || key;

      const downloadModel = async (m) => {
        const need = Number(String(m.size).replace(/[^\d.]/g, '')) * 1024 * 1024 * 1024;
        if (disk && Number.isFinite(need) && disk.freeBytes < need * 1.05) {
          setBanner(`磁盘剩余 ${fmtBytes(disk.freeBytes)}，可能不够放下 ${m.size}`);
          return;
        }
        setBusy('download');
        setBanner('');
        try {
          const data = await api('/models/download', { method: 'POST', body: { id: m.id } });
          setJob(data.job || null);
          setToast('开始下载 ' + m.name);
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const cancelModel = async () => {
        try {
          const data = await api('/models/cancel', { method: 'POST', body: {} });
          setJob(data.job || null);
          setToast('已取消');
        } catch (error) {
          setBanner(String(error.message || error));
        }
      };

      const uninstallModel = async (m) => {
        if (!window.confirm(`卸载 ${m.name}？\n会删掉这个目录：${m.dir}\n删了以后要重新下载。`)) return;
        setBusy('remove');
        setBanner('');
        try {
          await api('/models/remove', { method: 'POST', body: { id: m.id } });
          setToast('已卸载 ' + m.name);
          await loadModels();
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const selectModel = async (m) => {
        if (!m.dir || !m.installed) {
          setBanner(`${m.name} 还没装好，先下载`);
          return;
        }
        if (!window.confirm(`切换到 ${m.name}？\n服务会先停掉，下次启动就用这个模型。`)) return;
        setBusy('select');
        setBanner('');
        try {
          if (!m.listenable) {
            setBanner(`${m.name} 还没接推理，现在只会下载和体检`);
            return;
          }
          const data = await api('/models/select', { method: 'POST', body: { id: m.id } });
          if (data.ok === false) {
            setBanner(data.error || '切不过去');
            return;
          }
          setConfig(data.config);
          setDraft(data.config);
          if (data.status) setStatus(data.status);
          setToast('已切换到 ' + m.name);
          await loadModels();
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const useCloud = async (provider) => {
        setBusy('cloud');
        setBanner('');
        try {
          const data = await api('/config', {
            method: 'POST',
            body: { engine: 'cloud', cloud: { ...(config?.cloud || {}), provider } },
          });
          setConfig(data.config);
          setDraft(data.config);
          setToast('已切到云端：' + provider);
          await refresh();
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const updateBridge = (index, patch) => {
        setDraft((prev) => {
          if (!prev) return prev;
          const list = [...(prev.bridges || [])];
          list[index] = { ...list[index], ...patch };
          return { ...prev, bridges: list };
        });
      };

      const addBridge = () => {
        setDraft((prev) => (prev
          ? {
            ...prev,
            bridges: [...(prev.bridges || []), {
              name: '新桥接', enabled: true, mediaDir: '', prefix: 'media_', send: false, baseUrl: '', token: '', target: '',
            }],
          }
          : prev));
      };

      const removeBridge = (index) => {
        setDraft((prev) => (prev ? { ...prev, bridges: (prev.bridges || []).filter((_, i) => i !== index) } : prev));
      };

      const testReply = async () => {
        try {
          const data = await api('/reply/test', { method: 'POST', body: {} });
          setToast(data.result?.sent ? '发出去了' : (data.result?.reason || '没发'));
        } catch (error) {
          setBanner(String(error.message || error));
        }
      };

      // 逐条桥接试发：回复没接上时，先看是哪条桥发不出去。
      const testBridge = async (name) => {
        try {
          const data = await api('/qq/test', { method: 'POST', body: { name } });
          const r = data.result || {};
          setToast(r.sent ? `${name || '这条桥'}发出去了，看手机收没收到` : `${name || '这条桥'}没发出去：${r.reason || '原因不明'}`);
        } catch (error) {
          setBanner(String(error.message || error));
        }
      };

      const testVoice = async (name) => {
        try {
          const data = await api('/qq/voice-test', { method: 'POST', body: { name } });
          const r = data.result || {};
          setToast(r.sent ? `${name || '这条桥'}的语音发出去了` : `语音没发出去：${r.reason || '原因不明'}`);
        } catch (error) {
          setBanner(String(error.message || error));
        }
      };

      const openModelPage = (m) => {
        try {
          window.open(`https://www.modelscope.cn/models/${m.id}`, '_blank', 'noopener');
        } catch {}
      };

      const save = async () => {
        if (!draft) return;
        setBusy('save');
        try {
          const data = await api('/config', { method: 'POST', body: draft });
          setConfig(data.config);
          setDraft(data.config);
          setToast('保存成功');
          const qqData = await api('/qq/restart', { method: 'POST', body: {} }).catch(() => null);
          if (qqData) {
            setQq(qqData.qq || null);
            setToast(qqData.qq?.listening ? '保存成功，桥接已重启' : '保存成功，桥接没启动');
          }
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const statusLabel = (s) => {
        if (!s) return t('off');
        if (s.engine === 'cloud') return '云端';
        if (s.phase === 'error') return t('error');
        if (s.modelLoaded) return t('on');
        if (s.serviceUp) return t('loading');
        return t('off');
      };

      const repair = async (ids) => {
        setBusy('repair');
        setBanner('');
        try {
          const data = await api('/repair', { method: 'POST', body: ids ? { ids } : {} });
          if (data.diagnose) setDiag(data.diagnose);
          const failed = (data.results || []).filter((r) => !r.ok);
          if (!data.results || !data.results.length) setToast('没有能自动修的项目');
          else if (failed.length) setToast(`修好 ${data.repaired} 项，${failed.length} 项没成：${failed.map((f) => f.title).join('、')}`);
          else setToast(`修好 ${data.repaired} 项`);
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const relevantErrors = errors.filter((e) => !e.engine || !status?.engine || e.engine === status.engine);
      const fixables = (diag?.checks || []).filter((c) => !c.ok && c.fixable);
      const gpuGb = status?.gpu ? Math.round(status.gpu.totalMiB / 1024) : null;
      const recommend = gpuGb == null
        ? '读不到独显，可以走云端，或者用 CPU 慢慢跑'
        : gpuGb >= 16 ? 'Qwen2-Audio-7B-Instruct'
          : gpuGb >= 12 ? 'Qwen2-Audio-7B-Instruct（4bit）'
            : gpuGb >= 8 ? 'MiniCPM-o-2_6-int4'
              : gpuGb >= 6 ? 'Qwen2.5-Omni-3B'
                : 'Qwen2.5-Omni-3B（4bit）或者走云端';

      const runSample = async () => {        setBusy('sample');
        setBanner('');
        try {
          const data = await api('/test', { method: 'POST', body: {} });
          const lines = [data.answer, data.extras ? `补充：${data.extras}` : '', data.timeline ? `时间点：${data.timeline}` : ''].filter(Boolean);
          setToast(lines.join(' / ').slice(0, 400) || '听完了');
        } catch (error) {
          setBanner(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      return h('div', { className: 'hear-app' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'hear-head', key: 'head' }, [
          h('div', { key: 'l' }, [
            h('div', { className: 'hear-title', key: 't' }, ['鱼鱼的耳朵', h('span', { className: dotClass(status) }, h('i'), statusLabel(status))]),
            h('p', { className: 'hear-sub', key: 's' }, t('sub')),
          ]),
          h('div', { className: 'hear-row', key: 'r' }, [
            h('span', { className: 'hear-dot' }, `v${status?.version || '0.1.0'}`),
            h('button', { className: 'hear-btn', key: 'upd', onClick: checkUpdate, disabled: busy === 'update' }, busy === 'update' ? '检查中…' : '检查更新'),
            h('span', {
              className: status?.vram ? (status.vram.freeMiB >= 4500 ? 'hear-dot ok' : 'hear-dot bad') : 'hear-dot',
              title: status?.vram ? `空闲 ${status.vram.freeMiB} MiB / 共 ${status.vram.totalMiB} MiB` : '',
            }, status?.vram ? (status.vram.freeMiB >= 4500 ? '显存充足' : '显存不足') : '显存 —'),
            h('span', { className: qq?.listening ? 'hear-dot ok' : 'hear-dot' }, [
              h('i', { key: 'd' }),
              qq?.listening ? 'QQ 语音已连接' : 'QQ 语音未连接',
            ]),
          ]),
        ]),
        h('div', { className: 'hear-tabs', key: 'tabs' }, [
          ['status', t('status')],
          ['options', t('options')],
          ['models', t('models')],
          ['doctor', t('doctor')],
        ].map(([id, label]) => h('button', {
          key: id,
          className: `hear-tab${tab === id ? ' on' : ''}`,
          onClick: () => setTab(id),
        }, label))),
        h('div', { className: 'hear-body', key: 'body' }, [
          banner ? h('div', { className: 'hear-banner', key: 'banner' }, banner) : null,
          toast ? h('div', {
            className: 'hear-banner',
            key: 'toast',
            style: {
              borderColor: 'var(--dsw-alias-state-success-primary)',
              color: 'var(--dsw-alias-state-success-primary)',
              background: 'rgba(46,160,67,.12)',
            },
          }, toast) : null,
          portInfo?.zombie && portInfo.pid && portInfo.pid !== dismissedPid ? h('div', {
            className: 'hear-banner',
            key: 'zombie',
            style: {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              borderColor: 'var(--dsw-alias-state-warn-primary)',
              color: 'var(--dsw-alias-state-warn-primary)',
              background: 'rgba(255,170,0,.12)',
            },
          }, [
            h('span', { key: 't', style: { flex: 1, minWidth: '240px' } }, `端口 ${portInfo.port} 上有个僵尸进程：PID ${portInfo.pid}${portInfo.name ? ` ${portInfo.name}` : ''}，是上次的听音服务没退干净，它还占着显存。要结束它吗？`),
            h('button', { className: 'hear-btn danger', key: 'k', disabled: busy === 'killport', onClick: killZombie }, busy === 'killport' ? '结束中…' : '结束它'),
            h('button', { className: 'hear-btn', key: 's', onClick: switchPort }, `换到 ${portInfo.suggestion || '空闲端口'}`),
            h('button', { className: 'hear-btn', key: 'd', onClick: () => setDismissedPid(portInfo.pid) }, '先不管'),
          ]) : null,
          (qq?.conflicts || []).length ? h('div', {
            className: 'hear-banner',
            key: 'qqconflict',
            style: {
              borderColor: 'var(--dsw-alias-state-warn-primary)',
              color: 'var(--dsw-alias-state-warn-primary)',
              background: 'rgba(255,170,0,.12)',
              cursor: 'pointer',
            },
            onClick: () => setTab('options'),
          }, `${qq.conflicts[0].text}（点这里去改）`) : null,
          cleanup?.due ? h('div', {
            className: 'hear-banner',
            key: 'cleanup',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              borderColor: 'var(--dsw-alias-state-warn-primary)',
              color: 'var(--dsw-alias-state-warn-primary)',
              background: 'rgba(255,170,0,.12)',
            },
          }, [
            h('span', { key: 't', style: { flex: 1 } }, `清理提醒：这两天有 ${cleanup.voices} 个语音文件、${cleanup.records} 条听音记录、${cleanup.temps || 0} 份切段临时文件（约 ${fmtBytes(cleanup.bytes)}），要清掉吗？`),
            h('button', { className: 'hear-btn', key: 'c', disabled: busy === 'cleanup', onClick: doCleanup }, busy === 'cleanup' ? '清理中…' : '清掉全部'),
            h('button', { className: 'hear-btn', key: 'l', onClick: ackCleanup }, '之后再说'),
          ]) : null,
          !banner && relevantErrors.length ? h('div', {
            className: 'hear-banner',
            key: 'errbanner',
            style: { cursor: 'pointer' },
            onClick: () => setTab('doctor'),
          }, `有 ${relevantErrors.length} 条错误记录，点这里看诊断`) : null,
          tab === 'status' ? h('div', { key: 'st' }, [
            h('div', { className: 'hear-row', key: 'btns', style: { marginBottom: '14px' } }, [
              h('button', { className: 'hear-btn primary big', disabled: Boolean(busy) || status?.engine === 'cloud', onClick: startEars }, busy === 'start' ? '启动中…' : t('start')),
              h('button', { className: 'hear-btn big danger', disabled: Boolean(busy) || !status?.serviceUp, onClick: () => act('stop', '/stop') }, busy === 'stop' ? '停止中…' : t('stop')),
            ]),
            h('div', { className: 'hear-grid', key: 'grid' }, [
              cell(t('modelState'), status?.engine === 'cloud'
                ? `云端（${status.cloud?.provider === 'none' ? '未选服务商' : status.cloud?.provider || '未选'}）`
                : status?.modelLoaded ? '已加载' : status?.serviceUp ? (status.loading ? '正在加载' : '未加载') : '未启动'),
              cell(t('vram'), status?.vram ? `${status.vram.usedMiB} / ${status.vram.totalMiB} MiB` : '—'),
              cell(t('lastHear'), status?.lastHearAt ? `${fmtTime(status.lastHearAt)}（${status.lastHearSecs ?? '?'}s）` : t('never')),
              status?.idleUntil ? cell('空闲后自动关闭', fmtTime(status.idleUntil)) : null,
              cell(t('port'), status?.engine === 'cloud' ? '云端，不占本地端口' : `${config?.port ?? 8779} · PID ${status?.pid ?? '—'}`),
            ]),
            status?.engine === 'cloud' ? h('p', { className: 'hear-hint', key: 'cloudhint' }, '云端模式：不用启动本地服务，听的时候直接走 API，占的是网和钱') : null,
            h('div', { className: 'hear-row', key: 'mini', style: { marginTop: '14px' } }, [
              h('button', { className: 'hear-btn', disabled: Boolean(busy), onClick: startEars }, t('wake')),
              h('button', { className: 'hear-btn', disabled: Boolean(busy) || !status?.serviceUp, onClick: () => act('sleep', '/stop') }, t('sleep')),
              h('button', { className: 'hear-btn', disabled: Boolean(busy), onClick: runSample }, t('sample')),
            ]),
            h('p', { className: 'hear-hint', key: 'hint' }, t('tabStatusHint')),
            h('p', { className: 'hear-hint', key: 'qqhint' }, qq?.listening ? `QQ 语音：已连接 ${qq.dir}` : `QQ 语音：未连接${qq?.lastError ? `（${qq.lastError}）` : ''}`),
            status?.portMoved ? h('p', {
              className: 'hear-hint',
              key: 'pm',
              style: { color: 'var(--dsw-alias-state-warn-primary)' },
            }, `端口 ${status.portMoved.from} 被占用，已改用 ${status.portMoved.to}`) : null,
          ]) : null,
          tab === 'options' && draft ? h('div', { key: 'op' }, [
            field(t('port'), h('div', null, [
              h('div', { className: 'hear-row' }, [
                h('input', {
                  key: 'p',
                  className: 'hear-input',
                  type: 'number',
                  style: { maxWidth: '140px' },
                  value: draft.port,
                  onChange: (e) => {
                    const port = Number(e.target.value) || 8779;
                    setDraft({ ...draft, port, url: `http://127.0.0.1:${port}` });
                  },
                }),
                h('button', { key: 'a', className: 'hear-btn', disabled: busy === 'port', onClick: alignPort }, busy === 'port' ? '检测中…' : '一键对齐端口'),
              ]),
              h('div', { className: 'hear-hint' }, `${draft.url}　端占用会自动换一个空的，并写回配置`),
            ])),
            field(t('pythonPath'), h('input', {
              className: 'hear-input',
              placeholder: '留空就自动找 PATH 里的 python',
              value: draft.pythonPath,
              onChange: (e) => setDraft({ ...draft, pythonPath: e.target.value }),
            })),
            field(t('serviceScript'), h('input', {
              className: 'hear-input',
              value: draft.serviceScript,
              onChange: (e) => setDraft({ ...draft, serviceScript: e.target.value }),
            })),
            field(t('modelDir'), h('input', {
              className: 'hear-input',
              value: draft.modelDir,
              onChange: (e) => setDraft({ ...draft, modelDir: e.target.value }),
            })),
            field(t('settle'), slider(draft.settleMs / 1000, 5, 20, 1, (v) => setDraft({ ...draft, settleMs: v * 1000 }), `${draft.settleMs / 1000} 秒`), t('settleHint')),
            field(t('idle'), slider(draft.idleUnloadMs / 60000, 1, 30, 1, (v) => setDraft({ ...draft, idleUnloadMs: v * 60000 }), `${Math.round(draft.idleUnloadMs / 60000)} 分钟`), t('idleHint')),
            field(t('judge'), select(draft.judgeMode, [['auto', t('auto')], ['ask', t('ask')], ['dialog', t('dialog')], ['material', t('material')]], (v) => setDraft({ ...draft, judgeMode: v }))),
            field(t('features'), toggle(draft.features, (v) => setDraft({ ...draft, features: v }))),
            field(t('record'), toggle(draft.recordEnabled, (v) => setDraft({ ...draft, recordEnabled: v }))),
            field(t('recordDir'), h('input', {
              className: 'hear-input',
              value: draft.recordDir,
              onChange: (e) => setDraft({ ...draft, recordDir: e.target.value }),
            })),
            field('QQ 桥接', h('div', null, [
              ...(draft.bridges || []).map((bridge, index) => h('div', {
                key: `br${index}`,
                style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '9px', padding: '8px 10px', marginBottom: '8px' },
              }, [
                h('div', { className: 'hear-row', key: 'r1' }, [
                  h('input', { className: 'hear-input', style: { maxWidth: '150px' }, placeholder: '给这条起个名字', value: bridge.name || '', onChange: (e) => updateBridge(index, { name: e.target.value }) }),
                  h('button', { className: 'hear-btn', key: 't', onClick: () => updateBridge(index, { enabled: bridge.enabled === false }) }, bridge.enabled === false ? '启用' : '停用'),
                  h('button', { className: 'hear-btn danger', key: 'd', onClick: () => removeBridge(index) }, '删除'),
                ]),
                h('div', { className: 'hear-row', key: 'r2', style: { marginTop: '6px' } }, [
                  h('input', { className: 'hear-input', placeholder: '语音目录（留空用默认）', value: bridge.mediaDir || '', onChange: (e) => updateBridge(index, { mediaDir: e.target.value }) }),
                  h('input', { className: 'hear-input', style: { maxWidth: '130px' }, placeholder: '文件名开头', value: bridge.prefix ?? 'media_', onChange: (e) => updateBridge(index, { prefix: e.target.value }) }),
                ]),
                h('div', { className: 'hear-row', key: 'r3', style: { marginTop: '6px' } }, [
                  h('input', { className: 'hear-input', placeholder: '例如 http://127.0.0.1:3000', value: bridge.baseUrl || '', onChange: (e) => updateBridge(index, { baseUrl: e.target.value }) }),
                  h('input', { className: 'hear-input', style: { maxWidth: '150px' }, placeholder: 'Token', type: 'password', value: bridge.token || '', onChange: (e) => updateBridge(index, { token: e.target.value }) }),
                ]),
                h('div', { className: 'hear-row', key: 'r4', style: { marginTop: '6px' } }, [
                  h('input', { className: 'hear-input', placeholder: '例如 个人:10001 或 群组:123456', value: bridge.target || '', onChange: (e) => updateBridge(index, { target: e.target.value }) }),
                  h('button', { className: 'hear-btn', key: 's', onClick: () => updateBridge(index, { send: !bridge.send }) }, bridge.send ? '主动回复 开' : '主动回复 关'),
                  h('button', {
                    className: 'hear-btn',
                    key: 'm',
                    onClick: () => {
                      const cur = bridge.replyMode || 'auto';
                      const next = cur === 'auto' ? 'voice' : cur === 'voice' ? 'text' : 'auto';
                      updateBridge(index, { replyMode: next });
                    },
                  }, `回复方式：${({ auto: '自动', voice: '语音', text: '文字' })[bridge.replyMode || 'auto']}`),
                  h('button', { className: 'hear-btn', key: 'x', onClick: () => testBridge(bridge.name || '') }, '试发文字'),
                  h('button', { className: 'hear-btn', key: 'v', onClick: () => testVoice(bridge.name || '') }, '试发语音'),
                ]),
                (qq?.conflicts || []).some((c) => c.bridges?.includes(bridge.name)) ? h('div', {
                  key: 'cf',
                  className: 'hear-hint',
                  style: { color: 'var(--dsw-alias-state-warn-primary)', marginTop: '6px' },
                }, '这条桥跟别人共用同一个目录和前缀，文件只会被第一条取走') : null,
              ])),
              h('div', { className: 'hear-row', key: 'add' }, [
                h('button', { className: 'hear-btn', onClick: addBridge }, '添加一个桥接'),
                h('button', { className: 'hear-btn', onClick: testReply }, '发一条试试'),
                h('span', { className: 'hear-hint', key: 'h' }, '一条管一个号，各自听各自的，先保存再试'),
              ]),
            ]), '多开几个 QQ 就多加几条，互不打架'),
            field('语音回复', h('div', null, [
              h('div', { className: 'hear-row', key: 'v1' }, [
                h('button', {
                  className: 'hear-btn',
                  key: 'on',
                  onClick: () => setDraft({ ...draft, voiceReply: { ...(draft.voiceReply || {}), enabled: draft.voiceReply?.enabled === false } }),
                }, draft.voiceReply?.enabled === false ? '语音回复 关' : '语音回复 开'),
                h('input', {
                  className: 'hear-input',
                  key: 'ep',
                  placeholder: '合成接口，例如 http://127.0.0.1:8770/v1/speak/file',
                  value: draft.voiceReply?.endpoint || '',
                  onChange: (e) => setDraft({ ...draft, voiceReply: { ...(draft.voiceReply || {}), endpoint: e.target.value } }),
                }),
                h('input', {
                  className: 'hear-input',
                  key: 'vc',
                  style: { maxWidth: '120px' },
                  placeholder: '音色，例如 shou',
                  value: draft.voiceReply?.voice || '',
                  onChange: (e) => setDraft({ ...draft, voiceReply: { ...(draft.voiceReply || {}), voice: e.target.value } }),
                }),
                h('button', { className: 'hear-btn', key: 'tv', onClick: () => testVoice('') }, '试一条语音'),
              ]),
              h('span', { className: 'hear-hint', key: 'h2' }, '判定成对话（或者拿不准先问）时用语音回，判定成素材时用文字；每条桥可以单独强制语音或文字。合成失败会自动退回文字。'),
            ]), '对话用声音回，素材用文字回'),
            field('冷却', slider(Math.round((draft.reply?.cooldownMs || 60000) / 1000), 10, 600, 10, (v) => setDraft({ ...draft, reply: { ...(draft.reply || {}), cooldownMs: v * 1000 } }), `${Math.round((draft.reply?.cooldownMs || 60000) / 1000)} 秒`)),
            field('每批最多几条', slider(Number(draft.reply?.maxPerBatch ?? 1), 0, 10, 1, (v) => setDraft({ ...draft, reply: { ...(draft.reply || {}), maxPerBatch: v } }), `${Number(draft.reply?.maxPerBatch ?? 1)} 条`), '0 表示不主动发，你一口气发几段最多回几条'),
            field(t('vramPrio'), select(draft.vramPriority === 'indextts' ? 'voice' : draft.vramPriority, [['voice', t('prioVoice')], ['last', t('prioLast')]], (v) => setDraft({ ...draft, vramPriority: v }))),
            field('语音合成端口', h('input', {
              className: 'hear-input',
              placeholder: '8770,9880',
              value: (draft.voicePorts || []).join(','),
              onChange: (e) => setDraft({
                ...draft,
                voicePorts: e.target.value.split(',').map((s) => Number(s.trim())).filter(Boolean),
              }),
            }), '显存不够时按顺序关掉这些端口上的语音合成，多个用逗号隔开'),
            h('div', { className: 'hear-footer', key: 'f', style: { margin: '14px -20px -18px', paddingLeft: '20px', paddingRight: '20px' } }, [
              dirty ? h('span', { className: 'hear-warnbar', key: 'w' }, t('dirty')) : h('span', { className: 'hear-warnbar', key: 'w' }),
              h('button', { className: 'hear-btn primary', key: 's', disabled: !dirty || Boolean(busy), onClick: save }, t('save')),
              h('button', { className: 'hear-btn', key: 'sr', disabled: !dirty, onClick: async () => { await save(); } }, t('saveRestart')),
              h('button', { className: 'hear-btn', key: 'r', disabled: !dirty, onClick: () => { setDraft(config); setToast('已撤销改动'); } }, t('revert')),
              h('button', { className: 'hear-btn', key: 'l', onClick: () => { setDraft(config); refresh(); setToast('已从磁盘重新读取'); } }, t('reload')),
            ]),
          ]) : null,
          tab === 'models' ? h('div', { key: 'mo' }, [
            h('div', { className: 'hear-row', key: 'h', style: { marginBottom: '4px' } }, [
              h('p', { className: 'hear-hint', key: 'h1', style: { margin: 0, flex: 1 } }, t('tabModelsHint')),
              disk ? h('span', { className: 'hear-hint', key: 'h2' }, `磁盘剩余 ${fmtBytes(disk.freeBytes)} / 共 ${fmtBytes(disk.totalBytes)}`) : null,
            ]),
            h('p', { className: 'hear-hint', key: 'rec', style: { margin: '0 0 8px' } }, `按你这张显卡（${gpuGb == null ? '未识别' : gpuGb + 'G'}）建议：${recommend}`),
            h('div', { key: 'cloud', style: { margin: '4px 0 10px' } }, [
              h('b', { key: 't', style: { fontSize: '12.5px' } }, '云端（不占用显存，但依赖网络和需要收费）'),
              ...CLOUD.map((c) => {
                const active = status?.engine === 'cloud' && config?.cloud?.provider === c.id;
                return h('div', { className: 'hear-model', key: c.id }, [
                  h('div', { key: 'l', style: { flex: 1, minWidth: 0 } }, [
                    h('div', { key: 'n' }, [
                      h('b', null, c.name),
                      active ? h('span', { className: 'hear-tag ok', style: { marginLeft: '8px' } }, t('current')) : null,
                    ]),
                    h('div', { className: 'hear-hint', key: 'd' }, c.note),
                  ]),
                  h('div', { className: 'hear-row', key: 'r', style: { flex: 'none' } }, [
                    h('button', { className: 'hear-btn', key: 'u', disabled: Boolean(busy) || active, onClick: () => useCloud(c.id) }, active ? '在用' : '使用'),
                  ]),
                ]);
              }),
              h('div', {
                key: 'price',
                style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '8px 10px', margin: '6px 0 8px' },
              }, [
                h('b', { key: 't' }, '收费标准'),
                h('p', { className: 'hear-hint', key: 'p1', style: { margin: '4px 0' } }, 'Gemini：按输入 token 计费，音频大约 32 token/秒'),
                h('p', { className: 'hear-hint', key: 'p2', style: { margin: '4px 0' } }, 'GPT-4o：按音频 token 计费，比 Gemini 贵一些'),
                h('p', { className: 'hear-hint', key: 'p3', style: { margin: '4px 0' } }, '通义 Qwen-Omni：国内直连，按 token 计费，通常最便宜'),
                h('p', { className: 'hear-hint', key: 'p4', style: { margin: '4px 0' } }, '一小时的音频大概几块钱，具体以官网价目为准'),
                h('div', { className: 'hear-hint', key: 'links' }, [
                  h('a', { key: 'g', href: 'https://ai.google.dev/gemini-api/docs/pricing', target: '_blank', rel: 'noopener', style: { color: 'inherit' } }, 'Gemini 价目'),
                  h('span', { key: 's1' }, ' · '),
                  h('a', { key: 'o', href: 'https://openai.com/api/pricing/', target: '_blank', rel: 'noopener', style: { color: 'inherit' } }, 'OpenAI 价目'),
                  h('span', { key: 's2' }, ' · '),
                  h('a', { key: 'q', href: 'https://help.aliyun.com/zh/model-studio/models', target: '_blank', rel: 'noopener', style: { color: 'inherit' } }, '通义价目'),
                ]),
              ]),
              status?.engine === 'cloud' ? h('div', { key: 'cf' }, [
                field(t('apiKey'), h('input', {
                  className: 'hear-input',
                  type: 'password',
                  value: draft?.cloud?.apiKey || '',
                  onChange: (e) => setDraft({ ...draft, cloud: { ...(draft.cloud || {}), apiKey: e.target.value } }),
                })),
                field(t('cloudModel'), h('input', {
                  className: 'hear-input',
                  placeholder: '留空用默认',
                  value: draft?.cloud?.model || '',
                  onChange: (e) => setDraft({ ...draft, cloud: { ...(draft.cloud || {}), model: e.target.value } }),
                })),
                field(t('baseUrl'), h('input', {
                  className: 'hear-input',
                  placeholder: '留空用默认',
                  value: draft?.cloud?.baseUrl || '',
                  onChange: (e) => setDraft({ ...draft, cloud: { ...(draft.cloud || {}), baseUrl: e.target.value } }),
                })),
                h('div', { className: 'hear-row', key: 'f', style: { marginTop: '8px' } }, [
                  h('button', { className: 'hear-btn primary', key: 's', disabled: !dirty, onClick: save }, t('save')),
                  h('span', { className: 'hear-hint', key: 'h' }, '填完 Key 点保存'),
                ]),
              ]) : null,
            ]),
            h('b', { key: 'local', style: { fontSize: '12.5px', display: 'block', margin: '10px 0 2px' } }, '本地模型'),
            models.length ? models.map((m) => {
              const active = job && job.id === m.id && ['listing', 'downloading'].includes(job.phase);
              return h('div', { className: 'hear-model', key: m.id }, [
                h('div', { key: 'l', style: { minWidth: 0, flex: 1 } }, [
                  h('div', { key: 'n' }, [
                    h('b', null, m.name),
                    m.current ? h('span', { className: 'hear-tag ok', style: { marginLeft: '8px' } }, t('current')) : null,
                    h('span', {
                      className: m.listenable ? 'hear-tag ok' : 'hear-tag',
                      style: { marginLeft: '8px' },
                      title: m.listenable ? `引擎：${m.engine}` : '能下载、能体检，但还没接推理',
                    }, m.listenable ? '可听' : '只能下载'),
                    h('span', { className: 'hear-tag', style: { marginLeft: '8px' } }, m.installed ? `${t('installed')} ${m.installedSize}` : t('notInstalled')),
                  ]),
                  h('div', { className: 'hear-mono', key: 'd' }, m.dir),
                  h('div', { className: 'hear-hint', key: 's' }, `${m.size} · ${m.vram} · ${m.note}`),
                  h('div', { className: 'hear-hint', key: 'links' }, [
                    h('a', { key: 'a', href: `https://www.modelscope.cn/models/${m.id}`, target: '_blank', rel: 'noopener', style: { color: 'inherit' } }, 'ModelScope'),
                    h('span', { key: 's1' }, ' · '),
                    h('a', { key: 'b', href: `https://huggingface.co/${m.id}`, target: '_blank', rel: 'noopener', style: { color: 'inherit' } }, 'HuggingFace'),
                    h('span', { key: 's2' }, ' · '),
                    h('a', { key: 'c', href: `https://hf-mirror.com/${m.id}`, target: '_blank', rel: 'noopener', style: { color: 'inherit' } }, '国内镜像'),
                  ]),
                  active ? h('div', { className: 'hear-prog', key: 'p' }, [
                    h('div', { className: 'hear-prog-bar', key: 'b' }, h('i', { style: { width: `${job.phase === 'listing' ? 2 : job.percent}%` } })),
                    h('div', { className: 'hear-hint', key: 't', style: { marginTop: '4px' } }, job.phase === 'listing'
                      ? '正在读取文件列表…'
                      : `${job.percent}% · ${fmtBytes(job.done)} / ${fmtBytes(job.total)} · ${fmtBytes(job.speed)}/s · 第 ${job.fileIndex}/${job.files} 个文件`),
                  ]) : null,
                ]),
                h('div', { className: 'hear-row', key: 'r', style: { flex: 'none' } }, active
                  ? [h('button', { className: 'hear-btn', key: 'c', onClick: cancelModel }, '取消')]
                  : [
                    m.installed ? null : h('button', { className: 'hear-btn primary', key: 'd', disabled: Boolean(busy), onClick: () => downloadModel(m) }, busy === 'download' ? '准备中…' : '下载'),
                    m.installed && !m.current ? h('button', { className: 'hear-btn', key: 'sw', disabled: Boolean(busy) || !m.listenable, title: m.listenable ? '' : '这个模型还没接推理', onClick: () => selectModel(m) }, busy === 'select' ? '切换中…' : (m.listenable ? '切换' : '还不能用')) : null,
                    m.installed ? h('button', { className: 'hear-btn', key: 'v', disabled: Boolean(busy), onClick: async () => { await loadModels(); setToast('已重新校验'); } }, '重新校验') : null,
                    m.installed ? h('button', { className: 'hear-btn danger', key: 'u', disabled: Boolean(busy), onClick: () => uninstallModel(m) }, busy === 'remove' ? '卸载中…' : '卸载') : null,
                    h('button', { className: 'hear-btn', key: 'o', onClick: () => openModelPage(m) }, '打开模型页'),
                  ]),
              ]);
            }) : h('div', { className: 'hear-empty', key: 'e' }, '读取中…'),
            job && ['done', 'error', 'cancelled'].includes(job.phase) ? h('p', {
              className: 'hear-hint',
              key: 'j',
              style: { color: job.phase === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' },
            }, job.phase === 'done' ? `下载完成：${job.name}` : job.phase === 'error' ? `下载失败：${job.error || '未知原因'}` : '下载已取消') : null,
          ]) : null,
          tab === 'doctor' ? h('div', { key: 'dr' }, [
            h('div', { className: 'hear-row', key: 'b', style: { marginBottom: '10px' } }, [
              h('button', { className: 'hear-btn primary', key: 'c', disabled: busy === 'diag', onClick: async () => {
                setBusy('diag');
                try {
                  setDiag(await api('/diagnose'));
                } catch (e) {
                  setBanner(String(e.message));
                } finally {
                  setBusy('');
                }
              } }, busy === 'diag' ? '检查中…' : t('check')),
              h('button', {
                className: 'hear-btn',
                key: 'fix',
                disabled: Boolean(busy) || !fixables.length,
                onClick: () => repair(),
              }, busy === 'repair' ? '修复中…' : '一键修复'),
              h('button', { className: 'hear-btn', key: 'c2', disabled: !diag, onClick: () => copy(JSON.stringify(diag, null, 2)).then((ok) => setToast(ok ? '报告已复制' : '复制失败')) }, t('copyReport')),
              diag ? h('span', { className: 'hear-hint', key: 's' }, `通过 ${diag.summary?.ok ?? 0} / 失败 ${diag.summary?.fail ?? 0}`) : null,
            ]),
            diag?.checks?.length ? diag.checks.map((c) => h('div', { className: 'hear-check', key: c.id }, [
              h('span', { className: c.ok ? 'hear-mark' : 'hear-mark bad', key: 'm' }, c.ok ? '✓' : '✗'),
              h('div', { key: 'c', style: { flex: 1 } }, [
                h('b', null, c.title),
                h('p', null, c.detail + (c.ok ? '' : `　→ ${c.fix}`)),
              ]),
              !c.ok && c.fixable ? h('button', {
                className: 'hear-btn',
                key: 'f',
                disabled: busy === 'repair',
                onClick: () => repair([c.id]),
              }, '修复') : null,
            ])) : h('div', { className: 'hear-empty', key: 'e' }, busy === 'diag' ? '检查中…' : '还没检查'),
            diag?.models?.length ? h('div', { key: 'mods', style: { marginTop: '16px' } }, [
              h('b', { key: 't', style: { fontSize: '12.5px' } }, '各模型状态'),
              ...diag.models.map((m) => h('div', { className: 'hear-check', key: m.id }, [
                h('span', { className: m.complete ? 'hear-mark' : 'hear-mark bad', key: 'k' }, m.complete ? '✓' : '✗'),
                h('div', { key: 'c', style: { flex: 1 } }, [
                  h('b', null, `${m.name}${m.current ? '（当前）' : ''}${m.listenable ? '' : ' · 只能下载'}`),
                  h('p', null, `${m.complete ? '已安装' : '未安装'}　${m.sizeText}　${m.dir}`),
                  h('div', { className: 'hear-req', key: 'r' }, (m.requirements || []).map((r) => h('span', {
                    className: r.ok ? 'hear-req-item ok' : 'hear-req-item bad',
                    key: r.key,
                    title: r.detail,
                  }, `${r.ok ? '✓' : '✗'} ${r.title}`))),
                ]),
                m.complete && !m.current ? h('button', {
                  className: 'hear-btn',
                  key: 'sw',
                  disabled: busy === 'select' || !m.listenable,
                  title: m.listenable ? '' : '这个模型还没接推理',
                  onClick: () => selectModel(m),
                }, m.listenable ? '切换' : '还不能用') : null,
              ])),
            ]) : (diag ? h('div', { className: 'hear-empty', key: 'nomo', style: { marginTop: '12px' } }, '你还未添加任何模型') : null),
            h('div', { key: 'errs', style: { marginTop: '16px' } }, [
              h('div', { className: 'hear-row', key: 'h', style: { marginBottom: '6px' } }, [
                h('b', { key: 't', style: { fontSize: '12.5px' } }, '最近错误'),
                h('span', { className: 'hear-hint', key: 'n', style: { flex: 1 } }, errors.length ? `${errors.length} 条` : '没有'),
                errors.length ? h('button', {
                  className: 'hear-btn', key: 'c1',
                  onClick: () => copy(errors.map((e) => `${e.at} [${e.source}] ${e.message}`).join('\n')).then((ok) => setToast(ok ? '已复制' : '复制失败')),
                }, '复制') : null,
                errors.length ? h('button', {
                  className: 'hear-btn', key: 'c2',
                  onClick: async () => {
                    try {
                      await api('/errors/clear', { method: 'POST', body: {} });
                      setErrors([]);
                      setToast('已清空');
                    } catch (error) {
                      setBanner(String(error.message || error));
                    }
                  },
                }, '清空') : null,
              ]),
              ...(errors.length ? errors.slice(0, 8).map((e, i) => h('div', { className: 'hear-check', key: `${e.at}-${i}` }, [
                h('span', { className: 'hear-mark bad', key: 'm' }, '!'),
                h('div', { key: 'c', style: { flex: 1 } }, [
                  h('b', null, `${e.source || '未知'}　${fmtTime(Date.parse(e.at))}${e.engine && status?.engine && e.engine !== status.engine ? `（${e.engine === 'cloud' ? '云端模式时' : '本地模式时'}）` : ''}`),
                  h('p', null, String(e.message || '').slice(0, 300)),
                ]),
              ])) : [h('div', { className: 'hear-empty', key: 'e' }, '没有错误记录')]),
            ]),
          ]) : null,
        ]),
        onboard ? h('div', {
          key: 'onboard',
          style: {
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20,
          },
        }, h('div', {
          style: {
            background: 'var(--dsw-alias-bg-overlay, #222)', border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '12px', padding: '18px 20px', width: 'min(560px, 92%)',
            color: 'var(--dsw-alias-label-primary)', boxShadow: '0 12px 40px rgba(0,0,0,.35)',
          },
        }, [
          h('b', { key: 't', style: { fontSize: '14px' } }, '第一次用 先认一下你的电脑'),
          h('div', { key: 'rows', style: { marginTop: '10px', fontSize: '12.5px', lineHeight: '22px' } }, [
            h('div', { key: 'g' }, `显卡：${onboard.gpu ? `${onboard.gpu.name}（${onboard.gpuGb}G）` : '没读到独显'}`),
            h('div', { key: 'd' }, `硬盘剩余：${onboard.disk ? fmtBytes(onboard.disk.freeBytes) : '读不到'}`),
            h('div', { key: 'n' }, `网络：${onboard.network ? '能连上 ModelScope' : '连不上，建议走云端'}`),
            h('div', { key: 'p' }, `Python：${onboard.python?.version || '没找到'}`),
            h('div', { key: 'deps' }, `依赖：${onboard.deps ? ['torch', 'transformers', 'bitsandbytes', 'soundfile'].map((m) => `${m}${onboard.deps[m] ? '✓' : '✗'}`).join(' ') : '查不到'}`),
          ]),
          h('div', {
            key: 'rec',
            style: { marginTop: '10px', padding: '8px 10px', borderRadius: '9px', background: 'rgba(47,125,246,.10)', fontSize: '12.5px' },
          }, `建议用：${onboard.recommend?.name || '—'}${onboard.recommend?.size ? `（${onboard.recommend.size}）` : ''}　${onboard.recommend?.why || ''}${onboard.recommend?.minutes ? `　按五兆一秒大约 ${onboard.recommend.minutes} 分钟` : ''}`),
          h('div', { key: 'btns', style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } }, [
            onboard.recommend?.id && onboard.recommend.id !== 'cloud'
              ? h('button', { key: 'dl', className: 'hear-btn primary', disabled: Boolean(busy), onClick: onboardDownload }, busy === 'download' ? '准备中…' : '下载并启动')
              : null,
            h('button', { key: 'cl', className: 'hear-btn', onClick: onboardCloud }, '我想走云端'),
            h('button', { key: 'sk', className: 'hear-btn', onClick: finishOnboard }, '先跳过'),
          ]),
        ])) : null,
      ]);
    }

    function cell(label, value) {
      return h('div', { className: 'hear-cell', key: label }, [h('b', { key: 'b' }, label), h('span', { key: 'v' }, String(value))]);
    }

    function field(label, node, hint) {
      return h('div', { className: 'hear-field', key: label }, [
        h('label', { key: 'l' }, label),
        h('div', { key: 'n' }, [
          node,
          hint ? h('div', { className: 'hear-hint', key: 'h' }, hint) : null,
        ]),
      ]);
    }

    function slider(value, min, max, step, onChange, text) {
      return h('div', { className: 'hear-slider' }, [
        h('input', { key: 'i', type: 'range', min, max, step, value, onChange: (e) => onChange(Number(e.target.value)) }),
        h('span', { key: 't', style: { minWidth: '60px', textAlign: 'right' } }, text),
      ]);
    }

    function select(value, options, onChange) {
      return h('select', { className: 'hear-input', value, onChange: (e) => onChange(e.target.value) },
        options.map(([v, label]) => h('option', { key: v, value: v }, label)));
    }

    function toggle(value, onChange) {
      return h('button', {
        className: 'hear-btn',
        'aria-pressed': Boolean(value),
        onClick: () => onChange(!value),
      }, value ? '开' : '关');
    }

    async function copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const el = document.createElement('textarea');
          el.value = text;
          document.body.appendChild(el);
          el.select();
          document.execCommand('copy');
          el.remove();
          return true;
        } catch {
          return false;
        }
      }
    }

    function Shell() {
      return h(Boundary, null, h(HearPage));
    }

    function apply(ctx) {
      const t = makeT(ctx);
      if (!ctx.slots) return;
      const mount = () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-hear',
        order: 8,
        label: () => t('nav'),
      }, Shell));
      try {
        if (typeof ctx.effect === 'function') ctx.effect(mount, 'dsh-hear: settings section');
        else mount();
      } catch (error) {
        report('register: ' + ((error && error.message) || error), error && error.stack);
      }
    }

    return { inject: ['slots'], apply };
  },
});
