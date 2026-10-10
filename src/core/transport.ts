// One request budget shared by the HTTP server, CLI and browser. Count UTF-8 bytes.
export const requestLimitBytes = 8 * 1024 * 1024;
export class RequestSizeError extends Error {
  readonly code = 'REQUEST_TOO_LARGE';
  constructor(readonly actualBytes:number,readonly limitBytes=requestLimitBytes){
    super(`请求为 ${actualBytes} 字节，上限 ${limitBytes} 字节。数组切片请使用 sliceMapping 规则，避免逐元素重复连接。`);
  }
}
export function serializeRequest(value:unknown){
  const json=JSON.stringify(value),bytes=new TextEncoder().encode(json).length;
  if(bytes>requestLimitBytes)throw new RequestSizeError(bytes);
  return {json,bytes,limitBytes:requestLimitBytes};
}
