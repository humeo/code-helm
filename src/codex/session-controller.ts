import { JsonRpcClient } from "./jsonrpc-client";
import type {
  ReplyToServerRequestParams,
  ResumeThreadParams,
  StartThreadParams,
  StartTurnParams,
} from "./protocol-types";

const readThreadId = (result: unknown) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }

  const { threadId } = result as { threadId?: unknown };

  return typeof threadId === "string" ? threadId : undefined;
};

export class SessionController {
  activeThreadId: string | undefined;

  constructor(private readonly client: JsonRpcClient) {}

  initialize() {
    return this.client.initialize();
  }

  async startThread(params: StartThreadParams) {
    const result = await this.client.startThread(params);

    this.activeThreadId = readThreadId(result);
    return result;
  }

  async resumeThread(params: ResumeThreadParams) {
    const result = await this.client.resumeThread(params);

    this.activeThreadId = params.threadId;
    return result;
  }

  async startTurn(params: StartTurnParams) {
    const result = await this.client.startTurn(params);

    this.activeThreadId = params.threadId;
    return result;
  }

  replyToServerRequest(params: ReplyToServerRequestParams) {
    return this.client.replyToServerRequest(params);
  }
}
