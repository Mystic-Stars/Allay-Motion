import { useEffect } from 'react';
import { shortcutFromEvent } from '../../../shared/shortcuts';
import { commandEnabled, getCommand, trigger } from '../../app/registry';
import { isNativeTextEditing } from '../../app/mainCommands';
import { hasNativeMacChrome } from '../../app/titlebarChrome';
import { stepFrames } from './commands';
import { commandForShortcut } from './shortcutState';
import { onboardingVisible, tourVisible, useUiStore } from '../../stores/uiStore';

// 全局快捷键（6.7）：按各命令生效的快捷键匹配（默认值加设置里的自定义，6.11；核心命令和可选模块的命令一样），
// 执行一律经 dispatcher（trigger）。
// 焦点在文本输入框里时，单字母和空格快捷键不生效；已经被控件处理过的按键（defaultPrevented，
// 例如数字框和时间轴自己的方向键）不再处理。逐帧的左右方向键不是命令，在这里直接处理。

function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type);
  return (el as HTMLElement).isContentEditable === true;
}

/** 空格会激活聚焦的按钮：这时不当成播放快捷键 */
function isActivatable(el: Element | null): boolean {
  if (!el) return false;
  return el.matches('button, a[href], [role="button"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="tab"], [role="slider"], [role="radio"], input, select, summary');
}

/** 弹层或对话框开着时，单键快捷键不生效（它们有自己的键盘操作） */
function inOverlay(el: Element | null): boolean {
  return !!el?.closest('[role="dialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"]');
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      // 首次启动引导、新手引导开着时主界面的快捷键都不生效（6.10、6.14）：它们自己处理按键
      const ui = useUiStore.getState();
      if (onboardingVisible(ui) || tourVisible(ui)) return;
      const target = document.activeElement;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl && !e.altKey) {
        // 单键：文本框里、弹层里不生效
        if (isTextInput(target) || inOverlay(target)) return;
        if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
          if (isActivatable(target) && target?.getAttribute('role') === 'slider') return;
          e.preventDefault();
          return stepFrames((e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
        }
        if (e.code === 'Space' && isActivatable(target)) return;
      }
      const shortcut = shortcutFromEvent(e);
      if (!shortcut) return;
      if (hasNativeMacChrome() && (shortcut === 'Ctrl+Z' || shortcut === 'Ctrl+Shift+Z') && isNativeTextEditing()) return;
      const id = commandForShortcut(shortcut);
      const cmd = id ? getCommand(id) : undefined;
      if (!cmd || !commandEnabled(cmd)) return;
      e.preventDefault();
      trigger(cmd.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
