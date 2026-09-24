import { EventEmitter } from "node:events";

/** Live notification pushed to API clients (Server-Sent Events). */
export interface LiveEvent {
  type: "tokenCreated" | "trade" | "curveCompleted" | "curveReopened" | "migrated";
  mint: string;
  signature: string;
  data: unknown;
}

/** In-process pub/sub between the indexer and the API. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: LiveEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
