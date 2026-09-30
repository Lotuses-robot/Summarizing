// web 测试的 fetch 替身公用管道（各测试只留「路由表与标志位」，管道不再抄五份）。

/** 取 fetch 入参的 URL（RequestInfo 可能是 string / URL / Request 三种形态）。 */
export function fetchUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** JSON 响应快捷构造（默认 200）。 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 空体响应（204/409 等无 body 场景）。 */
export function emptyResponse(status: number): Response {
  return new Response(null, { status });
}
