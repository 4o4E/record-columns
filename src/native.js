// QQ 9.9.36-53644 的模块编号集中维护；业务界面不直接依赖 QQ 的私有导出名称。
let runtime;

export function nativeRuntime() {
  if (runtime) return runtime;
  let require;
  const chunks = window.webpackChunkqq_chat;
  const length = chunks.length;
  chunks.push([[`record-columns-${crypto.randomUUID()}`], {}, value => { require = value; }]);
  if (chunks.length > length) chunks.pop();
  runtime = { require, api: require(7375) };
  return runtime;
}

export async function readRecord(root, parentMsgId) {
  const { api } = nativeRuntime();
  const result = await api.ntApi.nodeIKernelMsgService.getMultiMsg({
    peer: { chatType: root.chatType, peerUid: root.peerUid },
    rootMsgId: root.msgId,
    parentMsgId,
  }, null);
  if (result.result !== 0) {
    throw new Error(`无法读取聊天记录：${result.errMsg || `结果码 ${result.result}`}`);
  }
  return result.msgList;
}

export function recordTitle(record) {
  const element = record.elements.find(element => element.multiForwardMsgElement);
  if (element) {
    const xml = new DOMParser().parseFromString(element.multiForwardMsgElement.xmlContent, 'text/xml');
    const title = xml.querySelector('title');
    return title?.textContent?.trim() || '聊天记录';
  }
  const ark = record.elements.find(element => element.arkElement);
  if (ark) {
    const data = JSON.parse(ark.arkElement.bytesData);
    return data.meta?.detail?.news?.[0]?.text || data.prompt || '聊天记录';
  }
  return '聊天记录';
}

export function hasRecord(record) {
  return record.elements.some(element => {
    if (element.multiForwardMsgElement) return true;
    if (!element.arkElement) return false;
    return JSON.parse(element.arkElement.bytesData).app === 'com.tencent.multimsg';
  });
}

// 回复原文保存在 msgRecord.records 中，不一定出现在当前列的可见消息中。
// 只使用引用身份匹配，不把摘要、第一条消息或缩略图当作被引用的原消息。
export function replySource(record, messages) {
  const reply = record.elements.find(element => element.replyElement)?.replyElement;
  if (!reply) throw new Error('这条消息没有回复引用');
  const ids = new Set([reply.sourceMsgIdInRecords, reply.replayMsgId].filter(id => id && id !== '0'));
  const visited = new Set();
  const queue = [...(record.records || []), ...messages];
  for (let index = 0; index < queue.length; index++) {
    const candidate = queue[index];
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (ids.has(candidate.msgId)) return candidate;
    queue.push(...(candidate.records || []));
  }
  throw new Error(reply.sourceMsgExpired
    ? '被回复的原消息已经过期，无法查看引用图片'
    : '这份转发记录没有保存被回复的原消息，无法查看引用图片');
}

export async function openMedia(host, root, messages, payload) {
  const helper = host.ctx.msgMediaViewerHelperService;
  // 用当前列构建媒体列表，避免原生共享列表把图片导航带到其他列。
  const mediaItems = await helper.fetchMsgService.formatMsg(messages, root);
  await helper.openMediaViewer({ ...payload, mediaItems });
}

// IPC 不能发送 Vue Proxy。保留 QQ 消息中的二进制和 Map，不通过 JSON 重建消息元素。
export function ipcValue(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return value.slice(0);
  const result = Array.isArray(value) ? [] : value instanceof Map ? new Map() : {};
  seen.set(value, result);
  if (value instanceof Map) {
    for (const [key, item] of value) result.set(ipcValue(key, seen), ipcValue(item, seen));
  } else {
    for (const key of Object.keys(value)) result[key] = ipcValue(value[key], seen);
  }
  return result;
}

export async function forwardFromMain({ record, root, element }) {
  const { require } = nativeRuntime();
  // QQ 的联系人选择和发送服务属于主窗口模块，只在原生主窗口内调用。
  const action = require(811).Z;
  const auth = require(50166).getAuthStore();
  const options = {
    sendable: true,
    selfUid: auth.uid,
    selectionMsgIds: [],
    rootMsg: root,
  };
  await action.handler(record, element, options, new MouseEvent('click'));
}
