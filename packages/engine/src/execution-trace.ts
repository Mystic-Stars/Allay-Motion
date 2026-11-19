import { MAX_EXECUTION_TRACE_LINES } from '@allay/template-sdk';

export type BindTraceRecorder = (record: ((line: number, entry?: boolean) => void) | undefined) => void;

/** 一个预览实例独占这个记录器，只在同步 update 的调用栈内绑定。 */
export class ExecutionTraceRecorder {
  private readonly lines = new Set<number>();
  private overflow = false;
  private ran = false;

  constructor(private readonly bind: BindTraceRecorder) {}

  begin(): void {
    this.lines.clear();
    this.overflow = false;
    this.ran = false;
  }

  run(update: () => void): void {
    this.ran = true;
    this.bind(this.record);
    try {
      update();
    } finally {
      this.bind(undefined);
    }
  }

  async runSetup<Result>(setup: () => Result | Promise<Result>): Promise<Result> {
    this.begin();
    this.ran = true;
    this.bind(this.recordSetup);
    try {
      return await setup();
    } finally {
      this.bind(undefined);
    }
  }

  finish(): number[] | undefined {
    return this.ran && !this.overflow && this.lines.size > 0 ? [...this.lines].sort((a, b) => a - b) : undefined;
  }

  private readonly record = (line: number): void => {
    if (this.overflow || this.lines.has(line)) return;
    if (this.lines.size >= MAX_EXECUTION_TRACE_LINES) this.overflow = true;
    else this.lines.add(line);
  };

  private readonly recordSetup = (line: number, entry?: boolean): void => {
    if (!entry) this.record(line);
  };
}
