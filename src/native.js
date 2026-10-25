// 只接管本次转发新建的原生选择器；用户确认前不发送，关闭选择器即取消。
let pendingForward;
const cancelledForwards = new Map();

function finishForward(pending, error, result) {
  if (pendingForward !== pending) return;
  clearTimeout(pending.timer);
  pendingForward = undefined;
  if (error) pending.reject(error);
  else pending.resolve(result);
}

function cancelBeforeMount(pending, error) {
  const msgId = pending.record.msgId;
  if (!pending.component) {
    cancelledForwards.set(msgId, { component: null });
  }
  finishForward(pending, error);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function closeCancelledSelector(component, cancelled) {
  if (cancelled.component) return;
  cancelled.component = component;
  const close = () => component.ctx.close();
  component.vnode.props.onConfirmed = close;
  component.props.onConfirmed = close;
  close();
}

const forwardCleanupWarning = errors =>
  `转发请求已提交，但选择器界面清理失败：${errors.map(errorMessage).join('；')}。请勿重复转发。`;

export function attachForwardSelector(component) {
  const msgId = component.props?.msgRecords?.[0]?.msgId;
  if (component.props?.type === 'messageForward' && msgId != null) {
    const cancelled = cancelledForwards.get(msgId);
    if (cancelled) {
      closeCancelledSelector(component, cancelled);
      return;
    }
  }
  const pending = pendingForward;
  if (!pending || pending.component || component.props?.type !== 'messageForward' ||
      msgId !== pending.record.msgId ||
      typeof component.props.onConfirmed !== 'function') return;

  pending.component = component;
  clearTimeout(pending.timer);
  const confirm = (selectedContacts, commentElements) => {
    if (pending.confirmed || pendingForward !== pending) return;
    // 原生不等待此回调的 Promise；先锁定确认，卸载不能覆盖发送结果。
    pending.confirmed = true;
    void (async () => {
      let error;
      try {
        const { api } = nativeRuntime();
        const result = await api.ntApi.nodeIKernelMsgService.forwardSubMsgWithComment({
          rootMsgIds: pending.rootMsgIds,
          subMsgIds: [pending.record.msgId],
          srcContact: {
            chatType: pending.root.chatType,
            peerUid: pending.root.peerUid,
            guildId: pending.root.guildId || '',
          },
          dstContacts: selectedContacts.map(contact => ({
            chatType: contact.type,
            peerUid: contact.uid,
            guildId: '',
          })),
          commentElements,
          msgAttributeInfos: new Map(),
        }, null);
        if (result.result !== 0) {
          throw new Error(`转发失败：${result.errMsg || `结果码 ${result.result}`}`);
        }
      } catch (caught) {
        error = caught;
      }

      const cleanupErrors = [];
      if (!component.isUnmounted) {
        try {
          component.ctx.setConfirmStatus(false);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          component.ctx.close();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (error && cleanupErrors.length) {
        const combined = new Error(
          `${errorMessage(error)}；选择器界面清理失败：${cleanupErrors.map(errorMessage).join('；')}`,
        );
        combined.cause = error;
        error = combined;
      }
      finishForward(
        pending,
        error,
        !error && cleanupErrors.length ? { warning: forwardCleanupWarning(cleanupErrors) } : undefined,
      );
    })();
  };

  component.vnode.props.onConfirmed = confirm;
  component.props.onConfirmed = confirm;
  // 只转发选中的消息，不附带当前群的其他聊天内容。
  component.props.enableChatRecord = false;
  component.vnode.props.enableChatRecord = false;
}


export function detachForwardSelector(component) {
  const msgId = component.props?.msgRecords?.[0]?.msgId;
  const cancelled = msgId == null ? undefined : cancelledForwards.get(msgId);
  if (cancelled?.component === component) {
    cancelledForwards.delete(msgId);
    return;
  }
  const pending = pendingForward;
  if (!pending || pending.component !== component || pending.confirmed) return;
  // 原生选择器关闭且未确认即为用户取消；正常完成，不向源窗口报告错误。
  finishForward(pending);
}

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

export async function forwardFromMain({ record, root, rootMsgIds, element }) {
  const msgId = record.msgId;
  if (cancelledForwards.has(msgId)) {
    throw new Error('上一次转发选择器尚未结束，请关闭它或重新加载 QQ 主窗口后重试');
  }
  if (pendingForward) throw new Error('已有一项聊天记录转发选择正在进行');
  const { require } = nativeRuntime();
  // QQ 的联系人选择和发送服务属于主窗口模块，只在原生主窗口内调用。
  const action = require(811).Z;
  const auth = require(50166).getAuthStore();
  const pending = { record, root, rootMsgIds, component: null, confirmed: false };
  const result = new Promise((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });
  pendingForward = pending;
  // 原生 action 异步挂载选择器；10 秒后虽结束请求，仍需用 msgId 接住迟到窗口。
  pending.timer = setTimeout(() => {
    cancelBeforeMount(pending, new Error('QQ 联系人选择器未接入，无法转发聊天记录'));
  }, 10000);
  try {
    await action.handler(record, element, {
      sendable: true,
      selfUid: auth.uid,
      rootMsg: root,
    }, new MouseEvent('click'));
  } catch (error) {
    if (pendingForward === pending) {
      if (pending.component) finishForward(pending, error);
      else cancelBeforeMount(pending, error);
    }
  }
  return result;
}
