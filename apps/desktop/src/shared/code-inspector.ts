import type { ParamValue } from '@allay/template-sdk';

export type CodeInspectorPacket =
  | {
      type: 'document';
      token: number;
      id: string;
      version: string;
      clipId?: string;
      title: string;
      source: string;
      manifest: string;
      editable: boolean;
      language: 'en' | 'zh-CN';
      theme: 'dark' | 'light';
      baseVersion?: string;
    }
  | { type: 'params'; token: number; params: Record<string, ParamValue>; fps: number }
  | { type: 'frame'; token: number; time: number; frame: number; playing: boolean; lines: number[] }
  | { type: 'setup'; token: number; lines: number[] }
  | { type: 'empty'; message: string; language: 'en' | 'zh-CN'; theme: 'dark' | 'light' }
  | { type: 'result'; token: number; ok: boolean; message: string };

export type CodeInspectorAction =
  | { type: 'save'; token: number; source: string; manifest: string; baseVersion: string }
  | { type: 'copy'; token: number }
  | { type: 'authoring' };

export interface CodeInspectorParentApi {
  open(): Promise<void>;
  publish(packet: CodeInspectorPacket): void;
  onOpenChanged(cb: (open: boolean) => void): () => void;
  onAction(cb: (action: CodeInspectorAction) => void): () => void;
}

export interface CodeInspectorChildApi {
  onPacket(cb: (packet: CodeInspectorPacket) => void): () => void;
  ready(): void;
  action(action: CodeInspectorAction): void;
  setDirty(dirty: boolean): void;
}

declare global {
  interface Window {
    allayCodeInspector: CodeInspectorChildApi;
  }
}

export const CODE_INSPECTOR_CHANNELS = {
  open: 'code-inspector:open',
  publish: 'code-inspector:publish',
  openChanged: 'code-inspector:open-changed',
  parentAction: 'code-inspector:parent-action',
  packet: 'code-inspector:packet',
  ready: 'code-inspector:ready',
  action: 'code-inspector:action',
  dirty: 'code-inspector:dirty',
} as const;
