export type EventHandler<TEvent> = (event: TEvent) => void;

export class EventRouter<TEventMap extends Record<string, unknown>> {
  private readonly subscribers = new Map<
    keyof TEventMap,
    Set<EventHandler<TEventMap[keyof TEventMap]>>
  >();

  subscribe<TKey extends keyof TEventMap>(
    eventName: TKey,
    handler: EventHandler<TEventMap[TKey]>,
  ) {
    const nextHandlers =
      this.subscribers.get(eventName) ??
      new Set<EventHandler<TEventMap[keyof TEventMap]>>();

    nextHandlers.add(
      handler as EventHandler<TEventMap[keyof TEventMap]>,
    );
    this.subscribers.set(eventName, nextHandlers);

    return () => {
      const handlers = this.subscribers.get(eventName);

      if (!handlers) {
        return;
      }

      handlers.delete(
        handler as EventHandler<TEventMap[keyof TEventMap]>,
      );

      if (handlers.size === 0) {
        this.subscribers.delete(eventName);
      }
    };
  }

  publish<TKey extends keyof TEventMap>(
    eventName: TKey,
    event: TEventMap[TKey],
  ) {
    const handlers = this.subscribers.get(eventName);

    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(event);
    }
  }
}
