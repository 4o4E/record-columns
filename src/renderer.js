import { createVNode } from '@vue/runtime-core';
import { Columns } from './columns.js';
import {
  attachForwardSelector, detachForwardSelector, forwardFromMain, hasRecord, ipcValue, openMedia, replySource,
} from './native.js';
import styles from './style.css';
const views = new Map();
const hosts = new Set();
let enabled = null;
let styleElement;
let settingSubscription;
const COLUMN_MIN_WIDTH = 320;
const COLUMN_WIDTH = 410;
const COLLAPSED_COLUMN_WIDTH = 60;
 
class RecordView {
  constructor(host) {
    this.host = host;
    // 只创建与 QQ 同版本的 VNode；组件实例、响应更新和引用均由 QQ 的渲染器管理。
    this.h = (type, props, children) => {
      const vnode = createVNode(type, props, children);
      vnode.ctx = host;
      if (vnode.ref) vnode.ref.i = host;
      return vnode;
    };
    this.originalRender = host.render;
    this.Message = host.type.components.Message;
    this.Menu = host.type.components.MessageContextMenu;
    this.busy = new Set();
    this.error = '';
    this.disposed = false;
    this.revealNext = false;
    this.replyDialog = null;
    this.replyDialogElement = null;
    this.layoutWidth = 0;
    this.manualCollapse = new WeakMap();
    this.layoutElement = null;
    this.layoutObserver = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - this.layoutWidth) < 1) return;
      this.layoutWidth = width;
      this.updateColumnLayout();
      this.refresh();
    });
    this.bindLayout = element => {
      if (this.layoutElement === element) return;
      if (this.layoutElement) this.layoutObserver.unobserve(this.layoutElement);
      this.layoutElement = element;
      if (element) {
        this.layoutObserver.observe(element);
        this.layoutWidth = element.getBoundingClientRect().width;
        this.updateColumnLayout();
      }
    };
    this.bindReplyDialog = element => {
      this.replyDialogElement = element;
      if (element && !element.open) {
        element.show();
        element.querySelector('.rc-reply-close')?.focus();
      }
    };
    this.refresh = () => {
      if (!this.disposed && !host.isUnmounted) host.proxy.$forceUpdate();
    };
    this.columns = new Columns(host.props.forwardInfo, this.refresh);
    this.updateColumnLayout();
    this.scrollIntoView = element => {
      if (element && this.revealNext) {
        this.revealNext = false;
        element.scrollIntoView({ block: 'nearest', inline: 'end' });
      }
    };
    host.render = () => this.render();
    this.refresh();
  }
  updateColumnLayout() {
    const columns = this.columns?.items ?? [];
    if (!columns.length) return;
    const collapsed = new Set();
    for (let index = 0; index < columns.length - 1; index++) {
      if (this.manualCollapse.get(columns[index]) === true) collapsed.add(columns[index]);
    }
    let required = COLUMN_MIN_WIDTH;
    for (let index = 0; index < columns.length - 1; index++) {
      required += collapsed.has(columns[index]) ? COLLAPSED_COLUMN_WIDTH : COLUMN_WIDTH;
    }
    for (let index = 0; required > this.layoutWidth && index < columns.length - 1; index++) {
      const column = columns[index];
      if (this.manualCollapse.get(column) === false || collapsed.has(column)) continue;
      collapsed.add(column);
      required -= COLUMN_WIDTH - COLLAPSED_COLUMN_WIDTH;
    }
    for (let index = 0; index < columns.length; index++) {
      const value = index < columns.length - 1 && collapsed.has(columns[index]);
      if (columns[index].collapsed !== value) columns[index].setCollapsed(value);
    }
  }

  toggleColumn(column) {
    const collapse = !column.collapsed;
    this.manualCollapse.set(column, collapse);
    this.updateColumnLayout();
    this.refresh();
  }

  async open(index, record) {
    if (this.columns.items.length === 1) window.recordColumns?.ready();
    this.revealNext = true;
    await this.columns.open(index, record);
  }

  showReply(column, record) {
    try {
      this.replyDialog = { column, source: replySource(record, column.messages) };
    } catch (error) {
      this.replyDialog = { column, error: error.message };
    }
    this.refresh();
  }

  closeReply() {
    this.replyDialog = null;
    this.replyDialogElement?.close();
    this.refresh();
  }

  async forward(column, record, element) {
    if (this.busy.has(record.msgId)) return;
    this.error = '';
    this.busy.add(record.msgId);
    this.refresh();
    try {
      if (!window.recordColumns) throw new Error('请重启 QQ，加载多列聊天记录插件的发送接口');
      // 内层消息不属于群消息列表；转发必须携带最外层到当前列的完整祖先身份。
      const root = column.info.rootMsg;
      const rootMsgIds = this.columns.items
        .slice(0, this.columns.items.indexOf(column) + 1)
        .map(item => item.info.parentMsgId);
      if (rootMsgIds[0] !== root.msgId) rootMsgIds.unshift(root.msgId);
      const result = await window.recordColumns.forward(ipcValue({ record, root, rootMsgIds, element }));
      if (result?.warning) this.error = result.warning;
    } catch (error) {
      this.error = error.message;
      console.error('[多列聊天记录]', error);
    } finally {
      this.busy.delete(record.msgId);
      this.refresh();
    }
  }

  async action(column, event, source) {
    try {
      if (event.action.actionType === 'open-media-viewer') {
        const messages = source && !column.messages.includes(source)
          ? [...column.messages, source] : column.messages;
        await openMedia(this.host, column.info.rootMsg, messages, event.action.payload);
      } else {
        await this.host.ctx.handleAction(event);
      }
    } catch (error) {
      this.error = error.message;
      console.error('[多列聊天记录]', error);
      this.refresh();
    }
  }

  contextMenu(column, event) {
    const menu = this.host.ctx.msgCtxMenu;
    const isRecord = hasRecord(event.msgRecord);
    const item = {
      type: 6,
      text: '转发',
      icon: 'forward',
      when: () => !this.busy.has(event.msgRecord.msgId),
      handler: () => this.forward(column, event.msgRecord, event.msgElement),
    };
    // 记录卡片使用自己的转发入口；其他消息保留 QQ 原有的复制、另存为等操作。
    if (!isRecord) this.host.ctx.handleMsgContextMenu(event);
    const items = isRecord ? [] : menu.menuConfig.filter(item => item.type !== 6);
    menu.openMenu(event.e, [...items, item], {
      sense: 'aio',
      msgRecord: event.msgRecord,
      element: event.msgElement,
      rootMsg: column.info.rootMsg,
      options: { sendable: true, selfUid: this.host.ctx.selfUid },
    });
  }

  message(column, record, source) {
    return this.h(this.Message, {
      key: record.msgId,
      scene: this.host.ctx.msgScene,
      uid: this.host.ctx.selfUid,
      'get-member-info-by-uid': this.host.ctx.getMemberInfoByUid,
      'msg-record': record,
      'root-msg': column.info.rootMsg,
      'parent-msg-id': column.info.parentMsgId,
      'show-name': true,
      'buddy-map-info': this.host.ctx.buddyMapInfo,
      'view-port-container': source ? undefined : column.element,
      onContextmenu: event => this.contextMenu(column, event),
      onAction: event => this.action(column, event, source),
      onCopy: this.host.ctx.handleCopy,
      onDragMedia: this.host.ctx.handleDragMedia,
    });
  }

  row(column, columnIndex, row) {
    const record = column.messages[row.index];
    const isRecord = hasRecord(record);
    const reply = record.elements.some(element => element.replyElement);
    return this.h('article', {
      key: row.key,
      class: ['rc-row', { 'rc-row--selected': column.selected === record.msgId }],
      'data-index': row.index,
      'data-msg-id': record.msgId,
      ref: column.measureElement,
      onClickCapture: event => {
        if (isRecord && event.target.closest('.forward-msg')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void this.open(columnIndex, record);
        } else if (reply && event.target.closest('.reply-element')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.showReply(column, record);
        }
      },
    }, [
      this.message(column, record),
    ]);
  }

  renderColumn(column, index) {
    // 可见消息按自然高度依次排列，虚拟占位只表示屏幕外尚未挂载的消息。
    const rows = column.rows();
    const isAncestor = index < this.columns.items.length - 1;
    const isCollapsed = isAncestor && column.collapsed;
    return this.h('section', {
      key: column.info.parentMsgId,
      class: ['rc-column', { 'rc-column--collapsed': isCollapsed }],
      ref: index === this.columns.items.length - 1 ? this.scrollIntoView : null,
      'aria-label': `第 ${index + 1} 层聊天记录`,
    }, [
      isAncestor || index ? this.h('header', { class: 'rc-column-header' }, [
        isAncestor ? this.h('button', {
          class: 'rc-collapse',
          title: isCollapsed ? '展开此列' : '折叠此列',
          'aria-label': isCollapsed ? '展开此列' : '折叠此列',
          'aria-expanded': String(!isCollapsed),
          onClick: () => this.toggleColumn(column),
        }, isCollapsed ? '›' : '‹') : null,
        index ? this.h('button', {
          class: 'rc-close',
          title: '关闭本列及后续记录',
          'aria-label': '关闭本列及后续记录',
          onClick: () => this.columns.close(index),
        }, '×') : null,
      ]) : null,
      this.h('div', { class: 'rc-scroll', ref: column.bindElement }, [
        column.loading ? this.h('p', { class: 'rc-status', role: 'status' }, '正在读取聊天记录…') : null,
        column.error ? this.h('p', { class: 'rc-inline-error', role: 'alert' }, column.error) : null,
        !column.loading && !column.error && !column.messages.length
          ? this.h('p', { class: 'rc-status' }, '没有可显示的聊天记录') : null,
        this.h('div', {
          class: 'rc-message-list',
          style: {
            paddingTop: `${rows[0]?.start ?? 0}px`,
            paddingBottom: `${Math.max(0, column.virtualizer.getTotalSize() - (rows.at(-1)?.end ?? 0))}px`,
          },
        }, rows.map(row => this.row(column, index, row))),
      ]),
    ]);
  }

  renderReplyDialog() {
    const popup = this.replyDialog;
    return this.h('dialog', {
      class: 'rc-reply-dialog',
      ref: this.bindReplyDialog,
      tabindex: '-1',
      'aria-labelledby': 'rc-reply-title',
      onKeydown: event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          this.closeReply();
        } else if (event.key === 'Tab') {
          const focusable = [...event.currentTarget.querySelectorAll(
            'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
          )];
          if (!focusable.length) {
            event.preventDefault();
            event.currentTarget.focus();
          } else if (event.shiftKey && (
            event.target === focusable[0] || !event.currentTarget.contains(event.target)
          )) {
            event.preventDefault();
            focusable.at(-1).focus();
          } else if (!event.shiftKey && (
            event.target === focusable.at(-1) || !event.currentTarget.contains(event.target)
          )) {
            event.preventDefault();
            focusable[0].focus();
          }
        }
      },
      onClose: () => {
        if (this.replyDialog === popup) {
          this.replyDialog = null;
          this.refresh();
        }
      },
    }, [
      this.h('header', { class: 'rc-reply-header' }, [
        this.h('h2', { id: 'rc-reply-title' }, '被回复的原消息'),
        this.h('button', {
          class: 'rc-close rc-reply-close',
          'aria-label': '关闭回复原文',
          onClick: () => this.closeReply(),
        }, '×'),
      ]),
      this.h('div', { class: 'rc-reply-body' }, [
        popup.error
          ? this.h('p', { class: 'rc-inline-error', role: 'alert' }, popup.error)
          : this.message(popup.column, popup.source, popup.source),
      ]),
    ]);
  }

  render() {
    const first = this.columns.items[0];
    first.messages = this.host.ctx.msgList;
    first.error = this.host.ctx.errorTips;
    this.updateColumnLayout();
    const root = this.h('div', { class: 'rc-root', ref: this.bindLayout }, [
      this.error ? this.h('div', { class: 'rc-error', role: 'alert' }, [
        this.h('span', {}, this.error),
        this.h('button', { onClick: () => { this.error = ''; this.refresh(); } }, '关闭提示'),
      ]) : null,
      this.h('div', { class: 'rc-columns' }, this.columns.items.map((column, index) => this.renderColumn(column, index))),
      this.h(this.Menu, { ref: 'msgCtxMenu' }),
      this.replyDialog ? this.h('div', {
        class: 'rc-reply-backdrop',
        'aria-hidden': 'true',
        onClick: () => this.closeReply(),
      }) : null,
      this.replyDialog ? this.renderReplyDialog() : null,
    ]);
    return root;
  }

  dispose() {
    this.disposed = true;
    this.layoutObserver.disconnect();
    this.layoutElement = null;
    this.closeReply();
    this.columns.dispose();
    this.host.render = this.originalRender;
    if (!this.host.isUnmounted) this.host.proxy.$forceUpdate();
  }
}

function isRecordList(component) {
  return location.hash.startsWith('#/forward/') &&
    component.props?.forwardInfo && component.ctx?.forwardMsgListStore &&
    component.type.components?.Message && component.type.components?.MessageContextMenu;
}

function removeView(component) {
  const view = views.get(component);
  if (!view) return;
  view.dispose();
  views.delete(component);
  if (!views.size && styleElement) {
    styleElement.remove();
    styleElement = undefined;
  }
}

function mountView(component) {
  if (enabled !== true || component.isUnmounted || views.has(component)) return;
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.textContent = styles;
    document.head.append(styleElement);
  }
  views.set(component, new RecordView(component));
}

function setEnabled(value) {
  enabled = value === true;
  if (!enabled) {
    for (const component of views.keys()) removeView(component);
    return;
  }
  for (const component of hosts) {
    queueMicrotask(() => {
      if (enabled && hosts.has(component)) mountView(component);
    });
  }
}

export function onVueComponentMount(component) {
  attachForwardSelector(component);
  if (!isRecordList(component)) return;
  hosts.add(component);
  if (enabled !== true) return;
  queueMicrotask(() => {
    if (enabled && hosts.has(component)) mountView(component);
  });
}

export function onVueComponentUnmount(component) {
  detachForwardSelector(component);
  hosts.delete(component);
  removeView(component);
}

async function startEnabledSync() {
  const api = window.recordColumns;
  if (!api || typeof api.getEnabled !== 'function' || typeof api.onEnabledChanged !== 'function') {
    throw new Error('多列聊天记录设置接口未加载，请重启 QQ');
  }
  api.onEnabledChanged(setEnabled);
  const value = await api.getEnabled();
  if (enabled === null) setEnabled(value);
}

export async function onSettingWindowCreated(view) {
  view.setAttribute('data-title', '多列聊天记录');
  view.innerHTML = `<setting-section data-title="功能设置"><setting-panel><setting-list data-direction="column"><setting-item data-direction="row"><setting-text>启用多列聊天记录</setting-text><setting-switch role="switch" aria-label="启用多列聊天记录" tabindex="0" aria-checked="false" aria-disabled="true"></setting-switch></setting-item></setting-list></setting-panel><div class="rc-setting-error" role="status" aria-live="polite"></div></setting-section>`;
  const toggle = view.querySelector('setting-switch');
  const feedback = view.querySelector('.rc-setting-error');
  let active = false;
  let ready = false;
  let busy = false;
  let controlRevision = 0;
  const setControl = value => {
    active = value === true;
    toggle.setActive(active);
    toggle.setAttribute('aria-checked', String(active));
  };
  const setBusy = value => {
    busy = value;
    toggle.setDisabled(value || !ready);
    toggle.setAttribute('aria-disabled', String(value || !ready));
  };
  settingSubscription?.();
  settingSubscription = window.recordColumns.onEnabledChanged(value => {
    controlRevision++;
    setControl(value);
  });
  setBusy(true);
  const revision = controlRevision;
  try {
    const value = await window.recordColumns.getEnabled();
    if (revision === controlRevision) setControl(value);
    ready = true;
    setBusy(false);
  } catch (error) {
    feedback.textContent = `读取失败：${error?.message || error}`;
  }
  const saveToggle = async () => {
    if (!ready || busy) return;
    const previous = active;
    const next = !previous;
    const revision = controlRevision;
    setBusy(true);
    feedback.textContent = '';
    try {
      const saved = await window.recordColumns.setEnabled(next);
      if (revision === controlRevision) setControl(saved);
    } catch (error) {
      if (revision === controlRevision) setControl(previous);
      feedback.textContent = `保存失败：${error?.message || error}`;
    } finally {
      setBusy(false);
    }
  };
  toggle.addEventListener('click', saveToggle);
  toggle.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.repeat) return;
    event.preventDefault();
    saveToggle();
  });
}

// 主窗口承接原生联系人选择；消息和 rootMsg 通过 Electron IPC 保留原有数据类型。
window.recordColumns?.onForwardRequest(async request => {
  try {
    const result = await forwardFromMain(request);
    window.recordColumns.completeForward(request.requestId, undefined, result);
  } catch (error) {
    console.error('[多列聊天记录]', error);
    window.recordColumns.completeForward(request.requestId, error.message);
  }
});

function discover() {
  if (!location.hash.startsWith('#/forward/')) return;
  for (const element of document.querySelectorAll('.vue-component')) {
    for (const component of element.__VUE__ || []) onVueComponentMount(component);
  }
}

await startEnabledSync();
discover();
window.addEventListener('pagehide', () => {
  for (const component of hosts) onVueComponentUnmount(component);
  settingSubscription?.();
}, { once: true });
