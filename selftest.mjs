/**
 * 工作区里的自检台，不属于插件包。
 * 用一个假的 ctx / React 把 Host 和 Client 两半各跑一遍，先抓住会直接崩的东西。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = 'D:\\插件开发\\dsh-hear';

// ── Host 半 ────────────────────────────────────────────────────────────────
const effects = [];
const routes = [];
const tools = [];
const hostCtx = {
  effect(fn) {
    const dispose = fn();
    effects.push(dispose);
    return dispose;
  },
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
          routes.push(route);
          return () => {
            const i = routes.indexOf(route);
            if (i >= 0) routes.splice(i, 1);
          };
        },
      };
    }
    if (name === 'tools') {
      return {
        register(def) {
          tools.push(def);
          return () => {
            const i = tools.indexOf(def);
            if (i >= 0) tools.splice(i, 1);
          };
        },
      };
    }
    return undefined;
  },
  on() {},
};

const host = await import(pathToFileURL(path.join(root, 'index.js')).href + '?t=' + Date.now());
host.apply(hostCtx, {});
console.log('host: routes=', routes.map((r) => r.path), 'tools=', tools.map((t) => t.name));

// 卸一次，看资源有没有收干净。
for (const dispose of effects.splice(0)) dispose();
console.log('host: after dispose routes=', routes.length, 'tools=', tools.length);

// 再挂一次，确认不重复。
host.apply(hostCtx, {});
console.log('host: re-apply routes=', routes.length, 'tools=', tools.length);

// ── Client 半 ──────────────────────────────────────────────────────────────
function makeReact(tabOverride) {
  class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  }
  Component.prototype.isReactComponent = {};
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() };
    },
    Component,
    useState(initial) {
      const tab = globalThis.__tab;
      const value = initial === 'status' && tab ? tab : typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    },
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
    useRef(value) {
      return { current: value };
    },
  };
  return React;
}

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(mod) {
      loaded = mod;
    },
  },
  addEventListener() {},
};

await import(pathToFileURL(path.join(root, 'client.js')).href + '?t=' + Date.now());
if (!loaded) throw new Error('client module did not register');
const React = makeReact();
const clientModule = loaded.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});
console.log('client: exports=', Object.keys(clientModule));

const slots = [];
const clientCtx = {
  locale: undefined,
  effect(fn, _label) {
    return fn();
  },
  slots: {
    inject(key, cb) {
      return cb();
    },
    register(options, component) {
      slots.push({ options, component });
      return () => {};
    },
  },
};
clientModule.apply(clientCtx);
console.log('client: slots=', slots.map((s) => s.options.id + '/' + s.options.order));

// 真的渲染一遍，抓渲染期异常。
const shell = slots[0].component({});
console.log('client: shell root=', shell && shell.type ? shell.type.name || shell.type : typeof shell);

function renderComponent(element) {
  if (!element || typeof element !== 'object') return element;
  if (typeof element.type === 'function' && !(element.type.prototype && element.type.prototype.isReactComponent)) {
    const child = element.type(element.props || {});
    return renderComponent(child);
  }
  if (element.children) {
    for (const child of element.children) renderComponent(child);
  }
  return element;
}

renderComponent((shell.children || [])[0]);
for (const tab of ['status', 'options', 'models', 'doctor']) {
  globalThis.__tab = tab;
  const view = renderComponent((shell.children || [])[0]);
  console.log('client: tab', tab, 'rendered ->', view && view.type);
}

// 插件会开文件监听，测试跑完直接退，别挂着。
process.exit(0);
