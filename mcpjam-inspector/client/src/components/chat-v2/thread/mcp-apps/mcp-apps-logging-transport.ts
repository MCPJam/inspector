import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

export class LoggingTransport implements Transport {
  private inner: Transport;
  private onSend?: (message: JSONRPCMessage) => void;
  private onReceive?: (message: JSONRPCMessage) => void;
  private _sessionId?: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  setProtocolVersion?: (version: string) => void;

  constructor(
    inner: Transport,
    handlers: {
      onSend?: (message: JSONRPCMessage) => void;
      onReceive?: (message: JSONRPCMessage) => void;
    },
  ) {
    this.inner = inner;
    this.onSend = handlers.onSend;
    this.onReceive = handlers.onReceive;
  }

  get sessionId() {
    return this._sessionId ?? this.inner.sessionId;
  }

  set sessionId(value: string | undefined) {
    this._sessionId = value;
    this.inner.sessionId = value;
  }

  async start() {
    this.inner.onmessage = (message, extra) => {
      this.onReceive?.(message);
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => {
      this.onerror?.(error);
    };
    this.inner.onclose = () => {
      this.onclose?.();
    };
    this.inner.setProtocolVersion = (version) => {
      this.setProtocolVersion?.(version);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    this.onSend?.(message);
    await this.inner.send(message, options);
  }

  async close() {
    await this.inner.close();
  }
}
