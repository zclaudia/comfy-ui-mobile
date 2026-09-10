/** Keep the original payload on an uncertain reply, even if polling has advanced the draft head meanwhile. */
export class WorkspaceCommands {
  private pending = new Map<string, { requestId: string; input: unknown }>();
  async run<T, R>(key: string, input: T, send: (input: T, requestId: string) => Promise<R>): Promise<R> {
    let command = this.pending.get(key);
    if (!command) { command = { requestId: crypto.randomUUID(), input: structuredClone(input) }; this.pending.set(key, command); }
    const result = await send(structuredClone(command.input) as T, command.requestId);
    this.pending.delete(key);
    return result;
  }
}
