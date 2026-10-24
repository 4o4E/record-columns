import {
  Virtualizer, elementScroll, observeElementOffset, observeElementRect,
} from '@tanstack/virtual-core';
import { readRecord, recordTitle } from './native.js';

const MESSAGE_SIZE_TARGETS = '.message, .message-container, .message-native, .message-content__wrapper, .forward-msg, .pic-element, img, video';

class Column {
  constructor(info, changed) {
    this.info = info;
    this.messages = [];
    this.selected = null;
    this.loading = false;
    this.error = '';
    this.element = null;
    this.collapsed = false;
    this.savedScrollTop = 0;
    this.observedRows = new Map();
    this.measuredSizes = new Map();
    this.pendingRows = new Set();
    this.measureFrame = 0;
    this.options = {
      count: 0,
      getScrollElement: () => this.element,
      estimateSize: () => 140,
      getItemKey: index => this.messages[index].msgId,
      measureElement: (element, entry) => {
        const index = Number(element.getAttribute('data-index'));
        const key = this.messages[index]?.msgId;
        if (this.collapsed) return this.measuredSizes.get(key) ?? this.options.estimateSize(index);
        const box = entry?.borderBoxSize;
        const borderHeight = (Array.isArray(box) ? box[0] : box)?.blockSize;
        let height = Math.max(borderHeight || element.offsetHeight, element.scrollHeight);
        // QQ 卡片异步填充时可能溢出行盒，行高还需覆盖实际显示的消息内容。
        const rowRect = element.getBoundingClientRect();
        let top = rowRect.top;
        let bottom = rowRect.bottom;
        for (const child of element.querySelectorAll(MESSAGE_SIZE_TARGETS)) {
          const rect = child.getBoundingClientRect();
          if ((!rect.width && !rect.height) || getComputedStyle(child).position === 'fixed') continue;
          top = Math.min(top, rect.top);
          bottom = Math.max(bottom, rect.bottom);
        }
        const scale = element.offsetHeight ? rowRect.height / element.offsetHeight : 1;
        height = Math.ceil(Math.max(height, (bottom - top) / (scale || 1)));
        if (key !== undefined && height > 0) this.measuredSizes.set(key, height);
        return height;
      },
      observeElementRect,
      observeElementOffset,
      scrollToFn: elementScroll,
      overscan: 4,
      initialRect: { width: 400, height: 600 },
      onChange: changed,
      useAnimationFrameWithResizeObserver: true,
    };
    this.virtualizer = new Virtualizer(this.options);
    this.cleanup = this.virtualizer._didMount();
    this.contentObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const row = entry.target.closest?.('.rc-row');
        if (row) this.pendingRows.add(row);
      }
      this.scheduleMeasurements();
    });
    this.layoutObserver = new ResizeObserver(entries => {
      if (this.collapsed || !this.element?.clientWidth) return;
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          this.scheduleAllMeasurements();
          break;
        }
      }
    });
    this.bindElement = element => {
      if (this.element !== element) {
        if (this.element) this.layoutObserver.unobserve(this.element);
        this.element = element;
        if (element) this.layoutObserver.observe(element);
      }
      this.virtualizer._willUpdate();
    };
    this.measureElement = element => {
      if (!element) {
        this.virtualizer.measureElement(null);
        this.pruneRows();
        return;
      }
      this.observeRow(element);
      this.virtualizer.measureElement(element);
      if (!this.collapsed && element.offsetHeight > 0) {
        this.pendingRows.add(element);
        this.scheduleMeasurements();
      }
    };
  }

  observeRow(row) {
    if (this.observedRows.has(row)) return;
    const observer = new MutationObserver(records => {
      let contentChanged = false;
      for (const record of records) {
        // 选中高亮不属于消息内容，避免样式更新触发自身测量。
        if (record.type === 'attributes' && record.target === row) continue;
        contentChanged = true;
        for (const node of record.addedNodes) this.observeSubtree(row, node);
        for (const node of record.removedNodes) this.unobserveSubtree(node);
      }
      if (contentChanged && !this.collapsed) {
        this.pendingRows.add(row);
        this.scheduleMeasurements();
      }
    });
    this.observedRows.set(row, observer);
    for (const child of row.children) this.observeSubtree(row, child);
    observer.observe(row, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'src', 'srcset'],
    });
  }

  observeSubtree(row, node) {
    if (node.nodeType !== 1) return;
    if (node.parentElement === row || node.matches(MESSAGE_SIZE_TARGETS)) this.contentObserver.observe(node);
    for (const child of node.querySelectorAll(MESSAGE_SIZE_TARGETS)) this.contentObserver.observe(child);
  }

  unobserveSubtree(node) {
    if (node.nodeType !== 1) return;
    this.contentObserver.unobserve(node);
    for (const child of node.querySelectorAll(MESSAGE_SIZE_TARGETS)) this.contentObserver.unobserve(child);
  }

  pruneRows() {
    for (const [row, observer] of this.observedRows) {
      if (row.isConnected) continue;
      observer.disconnect();
      for (const child of row.children) this.unobserveSubtree(child);
      this.observedRows.delete(row);
    }
  }

  scheduleMeasurements() {
    if (this.collapsed || this.measureFrame) return;
    const view = this.element?.ownerDocument.defaultView;
    if (!view) return;
    this.measureFrame = view.requestAnimationFrame(() => {
      this.measureFrame = 0;
      if (this.collapsed) return;
      for (const row of this.pendingRows) {
        if (row.isConnected && row.offsetHeight > 0) this.virtualizer.measureElement(row);
      }
      this.pendingRows.clear();
      this.pruneRows();
    });
  }

  scheduleAllMeasurements() {
    if (this.collapsed || !this.element?.clientWidth) return;
    for (const row of this.observedRows.keys()) this.pendingRows.add(row);
    this.scheduleMeasurements();
  }

  setCollapsed(value) {
    value = Boolean(value);
    if (this.collapsed === value) return;
    if (value) {
      this.savedScrollTop = this.element?.scrollTop ?? this.savedScrollTop;
      this.collapsed = true;
      this.pendingRows.clear();
      if (this.measureFrame) {
        this.element?.ownerDocument.defaultView?.cancelAnimationFrame(this.measureFrame);
        this.measureFrame = 0;
      }
      return;
    }
    this.collapsed = false;
    const view = this.element?.ownerDocument.defaultView;
    if (!view) return;
    this.measureFrame = view.requestAnimationFrame(() => {
      this.measureFrame = 0;
      if (!this.element || !this.element.clientWidth) return;
      this.element.scrollTop = this.savedScrollTop;
      this.scheduleAllMeasurements();
    });
  }

  rows() {
    if (this.virtualizer.options.count !== this.messages.length) {
      this.virtualizer.setOptions({ ...this.options, count: this.messages.length });
    }
    return this.virtualizer.getVirtualItems();
  }

  dispose() {
    this.cleanup();
    this.contentObserver.disconnect();
    this.layoutObserver.disconnect();
    for (const observer of this.observedRows.values()) observer.disconnect();
    this.observedRows.clear();
    this.measuredSizes.clear();
    this.pendingRows.clear();
    if (this.measureFrame) {
      this.element?.ownerDocument.defaultView?.cancelAnimationFrame(this.measureFrame);
      this.measureFrame = 0;
    }
    this.element = null;
    this.messages = [];
  }
}


/** 一条导航路径对应若干独立列；异步返回只允许写入仍在该路径中的原列。 */
export class Columns {
  constructor(info, changed) {
    this.changed = changed;
    this.items = [new Column(info, changed)];
    this.disposed = false;
  }

  async open(index, message) {
    const parent = this.items[index];
    if (parent.selected === message.msgId && this.items[index + 1]) return;
    parent.selected = message.msgId;
    this.truncate(index + 1);
    const column = new Column({
      ...parent.info,
      parentMsgId: message.msgId,
      peerName: recordTitle(message),
    }, this.changed);
    column.loading = true;
    this.items.push(column);
    this.changed();
    try {
      const messages = await readRecord(column.info.rootMsg, column.info.parentMsgId);
      if (this.disposed || !this.items.includes(column)) return;
      column.messages = messages;
    } catch (error) {
      if (this.disposed || !this.items.includes(column)) return;
      column.error = error.message;
      console.error('[多列聊天记录]', error);
    } finally {
      if (!this.disposed && this.items.includes(column)) {
        column.loading = false;
        this.changed();
      }
    }
  }

  truncate(length) {
    for (const column of this.items.splice(length)) column.dispose();
  }

  close(index) {
    this.truncate(index);
    this.items[index - 1].selected = null;
    this.changed();
  }

  dispose() {
    this.disposed = true;
    this.truncate(0);
  }
}
