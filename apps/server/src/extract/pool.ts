import type {
  ExtractOutput,
  ExtractRequest,
  ExtractResponse,
  MarkdownOutput,
  MathOutput,
} from "./protocol.ts";

type Output = ExtractOutput | MarkdownOutput | MathOutput;
/** A request before the pool numbers it. */
type Unnumbered<R = ExtractRequest> = R extends unknown ? Omit<R, "id"> : never;

interface Task {
  req: ExtractRequest;
  resolve: (o: Output) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  timer: Timer | null;
}

/**
 * Fixed-size pool of extraction worker threads. A task that exceeds the
 * timeout (pathological HTML) gets its worker terminated and replaced, so one
 * bad page can never wedge extraction.
 */
export class ExtractPool {
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    size: number,
    private timeoutMs = 60_000,
  ) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  run(html: string, url: string): Promise<ExtractOutput> {
    return this.submit({ kind: "extract", html, url }) as Promise<ExtractOutput>;
  }

  /** Converts an extracted article's HTML to Markdown again (see extract/markdown.ts). */
  markdown(html: string, url: string): Promise<MarkdownOutput> {
    return this.submit({ kind: "markdown", html, url }) as Promise<MarkdownOutput>;
  }

  /** Draws a formula's TeX as SVG (see extract/mathSvg.ts). */
  math(tex: string, display: boolean): Promise<MathOutput> {
    return this.submit({ kind: "math", tex, display }) as Promise<MathOutput>;
  }

  private submit(req: Unnumbered) {
    if (this.closed) return Promise.reject(new Error("extract pool closed"));
    return new Promise<Output>((resolve, reject) => {
      const numbered = { ...req, id: this.nextId++ } as ExtractRequest;
      this.queue.push({ req: numbered, resolve, reject });
      this.pump();
    });
  }

  get pending(): number {
    return this.queue.length + this.slots.filter((s) => s.task).length;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.queue.splice(0)) t.reject(new Error("extract pool closed"));
    for (const s of this.slots) {
      s.task?.reject(new Error("extract pool closed"));
      s.worker.terminate();
    }
  }

  private spawn(): Slot {
    const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
    const slot: Slot = { worker, task: null, timer: null };
    worker.onmessage = (ev: MessageEvent<ExtractResponse>) => {
      const task = slot.task;
      if (!task || task.req.id !== ev.data.id) return;
      this.finish(slot);
      if (ev.data.ok) task.resolve(ev.data.out);
      else task.reject(new Error(ev.data.error));
      this.pump();
    };
    worker.onerror = (ev) => this.replace(slot, new Error(`extract worker crashed: ${ev.message}`));
    return slot;
  }

  private finish(slot: Slot) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
  }

  private replace(slot: Slot, err: Error) {
    const task = slot.task;
    this.finish(slot);
    slot.worker.terminate();
    task?.reject(err);
    if (this.closed) return;
    const idx = this.slots.indexOf(slot);
    if (idx >= 0) this.slots[idx] = this.spawn();
    this.pump();
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.task) continue;
      const task = this.queue.shift();
      if (!task) return;
      slot.task = task;
      slot.timer = setTimeout(
        () => this.replace(slot, new Error(`extraction timed out after ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
      slot.worker.postMessage(task.req);
    }
  }
}
