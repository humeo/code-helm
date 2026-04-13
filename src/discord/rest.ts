import { Buffer } from "node:buffer";
import { STATUS_CODES } from "node:http";
import { types } from "node:util";
import { shouldUseGlobalFetchAndWebSocket } from "@discordjs/util";
import { DefaultRestOptions, type RESTOptions } from "discord.js";
import { Headers, request } from "undici";

type RestMakeRequest = NonNullable<RESTOptions["makeRequest"]>;
type RestRequestInit = Parameters<RestMakeRequest>[1];
type RestRequestBody = RestRequestInit["body"];
type UndiciRequestOptions = NonNullable<Parameters<typeof request>[1]>;
type RestRequestInitWithDispatcher = RestRequestInit & {
  dispatcher?: UndiciRequestOptions["dispatcher"];
};

const resolveRestBody = async (body: RestRequestBody) => {
  if (body == null) {
    return null;
  }

  if (typeof body === "string") {
    return body;
  }

  if (types.isUint8Array(body)) {
    return body;
  }

  if (types.isArrayBuffer(body)) {
    return new Uint8Array(body);
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof DataView) {
    return new Uint8Array(body.buffer);
  }

  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }

  if (body instanceof FormData) {
    return body;
  }

  if (Symbol.iterator in body) {
    return Buffer.concat([...body] as Uint8Array[]);
  }

  if (Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];

    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  throw new TypeError("Unable to resolve REST request body.");
};

const makeUndiciRequest: RestMakeRequest = async (url, init) => {
  const requestInit = init as RestRequestInitWithDispatcher;
  const response = await request(url, {
    body: await resolveRestBody(requestInit.body) as UndiciRequestOptions["body"],
    method: requestInit.method as UndiciRequestOptions["method"],
    headers: requestInit.headers
      ? Array.from(new Headers(requestInit.headers).entries())
      : undefined,
    signal: requestInit.signal,
    dispatcher: requestInit.dispatcher,
  });

  const headers = new Headers();

  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }

      continue;
    }

    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  return {
    body: response.body,
    async arrayBuffer() {
      return response.body.arrayBuffer();
    },
    async json() {
      return response.body.json();
    },
    async text() {
      return response.body.text();
    },
    get bodyUsed() {
      return response.body.bodyUsed;
    },
    headers,
    status: response.statusCode,
    statusText: STATUS_CODES[response.statusCode] ?? "",
    ok: response.statusCode >= 200 && response.statusCode < 300,
  };
};

export const buildDiscordRestOptions = (
  overrides: Partial<RESTOptions> = {},
): Partial<RESTOptions> => {
  return {
    ...overrides,
    makeRequest:
      overrides.makeRequest
      ?? (shouldUseGlobalFetchAndWebSocket()
        ? makeUndiciRequest
        : DefaultRestOptions.makeRequest),
  };
};
