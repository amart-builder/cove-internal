import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Runs the actual component's event handlers and hook state without a browser.
// DOM layout and focus stay in the separately owned browser acceptance checks.
export function componentHarness(path, { mocks = {}, globals = {}, exportName = 'default' } = {}) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const hook = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  const react = {
    useState: hook,
    useRef: value => hook(() => ({ current: value }))[0],
    useMemo: factory => factory(),
    useCallback: callback => callback,
    useEffect: (effect, dependencies) => {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies?.some((value, n) => value !== previous[n])) effects.push(effect);
      slots[index] = dependencies;
    },
  };
  react.useLayoutEffect = react.useEffect;
  react.forwardRef = render => props => render(props, props.ref);
  react.useImperativeHandle = (ref, create) => { if (ref) ref.current = create(); };
  const source = fs.readFileSync(path, 'utf8') + (exportName === 'default' ? '' : `\nexport { ${exportName} };`);
  const javascript = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(javascript, {
    exports, console, setTimeout, clearTimeout, URLSearchParams, Error,
    require: name => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      return mocks[name] ?? {};
    }, ...globals,
  }, { filename: path });
  return {
    render(props) { cursor = 0; return exports[exportName](props); },
    async effects() { const pending = effects; effects = []; for (const run of pending) run(); await tick(); },
  };
}
export async function tick() { await new Promise(resolve => setTimeout(resolve, 5)); for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); }
/**
 * First node of `type` in the tree, depth first. Pass `match` when a screen has
 * several of the same element and you want a particular one, e.g. the submit
 * button rather than whichever button the walk reaches first.
 */
export function findElement(node, type, match = () => true) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === type && match(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = findElement(child, type, match); if (found) return found;
  }
}
