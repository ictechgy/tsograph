import type { NextFunction, Request, Response } from 'express';

/** 비동기 핸들러 타입이다. */
type AsyncRoute = (request: Request, response: Response, next: NextFunction) => Promise<unknown>;

/**
 * 비동기 핸들러의 거부를 `next`로 넘긴다.
 *
 * @param route 비동기 핸들러
 * @returns Express 핸들러
 */
export function asyncHandler(route: AsyncRoute) {
  return (request: Request, response: Response, next: NextFunction) => {
    route(request, response, next).catch(next);
  };
}
