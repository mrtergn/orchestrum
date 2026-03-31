export async function executeStep<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

export async function executeParallelBlock<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  return Promise.all(tasks.map((task) => task()));
}
