/**
 * GarbageMaster — "这是应用/环境，不该直接删目录" 的识别与卸载建议。
 *
 * 语义（用户定义的第 3 类清除方式）：如果用户选中的是一个**应用**或**运行时环境**，
 * 正确做法是**卸载**它，而不是 `rm -rf` 目录 —— 直接删目录会留下包管理器的状态、
 * 会让「已安装列表」与实际不一致，甚至把正在用的环境弄坏。
 *
 * 这里只做**纯识别**：给定路径，判断它属于哪个包管理器/环境管理器，并给出卸载命令。
 * 命令只作为「官方处置」呈现给用户（与规则包里的 remedy 同一套 UI），**不会自动执行**。
 *
 * 刻意保持保守：只认那些"删目录必留下坏状态"的目录；普通缓存/数据目录不在此列。
 */

/**
 * @param {string} input 绝对路径
 * @returns {{kind:string,name:string,command:string|null,why:string}|null}
 */
export function detectUninstall(input) {
  if (typeof input !== 'string' || !input.startsWith('/')) return null;
  const p = input.replace(/\/+$/, '');

  let m = /^(?:\/snap|\/home\/[^/]+\/snap)\/([^/]+)(?:\/|$)/.exec(p);
  if (m) {
    return {
      kind: 'snap', name: m[1],
      command: `sudo snap remove ${m[1]}`,
      why: 'Snap 应用要用 snap 卸载；直接删 /snap 下的目录会留下挂载点与 snapd 的登记信息。'
    };
  }

  m = /\/\.var\/app\/([^/]+)(?:\/|$)/.exec(p);
  if (m) {
    return {
      kind: 'flatpak', name: m[1],
      command: `flatpak uninstall ${m[1]}`,
      why: 'Flatpak 应用要用 flatpak 卸载；直接删 ~/.var/app 下的目录只清掉数据，应用本体还在。'
    };
  }

  m = /\/(?:anaconda3|miniconda3|\.conda)\/envs\/([^/]+)(?:\/|$)/.exec(p);
  if (m) {
    return {
      kind: 'conda-env', name: m[1],
      command: `conda env remove -n ${m[1]}`,
      why: 'Conda 环境要用 conda 删除，否则 conda 的 environments.txt 里会留下指向空气的登记项。'
    };
  }

  m = /\/\.nvm\/versions\/node\/([^/]+)(?:\/|$)/.exec(p);
  if (m) {
    return {
      kind: 'nvm', name: m[1],
      command: `nvm uninstall ${m[1]}`,
      why: 'Node 版本应当用 nvm 卸载，nvm 需要同步更新自己的别名与默认版本链接。'
    };
  }

  m = /\/\.pyenv\/versions\/([^/]+)(?:\/|$)/.exec(p);
  if (m) {
    return {
      kind: 'pyenv', name: m[1],
      command: `pyenv uninstall ${m[1]}`,
      why: 'Python 版本应当用 pyenv 卸载，否则 shims 会指向不存在的解释器。'
    };
  }

  m = /^\/opt\/([^/]+)(?:\/|$)/.exec(p);
  if (m) {
    return {
      kind: 'opt-app', name: m[1],
      command: null,
      why: '/opt 下的独立安装应用应走它自带的卸载方式（或在系统软件中心卸载），不要直接删目录。'
    };
  }

  return null;
}

/**
 * 在一批路径里筛出"其实该卸载"的条目。
 * @param {Array<{path:string,size?:number}>} items
 */
export function collectUninstallHints(items) {
  const hints = [];
  for (const item of items || []) {
    const found = detectUninstall(item.path);
    if (found) hints.push({ path: item.path, size: Number(item.size) || 0, ...found });
  }
  return hints;
}
