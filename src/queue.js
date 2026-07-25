class UnifiedGpuQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  enqueue(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this.processNext();
    });
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const { taskFn, resolve, reject } = this.queue.shift();

    try {
      const result = await taskFn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }
}

module.exports = UnifiedGpuQueue;
