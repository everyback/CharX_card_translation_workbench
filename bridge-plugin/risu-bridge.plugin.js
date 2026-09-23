//@name risu-bridge
//@display-name RisuAI 桥接器（预设动作转发）
//@api 2.1
//@version 1.0.0

/**
 * RisuAI 桥接插件 —— 纯转发执行器
 * ==================================
 *
 * 定位：**预设仍然是唯一的功能来源**。这个插件不渲染任何东西、不决定什么时候
 * 出现按钮、也不解析任何预设内容。它只做一件事：
 *
 *   预设写一个声明式动作 → 用户点击 → 插件把动作执行掉 → 插件从记忆中消失
 *
 * 为什么需要它：预设的正则只能注入 HTML。RisuAI 会剥掉消息里的 <script> 和
 * onclick，而消息内的 Lua 触发器白名单里没有任何 DOM 入口
 * （见 process/scriptings.ts 的 declareAPI 列表）。于是「把文字写进输入框」
 * 这类操作，预设无论怎么写都做不到 —— 这正是本插件存在的唯一理由。
 *
 * 能做的动作（预设用 data-risu-bridge 声明）：
 *
 *   data-risu-bridge="fill"        把内容写进聊天输入框（复刻 ST 的填充行为）
 *   data-risu-bridge="fill-send"   写入后再触发发送
 *   data-risu-bridge="send"        直接触发发送
 *   data-risu-bridge="copy"        把内容复制到剪贴板
 *
 * 内容来源：优先 data-risu-value 属性，否则取元素自身的文本。
 *
 * 说明：插件里直接写 `document` 即可，RisuAI 的 checkCodeSafety 会做 AST 重写，
 * 把 document → safeDocument、window/globalThis/top/parent → safeGlobalThis。
 * safeDocument 是**真实页面 DOM** 的受限包装（pluginSafeClass.ts 里直接转发
 * document.querySelector 等），所以选择器能命中真实元素。
 *
 * 选择器取自部署产物还原出的源码 src/lib/ChatScreens/DefaultChatScreen.svelte：
 *   输入框 <textarea class="... text-input-area ..." bind:value={messageInput}>
 *   发送键 <button onclick={send} class="... button-icon-send ...">
 */

const BRIDGE_ATTR = 'data-risu-bridge';
const VALUE_ATTR = 'data-risu-value';

/** 输入区选择器。text-input-area 在整份产物里只出现一次。 */
const INPUT_SELECTOR = 'textarea.text-input-area';
/** 发送键选择器。button-icon-send 是发送分支独有的类。 */
const SEND_SELECTOR = 'button.button-icon-send';

function log(...args) {
  try {
    console.log('[risu-bridge]', ...args);
  } catch {
    /* console 被替换时忽略 */
  }
}

function warn(message) {
  log(message);
  try {
    if (typeof alertStore !== 'undefined' && alertStore && typeof alertStore.set === 'function') {
      alertStore.set(message);
    }
  } catch {
    /* 没有可用提示通道时只写日志 */
  }
}

function findInput() {
  return document.querySelector(INPUT_SELECTOR);
}

function findSendButton() {
  return document.querySelector(SEND_SELECTOR);
}

/**
 * 写入输入框并派发 input 事件。
 *
 * DefaultChatScreen 用的是 Svelte 的 bind:value，靠 input 事件回写状态；
 * 只改 value 不派发事件的话，界面看起来有字但状态是空的，发送出去会是空消息。
 * 这里用原型上的 value setter 赋值，绕开可能被框架改写的实例属性。
 */
function fillInput(text) {
  const input = findInput();
  if (!input) {
    warn('桥接器：找不到聊天输入框，可能不在聊天界面。');
    return false;
  }
  try {
    const proto = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(input, text);
    else input.value = text;
  } catch {
    input.value = text;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  try {
    input.focus();
  } catch {
    /* focus 失败不影响写入结果 */
  }
  return true;
}

function clickSend() {
  const button = findSendButton();
  if (!button) {
    warn('桥接器：找不到发送按钮（可能正在生成回复）。');
    return false;
  }
  button.click();
  return true;
}

/**
 * 取动作内容。
 *
 * **优先元素自身文本，而不是 data-risu-value。**
 *
 * 原因是实测确认的 HTML 属性截断：预设把捕获组回填进属性时，
 * 若内容含引号就会在引号处终止属性。而 RisuAI 渲染前会做
 * `replace(/[“”]/g, '"')` 把弯引号转成直角引号，`$1` 又是运行时插入、
 * 模板侧无法预转义 —— 所以 `data-risu-value="$1"` 这种写法天生不可靠。
 * 例：`【…定金额度，“就它了”】` 在属性里只剩到 `“` 之前，而按钮文本是完整的。
 *
 * 结论：内容放元素文本，属性只放固定的动作名。属性在这里仅作兜底。
 */
function payloadOf(element) {
  const text = (element.textContent || '').trim();
  if (text) return text;
  const explicit = element.getAttribute(VALUE_ATTR);
  if (explicit !== null && explicit !== '') return explicit;
  return '';
}

async function copyText(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级到 execCommand */
  }
  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(helper);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 事件委托：只在点击的那一刻去找 [data-risu-bridge]。
 * 不在加载时扫描，是因为消息是渲染完不断变化的，任何缓存都会过期。
 */
async function handleClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const element = target.closest(`[${BRIDGE_ATTR}]`);
  if (!element) return;

  const action = (element.getAttribute(BRIDGE_ATTR) || '').trim();
  if (!action) return;

  // 阻止消息内其他点击副作用（比如折叠面板），动作由桥接器独占
  event.preventDefault();
  event.stopPropagation();

  const value = payloadOf(element);
  log('动作', action, '内容长度', value.length);

  switch (action) {
    case 'fill': {
      if (fillInput(value)) log('已写入输入框');
      break;
    }
    case 'fill-send': {
      if (fillInput(value)) {
        // 等一帧，让状态回写与高度自适应先跑完，再点发送
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (clickSend()) log('已写入并发送');
      }
      break;
    }
    case 'send': {
      if (clickSend()) log('已触发发送');
      break;
    }
    case 'copy': {
      const ok = await copyText(value);
      if (!ok) warn('桥接器：复制失败，浏览器可能拒绝了剪贴板访问。');
      else log('已复制');
      break;
    }
    default: {
      warn(`桥接器：不认识的动作 "${action}"。`);
      break;
    }
  }
}

document.addEventListener('click', handleClick, true);
log('已挂载：转发 [data-risu-bridge] 动作（fill / fill-send / send / copy）');

// 卸载时摘掉监听，避免热重载重复绑定
if (typeof onUnload === 'function') {
  onUnload(() => {
    try {
      document.removeEventListener('click', handleClick, true);
      log('已卸载');
    } catch {
      /* 忽略 */
    }
  });
}
